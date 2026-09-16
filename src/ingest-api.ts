import type { App } from "obsidian";
import type { BbtService } from "./bbt";
import { IndexRefusalError, resolveInIndex, type IndexService, type RefreshOutcome } from "./index-service";
import type { ZoteroIndex } from "./types";
import type { VaultLinks } from "./vault-links";
import { ACTION_API_VERSION, AGENT_ACTIONS, runAction, validateActionRequest, type ActionHost, type AgentAction, type ResolveRequest } from "./agent/actions";
import { buildEnvelope } from "./agent/connection";
import type { FailureReason } from "./agent/types";
import { LocalFileError } from "./local-file";
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from "node:timers";

export type IngestAction = AgentAction;
export interface IngestJob {
	state: "pending" | "completed" | "failed";
	createdAt: string;
	finishedAt?: string;
	result?: unknown;
	error?: string;
	/** The requested action; present on jobs created since 0.5. */
	action?: IngestAction;
}
export type ActionHostFactory = (action: AgentAction, request: unknown, now: Date) => Promise<ActionHost>;

// 0.5 R13/F18: injectable timers keep the timeout tests fast; the default never holds a Node process open.
export interface JobTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}
export interface IngestAPIOptions {
	timers?: JobTimers;
	/** Per-action job timeout overrides in milliseconds (tests). */
	timeoutMs?: Partial<Record<IngestAction, number>>;
}
/** A pending job is failed after this long so a hung extraction or bridge cannot block reconfiguration until reload. */
export const JOB_TIMEOUT_MS: Readonly<Record<IngestAction, number>> = {
	connection: 300_000, info: 300_000, refresh: 300_000, resolve: 300_000, identity: 300_000, cites: 300_000, reconcile: 300_000, diagnostics: 300_000, locate: 300_000,
	"pdf-text": 900_000,
};
/** Process-level Node timers (desktop-only plugin; tests run under Node), unref'd so an idle pending job never holds a process open. */
const defaultTimers: JobTimers = {
	setTimeout: (callback, ms) => nodeSetTimeout(callback, ms).unref(),
	clearTimeout: handle => { nodeClearTimeout(handle as NodeJS.Timeout); },
};

const MAX_JOBS = 16;
const TERMINAL_TTL_MS = 10 * 60 * 1000;

export class IngestAPI {
	readonly apiVersion = 2;
	readonly apiVersions = [1, 2] as const;
	private jobs = new Map<string, IngestJob>();
	private sequence = 0;
	private activeRequests = 0;
	private activeWrites = 0;
	private alive = true;
	private timers: JobTimers;
	private timeouts: Record<IngestAction, number>;
	private timerHandles = new Map<string, unknown>();
	private writeJobs = new Set<string>();

	constructor(
		private app: App,
		private bbt: BbtService,
		private index: IndexService,
		private links: VaultLinks,
		private onIndex: (index: ZoteroIndex) => Promise<void>,
		private hostFactory?: ActionHostFactory,
		options: IngestAPIOptions = {},
	) {
		this.timers = options.timers ?? defaultTimers;
		this.timeouts = { ...JOB_TIMEOUT_MS, ...options.timeoutMs };
	}

	/**
	 * True while a refresh or a writing job is active, or while any request (a non-forced read included) has started a
	 * BBT collection that will write the index; a read served from the snapshot never blocks reconfiguration.
	 */
	get busy(): boolean { return this.activeWrites > 0 || this.index.collecting === true; }
	/** Every in-flight request, reads included. */
	get activeCount(): number { return this.activeRequests; }

