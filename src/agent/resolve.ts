/**
 * Resolution over a loaded index for every selector family (CLI contract 2). Pure: never imports `obsidian`.
 * The citekey and itemKey families reproduce the v1 `IndexService.resolve()` verdict byte for byte (entry.id, citekey,
 * citekey history or item key, optionally scoped by library and item key, `matchedHistory` semantics unchanged);
 * DOI, arXiv, title and query go through `searchIndex`, which only resolves exact, rival-free hits.
 */
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import type { MatchedBy, QueryEcho, RankedItem, ResolveOutcome, Selector, SelectorKind } from "./types";
import { normalizeArxiv, normalizeDoi, normalizeTitle, RANKED_LIMIT, rankedCandidate, rankedItem, searchIndex, type Candidate } from "./search";

const ITEM_KEY = /^[A-Z0-9]{8}$/;
/** Family precedence when a selector is malformed; the CLI rejects zero or several families before this runs. */
const FAMILIES: SelectorKind[] = ["citekey", "itemKey", "doi", "arxiv", "title", "query"];

export interface SelectorCheck { kind: SelectorKind | null; error?: string }

function present(value: string | undefined): boolean { return value !== undefined; }

function families(selector: Selector): SelectorKind[] {
	return FAMILIES.filter(kind => present(selector[kind]));
}

/**
 * Validates that exactly one selector family is present with a usable value. `--item-key` needs `--library` and an
 * 8-character key; `--year`/`--author` accompany `--title` or `--query` only. `kind` is the family found (or the first
 * of several) so callers can still echo it next to the error.
 */
export function selectorKind(selector: Selector): SelectorCheck {
	const found = families(selector);
	if (!found.length) return { kind: null, error: "Exactly one selector is required: --citekey, --item-key --library, --doi, --arxiv, --title or --query." };
	const kind = found[0];
	if (found.length > 1) return { kind, error: `Only one selector may be given (received ${found.map(flag).join(", ")}).` };
	const value = selector[kind] ?? "";
	if (!value.trim()) return { kind, error: `${flag(kind)} needs a value.` };
	if (kind === "itemKey") {
		if (selector.libraryID === undefined) return { kind, error: "--item-key requires --library ID." };
		if (!Number.isInteger(selector.libraryID) || selector.libraryID < 0) return { kind, error: "--library must be a non-negative integer." };
		if (!ITEM_KEY.test(value.trim())) return { kind, error: "--item-key must be an 8-character Zotero item key (A-Z, 0-9)." };
	}
	if (kind !== "title" && kind !== "query" && (hasText(selector.year) || hasText(selector.author))) return { kind, error: "--year and --author apply only to --title or --query." };
	if (hasText(selector.year) && !/^\d{4}$/.test(selector.year?.trim() ?? "")) return { kind, error: "--year must be a four-digit year." };
	return { kind };
}

function flag(kind: SelectorKind): string {
	return kind === "itemKey" ? "--item-key" : `--${kind}`;
}

function hasText(value: string | undefined): value is string { return typeof value === "string" && value.trim().length > 0; }

function normalizedValue(kind: SelectorKind, raw: string): string {
	switch (kind) {
		case "citekey": return raw.trim().replace(/^@/, "");
		/* v1 compared the item key untrimmed; keep that so scoping stays byte-identical. */
		case "itemKey": return raw;
		case "doi": return normalizeDoi(raw);
		case "arxiv": return normalizeArxiv(raw);
		case "title":
		case "query": return normalizeTitle(raw);
	}
}

/** Echo of the selector as the plugin understood it: raw text, its normalized form, and the modifiers that applied. */
export function queryEcho(selector: Selector): QueryEcho {
	const kind = families(selector)[0] ?? "query";
	const raw = selector[kind] ?? "";
	const echo: QueryEcho = { kind, raw, normalized: normalizedValue(kind, raw) };
	if ((kind === "title" || kind === "query") && hasText(selector.year)) echo.year = selector.year.trim();
	if ((kind === "title" || kind === "query") && hasText(selector.author)) echo.author = selector.author.trim();
	if (selector.libraryID !== undefined) echo.libraryID = selector.libraryID;
	return echo;
}

interface KeyMatch { entry: ZoteroIndexEntry; matchedBy: Exclude<MatchedBy, null>; score: number; reason: string }

