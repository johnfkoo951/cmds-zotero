import type { MatchStatus } from "../agent/types";
import { pdfURI } from "../uris";

export interface PageText {
	/** 1-based PDF page position, the value used in zotero://open-pdf?page=N. */
	page: number;
	/** Printed page label from the PDF's page-label tree, or "" when absent. */
	pageLabel: string;
	text: string;
}

export interface QuoteMatch {
	page: number;
	pageLabel: string;
	/** 1.0 for an exact normalized substring; lower values come from the token-window fallback. */
	score: number;
	snippet: string;
	method: "exact" | "tokens";
	/** Present when the exact match starts on `page` and ends on the next page. */
	span?: { page: number; pageLabel: string };
}

const LIGATURES: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "æ": "ae", "œ": "oe" };

/** Canonical comparison form: NFC, ligatures expanded, typographic quotes/dashes folded, soft hyphens and line-break hyphenation removed, whitespace collapsed, lower-case. */
export function normalizeForMatch(value: string): string {
	return value.normalize("NFC")
		.replace(/[ﬀ-ﬄæœ]/g, c => LIGATURES[c] ?? c)
		.replace(/­/g, "")
		.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
		.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
		.replace(/[‐-―−]/g, "-").replace(/…/g, "...")
		.replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenize(value: string): string[] { return normalizeForMatch(value).split(" ").filter(Boolean); }

function snippetAround(text: string, index: number, length: number): string {
	const start = Math.max(0, index - 60);
	const end = Math.min(text.length, index + length + 60);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Finds the page(s) containing a quote. Exact normalized substring first; otherwise the page whose
 * sliding token window shares the most tokens with the quote, reported with a proportional score.
 */
export function locateQuote(pages: PageText[], quote: string, minScore = 0.6): QuoteMatch[] {
	const needle = normalizeForMatch(quote);
	if (needle.length < 8) throw new Error("Quote must be at least 8 characters after normalization");
	const exact: QuoteMatch[] = [];
	const normalized = pages.map(page => ({ page, text: normalizeForMatch(page.text) }));
	for (const { page, text } of normalized) {
		const index = text.indexOf(needle);
		if (index >= 0) exact.push({ page: page.page, pageLabel: page.pageLabel, score: 1, snippet: snippetAround(text, index, needle.length), method: "exact" });
	}
	if (exact.length) return exact;
	// Quotes can straddle a page break: try the join of consecutive pages before falling back to tokens.
	for (let i = 0; i + 1 < normalized.length; i++) {
		const joined = `${normalized[i].text} ${normalized[i + 1].text}`;
		const index = joined.indexOf(needle);
		if (index >= 0 && index < normalized[i].text.length) exact.push({ page: normalized[i].page.page, pageLabel: normalized[i].page.pageLabel, score: 0.95, snippet: snippetAround(joined, index, needle.length), method: "exact", span: { page: normalized[i + 1].page.page, pageLabel: normalized[i + 1].page.pageLabel } });
	}
	if (exact.length) return exact;
	const want = tokenize(quote);
	const results: QuoteMatch[] = [];
	for (const { page, text } of normalized) {
		const have = text.split(" ");
		if (!have.length) continue;
		const window = Math.min(have.length, Math.max(want.length * 2, 12));
		let best = 0;
		let bestAt = 0;
		const wantSet = new Set(want);
		let count = 0;
		const counts = new Map<string, number>();
		for (let i = 0; i < have.length; i++) {
			const add = have[i];
			if (wantSet.has(add)) { const c = (counts.get(add) ?? 0) + 1; counts.set(add, c); if (c === 1) count++; }
			if (i >= window) {
				const drop = have[i - window];
				if (wantSet.has(drop)) { const c = (counts.get(drop) ?? 1) - 1; counts.set(drop, c); if (c === 0) count--; }
			}
			if (count > best) { best = count; bestAt = Math.max(0, i - window + 1); }
		}
		const score = want.length ? best / new Set(want).size : 0;
		if (score >= minScore) {
			const charIndex = have.slice(0, bestAt).join(" ").length;
			results.push({ page: page.page, pageLabel: page.pageLabel, score: Math.round(score * 100) / 100, snippet: snippetAround(text, charIndex, Math.min(text.length - charIndex, needle.length)), method: "tokens" });
		}
	}
	return results.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, 5);
}

/** Selects pages by a "1-3,7" style range string against a 1-based page count. */
export function parsePageRange(value: string | undefined, count: number): number[] {
	if (!value) return Array.from({ length: count }, (_, i) => i + 1);
	const pages = new Set<number>();
	for (const part of value.split(",")) {
		const piece = part.trim();
		const range = /^(\d+)(?:-(\d+))?$/.exec(piece);
		if (!range) throw new Error(`Invalid page range: ${piece}`);
		const start = Number(range[1]);
		const end = range[2] ? Number(range[2]) : start;
		if (start < 1 || end < start || end > count) throw new Error(`Page range ${piece} is outside 1-${count}`);
		for (let n = start; n <= end; n++) pages.add(n);
	}
	return [...pages].sort((a, b) => a - b);
}

export interface TextItem { str: string; hasEOL?: boolean; transform?: number[]; width?: number }

/** Joins pdf.js text items into lines; inserts a space only where glyph runs are visibly separated. */
export function joinTextItems(items: TextItem[]): string {
	let out = "";
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		out += item.str;
		if (item.hasEOL) { out += "\n"; continue; }
		const next = items[i + 1];
		if (!next || !item.transform || !next.transform) continue;
		const gap = next.transform[4] - (item.transform[4] + (item.width ?? 0));
		const sameLine = Math.abs(next.transform[5] - item.transform[5]) < 2;
		if (!sameLine) out += "\n";
		else if (gap > 1 && !/\s$/.test(item.str) && !/^\s/.test(next.str)) out += " ";
	}
	return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

const PLACEHOLDER_LABEL = /^[\s\-–—]*$/;

/** Vocabulary §4: a page label is stored as "" when absent, equal to the page position, or only whitespace/dashes. */
export function normalizePageLabel(label: string | null | undefined, page: number): string {
	if (typeof label !== "string") return "";
	const trimmed = label.trim();
	return trimmed === String(page) || PLACEHOLDER_LABEL.test(trimmed) ? "" : trimmed;
}

/** What every output prints for a page: the label when there is one, else the position (never `p.-`). */
export function displayPageLabel(label: string | null | undefined, page: number): string {
	return normalizePageLabel(label, page) || String(page);
}

export interface QuoteCallout {
	/** 1-based line of the callout head. */
	line: number;
	quote: string;
}

const QUOTE_HEAD = /^ {0,3}>[ \t]*\[!quote\]/i;
/** Any callout head ends the previous callout's payload, quote or not. */
const CALLOUT_HEAD = /^ {0,3}>[ \t]*\[![A-Za-z][A-Za-z0-9_-]*\]/;
const QUOTE_LINE = /^ {0,3}>[ \t]?(.*)$/;
const WRAPPING_QUOTES: [string, string][] = [['"', '"'], ["“", "”"], ["'", "'"], ["‘", "’"], ["「", "」"], ["『", "』"], ["«", "»"]];

function stripWrappingQuotes(value: string): string {
	let text = value.trim();
	for (const [open, close] of WRAPPING_QUOTES) {
		if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) { text = text.slice(open.length, text.length - close.length).trim(); break; }
	}
	return text;
}

