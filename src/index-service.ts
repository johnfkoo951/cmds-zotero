import type { BbtService } from "./bbt";
import { validateIndex } from "./identity";
import { ITEM_KEY } from "./uris";
import type { IndexStorage, Resolution, ZoteroIndex } from "./types";

export class IndexService {
	private cache?: ZoteroIndex;
	private flight?: Promise<ZoteroIndex>;
	private loaded = false;

	constructor(private bbt: BbtService, private storage: IndexStorage, private maxAgeMinutes: () => number) {}

	get(force = false): Promise<ZoteroIndex> {
		if (this.flight) return this.flight;
		this.flight = this.load(force).finally(() => { this.flight = undefined; });
		return this.flight;
	}

	private async load(force: boolean): Promise<ZoteroIndex> {
		if (!this.loaded) {
			const persisted = await this.storage.read();
			if (persisted !== null) {
				try { const parsed: unknown = JSON.parse(persisted); if (validateIndex(parsed)) this.cache = parsed; } catch { /* Legacy or malformed caches must be rebuilt. */ }
			}
			this.loaded = true;
		}
		const age = this.cache ? Date.now() - Date.parse(this.cache.generatedAt) : Infinity;
		if (!force && this.cache && age >= 0 && age < this.maxAgeMinutes() * 60000) return this.cache;
		const candidate = await this.bbt.collect(this.cache);
		if (!validateIndex(candidate)) throw new Error("Refusing to save invalid Zotero index");
		await this.storage.writeValidated(JSON.stringify(candidate, null, 2));
		this.cache = candidate;
		return candidate;
	}

	async resolve(query: string, options?: { libraryID?: number; itemKey?: string }): Promise<Resolution> {
		let index: ZoteroIndex;
		try { index = await this.get(); } catch (error) { return { status: "unavailable", message: error instanceof Error ? error.message : "Zotero index unavailable" }; }
		const normalized = query.trim().replace(/^@/, "");
		const scoped = index.entries.filter(entry => (options?.libraryID === undefined || entry.libraryID === options.libraryID) && (options?.itemKey === undefined || entry.itemKey === options.itemKey));
		const matches = scoped.filter(entry => options?.itemKey !== undefined || entry.id === normalized || entry.citekey === normalized || entry.citekeyHistory.includes(normalized) || (ITEM_KEY.test(normalized) && entry.itemKey === normalized));
		if (!matches.length) return { status: "not-found" };
		if (matches.length > 1) return { status: "ambiguous", candidates: matches };
		const entry = matches[0];
		return { status: "resolved", entry, matchedHistory: entry.citekey !== normalized && entry.citekeyHistory.includes(normalized) };
	}
}
