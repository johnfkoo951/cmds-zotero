import type { BbtService } from "./bbt";
import { validateIndex } from "./identity";
import { resolveIndex } from "./agent/resolve";
import type { IndexStorage, Resolution, ZoteroIndex } from "./types";

export interface GetOptions {
	force?: boolean;
	/** Refresh only when the cached index is older than this; `undefined` keeps the settings threshold. */
	ifOlderThanMs?: number;
}

export interface RefreshOutcome { index: ZoteroIndex; refreshed: boolean; reason: "forced" | "stale" | "fresh"; ageMinutesBefore: number | null }

export class IndexService {
	private cache?: ZoteroIndex;
	private flight?: Promise<RefreshOutcome>;
	private loaded = false;
	private fingerprint: string | null = null;

	constructor(private bbt: BbtService, private storage: IndexStorage, private maxAgeMinutes: () => number) {}

	get(force = false): Promise<ZoteroIndex> {
		return this.refresh({ force }).then(outcome => outcome.index);
	}

	/** Loads or refreshes with an explicit outcome; concurrent callers share one flight. */
	refresh(options: GetOptions = {}): Promise<RefreshOutcome> {
		if (this.flight) return this.flight;
		this.flight = this.load(options).finally(() => { this.flight = undefined; });
		return this.flight;
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
		const candidate = await this.bbt.collect(this.cache);
		if (!validateIndex(candidate)) throw new Error("Refusing to save invalid Zotero index");
		await this.storage.writeValidated(JSON.stringify(candidate, null, 2));
		this.fingerprint = (await this.storage.fingerprint?.()) ?? null;
		this.cache = candidate;
		return { index: candidate, refreshed: true, reason: options.force ? "forced" : "stale", ageMinutesBefore: ageBefore };
	}

	async resolve(query: string, options?: { libraryID?: number; itemKey?: string }): Promise<Resolution> {
		let index: ZoteroIndex;
		try { index = await this.get(); } catch (error) { return { status: "unavailable", message: error instanceof Error ? error.message : "Zotero index unavailable" }; }
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
