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
