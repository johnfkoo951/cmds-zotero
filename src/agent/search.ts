/**
 * Pure normalization and ranking over the validated index (vocabulary §5). Never imports `obsidian`.
 * Only exact identifiers resolve: DOI, arXiv, or an exact normalized title (narrowed by year and author when given)
 * with exactly one hit. Prefix, token and free-text hits are ranked candidates only, so an agent never silently
 * receives the first search match.
 */
import type { ZoteroIndexEntry } from "../types";
import type { CitekeyShape, MatchedBy, RankedItem, RankedMatch } from "./types";

export type { CitekeyShape, MatchedBy, RankedItem, RankedMatch } from "./types";

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
	matchedBy: RankedMatch;
	score: number;
	reason: string;
}

export type SearchResult =
	| { status: "resolved"; matchedBy: Exclude<MatchedBy, null>; entry: ZoteroIndexEntry; candidates: Candidate[] }
	| { status: "ambiguous"; matchedBy: MatchedBy; candidates: Candidate[] }
	| { status: "not-found"; candidates: Candidate[]; suggestions: Candidate[] };

/** Default and maximum number of ranked candidates or suggestions. */
export const RANKED_LIMIT = 10;
export const RANKED_MAX = 50;

/** Scores at or above this are candidates; between SUGGESTION_FLOOR and CANDIDATE_FLOOR they are suggestions only. */
const CANDIDATE_FLOOR = 40;
const SUGGESTION_FLOOR = 15;
const PREFIX_MIN_LENGTH = 20;

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
const DOI_PREFIX = /^\s*(?:doi\s*:\s*)?(?:(?:https?:\/\/)?(?:dx\.)?doi\.org\/)?/i;
const DOI_TRAILING = /[\s.,;)\]}>]+$/g;

const VAULT_SHAPE = /^[a-z][a-z-]*\d{4}[A-Za-z]{2,}[A-Za-z0-9]*$/;
const BBT_DEFAULT_SHAPE = /^[a-z]+[A-Z][A-Za-z]*\d{4}[a-z]?$/;
const BBT_DISAMBIGUATED_SHAPE = /^[a-z]+\d{4}[a-z]?$/;

/** DOI for matching: lower-case bare DOI without resolver prefixes, trailing punctuation, or URL encoding; `""` when not a DOI. */
export function normalizeDoi(value: string): string {
	let doi = value.trim();
	try { doi = decodeURIComponent(doi); } catch { /* keep raw */ }
	doi = doi.replace(DOI_PREFIX, "").replace(DOI_TRAILING, "").toLowerCase();
	return DOI_PATTERN.test(doi) ? doi : "";
}

/** DOI for emitting (§1): trimmed, prefixes and trailing punctuation stripped, case preserved; `""` for absent or prose values. */
export function emitDoi(value: string): string {
	let doi = value.trim();
	try { doi = decodeURIComponent(doi); } catch { /* keep raw */ }
	doi = doi.replace(DOI_PREFIX, "").replace(DOI_TRAILING, "");
	return DOI_PATTERN.test(doi.toLowerCase()) ? doi : "";
}

/** arXiv identifier without version: new style `2005.11401`, old style `hep-th/9901001`; lower-case. */
export function normalizeArxiv(value: string): string {
	const text = value.trim();
	const id = "((?:\\d{4}\\.\\d{4,5})|(?:[a-z-]+(?:\\.[a-z]{2})?\\/\\d{7}))";
	const bare = new RegExp(`^${id}(?:v\\d+)?$`, "i").exec(text);
	const labeled = new RegExp(`^arxiv\\s*:\\s*${id}(?:v\\d+)?$`, "i").exec(text);
	const url = new RegExp(`^https?://(?:www\\.)?arxiv\\.org/(?:abs|pdf)/${id}(?:v\\d+)?(?:\\.pdf)?(?:[?#].*)?$`, "i").exec(text);
	const match = bare ?? labeled ?? url;
	return match ? match[1].toLowerCase() : "";
}

/** DOI 10.48550/arXiv.NNNN.NNNNN is DataCite's arXiv DOI; extract the id so DOI and arXiv lookups agree. */
export function arxivFromDoi(doi: string): string {
	const match = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
	return match ? normalizeArxiv(match[1]) : "";
}

