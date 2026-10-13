/**
 * Lookups derived from one index generation (0.6 PERF-05), each built on first use and shared by every reader of that
 * generation: the citekey suggester, the References and Annotations sidebars, the note map and the recent-reads
 * ordering. Pure: never imports `obsidian`.
 *
 * Every index generation publishes a new `entries` array, and nothing mutates a published array or its entries (a
 * refresh, a peek and a fresh read each build new ones), so the cache is a WeakMap keyed by the array itself: there is no
 * invalidation code, and a generation's lookups are released together with its array. Everything handed out here is
 * shared between callers and must be treated as read-only.
 */
import type { ZoteroIndexEntry } from "./types";
import { buildAliasIndex, type AliasIndex } from "./note-aliases";
import { completionRows, type CompletionRow } from "./citations/score";

// Pure annotation: modules bundled into the offline core import this one without using it (tree-shaken away).
const NONE: readonly ZoteroIndexEntry[] = /* @__PURE__ */ Object.freeze([]);

/** `key` → entries carrying it, in index order; an entry is listed once per distinct key it carries. */
function groupBy(entries: readonly ZoteroIndexEntry[], keys: (entry: ZoteroIndexEntry) => Iterable<string>): Map<string, ZoteroIndexEntry[]> {
	const groups = new Map<string, ZoteroIndexEntry[]>();
	for (const entry of entries) {
		for (const key of keys(entry)) {
			const group = groups.get(key);
			if (group) group.push(entry); else groups.set(key, [entry]);
		}
	}
	return groups;
}

export class IndexDerived {
	private alias: AliasIndex | null = null;
	private byCitekey: Map<string, ZoteroIndexEntry[]> | null = null;
	private byId: Map<string, ZoteroIndexEntry[]> | null = null;
	private byItemKey: Map<string, ZoteroIndexEntry[]> | null = null;
	private completion: readonly CompletionRow[] | null = null;

	constructor(readonly entries: readonly ZoteroIndexEntry[]) {}

	/** `buildAliasIndex(entries)`: the identity evidence vault notes are resolved against. */
	get aliasIndex(): AliasIndex {
		if (!this.alias) this.alias = buildAliasIndex(this.entries);
		return this.alias;
	}

	/** Citekey-completion rows in completion order (`completionRows`). */
	get completionRows(): readonly CompletionRow[] {
		if (!this.completion) this.completion = completionRows(this.entries);
		return this.completion;
	}

	/** Entries whose current or a previous citekey is `citekey`, in index order (several when libraries share a key). */
	entriesWithCitekey(citekey: string): readonly ZoteroIndexEntry[] {
		if (!this.byCitekey) this.byCitekey = groupBy(this.entries, entry => new Set([entry.citekey, ...entry.citekeyHistory]));
		return this.byCitekey.get(citekey) ?? NONE;
	}

	/** Entries with this id, in index order: exactly one in a validated index. */
	entriesWithId(id: string): readonly ZoteroIndexEntry[] {
		if (!this.byId) this.byId = groupBy(this.entries, entry => [entry.id]);
		return this.byId.get(id) ?? NONE;
	}

	/** The first entry with this id, or null. */
	entryById(id: string): ZoteroIndexEntry | null {
		return this.entriesWithId(id)[0] ?? null;
	}

	/** Entries with this Zotero item key, in index order; libraries are independent, so the key alone is not an identity. */
	entriesWithItemKey(itemKey: string): readonly ZoteroIndexEntry[] {
		if (!this.byItemKey) this.byItemKey = groupBy(this.entries, entry => [entry.itemKey]);
		return this.byItemKey.get(itemKey) ?? NONE;
	}
}

const derived = new WeakMap<readonly ZoteroIndexEntry[], IndexDerived>();

/** The derived lookups of the index generation whose entries array is `entries`. */
export function indexDerived(entries: readonly ZoteroIndexEntry[]): IndexDerived {
	let value = derived.get(entries);
	if (!value) {
		value = new IndexDerived(entries);
		derived.set(entries, value);
	}
	return value;
}
