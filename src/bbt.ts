import type { Capabilities, CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { BbtTransportError, httpRequest, isBbtTransportError, mapBounded, rpc, type BbtTransportReason } from "./api/transport";
import { normalizeAttachments, normalizeEntryUnhashed, parseItemURI, text } from "./api/normalize";
import { record, sealEntry, verifyEntry, verifyIndex } from "./identity";
import { indexDiagnostics } from "./diagnostics";
import { positiveInteger } from "./uris";
import { addDays, clampRecentDays, dayTerms, localDay, orderRecent, parseRecentItem, recentKey, windowTerms, type RecentRead } from "./recent/recent-reads";

/** Calendar days probed concurrently while dating recent reads; the probes are single indexed SQLite queries in Zotero. */
const RECENT_DAY_BATCH = 7;

/**
 * Parallel `item.attachments` calls during an index refresh: twice the configured parallel requests, at most 8 (the
 * `mapBounded` limit). A refresh makes one such call per parent item; each is a short read whose time is mostly the round
 * trip, so keeping more in flight shortens the refresh while bibliography batches, reading history and the export batches
 * keep the configured value. Doubling keeps the setting meaningful: the default 2 gives 4, a value lowered to 1 for a slow
 * Zotero still gives only 2. An out-of-range value is passed through so `mapBounded` rejects it as before.
 */
export function attachmentConcurrency(concurrency: number): number {
	return Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8 ? Math.min(8, concurrency * 2) : concurrency;
}

/**
 * Identity a fresh single-item collection must reproduce; the cached citekey is only the lookup handle. `libraryID` is the
 * local library ID when the saved index knows the item; an item added since then is addressed by its BBT library name.
 */
export interface FreshTarget { citekey: string; itemKey: string; libraryType: "user" | "group"; groupID?: number; libraryID?: number; library?: string }

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

	private call(method: string, params: unknown[] = [], timeout = this.settings.requestTimeoutMs, signal?: AbortSignal): Promise<unknown> {
		return this.withSignal(signal, joined => this.observed(() => rpc(this.settings.bbtEndpoint, method, params, timeout, joined)));
	}

	/** 0.5 R12: an optional short `timeoutMs` and caller `signal` (a sidebar's per-render abort) for a pre-batch probe. */
	async capabilities(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Capabilities> {
		const settings = options.timeoutMs ? { ...this.settings, requestTimeoutMs: options.timeoutMs } : this.settings;
		return this.withSignal(options.signal, joined => this.readCapabilities(settings, joined));
	}

	/**
	 * Runs one request under the service's own abort signal joined with a caller's signal; the listeners on the long-lived
	 * service signal are removed when the request settles so repeated sidebar renders never accumulate them.
	 */
	private async withSignal<T>(extra: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const own = this.controller.signal;
		if (!extra) return run(own);
		const combined = new AbortController();
		const abort = (): void => { combined.abort(); };
		if (own.aborted || extra.aborted) combined.abort();
		else { own.addEventListener("abort", abort); extra.addEventListener("abort", abort); }
		try { return await run(combined.signal); }
		finally { own.removeEventListener("abort", abort); extra.removeEventListener("abort", abort); }
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
		// The previous index is the host's validated snapshot: its sealed entries are not hashed again.
		const validPrevious = previous && verifyIndex(previous) ? new Map(previous.entries.map(entry => [entry.id, entry])) : new Map<string, ZoteroIndexEntry>();
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
				// Hashed once below, after the attachments step changed it for the last time.
				const entry = normalizeEntryUnhashed(item, validPrevious.get(id));
				const searched = libraries.get(library)?.get(entry.citekey);
				if (!keys.includes(entry.citekey) || !searched || searched.itemKey !== entry.itemKey || searched.libraryType !== entry.libraryType || searched.groupID !== entry.groupID) throw new Error("Export differs from searched item identity");
				return entry;
			});
			if (entries.length !== keys.length || new Set(entries.map(entry => entry.citekey)).size !== keys.length) throw new Error("BBT export did not cover the requested parents");
			return entries;
		});
		// Each entry is structure-checked and hashed once, after its last change (sealEntry): with attachments, or with the
		// previous attachments (or none) when this item's attachments could not be read.
		const entries = await mapBounded(exports.flat(), attachmentConcurrency(settings.concurrency), async entry => {
			try {
				const attachments = await call("item.attachments", [entry.citekey, entry.libraryID], settings.attachmentTimeoutMs);
				entry.attachments = normalizeAttachments(attachments, entry);
				entry.attachmentPath = entry.attachments.find(attachment => attachment.path?.toLowerCase().endsWith(".pdf"))?.path ?? "";
				if (!sealEntry(entry)) throw new Error("Invalid enriched attachment data");
			} catch (error) {
				if (signal.aborted) throw error;
				const old = validPrevious.get(entry.id);
				entry.attachments = old && old.libraryType === entry.libraryType && old.groupID === entry.groupID ? old.attachments : [];
				entry.attachmentPath = old && entry.attachments === old.attachments ? old.attachmentPath : "";
				entry.attachmentStatus = "unavailable";
				if (!sealEntry(entry)) throw new Error("Invalid normalized parent item");
			}
			return entry;
		});
		if (signal.aborted) throw new Error("BBT collection cancelled");
		entries.sort((left, right) => left.id.localeCompare(right.id));
		const index: ZoteroIndex = { schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: entries.length, entries, capabilities, diagnostics: indexDiagnostics(entries), complete: entries.every(entry => entry.attachmentStatus === "complete") };
		if (!verifyIndex(index)) throw new Error("Invalid collected Zotero index");
		return index;
	}

	/** CSL bibliography text for one entry; `style` defaults to the configured style (0.5 R4: every style is observed and typed). */
	async bibliography(entry: ZoteroIndexEntry, style = this.settings.bibliographyStyle, signal?: AbortSignal): Promise<string> {
		if (!verifyEntry(entry)) throw new Error("Bibliography requires a validated item");
		// 0.5 R12: a caller's signal (per-render abort) joins the service signal; the call stays observed.
		const output = await this.call("item.bibliography", [[entry.citekey], { id: style, contentType: "text" }, entry.libraryID], this.settings.requestTimeoutMs, signal);
		if (typeof output !== "string") throw new Error("Invalid BBT bibliography response");
		return output;
	}

	/**
	 * Items whose attachment Zotero opened within the last `days` calendar days, newest first (Zotero 10
	 * `attachmentLastRead`). One window search, then exact-day searches backwards from today until every item has its day;
	 * each probe is one cheap Zotero search. Read-only. Rows without a citekey (standalone PDFs) are left out.
	 */
	async recentlyRead(days: number, options: { signal?: AbortSignal; now?: Date } = {}): Promise<RecentRead[]> {
		const window = clampRecentDays(days);
		const search = async (terms: unknown[]): Promise<unknown[]> => {
			const result = await this.call("item.search", [terms], this.settings.requestTimeoutMs, options.signal);
			if (!Array.isArray(result)) throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid Better BibTeX search response");
			return result as unknown[];
		};
		const rows = new Map<string, RecentRead>();
		for (const raw of await search(windowTerms(window))) {
			const parsed = parseRecentItem(raw);
			if (parsed) rows.set(recentKey(parsed), { ...parsed, readOn: null });
		}
		const today = localDay(options.now ?? new Date());
		let undated = rows.size;
		for (let offset = 0; offset < window && undated > 0; offset += RECENT_DAY_BATCH) {
			const daysToProbe = Array.from({ length: Math.min(RECENT_DAY_BATCH, window - offset) }, (_, step) => addDays(today, -(offset + step)));
			const results = await mapBounded(daysToProbe, Math.max(1, this.settings.concurrency), day => search(dayTerms(day)));
			results.forEach((found, step) => {
				for (const raw of found) {
					const parsed = parseRecentItem(raw);
					const row = parsed ? rows.get(recentKey(parsed)) : undefined;
					if (row && row.readOn === null) { row.readOn = daysToProbe[step]; undated--; }
				}
			});
		}
		return orderRecent([...rows.values()]);
	}

	/** Parent items whose citekey is exactly `citekey`, in every library (a citekey is unique only within one library). */
	async findByCitekey(citekey: string, signal?: AbortSignal): Promise<Omit<RecentRead, "readOn">[]> {
		const result = await this.call("item.search", [[["citationKey", "is", citekey]]], this.settings.requestTimeoutMs, signal);
		if (!Array.isArray(result)) throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid Better BibTeX search response");
		return result.map(parseRecentItem).filter((row): row is Omit<RecentRead, "readOn"> => row !== null && row.citekey === citekey);
	}

	/** The item's current citekey in its library (local ID or BBT library name), or null when Zotero no longer has the item. */
	async currentCitekey(itemKey: string, library: number | string, signal?: AbortSignal): Promise<string | null> {
		const result = await this.call("item.search", [[["key", "is", itemKey], ["libraryID", "is", library]]], this.settings.requestTimeoutMs, signal);
		if (!Array.isArray(result)) throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid Better BibTeX search response");
		for (const raw of result) {
			if (!record(raw)) continue;
			try { if (parseItemURI(text(raw.id)).itemKey !== itemKey) continue; } catch { continue; }
			const citekey = text(raw.citekey);
			if (citekey) return citekey;
		}
		return null;
	}

	/**
	 * Fresh metadata, attachments and annotations for one item straight from BBT (`item.export` + `item.attachments`); the
	 * saved index is not touched. The export must reproduce `target`'s identity; a citekey renamed in Zotero since the index
	 * was saved is looked up again by item key. `previous` carries the citekey history forward.
	 */
	async collectEntry(target: FreshTarget, previous?: ZoteroIndexEntry, signal?: AbortSignal): Promise<ZoteroIndexEntry> {
		const library = target.libraryID ?? target.library;
		if (!target.citekey || library === undefined || (typeof library === "number" && !positiveInteger(library)) || library === "") throw new Error("A fresh collection needs a citekey and a library");
		const exportOne = async (citekey: string): Promise<Record<string, unknown> | null> => {
			let serialized: unknown;
			try { serialized = await this.call("item.export", [[citekey], "BetterBibTeX JSON", library], this.settings.requestTimeoutMs, signal); }
			catch (error) {
				// BBT answers an unknown citekey with a JSON-RPC error; anything else is a real fault.
				if (isBbtTransportError(error) && error.reason === "rpc" && /not found/i.test(error.rpcMessage ?? "")) return null;
				throw error;
			}
			if (typeof serialized !== "string") throw new Error("BBT export must return a JSON string");
			const exported: unknown = JSON.parse(serialized);
			if (!record(exported) || !Array.isArray(exported.items) || exported.items.length !== 1 || !record(exported.items[0])) throw new Error("Better BibTeX did not export exactly one item");
			return exported.items[0];
		};
		let raw = await exportOne(target.citekey);
		if (!raw || text(raw.itemKey) !== target.itemKey) {
			const current = await this.currentCitekey(target.itemKey, library, signal);
			if (!current) throw new Error(`Zotero no longer has item ${target.itemKey} in library ${String(library)}.`);
			raw = current === target.citekey && raw ? raw : await exportOne(current);
			if (!raw) throw new Error(`Better BibTeX could not export @${current}.`);
		}
		const entry = normalizeEntryUnhashed(raw, previous);
		if (entry.itemKey !== target.itemKey || (target.libraryID !== undefined && entry.libraryID !== target.libraryID) || entry.libraryType !== target.libraryType || (entry.groupID ?? 0) !== (target.groupID ?? 0)) throw new Error("The fresh Better BibTeX export is a different Zotero item; refresh the index.");
		const attachments = await this.call("item.attachments", [entry.citekey, entry.libraryID], this.settings.attachmentTimeoutMs, signal);
		entry.attachments = normalizeAttachments(attachments, entry);
		entry.attachmentPath = entry.attachments.find(attachment => attachment.path?.toLowerCase().endsWith(".pdf"))?.path ?? "";
		entry.attachmentStatus = "complete";
		if (!sealEntry(entry)) throw new Error("Invalid fresh Zotero item data");
		return entry;
	}

	/**
	 * 0.5 R10: one `item.export` for the pandoc-ready formats (`translator` is a BBT translator label such as
	 * "Better CSL JSON"); the response must be a string. Empty key lists never reach BBT.
	 */
	async export(citekeys: readonly string[], translator: string, libraryID: number): Promise<string> {
		if (!citekeys.length) return "";
		if (!positiveInteger(libraryID)) throw new Error("Bibliography export requires a positive library ID");
		const output = await this.call("item.export", [[...citekeys], translator, libraryID]);
		if (typeof output !== "string") throw new Error("Invalid BBT export response");
		return output;
	}
}
