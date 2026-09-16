import type { App } from "obsidian";
import type { BbtService } from "./bbt";
import { resolveInIndex, type IndexService } from "./index-service";
import type { ZoteroIndex } from "./types";
import type { VaultLinks } from "./vault-links";
import { ACTION_API_VERSION, AGENT_ACTIONS, runAction, validateActionRequest, type ActionHost, type AgentAction, type ResolveRequest } from "./agent/actions";
import { buildEnvelope } from "./agent/connection";
import type { FailureReason } from "./agent/types";

export type IngestAction = AgentAction;
export interface IngestJob {
	state: "pending" | "completed" | "failed";
	createdAt: string;
	finishedAt?: string;
	result?: unknown;
	error?: string;
}
export type ActionHostFactory = (action: AgentAction, request: unknown, now: Date) => Promise<ActionHost>;

const MAX_JOBS = 16;
const TERMINAL_TTL_MS = 10 * 60 * 1000;

export class IngestAPI {
	readonly apiVersion = 2;
	readonly apiVersions = [1, 2] as const;
	private jobs = new Map<string, IngestJob>();
	private sequence = 0;
	private activeRequests = 0;
	private alive = true;

	constructor(
		private app: App,
		private bbt: BbtService,
		private index: IndexService,
		private links: VaultLinks,
		private onIndex: (index: ZoteroIndex) => Promise<void>,
		private hostFactory?: ActionHostFactory,
	) {}

	get busy(): boolean { return this.activeRequests > 0; }

	private prune(now = Date.now()): void {
		for (const [id, job] of this.jobs) {
			if (job.state === "pending" || !job.finishedAt) continue;
			if (now - Date.parse(job.finishedAt) >= TERMINAL_TTL_MS) this.jobs.delete(id);
		}
	}

	startJob(action: IngestAction, request: unknown = {}): string {
		if (!AGENT_ACTIONS.includes(action)) throw new Error("Unsupported ingest action.");
		validateActionRequest(action, request);
		this.prune();
		if (!this.alive) throw new Error("CMDS Zotero service was unloaded.");
		if (this.jobs.size >= MAX_JOBS) throw new Error("Too many active ingest requests.");
		const id = `${Date.now()}-${++this.sequence}`;
		this.jobs.set(id, { state: "pending", createdAt: new Date().toISOString() });
		this.activeRequests++;
		void this.execute(action, request).then(result => {
			if (!this.alive || !this.jobs.has(id)) return;
			this.jobs.set(id, { ...this.jobs.get(id)!, state: "completed", result, finishedAt: new Date().toISOString() });
		}, error => {
			if (!this.alive || !this.jobs.has(id)) return;
			this.jobs.set(id, { ...this.jobs.get(id)!, state: "failed", error: error instanceof Error ? error.message : "Ingest request failed.", finishedAt: new Date().toISOString() });
		}).finally(() => { this.activeRequests--; });
		return id;
	}

	/** Reads never consume: a completed result persists until `ackJob` or its TTL, so a lost CLI delivery can be re-read. */
	getJob(id: string): IngestJob {
		this.prune();
		const job = this.jobs.get(id);
		if (!job) return { state: "failed", createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: "Request expired, was consumed, or the plugin was reloaded. Do not resubmit a possibly completed write; inspect current state first." };
		return { ...job };
	}

	/** Releases a terminal job after the client has read its result. Pending jobs are never acknowledged away. */
	ackJob(id: string): boolean {
		this.prune();
		const job = this.jobs.get(id);
		if (!job || job.state === "pending") return false;
		this.jobs.delete(id);
		return true;
	}

	dispose(): void {
		this.alive = false;
		this.jobs.clear();
	}

	async ensureIndex(force = false): Promise<{ apiVersion: 1; vault: string; index: ZoteroIndex }> {
		this.activeRequests++;
		try {
			const index = await this.index.get(force);
			await this.onIndex(index);
			return { apiVersion: 1, vault: this.app.vault.getName(), index };
		} finally { this.activeRequests--; }
	}

	async connection(): Promise<{ apiVersion: 1; vault: string; capabilities: { zotero: string; betterbibtex: string }; [key: string]: unknown }> {
		if (this.hostFactory) return await this.execute("connection", {}) as never;
		const capabilities = await this.bbt.capabilities();
		return { apiVersion: 1, vault: this.app.vault.getName(), capabilities };
	}

	async resolve(request: ResolveRequest): Promise<
		| { status: "resolved"; entry: ZoteroIndex["entries"][number]; matchedHistory?: boolean; [key: string]: unknown }
		| { status: "ambiguous"; candidates?: ZoteroIndex["entries"]; [key: string]: unknown }
		| { status: "not-found" | "unavailable"; message?: string; [key: string]: unknown }
	> {
		validateActionRequest("resolve", request);
		if (!this.hostFactory) {
			const index = request.refresh === true ? (await this.ensureIndex(true)).index : await this.index.peek();
			if (!index) return { status: "unavailable", message: "No validated Zotero index is available." };
			const query = request.itemKey ?? request.citekey ?? "";
			return resolveInIndex(index, query, { libraryID: request.libraryID, itemKey: request.itemKey });
		}
		const payload = await this.execute("resolve", request) as Record<string, unknown>;
		return payload as never;
	}

	async diagnose(): Promise<{ generatedAt: string | null; complete: boolean | null; count: number | null; diagnostics: { severity: string; code: string; message: string }[]; [key: string]: unknown }> {
		if (!this.hostFactory) {
			const index = await this.index.peek();
			if (!index) throw new Error("No validated Zotero index is available.");
			return { generatedAt: index.generatedAt, complete: index.complete, count: index.count, diagnostics: index.diagnostics };
		}
		return await this.execute("diagnostics", {}) as never;
	}

	private async execute(action: AgentAction, request: unknown): Promise<unknown> {
		if (!this.hostFactory) {
			if (action === "connection") return this.connectionLegacy();
			if (action === "refresh") {
				const options = request as { ifOlderThanMinutes?: number };
				const outcome = await this.index.refresh({ force: options.ifOlderThanMinutes === undefined, ...(options.ifOlderThanMinutes ? { ifOlderThanMs: options.ifOlderThanMinutes * 60000 } : {}) });
				await this.onIndex(outcome.index);
				return { apiVersion: 1, vault: this.app.vault.getName(), count: outcome.index.count, complete: outcome.index.complete, generatedAt: outcome.index.generatedAt, diagnostics: outcome.index.diagnostics, refreshed: outcome.refreshed };
			}
			throw new Error("The agent runtime host is unavailable.");
		}
		const now = new Date();
		const host = await this.hostFactory(action, request, now);
		try { return await runAction(host, action, request); }
		catch (error) {
			const message = error instanceof Error ? error.message : "Agent action failed.";
			let reason: FailureReason = action === "reconcile" ? "apply-failed" : "invalid-request";
			if (/64 MiB|too large/i.test(message)) reason = "pdf-too-large";
			else if (/PDF|pdf\.js|extraction/i.test(message)) reason = "pdf-invalid";
			const failure = buildEnvelope(action, host.vault, ACTION_API_VERSION[action], host.connection, now, { reason, message });
			return { ...failure, ...(ACTION_API_VERSION[action] === 1 ? { status: "unavailable" } : {}) };
		}
	}

	private async connectionLegacy(): Promise<unknown> {
		return { apiVersion: 1, vault: this.app.vault.getName(), capabilities: await this.bbt.capabilities() };
	}

}
