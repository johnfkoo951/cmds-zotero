/**
 * Fielded literature search (0.6.1 R18): `author:`, `title:`, `year:2019-2021`, `tag:`, `col:<path>`, `lib:`, `type:` and
 * `has:pdf|note|annotations`, each optionally negated with a leading `-`, with double quotes around values that contain
 * spaces. Everything else (free words, unknown fields such as `foo:bar`, a field with an unreadable value) stays free text
 * for the picker's fuzzy ranking. Predicates read only index fields (no Better BibTeX call); `has:note` asks the host.
 * Pure module: no `obsidian` import, so `tsx --test` and the offline core can load it.
 */
import { attachmentFormat } from "../api/normalize";
import { indexLibraries } from "../library/collections";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";

export type QueryField = "author" | "title" | "year" | "tag" | "col" | "lib" | "type" | "has";
export type HasValue = "pdf" | "note" | "annotations";

export type QueryTerm =
	| { field: "author" | "title" | "tag" | "lib" | "type"; value: string; negate: boolean }
	| { field: "col"; value: string; segments: string[]; negate: boolean }
	| { field: "year"; value: string; from: number | null; to: number | null; negate: boolean }
	| { field: "has"; value: HasValue; negate: boolean };

export interface ParsedQuery {
	/** The free text left for fuzzy ranking: unknown fields and plain words, single-spaced, quotes removed. */
	text: string;
	terms: QueryTerm[];
}

/** Field names and their aliases; a prefix not listed here is plain text. */
const FIELDS: Readonly<Record<string, QueryField>> = {
	author: "author", au: "author", title: "title", ti: "title", year: "year", tag: "tag",
	col: "col", collection: "col", lib: "lib", library: "lib", type: "type", has: "has",
};
const HAS: Readonly<Record<string, HasValue>> = { pdf: "pdf", note: "note", notes: "note", annotation: "annotations", annotations: "annotations", annot: "annotations" };

/** The field prefixes the pickers advertise (one name per field). */
export const QUERY_FIELDS: readonly string[] = ["author", "title", "year", "tag", "col", "lib", "type", "has"];

/** Case- and form-insensitive comparison key: NFC, lower-cased (Korean and other scripts unchanged apart from NFC). */
export function fold(value: string): string { return value.normalize("NFC").toLowerCase(); }

/** Splits on whitespace outside double quotes; a quote may open mid-token (`col:"Thesis/Related work"`). An unclosed quote runs to the end. */
function tokenize(input: string): { raw: string; quoted: boolean }[] {
	const tokens: { raw: string; quoted: boolean }[] = [];
	let current = "";
	let quoted = false;
	let inQuote = false;
	let started = false;
	for (const char of input) {
		if (char === '"') { inQuote = !inQuote; quoted = true; started = true; continue; }
		if (!inQuote && /\s/.test(char)) {
			if (started) tokens.push({ raw: current, quoted });
			current = ""; quoted = false; started = false;
			continue;
		}
		current += char; started = true;
	}
	if (started) tokens.push({ raw: current, quoted });
	return tokens;
}

/** `2019`, `2019-2021`, `2019-` or `-2021` (also `..` as the separator); null when it is not a year or range. */
function yearRange(value: string): { from: number | null; to: number | null } | null {
	const match = /^(\d{4})?(?:(-|\.\.)(\d{4})?)?$/.exec(value.trim());
	if (!match || (!match[1] && !match[3])) return null;
	const from = match[1] ? Number(match[1]) : null;
	if (!match[2]) return { from, to: from };
	const to = match[3] ? Number(match[3]) : null;
	return from !== null && to !== null && to < from ? { from: to, to: from } : { from, to };
}

/** Collection path segments, trimmed and folded; empty segments (`a//b`, a trailing `/`) are dropped. */
function segmentsOf(path: string): string[] { return path.split("/").map(part => fold(part.trim())).filter(Boolean); }

function termOf(field: QueryField, value: string, negate: boolean): QueryTerm | null {
	const trimmed = value.trim();
	if (field === "year") { const range = yearRange(trimmed); return range ? { field, value: trimmed, ...range, negate } : null; }
	if (field === "has") { const has = HAS[fold(trimmed)]; return has ? { field, value: has, negate } : null; }
	if (field === "col") { const segments = segmentsOf(trimmed); return segments.length ? { field, value: trimmed, segments, negate } : null; }
	return { field, value: trimmed, negate };
}

/**
 * Parses the picker's query. A known field with an empty value (`tag:` while typing) is dropped rather than searched as
 * text, so the list does not empty mid-word; a known field whose value cannot be read (`year:soon`, `has:video`) stays text.
 */
export function parseQuery(input: string): ParsedQuery {
	const { text, terms } = parse(input);
	return { text, terms };
}

