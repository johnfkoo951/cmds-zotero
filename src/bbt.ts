import type { Capabilities, CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { BbtTransportError, httpRequest, isBbtTransportError, mapBounded, rpc, type BbtTransportReason } from "./api/transport";
import { normalizeAttachments, normalizeEntry, parseItemURI, text } from "./api/normalize";
import { entryHash, record, validateEntry, validateIndex } from "./identity";
import { indexDiagnostics } from "./diagnostics";
import { positiveInteger } from "./uris";

// 0.5 R4: the last real BBT observation (no polling); `aborted` requests are the plugin's own cancellation and are not recorded.
export interface BbtOutcome { ok: boolean; at: Date; reason?: BbtTransportReason; status?: number; message?: string }

export class BbtService {
	private controller = new AbortController();
	private outcome: BbtOutcome | null = null;
	private readonly outcomeListeners = new Set<(outcome: BbtOutcome) => void>();
	constructor(private settings: CmdsZoteroSettings) {}
	updateSettings(settings: CmdsZoteroSettings): void {
		this.controller.abort();
		this.controller = new AbortController();
		this.settings = settings;
	}
	dispose(): void { this.controller.abort(); this.outcomeListeners.clear(); }

	/** The most recent real BBT call outcome, or null before any call completed. */
	get lastOutcome(): BbtOutcome | null { return this.outcome; }

	/** Subscribes to every recorded outcome; returns the unsubscribe function. */
	onOutcome(listener: (outcome: BbtOutcome) => void): () => void {
		this.outcomeListeners.add(listener);
		return () => { this.outcomeListeners.delete(listener); };
	}

	private recordOutcome(outcome: BbtOutcome): void {
		this.outcome = outcome;
		for (const listener of this.outcomeListeners) listener(outcome);
	}

	/**
	 * Records the outcome of one whole BBT operation (request plus the checks that decide whether the answer was usable):
	 * success, or a typed failure other than the plugin's own abort. Wrapping only the raw request would record `ok` for
	 * an HTTP 404 or an unusable readiness answer that the caller rejects a line later. A failure is sticky against
	 * concurrent in-flight successes: during `collect` (up to 8 requests at once) a slower request that started before
	 * the failure was observed must not overwrite it with `ok`, so the outcome compares start times, not completion.
	 */
	private async observed<T>(run: () => Promise<T>): Promise<T> {
		const started = new Date();
		try {
			const result = await run();
			if (!(this.outcome && !this.outcome.ok && started.getTime() < this.outcome.at.getTime())) this.recordOutcome({ ok: true, at: new Date() });
			return result;
		} catch (error) {
			if (isBbtTransportError(error) && error.reason !== "aborted") this.recordOutcome({ ok: false, at: new Date(), reason: error.reason, ...(error.status !== undefined ? { status: error.status } : {}), message: error.message });
			throw error;
		}
	}

	private call(method: string, params: unknown[] = [], timeout = this.settings.requestTimeoutMs): Promise<unknown> {
		return this.observed(() => rpc(this.settings.bbtEndpoint, method, params, timeout, this.controller.signal));
	}

	async capabilities(): Promise<Capabilities> {
		return this.readCapabilities(this.settings);
	}

	private async readCapabilities(settings: CmdsZoteroSettings, signal = this.controller.signal): Promise<Capabilities> {
		return this.observed(async () => {
			const ready = await rpc(settings.bbtEndpoint, "api.ready", [], settings.requestTimeoutMs, signal);
			if (!record(ready) || !text(ready.zotero) || !text(ready.betterbibtex)) throw new BbtTransportError("invalid-response", settings.bbtEndpoint, "Invalid BBT readiness response");
			return { zotero: text(ready.zotero), betterbibtex: text(ready.betterbibtex), metadata: true, attachments: true, annotations: true, bibliography: true };
		});
	}

	async isReachable(): Promise<boolean> {
		try { await this.capabilities(); return true; } catch { return false; }
	}

	async cayw(): Promise<string> {
		const params = new URLSearchParams({ format: this.settings.caywFormat, brackets: "true" });
		const endpoint = `${this.settings.bbtEndpoint.replace(/\/$/, "")}/cayw`;
		return this.observed(async () => {
			const response = await httpRequest(`${endpoint}?${params.toString()}`, this.settings.requestTimeoutMs, undefined, this.controller.signal);
			if (response.status !== 200) throw new BbtTransportError(response.status === 404 ? "http-404" : "http-other", endpoint, `BBT picker HTTP ${response.status}`, { status: response.status });
			return response.text.trim();
		});
	}

	async collect(previous?: ZoteroIndex): Promise<ZoteroIndex> {
		const settings = { ...this.settings };
		const signal = this.controller.signal;
		const call = (method: string, params: unknown[], timeout = settings.requestTimeoutMs): Promise<unknown> => this.observed(() => rpc(settings.bbtEndpoint, method, params, timeout, signal));
		const capabilities = await this.readCapabilities(settings, signal);
		const result = await call("item.search", [[["itemType", "isNot", "attachment"], ["itemType", "isNot", "annotation"], ["itemType", "isNot", "note"]], "*"]);
		if (!Array.isArray(result)) throw new Error("Invalid BBT parent search response");
		const libraries = new Map<string, Map<string, ReturnType<typeof parseItemURI>>>();
		for (const item of result) {
			if (!record(item)) throw new Error("Malformed BBT search item");
			const citekey = text(item.citekey) || text(item.citationKey) || text(item["citation-key"]);
			const library = text(item.library);
			if (!citekey || !library) throw new Error("Search item lacks named library citation identity");
			const scope = parseItemURI(text(item.id));
			const keys = libraries.get(library) ?? new Map<string, ReturnType<typeof parseItemURI>>();
			if (keys.has(citekey)) throw new Error("Duplicate citation key inside a named library cannot be exported unambiguously");
			for (const prior of keys.values()) if (prior.libraryType !== scope.libraryType || prior.groupID !== scope.groupID) throw new Error("Library name maps to multiple URI scopes");
			keys.set(citekey, scope);
			libraries.set(library, keys);
		}
		const batches: { library: string; keys: string[] }[] = [];
		for (const [library, scoped] of libraries) {
			const keys = [...scoped.keys()];
			for (let offset = 0; offset < keys.length; offset += 50) batches.push({ library, keys: keys.slice(offset, offset + 50) });
		}
		const libraryIDs = new Map<string, number>();
		const validPrevious = previous && validateIndex(previous) ? new Map(previous.entries.map(entry => [entry.id, entry])) : new Map<string, ZoteroIndexEntry>();
		const exports = await mapBounded(batches, settings.concurrency, async ({ library, keys }) => {
			const serialized = await call("item.export", [keys, "BetterBibTeX JSON", library]);
			if (typeof serialized !== "string") throw new Error("BBT export must return a JSON string");
			const exported: unknown = JSON.parse(serialized);
			if (!record(exported) || !Array.isArray(exported.items)) throw new Error("Invalid BetterBibTeX JSON export envelope");
			const entries = exported.items.map(item => {
				if (!record(item) || !positiveInteger(item.libraryID)) throw new Error("Exported library identity mismatch");
				const priorID = libraryIDs.get(library);
				if (priorID !== undefined && priorID !== item.libraryID) throw new Error("Named library has inconsistent local IDs");
				libraryIDs.set(library, item.libraryID);
				const id = `${item.libraryID}:${text(item.itemKey)}`;
				const entry = normalizeEntry(item, validPrevious.get(id));
				const searched = libraries.get(library)?.get(entry.citekey);
				if (!keys.includes(entry.citekey) || !searched || searched.itemKey !== entry.itemKey || searched.libraryType !== entry.libraryType || searched.groupID !== entry.groupID) throw new Error("Export differs from searched item identity");
				return entry;
			});
			if (entries.length !== keys.length || new Set(entries.map(entry => entry.citekey)).size !== keys.length) throw new Error("BBT export did not cover the requested parents");
			return entries;
		});
		const entries = await mapBounded(exports.flat(), settings.concurrency, async entry => {
			try {
				const attachments = await call("item.attachments", [entry.citekey, entry.libraryID], settings.attachmentTimeoutMs);
				entry.attachments = normalizeAttachments(attachments, entry);
				entry.attachmentPath = entry.attachments.find(attachment => attachment.path?.toLowerCase().endsWith(".pdf"))?.path ?? "";
				entry.contentHash = entryHash(entry);
				if (!validateEntry(entry)) throw new Error("Invalid enriched attachment data");
			} catch (error) {
				if (signal.aborted) throw error;
				const old = validPrevious.get(entry.id);
				entry.attachments = old && old.libraryType === entry.libraryType && old.groupID === entry.groupID ? old.attachments : [];
				entry.attachmentPath = old && entry.attachments === old.attachments ? old.attachmentPath : "";
				entry.attachmentStatus = "unavailable";
			}
			entry.contentHash = entryHash(entry);
			if (!validateEntry(entry)) throw new Error("Invalid normalized parent item");
			return entry;
		});
		if (signal.aborted) throw new Error("BBT collection cancelled");
		entries.sort((left, right) => left.id.localeCompare(right.id));
		const index: ZoteroIndex = { schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: entries.length, entries, capabilities, diagnostics: indexDiagnostics(entries), complete: entries.every(entry => entry.attachmentStatus === "complete") };
		if (!validateIndex(index)) throw new Error("Invalid collected Zotero index");
		return index;
	}

	/** CSL bibliography text for one entry; `style` defaults to the configured style (0.5 R4: every style is observed and typed). */
	async bibliography(entry: ZoteroIndexEntry, style = this.settings.bibliographyStyle): Promise<string> {
		if (!validateEntry(entry)) throw new Error("Bibliography requires a validated item");
		const output = await this.call("item.bibliography", [[entry.citekey], { id: style, contentType: "text" }, entry.libraryID]);
		if (typeof output !== "string") throw new Error("Invalid BBT bibliography response");
		return output;
	}
}