	private static writes(action: IngestAction, request: unknown): boolean {
		if (action === "refresh" || action === "pdf-text") return true;
		return action === "reconcile" && (request as { apply?: unknown }).apply === true;
	}

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
		this.jobs.set(id, { state: "pending", createdAt: new Date().toISOString(), action });
		const writes = IngestAPI.writes(action, request);
		this.activeRequests++;
		if (writes) { this.activeWrites++; this.writeJobs.add(id); }
		// 0.5 R13/F18: the counters are released exactly once, by settlement or by the timeout, whichever comes first.
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			this.activeRequests--;
			if (writes) { this.activeWrites--; this.writeJobs.delete(id); }
			const handle = this.timerHandles.get(id);
			if (handle !== undefined) { this.timers.clearTimeout(handle); this.timerHandles.delete(id); }
		};
		const settle = (job: Omit<IngestJob, "createdAt">): void => {
			const current = this.jobs.get(id);
			if (!this.alive || !current || current.state !== "pending") return;
			this.jobs.set(id, { ...current, ...job });
		};
		const timeoutMs = this.timeouts[action];
		this.timerHandles.set(id, this.timers.setTimeout(() => {
			this.timerHandles.delete(id);
			settle({ state: "failed", error: `Request timed out after ${Math.round(timeoutMs / 1000)} s (${action}). A timed-out write may still have completed; inspect the current state before resubmitting.`, finishedAt: new Date().toISOString() });
			release();
		}, timeoutMs));
		void this.execute(action, request).then(result => {
			settle({ state: "completed", result, finishedAt: new Date().toISOString() });
		}, error => {
			settle({ state: "failed", error: error instanceof Error ? error.message : "Ingest request failed.", finishedAt: new Date().toISOString() });
		}).finally(release);
		return id;
	}

	/** Pending jobs that hold the write gate (refresh, pdf-text, reconcile --apply), oldest first; for the settings guard message. */
	pendingWrites(): { id: string; action: IngestAction }[] {
		const pending: { id: string; action: IngestAction }[] = [];
		for (const id of this.writeJobs) { const job = this.jobs.get(id); if (job?.state === "pending" && job.action) pending.push({ id, action: job.action }); }
		return pending;
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
		for (const handle of this.timerHandles.values()) this.timers.clearTimeout(handle);
		this.timerHandles.clear();
	}

	/**
	 * Loads or refreshes the index and publishes it. A non-forced request returns the newest validated snapshot with
	 * `reason: "stale-fallback"` and `error` when collection is impossible; a forced request throws instead.
	 */
	async ensureIndex(force = false): Promise<{ apiVersion: 1; vault: string } & Omit<RefreshOutcome, "index"> & { index: ZoteroIndex }> {
		this.activeRequests++;
		if (force) this.activeWrites++;
		try {
			const outcome = await this.index.refresh({ force });
			await this.onIndex(outcome.index);
			return { apiVersion: 1, vault: this.app.vault.getName(), ...outcome };
		} finally { this.activeRequests--; if (force) this.activeWrites--; }
	}

	/** The newest validated snapshot without contacting BBT, or null; never publishes or refreshes. */
	peekIndex(): Promise<ZoteroIndex | null> { return this.index.peek(); }

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
		// 0.5 R13/F05: UI callers (protocol handler, open-PDF command) always resolve against the in-memory snapshot; the agent
		// resolve action (whole-vault note scan, git probe, vault links) stays behind startJob("resolve").
		const index = request.refresh === true ? (await this.ensureIndex(true)).index : await this.index.peek();
		if (!index) return { status: "unavailable", message: "No validated Zotero index is available." };
		const query = request.itemKey ?? request.citekey ?? "";
		return resolveInIndex(index, query, { libraryID: request.libraryID, itemKey: request.itemKey });
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
				// Like the live host, the refresh action is an explicit publication: a snapshot that could not be revalidated is a failure.
				if (outcome.reason === "stale-fallback") {
					const message = outcome.error ?? "The index could not be refreshed.";
					throw outcome.failure ? new IndexRefusalError(outcome.failure, message) : new Error(message);
				}
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
			const failure = buildEnvelope(action, host.vault, ACTION_API_VERSION[action], host.connection, now, { reason: IngestAPI.failureReason(action, request, error, message), message });
			return { ...failure, ...(ACTION_API_VERSION[action] === 1 ? { status: "unavailable" } : {}) };
		}
	}

	/**
	 * 0.5 R13/F08: typed errors map first (index refusals by reason, local-file refusals by code); message patterns only
	 * classify PDF actions; `apply-failed` is reserved for a reconcile that was asked to write.
	 */
	private static failureReason(action: AgentAction, request: unknown, error: unknown, message: string): FailureReason {
		if (error instanceof IndexRefusalError) return error.reason;
		if (error instanceof LocalFileError) return error.code === "too-large" ? "pdf-too-large" : "pdf-invalid";
		if (action === "pdf-text" || action === "locate") {
			if (/64 MiB|too large/i.test(message)) return "pdf-too-large";
			if (/PDF|pdf\.js|extraction/i.test(message)) return "pdf-invalid";
		}
		return IngestAPI.writes(action, request) && action === "reconcile" ? "apply-failed" : "invalid-request";
	}

	private async connectionLegacy(): Promise<unknown> {
		return { apiVersion: 1, vault: this.app.vault.getName(), capabilities: await this.bbt.capabilities() };
	}

}