/** v1 match order for one entry against the trimmed, `@`-stripped citekey selector. */
function keyMatch(entry: ZoteroIndexEntry, normalized: string): KeyMatch | null {
	if (entry.citekey === normalized) return { entry, matchedBy: "citekey", score: 100, reason: `citekey ${normalized}` };
	if (entry.citekeyHistory.includes(normalized)) return { entry, matchedBy: "citekeyHistory", score: 90, reason: `former citekey ${normalized}` };
	if (entry.id === normalized) return { entry, matchedBy: "id", score: 100, reason: `id ${normalized}` };
	if (ITEM_KEY.test(normalized) && entry.itemKey === normalized) return { entry, matchedBy: "itemKey", score: 100, reason: `item key ${normalized}` };
	return null;
}

function rankKeyMatches(matches: KeyMatch[]): RankedItem[] {
	return [...matches]
		.sort((a, b) => b.score - a.score || a.entry.citekey.localeCompare(b.entry.citekey) || a.entry.id.localeCompare(b.entry.id))
		.slice(0, RANKED_LIMIT)
		.map(m => rankedItem(m.entry, m.matchedBy, m.score, m.reason));
}

function resolveByKey(index: ZoteroIndex, selector: Selector, kind: "citekey" | "itemKey", query: QueryEcho): ResolveOutcome {
	const base = { matchedHistory: false, candidates: [] as ZoteroIndexEntry[], ranked: [] as RankedItem[], query };
	const scoped = index.entries.filter(entry => (selector.libraryID === undefined || entry.libraryID === selector.libraryID) && (kind !== "itemKey" || entry.itemKey === query.normalized));
	const rawMatches: KeyMatch[] = kind === "itemKey"
		? scoped.map(entry => ({ entry, matchedBy: "itemKey", score: 100, reason: `item key ${query.normalized}` }))
		: scoped.flatMap(entry => { const m = keyMatch(entry, query.normalized); return m ? [m] : []; });
	const byId = new Map<string, KeyMatch>();
	for (const match of rawMatches) {
		const previous = byId.get(match.entry.id);
		if (!previous || match.score > previous.score) byId.set(match.entry.id, match);
	}
	const matches = [...byId.values()];
	if (!matches.length) return { ...base, status: "not-found", matchedBy: null, entry: null };
	if (matches.length > 1) return { ...base, status: "ambiguous", matchedBy: kind, entry: null, candidates: matches.map(m => m.entry), ranked: rankKeyMatches(matches) };
	const { entry, matchedBy } = matches[0];
	const matchedHistory = kind === "citekey" && entry.citekey !== query.normalized && entry.citekeyHistory.includes(query.normalized);
	return { ...base, status: "resolved", matchedBy, entry, matchedHistory };
}

function resolveBySearch(index: ZoteroIndex, selector: Selector, kind: "doi" | "arxiv" | "title" | "query", query: QueryEcho): ResolveOutcome {
	const base = { matchedHistory: false, candidates: [] as ZoteroIndexEntry[], ranked: [] as RankedItem[], query };
	const entries = selector.libraryID === undefined ? index.entries : index.entries.filter(entry => entry.libraryID === selector.libraryID);
	const modifiers = kind === "title" || kind === "query" ? { year: hasText(selector.year) ? selector.year.trim() : undefined, author: hasText(selector.author) ? selector.author.trim() : undefined } : {};
	const result = searchIndex(entries, { [kind]: selector[kind], ...modifiers, limit: RANKED_LIMIT });
	const ranked = (list: Candidate[]): RankedItem[] => list.slice(0, RANKED_LIMIT).map(rankedCandidate);
	if (result.status === "resolved") return { ...base, status: "resolved", matchedBy: result.matchedBy, entry: result.entry };
	if (result.status === "ambiguous") return { ...base, status: "ambiguous", matchedBy: result.matchedBy, entry: null, candidates: result.candidates.map(c => c.entry), ranked: ranked(result.candidates) };
	return { ...base, status: "not-found", matchedBy: null, entry: null, ranked: ranked(result.suggestions) };
}

/**
 * Resolves one selector against a loaded index. Throws only for zero or several selector families (a contract
 * violation the CLI rejects earlier); an item key without a library or of the wrong length simply finds nothing,
 * exactly as v1 did. `unavailable` is never produced here: the host decides that before it has an index.
 */
export function resolveIndex(index: ZoteroIndex, selector: Selector): ResolveOutcome {
	const found = families(selector);
	if (found.length !== 1) throw new Error(selectorKind(selector).error ?? "Exactly one selector is required.");
	const kind = found[0];
	const query = queryEcho(selector);
	if (kind === "citekey" || kind === "itemKey") return resolveByKey(index, selector, kind, query);
	return resolveBySearch(index, selector, kind, query);
}
