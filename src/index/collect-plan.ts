/**
 * Pure planning for an index refresh (0.6 index-refresh-resilience): the libraries `user.groups` lists, the search terms
 * the collector sends, and the rule that turns one library's search rows into exportable items plus skipped items with a
 * reason, instead of aborting the whole refresh on the first bad row. No I/O and no `obsidian` import.
 */
import { parseItemURI, text } from "../api/normalize";
import { record } from "../identity";
import { parseCollections, type CollectionNode } from "../library/collections";
import { positiveInteger } from "../uris";

/** One library from `user.groups(true)`: local library ID, name, and its collections (null when none were listed). */
export interface LibraryInfo { libraryID: number; name: string; collections: CollectionNode[] | null }

/**
 * `user.groups(true)` → libraries (`[{id, name, collections}]`; feeds are listed too and told apart later). A row without
 * a positive id is skipped and a repeated id keeps its first row; a reply that is not an array is an error.
 */
export function parseGroups(raw: unknown): LibraryInfo[] {
	if (!Array.isArray(raw)) throw new Error("Invalid Better BibTeX library list");
	const seen = new Set<number>();
	const libraries: LibraryInfo[] = [];
	for (const row of raw) {
		if (!record(row) || !positiveInteger(row.id) || seen.has(row.id)) continue;
		seen.add(row.id);
		libraries.push({ libraryID: row.id, name: text(row.name), collections: Array.isArray(row.collections) ? parseCollections(row.id, row.collections) : null });
	}
	return libraries;
}

/** Parent items only: attachments, notes and annotations are children (an annotation row also makes BBT fail). */
const PARENT_FILTER: readonly unknown[][] = [["itemType", "isNot", "attachment"], ["itemType", "isNot", "annotation"], ["itemType", "isNot", "note"]];

/**
 * Parent items of one library. The libraryID condition keeps libraries that share a name apart and is required for
 * collection searches; `ignore_feeds` (a Better BibTeX term) keeps feed items out. `feeds: true` drops it, which is how a
 * library with no rows is told apart as a feed.
 */
export function parentTerms(libraryID: number, options: { feeds?: boolean } = {}): unknown[] {
	return [["libraryID", "is", libraryID], ...PARENT_FILTER.map(term => [...term]), ...(options.feeds ? [] : [["ignore_feeds"]])];
}

/** The 0.5 single search across every library, used only when `user.groups` is unavailable; feeds stay out. */
export function legacyParentTerms(): unknown[] { return [...PARENT_FILTER.map(term => [...term]), ["ignore_feeds"]]; }

/** Parent items filed directly in one collection (Zotero returns nothing for a collection search without libraryID). */
export function collectionTerms(libraryID: number, collectionKey: string): unknown[] {
	return [["libraryID", "is", libraryID], ["collection", "is", collectionKey], ...PARENT_FILTER.map(term => [...term]), ["ignore_feeds"]];
}

export interface Scope { libraryType: "user" | "group"; groupID?: number }
export interface SearchedItem extends Scope { citekey: string; itemKey: string }

/**
 * Why a searched item was left out of a refresh: `duplicate-citekey` (Better BibTeX gives its key to another item of the
 * same library), `missing-citekey`, `invalid-uri`, `library-scope` (a row from another library), `library-name` (the 0.5
 * name-based fallback cannot tell same-named libraries apart), `export-failed`, `export-mismatch` (the export answered
 * with another identity), `invalid-item` (metadata the index cannot hold).
 */
export type SkipReason = "duplicate-citekey" | "missing-citekey" | "invalid-uri" | "library-scope" | "library-name" | "export-failed" | "export-mismatch" | "invalid-item";
export interface SkippedItem { reason: SkipReason; library: string; libraryID?: number; itemKey?: string; citekey?: string; detail?: string }

export interface LibraryRows {
	/** Items to export, in row order, one per item key. */
	accepted: SearchedItem[];
	skipped: SkippedItem[];
	/** The library's item URI scope (the scope most rows share; the user scope for library 1), or null without parsable rows. */
	scope: Scope | null;
	/** Search rows seen. */
	rows: number;
}

function scopeKey(scope: Scope): string { return scope.libraryType === "group" ? `group:${scope.groupID ?? 0}` : "user"; }

/**
 * One library's parent-search rows as items to export. Nothing here throws: a row that cannot be exported unambiguously
 * is skipped with a reason, and every item that shares a citekey with another item of the same library is skipped (an
 * export by that key would be ambiguous). A row repeated with the same item key is counted once.
 */