/** Every `> [!quote]` callout in a note: payload = the `> ` lines that follow the head, surrounding quotes stripped. */
export function extractQuoteCallouts(markdown: string): QuoteCallout[] {
	const lines = markdown.split(/\r?\n/);
	const callouts: QuoteCallout[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!QUOTE_HEAD.test(lines[i])) continue;
		const payload: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const match = QUOTE_LINE.exec(lines[j]);
			if (!match || CALLOUT_HEAD.test(lines[j])) break;
			payload.push(match[1]);
		}
		callouts.push({ line: i + 1, quote: stripWrappingQuotes(payload.join("\n")) });
		i = j - 1;
	}
	return callouts;
}

export interface LocateRequest {
	line?: number;
	quote: string;
}

export interface LocateMatch {
	page: number;
	pageLabel: string;
	/** `p.<label>` or `p.<a>-<b>` when the quote spans two consecutive pages. */
	locator: string;
	spansPages: boolean;
	/** `zotero://open-pdf/library/items/<ATTACHMENTKEY>?page=N`; null for `--file` targets. */
	uri: string | null;
	method: "exact" | "tokens";
	score: number;
	snippet: string;
}

export interface LocateResult {
	line?: number;
	quote: { raw: string; normalized: string; chars: number };
	matchStatus: MatchStatus;
	matches: LocateMatch[];
	/** `원문 (p.N)` for a single exact hit; null for multiple, fuzzy and not-found. */
	calloutTitle: string | null;
}

