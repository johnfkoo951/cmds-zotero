/**
 * Retracted sources from Zotero's own retraction data (0.6 retraction-flags-from-zotero): Zotero flags items that the
 * Retraction Watch database lists, and Better BibTeX's `item.search` accepts the `retracted` condition. The index keeps
 * the flagged entry ids; diagnostics name them. No third-party service is contacted. Pure module.
 */
import { parseItemURI, text } from "../api/normalize";
import { record } from "../identity";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";

/**
 * Search terms for retracted parent items in every library. Zotero 10 maps the result to parent items with `resultLevel`
 * (live-verified); older versions lack that condition, and the retraction table holds regular items only, so the bare
 * condition is used there. Feeds stay out.
 */
export function retractedTerms(zoteroMajor: number | null): unknown[] {
	return [["retracted", "true"], ...(zoteroMajor !== null && zoteroMajor >= 10 ? [["resultLevel", "item"]] : []), ["ignore_feeds"]];
}

/**
 * Index ids of the search rows: a row maps to the entry with the same item key in the same library scope (the user
 * library, or the group named in the item URI), which needs no local library ID. Rows that are not parents in the index
 * (annotation or note rows, items the refresh skipped) are ignored. Sorted, each id once.
 */
export function retractedIdsFromRows(rows: readonly unknown[], entries: readonly ZoteroIndexEntry[]): string[] {
	const byScope = new Map<string, string>();
	for (const entry of entries) byScope.set(`${entry.libraryType}:${entry.groupID ?? 0}:${entry.itemKey}`, entry.id);
	const ids = new Set<string>();
	for (const row of rows) {
		if (!record(row)) continue;
		let scope: ReturnType<typeof parseItemURI>;
		try { scope = parseItemURI(text(row.id)); } catch { continue; }
		const id = byScope.get(`${scope.libraryType}:${scope.groupID ?? 0}:${scope.itemKey}`);
		if (id) ids.add(id);
	}
	return [...ids].sort();
}

const NONE: ReadonlySet<string> = new Set<string>();
/** One set per published `retracted` array (index generations never mutate it), so per-row checks stay O(1). */
const sets = new WeakMap<readonly unknown[], ReadonlySet<string>>();

/** The retracted entry ids of an index (empty for an older index or when the flag could not be read). */
export function retractedIds(index: Pick<ZoteroIndex, "retracted"> | null | undefined): ReadonlySet<string> {
	const raw: unknown = index?.retracted;
	if (!Array.isArray(raw)) return NONE;
	let set = sets.get(raw);
	if (!set) { set = new Set(raw.filter((id: unknown): id is string => typeof id === "string")); sets.set(raw, set); }
	return set;
}

/** True when Zotero marks the entry as retracted in this index. */
export function isRetracted(index: Pick<ZoteroIndex, "retracted"> | null | undefined, entryId: string): boolean {
	return retractedIds(index).has(entryId);
}
