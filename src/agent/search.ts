import type { ZoteroIndexEntry } from "../types";

export type MatchedBy = "citekey" | "doi" | "arxiv" | "title" | "query";

export interface SearchQuery {
	doi?: string;
	arxiv?: string;
	title?: string;
	year?: string;
	author?: string;
	query?: string;
	limit?: number;
}

export interface Candidate {
	entry: ZoteroIndexEntry;
	matchedBy: MatchedBy;
	score: number;
	reason: string;
}

export type SearchResult =
	| { status: "resolved"; matchedBy: MatchedBy; entry: ZoteroIndexEntry; candidates: Candidate[] }
	| { status: "ambiguous"; matchedBy: MatchedBy; candidates: Candidate[] }
	| { status: "not-found"; candidates: Candidate[] };

/** Lower-case bare DOI without resolver prefixes, trailing punctuation, or URL encoding. */
export function normalizeDoi(value: string): string {
	let doi = value.trim();
	try { doi = decodeURIComponent(doi); } catch { /* keep raw */ }
	doi = doi.replace(/^\s*(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "").replace(/[\s.,;)\]}>]+$/g, "").toLowerCase();
	return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : "";
}

/** arXiv identifier without version: new style `2005.11401`, old style `hep-th/9901001`. */
export function normalizeArxiv(value: string): string {
	const text = value.trim();
	const match = /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)?((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\.pdf)?$/i.exec(text);
	return match ? match[1].toLowerCase() : "";
}

/** DOI 10.48550/arXiv.NNNN.NNNNN is DataCite's arXiv DOI; extract the id so DOI and arXiv lookups agree. */
export function arxivFromDoi(doi: string): string {
	const match = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
	return match ? normalizeArxiv(match[1]) : "";
}

export function normalizeTitle(value: string): string {
	return value.normalize("NFC").toLowerCase().replace(/[‘’“”]/g, "'").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function entryArxiv(entry: ZoteroIndexEntry): string {
	const extra = typeof entry.metadata.extra === "string" ? entry.metadata.extra : "";
	const fromExtra = /arxiv\s*:\s*(\S+)/i.exec(extra)?.[1];
	return (fromExtra && normalizeArxiv(fromExtra)) || normalizeArxiv(entry.url) || arxivFromDoi(normalizeDoi(entry.doi));
}

function tokens(value: string): string[] { return normalizeTitle(value).split(" ").filter(t => t.length > 1); }

function resolution(matchedBy: MatchedBy, candidates: Candidate[]): SearchResult {
	if (!candidates.length) return { status: "not-found", candidates };
	const top = candidates[0];
	const rivals = candidates.filter(c => c.score >= top.score - 5);
	if (rivals.length === 1 && top.score >= 60) return { status: "resolved", matchedBy: top.matchedBy, entry: top.entry, candidates };
	return { status: "ambiguous", matchedBy, candidates };
}

/**
 * Offline lookup over the validated index. Exact DOI or arXiv matches resolve; duplicates or fuzzy title hits are
 * reported as ambiguous with ranked candidates so an agent never silently picks the first item.
 */
export function searchIndex(entries: ZoteroIndexEntry[], query: SearchQuery): SearchResult {
	const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
	const doi = query.doi ? normalizeDoi(query.doi) : "";
	const arxiv = (query.arxiv ? normalizeArxiv(query.arxiv) : "") || (doi ? arxivFromDoi(doi) : "");
	if (doi || arxiv) {
		const found: Candidate[] = [];
		for (const entry of entries) {
			const entryDoi = normalizeDoi(entry.doi);
			if (doi && entryDoi && entryDoi === doi) { found.push({ entry, matchedBy: "doi", score: 100, reason: `DOI ${doi}` }); continue; }
			if (arxiv && entryArxiv(entry) === arxiv) found.push({ entry, matchedBy: "arxiv", score: 100, reason: `arXiv ${arxiv}` });
		}
		found.sort((a, b) => b.score - a.score || a.entry.citekey.localeCompare(b.entry.citekey));
		if (found.length) return resolution(found[0].matchedBy, found.slice(0, limit));
		if (!query.title && !query.query) return { status: "not-found", candidates: [] };
	}
	const title = query.title ? normalizeTitle(query.title) : "";
	const free = query.query ? tokens(query.query) : [];
	const author = query.author ? normalizeTitle(query.author) : "";
	if (!title && !free.length && !author) return { status: "not-found", candidates: [] };
	const found: Candidate[] = [];
	for (const entry of entries) {
		const entryTitle = normalizeTitle(entry.title);
		let score = 0;
		const reasons: string[] = [];
		if (title) {
			if (entryTitle === title) { score += 90; reasons.push("exact title"); }
			else if (entryTitle && (entryTitle.startsWith(title) || title.startsWith(entryTitle)) && Math.min(entryTitle.length, title.length) >= 20) { score += 70; reasons.push("title prefix"); }
			else {
				const want = tokens(title);
				const have = new Set(tokens(entry.title));
				const hit = want.filter(t => have.has(t)).length;
				if (want.length && hit / want.length >= 0.8) { score += 50 + Math.round(10 * hit / want.length); reasons.push(`${hit}/${want.length} title tokens`); }
			}
		}
		if (free.length) {
			const hay = `${entry.citekey} ${entry.title} ${entry.authors.join(" ")} ${entry.year}`;
			const have = new Set(tokens(hay));
			const hit = free.filter(t => have.has(t)).length;
			if (hit === free.length) { score += 45; reasons.push("all query tokens"); }
			else if (hit / free.length >= 0.6) { score += Math.round(30 * hit / free.length); reasons.push(`${hit}/${free.length} query tokens`); }
		}
		if (author) {
			const names = normalizeTitle(entry.authors.join(" "));
			if (names.includes(author)) { score += 15; reasons.push("author"); } else if (title || free.length) score -= 10;
		}
		if (query.year) {
			if (entry.year === String(query.year).trim()) { score += 10; reasons.push("year"); } else if (entry.year && score > 0) score -= 15;
		}
		if (score >= 40) found.push({ entry, matchedBy: title ? "title" : "query", score, reason: reasons.join(", ") });
	}
	found.sort((a, b) => b.score - a.score || a.entry.citekey.localeCompare(b.entry.citekey));
	return resolution(title ? "title" : "query", found.slice(0, limit));
}
