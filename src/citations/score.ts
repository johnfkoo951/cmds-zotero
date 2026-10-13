import type { ZoteroIndexEntry } from "../types";

/** Ranks index entries for inline completion: exact citekey, citekey prefix, then all query terms across citekey/title/authors/year. Underscores stand in for spaces. */
export function matchScore(entry: ZoteroIndexEntry, query: string): number {
	const q = query.toLowerCase().replace(/_/g, " ").trim();
	if (!q) return 1;
	const citekey = entry.citekey.toLowerCase();
	if (citekey === q) return 100;
	if (citekey.startsWith(q)) return 80;
	const haystack = `${citekey} ${entry.title} ${entry.authors.join(" ")} ${entry.year}`.toLowerCase();
	const terms = q.split(/\s+/).filter(Boolean);
	if (!terms.every(term => haystack.includes(term))) return 0;
	return 40 + Math.min(terms.length, 5);
}

/** Inline completion offers at most this many entries. */
export const COMPLETION_LIMIT = 30;

/** An entry with the lower-cased text `matchScore` reads, prepared once per index generation (0.6 PERF-04). */
export interface CompletionRow {
	readonly entry: ZoteroIndexEntry;
	/** `entry.citekey`, lower-cased. */
	readonly citekey: string;
	/** Citekey, title, authors and year, lower-cased exactly as `matchScore` builds them. */
	readonly haystack: string;
}

/**
 * Completion rows for `entries` in completion order: citekey collation (`localeCompare`, the comparator the ranking has
 * always used), index order on ties (the sort is stable). Built once per index generation; see `indexDerived`.
 */
export function completionRows(entries: readonly ZoteroIndexEntry[]): CompletionRow[] {
	return entries.map(entry => {
		const citekey = entry.citekey.toLowerCase();
		return { entry, citekey, haystack: `${citekey} ${entry.title} ${entry.authors.join(" ")} ${entry.year}`.toLowerCase() };
	}).sort((a, b) => a.entry.citekey.localeCompare(b.entry.citekey));
}

function hasAllTerms(haystack: string, terms: readonly string[]): boolean {
	for (const term of terms) if (!haystack.includes(term)) return false;
	return true;
}

/**
 * The top `limit` entries for `query`, identical to scoring every entry with `matchScore` and stably sorting by score
 * (descending), then citekey (`localeCompare`), then index order — in one pass over rows already in that citekey order.
 * For one query a matching row scores 100 (exact citekey), 80 (citekey prefix) or the same term score, so the result is
 * the exact matches, then the prefix matches, then the term matches, each in row order. Only the first `limit` prefix and
 * term matches can be shown, so later term matches skip the substring test.
 */
export function rankCompletions(rows: readonly CompletionRow[], query: string, limit = COMPLETION_LIMIT): ZoteroIndexEntry[] {
	const text = query.toLowerCase().replace(/_/g, " ").trim();
	if (!text) return rows.slice(0, limit).map(row => row.entry);
	const terms = text.split(/\s+/).filter(Boolean);
	const exact: CompletionRow[] = [];
	const prefix: CompletionRow[] = [];
	const matched: CompletionRow[] = [];
	for (const row of rows) {
		if (row.citekey === text) exact.push(row);
		else if (row.citekey.startsWith(text)) { if (prefix.length < limit) prefix.push(row); }
		else if (matched.length < limit && exact.length + prefix.length < limit && hasAllTerms(row.haystack, terms)) matched.push(row);
	}
	return [...exact, ...prefix, ...matched].slice(0, limit).map(row => row.entry);
}