/** Title for matching: NFC, lower-case, curly quotes folded to `'`, non-letter/number runs collapsed to one space, trimmed. */
export function normalizeTitle(value: string): string {
	return value.normalize("NFC").toLowerCase().replace(/[‘’“”]/g, "'").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Index-side arXiv id: `metadata.extra` `arXiv: ID`, then `url`, then the DataCite arXiv DOI. */
export function entryArxiv(entry: ZoteroIndexEntry): string {
	const extra = typeof entry.metadata.extra === "string" ? entry.metadata.extra : "";
	const fromExtra = /arxiv\s*:\s*(\S+)/i.exec(extra)?.[1];
	return (fromExtra && normalizeArxiv(fromExtra)) || normalizeArxiv(entry.url) || arxivFromDoi(normalizeDoi(entry.doi));
}

/** Citekey shape per vocabulary §5; `vault` needs a short title of at least two letters after the year. */
export function citekeyShape(key: string): CitekeyShape {
	if (VAULT_SHAPE.test(key)) return "vault";
	if (BBT_DEFAULT_SHAPE.test(key)) return "bbt-default";
	if (BBT_DISAMBIGUATED_SHAPE.test(key)) return "bbt-disambiguated";
	return "other";
}

/** Projects an index entry onto the ranked-list shape shared by every action. */
export function rankedItem(entry: ZoteroIndexEntry, matchedBy: RankedMatch, score: number, reason: string): RankedItem {
	return {
		id: entry.id,
		citekey: entry.citekey,
		title: entry.title,
		year: entry.year,
		authors: [...entry.authors],
		doi: emitDoi(entry.doi),
		libraryID: entry.libraryID,
		zoteroSelectURI: entry.zoteroSelectURI,
		matchedBy,
		score,
		reason,
	};
}

export function rankedCandidate(candidate: Candidate): RankedItem {
	return rankedItem(candidate.entry, candidate.matchedBy, candidate.score, candidate.reason);
}

function tokens(value: string): string[] { return normalizeTitle(value).split(" ").filter(t => t.length > 1); }

function compareCandidates(a: Candidate, b: Candidate): number {
	return b.score - a.score || a.entry.citekey.localeCompare(b.entry.citekey) || a.entry.id.localeCompare(b.entry.id);
}

function clampLimit(limit: number | undefined): number {
	return Math.min(Math.max(limit ?? RANKED_LIMIT, 1), RANKED_MAX);
}

function isExactTitle(candidate: Candidate): boolean { return candidate.matchedBy === "title"; }

function authorMatches(entry: ZoteroIndexEntry, author: string): boolean {
	if (!author) return false;
	const haystack = ` ${normalizeTitle(entry.authors.join(" "))} `;
	return haystack.includes(` ${author} `);
}

/** Exact hits narrowed by `--year` and `--author` when given: only these may resolve. */
function narrowExact(candidates: Candidate[], query: SearchQuery): Candidate[] {
	const year = query.year?.trim() ?? "";
	const author = query.author ? normalizeTitle(query.author) : "";
	return candidates.filter(c => isExactTitle(c) && (!year || c.entry.year === year) && (!author || authorMatches(c.entry, author)));
}

function identifierResolution(candidates: Candidate[]): SearchResult {
	if (candidates.length === 1) return { status: "resolved", matchedBy: candidates[0].matchedBy === "arxiv" ? "arxiv" : "doi", entry: candidates[0].entry, candidates };
	return { status: "ambiguous", matchedBy: candidates[0].matchedBy === "arxiv" ? "arxiv" : "doi", candidates };
}

function scoreEntry(entry: ZoteroIndexEntry, title: string, free: string[], author: string, year: string): Candidate | null {
	const entryTitle = normalizeTitle(entry.title);
	let score = 0;
	let matchedBy: RankedMatch | null = null;
	const reasons: string[] = [];
	if (title) {
		if (entryTitle === title) { score += 90; matchedBy = "title"; reasons.push("exact title"); }
		else if (entryTitle && (entryTitle.startsWith(title) || title.startsWith(entryTitle)) && Math.min(entryTitle.length, title.length) >= PREFIX_MIN_LENGTH) { score += 70; matchedBy = "titlePrefix"; reasons.push("title prefix"); }
		else {
			const want = tokens(title);
			const have = new Set(tokens(entry.title));
			const hit = want.filter(t => have.has(t)).length;
			const ratio = want.length ? hit / want.length : 0;
			if (ratio >= 0.8) { score += 50 + Math.round(10 * ratio); matchedBy = "titleTokens"; reasons.push(`${hit}/${want.length} title tokens`); }
			else if (ratio >= 0.5) { score += Math.round(40 * ratio); matchedBy = "titleTokens"; reasons.push(`${hit}/${want.length} title tokens`); }
		}
	}
	if (free.length) {
		const hay = `${entry.citekey} ${entry.title} ${entry.authors.join(" ")} ${entry.year}`;
		const have = new Set(tokens(hay));
		const hit = free.filter(t => have.has(t)).length;
		if (hit === free.length) { score += 45; reasons.push("all query tokens"); }
		else if (hit / free.length >= 0.6) { score += Math.round(30 * hit / free.length); reasons.push(`${hit}/${free.length} query tokens`); }
		if (hit && !matchedBy) matchedBy = "query";
	}
	if (author) {
		if (authorMatches(entry, author)) { score += 15; reasons.push("author"); }
		else if (title || free.length) { score -= 10; reasons.push("author mismatch"); }
	}
	if (year) {
		if (entry.year === year) { score += 10; reasons.push("year"); }
		else if (entry.year && score > 0) { score -= 15; reasons.push("year mismatch"); }
	}
	if (!matchedBy || score < SUGGESTION_FLOOR) return null;
	return { entry, matchedBy, score, reason: reasons.join(", ") };
}

/**
 * Offline lookup over the validated index. Exact DOI or arXiv matches resolve; duplicates are ambiguous. An exact
 * normalized title (narrowed by year and author when given) resolves only when exactly one entry carries it; prefix,
 * token and free-text hits are ranked candidates and never resolve. `not-found` carries looser suggestions.
 */
export function searchIndex(entries: ZoteroIndexEntry[], query: SearchQuery): SearchResult {
	const limit = clampLimit(query.limit);
	const doi = query.doi ? normalizeDoi(query.doi) : "";
	const arxiv = (query.arxiv ? normalizeArxiv(query.arxiv) : "") || (doi ? arxivFromDoi(doi) : "");
	if (doi || arxiv) {
		const found: Candidate[] = [];
		for (const entry of entries) {
			const entryDoi = normalizeDoi(entry.doi);
			if (doi && entryDoi && entryDoi === doi) { found.push({ entry, matchedBy: "doi", score: 100, reason: `DOI ${doi}` }); continue; }
			if (arxiv && entryArxiv(entry) === arxiv) found.push({ entry, matchedBy: "arxiv", score: 100, reason: `arXiv ${arxiv}` });
		}
		found.sort(compareCandidates);
		if (found.length) return identifierResolution(found.slice(0, limit));
		if (!query.title && !query.query) return { status: "not-found", candidates: [], suggestions: [] };
	}
	const title = query.title ? normalizeTitle(query.title) : "";
	const free = query.query ? tokens(query.query) : [];
	const author = query.author ? normalizeTitle(query.author) : "";
	const year = query.year?.trim() ?? "";
	if (!title && !free.length) return { status: "not-found", candidates: [], suggestions: [] };
	const scored: Candidate[] = [];
	for (const entry of entries) {
		const candidate = scoreEntry(entry, title, free, author, year);
		if (candidate) scored.push(candidate);
	}
	scored.sort(compareCandidates);
	const candidates = scored.filter(c => c.score >= CANDIDATE_FLOOR).slice(0, limit);
	if (!candidates.length) return { status: "not-found", candidates: [], suggestions: scored.slice(0, limit) };
	if (title) {
		const exact = narrowExact(candidates, query);
		if (exact.length === 1) return { status: "resolved", matchedBy: "title", entry: exact[0].entry, candidates };
		return { status: "ambiguous", matchedBy: "title", candidates };
	}
	return { status: "ambiguous", matchedBy: null, candidates };
}
