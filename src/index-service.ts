import type { BbtService } from "./bbt";
import { validateIndex } from "./identity";
import { resolveIndex } from "./agent/resolve";
import type { FailureReason } from "./agent/types";
import type { IndexStorage, Resolution, ZoteroIndex } from "./types";

export interface GetOptions {
	force?: boolean;
	/** Refresh only when the cached index is older than this; `undefined` keeps the settings threshold. */
	ifOlderThanMs?: number;
}

/**
 * `forced`/`stale`: a new index was collected. `fresh`: the cache was young enough.
 * `stale-fallback`: a non-forced request could not collect (BBT unreachable or collection refused) and returned the
 * newest validated snapshot instead; `error` carries the cause. A forced request never falls back.
 */
export type RefreshReason = "forced" | "stale" | "fresh" | "stale-fallback";
/** `failure` classifies a `stale-fallback` cause when it maps to a contract reason (`legacy-plugin-enabled`, `bbt-unreachable`). */
export interface RefreshOutcome { index: ZoteroIndex; refreshed: boolean; reason: RefreshReason; ageMinutesBefore: number | null; error?: string; failure?: FailureReason }

const UNREACHABLE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|timed out|socket hang up|fetch failed|abort/i;

/** Host-injected precondition consulted before every BBT collection; a refusal is structured so callers can map it. */
export type CollectPrecondition = () => { ok: true } | { ok: false; reason: "legacy-plugin-enabled"; message: string };

/** A collection that was refused before contacting BBT; `reason` is a contract failure reason. */
export class IndexRefusalError extends Error {
	constructor(readonly reason: FailureReason, message: string) { super(message); this.name = "IndexRefusalError"; }
}

interface Flight { promise: Promise<RefreshOutcome>; force: boolean; thresholdMs: number }

export class IndexService {
	private cache?: ZoteroIndex;
	private flight?: Flight;
	private loaded = false;
	private fingerprint: string | null = null;

	constructor(private bbt: BbtService, private storage: IndexStorage, private maxAgeMinutes: () => number, private canCollect: CollectPrecondition = () => ({ ok: true })) {}

	get(force = false): Promise<ZoteroIndex> {
		return this.refresh({ force }).then(outcome => outcome.index);
	}

	/**
	 * Loads or refreshes with an explicit outcome. Concurrent callers share a flight only when the in-flight request is at
	 * least as strict: a forced request never joins a non-forced flight and is chained after it instead.
	 */
	refresh(options: GetOptions = {}): Promise<RefreshOutcome> {
		const force = options.force === true;
		const thresholdMs = options.ifOlderThanMs ?? this.maxAgeMinutes() * 60000;
		const existing = this.flight;
		if (existing && (existing.force || (!force && existing.thresholdMs <= thresholdMs))) return existing.promise;
		const base = existing ? existing.promise.then(() => this.load(options), () => this.load(options)) : this.load(options);
		const flight: Flight = { force, thresholdMs, promise: base };
		flight.promise = base.finally(() => { if (this.flight === flight) this.flight = undefined; });
		this.flight = flight;
		return flight.promise;
	}

	/** The persisted index without contacting BBT; re-reads the file when it changed on disk. Null when absent or invalid. */
	async peek(): Promise<ZoteroIndex | null> {
		await this.ensureLoaded();
		return this.cache ?? null;
	}

	ageMinutes(index: ZoteroIndex | null | undefined, now = Date.now()): number | null {
		if (!index) return null;
		const age = now - Date.parse(index.generatedAt);
		return Number.isFinite(age) && age >= 0 ? Math.floor(age / 60000) : null;
	}

	isStale(index: ZoteroIndex | null | undefined, now = Date.now()): boolean | null {
		const age = this.ageMinutes(index, now);
		return age === null ? null : age > this.maxAgeMinutes();
	}

	private async ensureLoaded(): Promise<void> {
		const fingerprint = await this.storage.fingerprint?.();
		if (this.loaded && (fingerprint === undefined || fingerprint === this.fingerprint)) return;
		const persisted = await this.storage.read();
		this.cache = undefined;
		if (persisted !== null) {
			try { const parsed: unknown = JSON.parse(persisted); if (validateIndex(parsed)) this.cache = parsed; } catch { /* Legacy or malformed caches must be rebuilt. */ }
		}
		this.fingerprint = fingerprint ?? null;
		this.loaded = true;
	}

