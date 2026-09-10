import type { App } from "obsidian";
import type { BbtService } from "./bbt";
import type { IndexService } from "./index-service";
import type { ZoteroIndex, Diagnostic } from "./types";
import type { VaultLinks } from "./vault-links";

export interface ResolveRequest {
	citekey?: string;
	itemKey?: string;
	libraryID?: number;
	refresh?: boolean;
}

export type IngestAction = "connection" | "refresh" | "resolve" | "diagnostics";
export interface IngestJob {
	state: "pending" | "completed" | "failed";
	result?: unknown;
	error?: string;
}

export class IngestAPI {
	readonly apiVersion = 1;
	private jobs = new Map<string, IngestJob>();
	private sequence = 0;

	startJob(action: IngestAction, request: ResolveRequest = {}): string {
		if (!["connection", "refresh", "resolve", "diagnostics"].includes(action)) throw new Error("Unsupported ingest action.");
		if (this.jobs.size >= 16) {
			for (const [key, job] of this.jobs) if (job.state !== "pending") this.jobs.delete(key);
			if (this.jobs.size >= 16) throw new Error("Too many active ingest requests.");
		}
		const id = `${Date.now()}-${++this.sequence}`;
		this.jobs.set(id, { state: "pending" });
		void (async () => {
			try {
				let result: unknown;
				if (action === "connection") result = await this.connection();
				else if (action === "diagnostics") result = await this.diagnose();
				else if (action === "resolve") result = await this.resolve(request);
				else {
					const { index, vault } = await this.ensureIndex(true);
					result = { apiVersion: 1, vault, count: index.count, complete: index.complete, generatedAt: index.generatedAt, diagnostics: index.diagnostics };
				}
				this.jobs.set(id, { state: "completed", result });
			} catch (error) { this.jobs.set(id, { state: "failed", error: error instanceof Error ? error.message : "Ingest request failed." }); }
		})();
		return id;
	}

	getJob(id: string): IngestJob {
		return this.jobs.get(id) ?? { state: "failed", error: "Request expired or the plugin was reloaded. Start a new request." };
	}
	private activeRequests = 0;
	get busy(): boolean { return this.activeRequests > 0; }
	constructor(
		private app: App,
		private bbt: BbtService,
		private index: IndexService,
		private links: VaultLinks,
		private onIndex: (index: ZoteroIndex) => Promise<void>,
	) {}

	async connection() {
		return { apiVersion: this.apiVersion, vault: this.app.vault.getName(), capabilities: await this.bbt.capabilities() };
	}

	async ensureIndex(force = false) {
		this.activeRequests++;
		try {
			const index = await this.index.get(force);
			await this.onIndex(index);
			return { apiVersion: this.apiVersion, vault: this.app.vault.getName(), index };
		} finally { this.activeRequests--; }
	}

	async resolve(request: ResolveRequest) {
		if (typeof request !== "object" || request === null) throw new Error("A resolution request is required.");
		const query = request.citekey ?? request.itemKey;
		if (typeof query !== "string" || !query.trim() || query.length > 1000) throw new Error("Provide a citekey or item key.");
		if (request.libraryID !== undefined && (!Number.isInteger(request.libraryID) || request.libraryID < 1)) throw new Error("Library ID must be a positive integer.");
		if (request.itemKey && (!/^[A-Z0-9]{8}$/.test(request.itemKey) || request.libraryID === undefined)) throw new Error("Stable resolution requires an eight-character item key and a library ID.");
		try {
			const { index } = await this.ensureIndex(request.refresh === true);
			const result = await this.index.resolve(query, { libraryID: request.libraryID, itemKey: request.itemKey });
			if (result.status !== "resolved") return { apiVersion: this.apiVersion, ...result, generatedAt: index.generatedAt };
			return {
				apiVersion: this.apiVersion, ...result, generatedAt: index.generatedAt,
				vaultLinks: await this.links.find(result.entry, index),
				evidence: result.entry.attachments.flatMap(attachment => attachment.annotations.map(annotation => ({
					annotationKey: annotation.key, attachmentKey: attachment.key, page: annotation.page,
					pageLabel: annotation.pageLabel, uri: annotation.uri,
				}))),
			};
		} catch (error) {
			return { apiVersion: this.apiVersion, status: "unavailable" as const, message: error instanceof Error ? error.message : "Zotero is unavailable." };
		}
	}

	async diagnose() {
		const { index } = await this.ensureIndex();
		const diagnostics: Diagnostic[] = [...index.diagnostics];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm?.citekeyProvisional === true) diagnostics.push({ code: "provisional-citekey", severity: "warning", message: `Provisional citekey: ${file.path}. Pin it in Zotero; do not rename the note automatically.` });
		}
		return { apiVersion: this.apiVersion, vault: this.app.vault.getName(), generatedAt: index.generatedAt, complete: index.complete, count: index.count, diagnostics };
	}
}