export interface LocateSummary { total: number; found: number; multiple: number; fuzzy: number; notFound: number }

export interface LocateBatch {
	results: LocateResult[];
	summary: LocateSummary;
	warnings: string[];
}

export const MIN_QUOTE_CHARS = 8;

function renderMatch(match: QuoteMatch, openURI: string | null): LocateMatch {
	const label = displayPageLabel(match.pageLabel, match.page);
	const locator = match.span ? `p.${label}-${displayPageLabel(match.span.pageLabel, match.span.page)}` : `p.${label}`;
	return { page: match.page, pageLabel: label, locator, spansPages: Boolean(match.span), uri: openURI ? pdfURI(openURI, match.page) : null, method: match.method, score: match.score, snippet: match.snippet };
}

/**
 * Locates each quote in the cached pages. Order: exact on a page → exact across two consecutive pages
 * (`spansPages`) → token window (fuzzy, score ≥ 0.6). Several exact pages → `multiple`. The attachment's
 * `openURI` already names the attachment key; this never constructs keys.
 */
export function locateBatch(pages: PageText[], quotes: LocateRequest[], attachment: { openURI: string | null }): LocateBatch {
	const results: LocateResult[] = [];
	const warnings: string[] = [];
	const summary: LocateSummary = { total: quotes.length, found: 0, multiple: 0, fuzzy: 0, notFound: 0 };
	for (const request of quotes) {
		const raw = request.quote;
		const normalized = normalizeForMatch(raw);
		const where = request.line !== undefined ? ` at line ${request.line}` : "";
		const result: LocateResult = { ...(request.line !== undefined ? { line: request.line } : {}), quote: { raw, normalized, chars: normalized.length }, matchStatus: "not-found", matches: [], calloutTitle: null };
		if (normalized.length < MIN_QUOTE_CHARS) {
			warnings.push(`Quote${where} is shorter than ${MIN_QUOTE_CHARS} characters after normalization and was not searched`);
		} else {
			const matches = locateQuote(pages, raw).map(match => renderMatch(match, attachment.openURI));
			result.matches = matches;
			if (matches.length && matches[0].method === "exact") result.matchStatus = matches.length === 1 ? "found" : "multiple";
			else if (matches.length) result.matchStatus = "fuzzy";
			if (result.matchStatus === "found") result.calloutTitle = `원문 (${matches[0].locator})`;
		}
		if (result.matchStatus === "found") summary.found++;
		else if (result.matchStatus === "multiple") summary.multiple++;
		else if (result.matchStatus === "fuzzy") summary.fuzzy++;
		else summary.notFound++;
		results.push(result);
	}
	return { results, summary, warnings };
}