export function planLibraryRows(library: { libraryID?: number; name: string }, rows: readonly unknown[]): LibraryRows {
	const skipped: SkippedItem[] = [];
	const at = { library: library.name, ...(library.libraryID !== undefined ? { libraryID: library.libraryID } : {}) };
	const parsed: SearchedItem[] = [];
	const itemKeys = new Set<string>();
	for (const row of rows) {
		if (!record(row)) { skipped.push({ reason: "invalid-item", ...at, detail: "malformed search row" }); continue; }
		const citekey = text(row.citekey) || text(row.citationKey) || text(row["citation-key"]);
		let scope: ReturnType<typeof parseItemURI>;
		try { scope = parseItemURI(text(row.id)); }
		catch { skipped.push({ reason: "invalid-uri", ...at, ...(citekey ? { citekey } : {}), detail: "no verifiable Zotero item URI" }); continue; }
		if (itemKeys.has(scope.itemKey)) continue;
		itemKeys.add(scope.itemKey);
		parsed.push({ ...scope, citekey });
	}
	let scope: Scope | null = null;
	if (library.libraryID === 1) scope = { libraryType: "user" };
	else if (parsed.length) {
		const counts = new Map<string, { scope: Scope; count: number }>();
		for (const item of parsed) {
			const key = scopeKey(item);
			const slot = counts.get(key) ?? { scope: { libraryType: item.libraryType, ...(item.groupID !== undefined ? { groupID: item.groupID } : {}) }, count: 0 };
			slot.count++;
			counts.set(key, slot);
		}
		scope = [...counts.values()].reduce((best, slot) => slot.count > best.count ? slot : best).scope;
	}
	const inScope = parsed.filter(item => {
		if (scope && scopeKey(item) === scopeKey(scope)) return true;
		skipped.push({ reason: "library-scope", ...at, itemKey: item.itemKey, ...(item.citekey ? { citekey: item.citekey } : {}), detail: "the row belongs to another library" });
		return false;
	});
	const byCitekey = new Map<string, SearchedItem[]>();
	for (const item of inScope) {
		if (!item.citekey.trim()) { skipped.push({ reason: "missing-citekey", ...at, itemKey: item.itemKey }); continue; }
		byCitekey.set(item.citekey, [...(byCitekey.get(item.citekey) ?? []), item]);
	}
	const accepted: SearchedItem[] = [];
	for (const item of inScope) {
		const group = byCitekey.get(item.citekey);
		if (!group) continue;
		if (group.length === 1) accepted.push(item);
		else skipped.push({ reason: "duplicate-citekey", ...at, itemKey: item.itemKey, citekey: item.citekey, detail: `${group.length} items` });
	}
	return { accepted, skipped, scope, rows: rows.length };
}

/**
 * The 0.5 fallback when `user.groups` is unavailable: one search across libraries, grouped by the library name each row
 * carries. Rows without a name, and every row of a name that maps to more than one URI scope (two libraries with one
 * name cannot be exported by name), are skipped instead of aborting the refresh.
 */
export function groupRowsByLibraryName(rows: readonly unknown[]): { libraries: Map<string, unknown[]>; skipped: SkippedItem[] } {
	const libraries = new Map<string, unknown[]>();
	const skipped: SkippedItem[] = [];
	const scopes = new Map<string, Set<string>>();
	for (const row of rows) {
		const name = record(row) ? text(row.library) : "";
		if (!name) {
			const citekey = record(row) ? text(row.citekey) : "";
			skipped.push({ reason: "library-name", library: "", ...(citekey ? { citekey } : {}), detail: "the search row names no library" });
			continue;
		}
		libraries.set(name, [...(libraries.get(name) ?? []), row]);
		try { const scope = parseItemURI(text((row as Record<string, unknown>).id)); scopes.set(name, (scopes.get(name) ?? new Set()).add(scopeKey(scope))); } catch { /* planLibraryRows reports the URI */ }
	}
	for (const [name, set] of scopes) {
		if (set.size < 2) continue;
		for (const row of libraries.get(name) ?? []) {
			const citekey = record(row) ? text(row.citekey) : "";
			let itemKey: string | undefined;
			try { itemKey = parseItemURI(text((row as Record<string, unknown>).id)).itemKey; } catch { itemKey = undefined; }
			skipped.push({ reason: "library-name", library: name, ...(itemKey ? { itemKey } : {}), ...(citekey ? { citekey } : {}), detail: "several libraries share this name" });
		}
		libraries.delete(name);
	}
	return { libraries, skipped };
}

/** Index id (`libraryID:itemKey`) of a skipped item when the library ID and item key are known. */
export function skippedId(item: SkippedItem): string | null {
	return item.libraryID !== undefined && item.itemKey ? `${item.libraryID}:${item.itemKey}` : null;
}
