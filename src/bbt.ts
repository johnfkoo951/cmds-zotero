import type { Capabilities, CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { BbtTransportError, httpRequest, isBbtTransportError, isUnknownConditionFault, mapBounded, rpc, rpcBatch, zoteroMajor, ZoteroVersionError, type BbtTransportReason } from "./api/transport";
import { normalizeAttachments, normalizeEntryUnhashed, parseItemURI, primaryPdfPath, text } from "./api/normalize";
import { collectIndex } from "./index/collector";
import { record, sealEntry, verifyEntry, verifyIndex } from "./identity";
import { positiveInteger } from "./uris";
import { addDays, clampRecentDays, dayTerms, localDay, orderRecent, parseRecentItem, recentKey, windowTerms, type RecentRead } from "./recent/recent-reads";
import { afterTerms, dateByBisection } from "./recent/read-dating";
import { parseSelection, type SelectedItem } from "./library/selection";

/** Calendar days probed concurrently when an item's reading day must be found by exact-day probes. */
const RECENT_DAY_BATCH = 7;
/** Search conditions only Zotero 10 knows; refusing them is how an older Zotero answers a reading-history search. */
const ZOTERO_10_CONDITIONS: readonly string[] = ["resultLevel", "lastRead"];

/**
 * Identity a fresh single-item collection must reproduce; the cached citekey is only the lookup handle. `libraryID` is the
 * local library ID when the saved index knows the item; an item added since then is addressed by its BBT library name.
 */
export interface FreshTarget { citekey: string; itemKey: string; libraryType: "user" | "group"; groupID?: number; libraryID?: number; library?: string }

// 0.5 R4: the last real BBT observation (no polling); `aborted` requests are the plugin's own cancellation and are not recorded.
export interface BbtOutcome { ok: boolean; at: Date; reason?: BbtTransportReason; status?: number; message?: string }

/** 0.6.2: the `locale` (empty: the style's default) and output form of an `item.bibliography` call. */
export interface BibliographyCallOptions { locale?: string; contentType?: "text" | "html" }

/** The `format` argument of Better BibTeX's `item.bibliography`: style id, content type and, when set, the locale. */
export function bibliographyFormat(style: string, options: BibliographyCallOptions = {}): { id: string; contentType: "text" | "html"; locale?: string } {
	return { id: style, contentType: options.contentType ?? "text", ...(options.locale ? { locale: options.locale } : {}) };
}

/** What Zotero's citation picker answered (0.6 OPT-14): the formatted citation, or nothing when it was closed without a pick. */
export type PickerAnswer = { kind: "picked"; text: string } | { kind: "empty" };

/** The picker did not produce a citation for a reason that is not a Better BibTeX failure: Zotero still starting, or the wait ran out. */
export class PickerWaitError extends Error {
	readonly name = "PickerWaitError";
}

/** The readiness probe's answer (`GET /cayw?probe=true`): BBT says "ready" or "starting"; anything else is a fault. */
export function pickerReadiness(status: number, body: string, endpoint: string): "ready" | "starting" {
	if (status !== 200) throw new BbtTransportError(status === 404 ? "http-404" : "http-other", endpoint, `BBT picker HTTP ${status}`, { status });
	const answer = body.trim();
	if (answer === "ready" || answer === "starting") return answer;
	throw new BbtTransportError("invalid-response", endpoint, "Unexpected citation picker readiness answer");
}

/** The pick's answer: HTTP 200 with the formatted citation, or an empty body when the picker was closed without a pick. */
export function pickerAnswer(status: number, body: string, endpoint: string): PickerAnswer {
	if (status !== 200) throw new BbtTransportError(status === 404 ? "http-404" : "http-other", endpoint, `BBT picker HTTP ${status}`, { status });
	const text = body.trim();
	return text ? { kind: "picked", text } : { kind: "empty" };
}

/** "10 minutes", "1 minute", "45 seconds": the picker wait in words. */
export function formatWait(seconds: number): string {
	if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
	return `${seconds} seconds`;
}

export class BbtService {
	private controller = new AbortController();
	private outcome: BbtOutcome | null = null;
	private readonly outcomeListeners = new Set<(outcome: BbtOutcome) => void>();
	constructor(private settings: CmdsZoteroSettings) {}
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
	private async observed<T>(run: () => Promise<T>, counts: (error: BbtTransportError) => boolean = () => true): Promise<T> {
		const started = new Date();
		try {
			const result = await run();
			if (!(this.outcome && !this.outcome.ok && started.getTime() < this.outcome.at.getTime())) this.recordOutcome({ ok: true, at: new Date() });
			return result;
		} catch (error) {
			// `counts` leaves out faults that say nothing about Zotero (0.6 OPT-14: a citation pick that ran out of time).
			if (isBbtTransportError(error) && error.reason !== "aborted" && counts(error)) this.recordOutcome({ ok: false, at: new Date(), reason: error.reason, ...(error.status !== undefined ? { status: error.status } : {}), message: error.message });
			throw error;
		}
	}

	private call<T = unknown>(
		method: string,
		params: unknown[] = [],
		timeout = this.settings.requestTimeoutMs,
		signal?: AbortSignal,
		options?: { validate?: (result: unknown) => T; counts?: (error: BbtTransportError) => boolean },
	): Promise<T> {
		return this.withSignal(signal, joined => this.observed(async () => {
			const result = await rpc(this.settings.bbtEndpoint, method, params, timeout, joined);
			return options?.validate ? options.validate(result) : result as T;
		}, options?.counts));
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

	/**
	 * Zotero's citation picker (CAYW), 0.6 OPT-14. A readiness probe (`?probe=true`, the short request timeout) comes first,
	 * so a closed Zotero fails fast and a starting one says so without opening anything. The pick then waits up to
	 * `pickerWaitSeconds` for the person choosing, apart from the request timeout. Running out of that wait is a
	 * `PickerWaitError` and `signal` (Cancel) an `aborted` fault: neither is recorded as a Better BibTeX failure, and an
	 * answer that arrives after either is discarded with the closed request.
	 */
	async pickCitation(signal?: AbortSignal): Promise<PickerAnswer> {
		const endpoint = `${this.settings.bbtEndpoint.replace(/\/$/, "")}/cayw`;
		const settings = this.settings;
		return this.withSignal(signal, async joined => {
			const readiness = await this.observed(async () => {
				const response = await httpRequest(`${endpoint}?probe=true`, settings.requestTimeoutMs, undefined, joined);
				return pickerReadiness(response.status, response.text, endpoint);
			});
			if (readiness === "starting") throw new PickerWaitError("Zotero is still starting. Try again in a moment.");
			const params = new URLSearchParams({ format: settings.caywFormat, brackets: "true" });
			try {
				return await this.observed(async () => {
					const response = await httpRequest(`${endpoint}?${params.toString()}`, settings.pickerWaitSeconds * 1000, undefined, joined);
					return pickerAnswer(response.status, response.text, endpoint);
				}, error => error.reason !== "timeout");
			} catch (error) {
				if (isBbtTransportError(error) && error.reason === "timeout") throw new PickerWaitError(`No citation was picked within ${formatWait(settings.pickerWaitSeconds)}. Run the command again to pick.`);
				throw error;
			}
		});
	}

	/**
	 * A new index from Better BibTeX (0.6: per-library searches, skipped items instead of aborts, collections, retraction
	 * flags, batched attachment reads; see `collectIndex`). The previous index is the host's validated snapshot: its sealed
	 * entries are not hashed again, and skipped items keep their previous entries.
	 */
	async collect(previous?: ZoteroIndex): Promise<ZoteroIndex> {
		const settings = { ...this.settings };
		const signal = this.controller.signal;
		const capabilities = await this.readCapabilities(settings, signal);
		const validPrevious = previous && verifyIndex(previous) ? new Map(previous.entries.map(entry => [entry.id, entry])) : new Map<string, ZoteroIndexEntry>();
		const optionalProbe = (method: string, params: readonly unknown[]): boolean =>
			method === "user.groups" || (method === "item.search" && Array.isArray(params[0]) && (params[0] as unknown[]).some(term => Array.isArray(term) && term[0] === "retracted"));
		return collectIndex({
			call: (method, params, timeout = settings.requestTimeoutMs) => this.observed(
				() => rpc(settings.bbtEndpoint, method, params, timeout, signal),
				optionalProbe(method, params) ? error => error.reason !== "rpc" : undefined,
			),
			batch: (calls, timeout) => this.observed(() => rpcBatch(settings.bbtEndpoint, calls, timeout, signal)),
			signal,
		}, settings, capabilities, validPrevious);
	}

	/** CSL bibliography text for one entry; `style` defaults to the configured style (0.5 R4: every style is observed and typed). */
	async bibliography(entry: ZoteroIndexEntry, style = this.settings.bibliographyStyle, signal?: AbortSignal, options: BibliographyCallOptions = {}): Promise<string> {
		if (!verifyEntry(entry)) throw new Error("Bibliography requires a validated item");
		// 0.5 R12: a caller's signal (per-render abort) joins the service signal; the call stays observed.
		return this.call("item.bibliography", [[entry.citekey], bibliographyFormat(style, options), entry.libraryID], this.settings.requestTimeoutMs, signal, {
			validate: output => {
				if (typeof output !== "string") throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid BBT bibliography response");
				return output;
			},
		});
	}

	/**
	 * 0.6.2 bibliography-style-order: one bibliography for several citekeys of one library, rendered as a whole so the
	 * style orders (and disambiguates) the entries. Empty key lists never reach BBT.
	 */
	async bibliographyList(citekeys: readonly string[], libraryID: number, style = this.settings.bibliographyStyle, options: BibliographyCallOptions = {}): Promise<string> {
		if (!citekeys.length) return "";
		if (!positiveInteger(libraryID)) throw new Error("Bibliography requires a positive library ID");
		return this.call("item.bibliography", [[...citekeys], bibliographyFormat(style, options), libraryID], this.settings.requestTimeoutMs, undefined, {
			validate: output => {
				if (typeof output !== "string") throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid BBT bibliography response");
				return output;
			},
		});
	}

	/**
	 * Items whose attachment Zotero opened within the last `days` calendar days, newest first (Zotero 10
	 * `attachmentLastRead`). One window search, then the day of each item's latest read by bisection over the window
	 * (0.6 OPT-19: date-form `lastRead isAfter` searches, about log2(days) per distinct reading day instead of one per day),
	 * each proposed day confirmed by one exact-day search.
	 * Read-only. Rows without a citekey (standalone PDFs) are left out. A Zotero that refuses the Zotero 10 search
	 * conditions raises `ZoteroVersionError`, never a Better BibTeX outage.
	 */
	async recentlyRead(days: number, options: { signal?: AbortSignal; now?: Date } = {}): Promise<RecentRead[]> {
		const window = clampRecentDays(days);
		const search = async (terms: unknown[]): Promise<unknown[]> => {
			try {
				return await this.call("item.search", [terms], this.settings.requestTimeoutMs, options.signal, {
					validate: result => {
						if (!Array.isArray(result)) throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid Better BibTeX search response");
						return result as unknown[];
					},
					counts: error => !isUnknownConditionFault(error, ZOTERO_10_CONDITIONS),
				});
			} catch (error) { throw await this.zotero10Gate(error, options.signal); }
		};
		const rows = new Map<string, RecentRead>();
		for (const raw of await search(windowTerms(window))) {
			const parsed = parseRecentItem(raw);
			if (parsed) rows.set(recentKey(parsed), { ...parsed, readOn: null });
		}
		if (!rows.size) return [];
		const today = localDay(options.now ?? new Date());
		const concurrency = Math.max(1, this.settings.concurrency);
		const keysOf = (found: unknown[]): Set<string> => {
			const keys = new Set<string>();
			for (const raw of found) { const parsed = parseRecentItem(raw); if (parsed) keys.add(recentKey(parsed)); }
			return keys;
		};
		// Bisection proposes each item's day; one exact-day search per proposed day (the `is` form verified live in 0.5)
		// confirms it. An item its proposed day does not confirm is dated by exact-day probes backwards from today, as before
		// 0.6, so a Zotero that compares `isAfter` differently costs searches but never mis-dates a read.
		const proposed = await dateByBisection([...rows.keys()], addDays(today, -(window - 1)), today, async day => keysOf(await search(afterTerms(day))), concurrency);
		const byDay = new Map<string, string[]>();
		for (const [key, day] of proposed) byDay.set(day, [...(byDay.get(day) ?? []), key]);
		const proposedDays = [...byDay.keys()];
		const confirmed = await mapBounded(proposedDays, concurrency, async day => keysOf(await search(dayTerms(day))));
		const confirmedByDay = new Map<string, Set<string>>();
		const undated = new Set(rows.keys());
		proposedDays.forEach((day, index) => {
			confirmedByDay.set(day, confirmed[index]);
			for (const key of byDay.get(day) ?? []) {
				const row = rows.get(key);
				if (row && confirmed[index].has(key)) { row.readOn = day; undated.delete(key); }
			}
		});
		for (let offset = 0; offset <= window && undated.size > 0; offset += RECENT_DAY_BATCH) {
			const daysToProbe = Array.from({ length: Math.min(RECENT_DAY_BATCH, window + 1 - offset) }, (_, step) => addDays(today, -(offset + step)));
			const results = await mapBounded(daysToProbe, concurrency, async day => confirmedByDay.get(day) ?? keysOf(await search(dayTerms(day))));
			results.forEach((found, step) => {
				for (const key of found) {
					const row = rows.get(key);
					if (row && undated.has(key)) { row.readOn = daysToProbe[step]; undated.delete(key); }
				}
			});
		}
		return orderRecent([...rows.values()]);
	}

	/**
	 * 0.6 recent-reads-efficiency: a refused Zotero 10 search condition (`Invalid condition 'resultLevel'`, JSON-RPC
	 * -32603) becomes a `ZoteroVersionError` naming the version `api.ready` reports, unless that version is 10 or later
	 * (then the original fault stands). Any other error is returned unchanged.
	 */
	private async zotero10Gate(error: unknown, signal?: AbortSignal): Promise<unknown> {
		if (!isUnknownConditionFault(error, ZOTERO_10_CONDITIONS)) return error;
		let found: string | null = null;
		try { found = (await this.capabilities({ signal })).zotero; } catch { /* the refused condition alone tells */ }
		const major = zoteroMajor(found);
		return major !== null && major >= 10 ? error : new ZoteroVersionError("Zotero's reading history", 10, found, error);
	}

	/**
	 * The items selected in Zotero's library pane right now (0.6.1), read once through Better BibTeX's export of the
	 * selection with the request timeout. An empty selection is []. Read-only; there is no listener.
	 */
	async selectedItems(signal?: AbortSignal, options: { timeoutMs?: number; quiet?: boolean } = {}): Promise<SelectedItem[]> {
		const endpoint = `${this.settings.bbtEndpoint.replace(/\/$/, "")}/export/selected?jzon`;
		const timeout = options.timeoutMs ?? this.settings.requestTimeoutMs;
		const read = async (joined: AbortSignal): Promise<SelectedItem[]> => {
			const response = await httpRequest(endpoint, timeout, undefined, joined);
			return parseSelection(response.status, response.text, endpoint);
		};
		// 0.6.1 follow-zotero-selection: a background poll is `quiet`, so its outcome never reaches the connection status.
		return this.withSignal(signal, joined => options.quiet ? read(joined) : this.observed(() => read(joined)));
	}

	/** Parent items whose citekey is exactly `citekey`, in every library (a citekey is unique only within one library). */
	async findByCitekey(citekey: string, signal?: AbortSignal): Promise<Omit<RecentRead, "readOn">[]> {
		const result = await this.call("item.search", [[["citationKey", "is", citekey]]], this.settings.requestTimeoutMs, signal, {
			validate: rows => {
				if (!Array.isArray(rows)) throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid Better BibTeX search response");
				return rows as unknown[];
			},
		});
		return result.map(parseRecentItem).filter((row): row is Omit<RecentRead, "readOn"> => row !== null && row.citekey === citekey);
	}

	/** The item's current citekey in its library (local ID or BBT library name), or null when Zotero no longer has the item. */
	async currentCitekey(itemKey: string, library: number | string, signal?: AbortSignal): Promise<string | null> {
		const result = await this.call("item.search", [[["key", "is", itemKey], ["libraryID", "is", library]]], this.settings.requestTimeoutMs, signal, {
			validate: rows => {
				if (!Array.isArray(rows)) throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid Better BibTeX search response");
				return rows as unknown[];
			},
		});
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
		const exportOne = async (citekey: string, counts?: (error: BbtTransportError) => boolean): Promise<Record<string, unknown> | null> => {
			try {
				return await this.call("item.export", [[citekey], "BetterBibTeX JSON", library], this.settings.requestTimeoutMs, signal, {
					validate: serialized => {
						if (typeof serialized !== "string") throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "BBT export must return a JSON string");
						let exported: unknown;
						try { exported = JSON.parse(serialized); }
						catch { throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid BetterBibTeX JSON export"); }
						if (!record(exported) || !Array.isArray(exported.items) || exported.items.length !== 1 || !record(exported.items[0])) {
							throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Better BibTeX did not export exactly one item");
						}
						return exported.items[0];
					},
					counts,
				});
			} catch (error) {
				// BBT answers an unknown citekey with a JSON-RPC error; anything else is a real fault.
				if (isBbtTransportError(error) && error.reason === "rpc" && /not found/i.test(error.rpcMessage ?? "")) return null;
				throw error;
			}
		};
		let raw = await exportOne(target.citekey, error => !(error.reason === "rpc" && /not found/i.test(error.rpcMessage ?? "")));
		if (!raw || text(raw.itemKey) !== target.itemKey) {
			const current = await this.currentCitekey(target.itemKey, library, signal);
			if (!current) throw new Error(`Zotero no longer has item ${target.itemKey} in library ${String(library)}.`);
			raw = current === target.citekey && raw ? raw : await exportOne(current);
			if (!raw) throw new Error(`Better BibTeX could not export @${current}.`);
		}
		const entry = normalizeEntryUnhashed(raw, previous);
		if (entry.itemKey !== target.itemKey || (target.libraryID !== undefined && entry.libraryID !== target.libraryID) || entry.libraryType !== target.libraryType || (entry.groupID ?? 0) !== (target.groupID ?? 0)) throw new Error("The fresh Better BibTeX export is a different Zotero item; refresh the index.");
		const attachments = await this.call("item.attachments", [entry.citekey, entry.libraryID], this.settings.attachmentTimeoutMs, signal, {
			validate: result => {
				if (!Array.isArray(result)) throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Expected BBT attachment array");
				return result as unknown[];
			},
		});
		entry.attachments = normalizeAttachments(attachments, entry);
		entry.attachmentPath = primaryPdfPath(entry.attachments);
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
		return this.call("item.export", [[...citekeys], translator, libraryID], this.settings.requestTimeoutMs, undefined, {
			validate: output => {
				if (typeof output !== "string") throw new BbtTransportError("invalid-response", this.settings.bbtEndpoint, "Invalid BBT export response");
				return output;
			},
		});
	}
}