	private async load(options: GetOptions): Promise<RefreshOutcome> {
		await this.ensureLoaded();
		const ageBefore = this.ageMinutes(this.cache);
		const threshold = options.ifOlderThanMs ?? this.maxAgeMinutes() * 60000;
		const ageMs = this.cache ? Date.now() - Date.parse(this.cache.generatedAt) : Infinity;
		if (!options.force && this.cache && ageMs >= 0 && ageMs < threshold) return { index: this.cache, refreshed: false, reason: "fresh", ageMinutesBefore: ageBefore };
		const fallback = !options.force && this.cache ? this.cache : null;
		const gate = this.canCollect();
		if (!gate.ok) {
			if (fallback) return { index: fallback, refreshed: false, reason: "stale-fallback", ageMinutesBefore: ageBefore, error: gate.message, failure: gate.reason };
			throw new IndexRefusalError(gate.reason, gate.message);
		}
		let candidate: ZoteroIndex;
		try { candidate = await this.bbt.collect(this.cache); }
		catch (error) {
			if (!fallback) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return { index: fallback, refreshed: false, reason: "stale-fallback", ageMinutesBefore: ageBefore, error: message, ...(UNREACHABLE.test(message) ? { failure: "bbt-unreachable" as const } : {}) };
		}
		if (!validateIndex(candidate)) throw new Error("Refusing to save invalid Zotero index");
		await this.storage.writeValidated(JSON.stringify(candidate, null, 2));
		this.fingerprint = (await this.storage.fingerprint?.()) ?? null;
		this.cache = candidate;
		return { index: candidate, refreshed: true, reason: options.force ? "forced" : "stale", ageMinutesBefore: ageBefore };
	}

	/** Resolves against a loaded index; when no index can be loaded or collected, the newest persisted snapshot is used. */
	async resolve(query: string, options?: { libraryID?: number; itemKey?: string }): Promise<Resolution> {
		let index: ZoteroIndex | null;
		let failure = "Zotero index unavailable";
		try { index = await this.get(); }
		catch (error) {
			failure = error instanceof Error ? error.message : failure;
			index = await this.peek();
		}
		if (!index) return { status: "unavailable", message: failure };
		return resolveInIndex(index, query, options);
	}
}

/** v1 resolution over a loaded index: entry.id, citekey, citekey history, or item key, optionally scoped by library and item key. */
export function resolveInIndex(index: ZoteroIndex, query: string, options?: { libraryID?: number; itemKey?: string }): Resolution {
	const normalized = query.trim().replace(/^@/, "");
	const outcome = resolveIndex(index, options?.itemKey ? { itemKey: options.itemKey, libraryID: options.libraryID } : { citekey: normalized, libraryID: options?.libraryID });
	if (outcome.status === "resolved" && outcome.entry) return { status: "resolved", entry: outcome.entry, matchedHistory: outcome.matchedHistory };
	if (outcome.status === "ambiguous") return { status: "ambiguous", candidates: outcome.candidates };
	if (outcome.status === "unavailable") return { status: "unavailable", message: outcome.message ?? "Zotero index unavailable" };
	return { status: "not-found" };
}

/** Human-readable index age for UI labels: "under a minute", "12 min", "27 h", "3 d". */
export function formatIndexAge(minutes: number | null): string {
	if (minutes === null) return "unknown age";
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${minutes} min`;
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
	return `${Math.round(minutes / 1440)} d`;
}

/** Maps a refresh failure to one human sentence; `ageMinutes` is the age of the snapshot that reads keep using, or null when none exists. */
export function describeRefreshFailure(error: unknown, endpoint: string, ageMinutes: number | null): string {
	const message = error instanceof Error ? error.message : String(error);
	const cause = UNREACHABLE.test(message) ? `Zotero/Better BibTeX is not reachable at ${endpoint}`
		: error instanceof IndexRefusalError ? message
		: `The index could not be refreshed (${message})`;
	const consequence = ageMinutes === null ? "no saved index is available yet. Start Zotero and refresh the index." : `using the saved index from ${formatIndexAge(ageMinutes)} ago.`;
	return `${cause.replace(/\.$/, "")}; ${consequence}`;
}