function parse(input: string): ParsedQuery & { dropped: number } {
	const terms: QueryTerm[] = [];
	const text: string[] = [];
	let dropped = 0;
	for (const token of tokenize(input)) {
		const match = /^(-?)([A-Za-z]+):([\s\S]*)$/.exec(token.raw);
		const field = match ? FIELDS[match[2].toLowerCase()] : undefined;
		if (!match || !field) { if (token.raw) text.push(token.raw); continue; }
		if (!match[3].trim()) { dropped++; continue; }
		const term = termOf(field, match[3], match[1] === "-");
		if (term) terms.push(term); else text.push(token.raw);
	}
	return { text: text.join(" "), terms, dropped };
}

/** What a picker ranks: `fielded` is false only when the parser consumed nothing, and then `text` is the raw query (the unchanged path). */
export interface RankingQuery {
	terms: QueryTerm[];
	text: string;
	fielded: boolean;
}

/**
 * The picker and the `[@` suggester's plan for one query. A query with a fielded term, or with an empty known field still
 * being typed (`tag:`, `smith col:`), is fielded: its terms filter and only the remaining free text is ranked, so `tag:`
 * ranks like an empty query and `smith tag:` like `smith`. Any other query keeps the raw text for the unchanged ranking.
 */
export function rankingQuery(input: string): RankingQuery {
	const parsed = parse(input);
	const fielded = parsed.terms.length > 0 || parsed.dropped > 0;
	return { terms: parsed.terms, text: fielded ? parsed.text : input, fielded };
}

/** What the predicates need beyond the entry: library names and (only for `has:note`) whether a literature note exists. */
export interface QueryContext {
	/** The library's display name, or null when the index does not list it. */
	libraryName(libraryID: number): string | null;
	/** True when the entry has a literature note in this vault; absent means `has:note` matches nothing. */
	hasNote?(entry: ZoteroIndexEntry): boolean;
}

/** A context from the index's library list; `hasNote` is passed through. */
export function queryContext(index: Pick<ZoteroIndex, "libraries"> | null | undefined, hasNote?: (entry: ZoteroIndexEntry) => boolean): QueryContext {
	const names = new Map(indexLibraries(index).map(library => [library.libraryID, library.name]));
	return { libraryName: id => names.get(id) ?? null, ...(hasNote ? { hasNote } : {}) };
}

/** True when `needle` segments occur as a contiguous run of `path` segments: `col:Methods` matches `Thesis/Methods/Surveys`. */
function pathContains(path: readonly string[], needle: readonly string[]): boolean {
	for (let start = 0; start + needle.length <= path.length; start++) {
		let all = true;
		for (let offset = 0; offset < needle.length; offset++) if (path[start + offset] !== needle[offset]) { all = false; break; }
		if (all) return true;
	}
	return false;
}

/** `journalArticle`, `journal article` and `journal-article` compare equal. */
function typeKey(value: string): string { return fold(value).replace(/[^\p{L}\p{N}]/gu, ""); }

function positive(term: QueryTerm, entry: ZoteroIndexEntry, context: QueryContext): boolean {
	switch (term.field) {
		case "author": { const needle = fold(term.value); return entry.authors.some(author => fold(author).includes(needle)); }
		case "title": return fold(entry.title).includes(fold(term.value));
		case "tag": { const needle = fold(term.value); return entry.tags.some(tag => fold(tag) === needle); }
		// Entry collections are "Parent/Child" paths; a match on a parent also matches entries filed in its subcollections.
		case "col": return entry.collections.some(path => pathContains(segmentsOf(path), term.segments));
		case "lib": {
			if (/^\d+$/.test(term.value)) return entry.libraryID === Number(term.value);
			const name = context.libraryName(entry.libraryID);
			return name !== null && fold(name).includes(fold(term.value));
		}
		case "type": { const itemType = entry.metadata.itemType; return typeof itemType === "string" && typeKey(itemType) === typeKey(term.value); }
		case "year": {
			if (!/^\d{4}$/.test(entry.year)) return false;
			const year = Number(entry.year);
			return (term.from === null || year >= term.from) && (term.to === null || year <= term.to);
		}
		case "has":
			if (term.value === "pdf") return entry.attachments.some(attachment => attachmentFormat(attachment) === "pdf");
			if (term.value === "annotations") return entry.attachments.some(attachment => attachment.annotations.length > 0 || (attachment.readerAnnotations?.length ?? 0) > 0);
			return context.hasNote ? context.hasNote(entry) : false;
	}
}

/** True when the entry satisfies every term (AND); a negated term must not hold. */
export function matchesQuery(entry: ZoteroIndexEntry, terms: readonly QueryTerm[], context: QueryContext): boolean {
	for (const term of terms) if (positive(term, entry, context) === term.negate) return false;
	return true;
}

/** True when any term needs `QueryContext.hasNote`, so the host can skip building its note map otherwise. */
export function needsNotes(terms: readonly QueryTerm[]): boolean { return terms.some(term => term.field === "has" && term.value === "note"); }

/** The entries matching every term, in their given order (the free text is the caller's to rank). */
export function filterEntries<T extends ZoteroIndexEntry>(entries: readonly T[], terms: readonly QueryTerm[], context: QueryContext): T[] {
	return terms.length ? entries.filter(entry => matchesQuery(entry, terms, context)) : [...entries];
}
