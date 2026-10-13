/**
 * Pure core of the `citing` action (0.6): which vault notes cite a Zotero item, under its current citekey or any former
 * one, with the position of every body citation. A note is scanned exactly as `cites` scans it (same syntaxes, fenced
 * code and frontmatter skipped, the References section excluded), so the two actions agree on what a citation is. The
 * action shell (selector, scan, envelope) lives in `actions.ts`. Never imports `obsidian`.
 */
import type { ZoteroIndexEntry } from "../types";
import { DEFAULT_REFERENCES_HEADINGS } from "../types";
import type { FrontmatterCitationField } from "../citations/scan";
import { indexDerived } from "../index-derived";
import { scanNote, type CitationForm } from "./cites-core";
import { noteRef, type NoteRecord } from "./types";

/** Notes listed in one response; `summary.notes` still counts all of them. */
export const CITING_MAX_NOTES = 500;
/** Body citations listed per note; `count` still counts all of them. */
export const CITING_MAX_POSITIONS = 20;
/** Characters of the citing line shown around a citation (a cut end is marked with an ellipsis). */
export const EXCERPT_CHARS = 120;
/** Note reads in flight during one scan. */
export const CITING_READ_CONCURRENCY = 8;

export interface SearchedKey { key: string; kind: "current" | "former" }
export interface ExcludedKey extends SearchedKey {
	reason: "shared";
	/** The other items that carry the key as their current or a former citekey (at most five listed). */
	sharedWith: { id: string; citekey: string; libraryID: number }[];
}

/**
 * The citekeys whose occurrences count as citations of `entry`: its current key and its former keys, minus every key
 * another item also carries (a citekey is unique only within one library, and a former key can be reused later). Such a
 * key cannot be attributed to this item, so it is excluded and reported, never guessed.
 */
export function citingKeys(entry: ZoteroIndexEntry, entries: readonly ZoteroIndexEntry[]): { searched: SearchedKey[]; excluded: ExcludedKey[] } {
	const derived = indexDerived(entries);
	const candidates: SearchedKey[] = [{ key: entry.citekey, kind: "current" }, ...[...new Set(entry.citekeyHistory)].filter(key => key !== entry.citekey).map((key): SearchedKey => ({ key, kind: "former" }))];
	const searched: SearchedKey[] = [];
	const excluded: ExcludedKey[] = [];
	for (const candidate of candidates) {
		if (!candidate.key) continue;
		const others = derived.entriesWithCitekey(candidate.key).filter(other => other.id !== entry.id);
		if (others.length) excluded.push({ ...candidate, reason: "shared", sharedWith: others.slice(0, 5).map(other => ({ id: other.id, citekey: other.citekey, libraryID: other.libraryID })) });
		else searched.push(candidate);
	}
	return { searched, excluded };
}

/** Up to `max` characters of `line` around the zero-based `column`, trimmed; a cut end is marked with an ellipsis. */
export function excerptAround(line: string, column: number, max = EXCERPT_CHARS): string {
	const text = line.replace(/\s+$/, "");
	if (text.length <= max) return text.trim();
	let start = Math.max(0, Math.min(column, text.length) - Math.floor(max / 3));
	let end = Math.min(text.length, start + max);
	start = Math.max(0, end - max);
	// Never cut a surrogate pair in half.
	if (start > 0 && /[\udc00-\udfff]/.test(text.charAt(start))) start++;
	if (end < text.length && /[\ud800-\udbff]/.test(text.charAt(end - 1))) end--;
	return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export interface CitationHit {
	key: string;
	/** One-based line and column over the note text as read (frontmatter block included). */
	line: number;
	column: number;
	form: CitationForm;
	excerpt: string;
}
export interface FrontmatterHit { key: string; field: FrontmatterCitationField; form: "bare" | "pandoc" }

export interface CitingNote {
	path: string;
	basename: string;
	uri: string;
	/** Body citations (outside code and the References section) plus frontmatter citations. */
	count: number;
	/** The frontmatter share of `count`. */
	frontmatterCount: number;
	/** Body citations in note order, at most {@link CITING_MAX_POSITIONS}. */
	citations: CitationHit[];
	frontmatter: FrontmatterHit[];
	/** More body citations exist than `citations` lists. */
	positionsTruncated?: true;
}

/**
 * One note's citations of the searched keys, or null when it has none. `note.body` is the note text as read (frontmatter
 * block included). A text that mentions none of the keys is skipped before it is scanned.
 */
export function citingNote(vault: string, note: NoteRecord & { body: string }, keys: ReadonlySet<string>, headings: readonly string[] = DEFAULT_REFERENCES_HEADINGS): CitingNote | null {
	let mentioned = false;
	for (const key of keys) if (note.body.includes(key)) { mentioned = true; break; }
	if (!mentioned) return null;
	const { citations } = scanNote(note, headings);
	const lines = note.body.split(/\r?\n/);
	const body: CitationHit[] = [];
	const frontmatter: FrontmatterHit[] = [];
	for (const item of citations) {
		if (!keys.has(item.citekey)) continue;
		if (item.where === "frontmatter") { if (item.field) frontmatter.push({ key: item.citekey, field: item.field, form: item.form === "pandoc" ? "pandoc" : "bare" }); continue; }
		if (item.line === undefined || item.column === undefined || item.form === undefined) continue;
		body.push({ key: item.citekey, line: item.line, column: item.column, form: item.form, excerpt: excerptAround(lines[item.line - 1] ?? "", item.column - 1) });
	}
	if (!body.length && !frontmatter.length) return null;
	const ref = noteRef(vault, note.path);
	return {
		path: note.path, basename: ref.basename, uri: ref.uri, count: body.length + frontmatter.length, frontmatterCount: frontmatter.length,
		citations: body.slice(0, CITING_MAX_POSITIONS), frontmatter, ...(body.length > CITING_MAX_POSITIONS ? { positionsTruncated: true as const } : {}),
	};
}

/** Most citations first, then path order: the order of the UI's "Find notes citing this source". */
export function sortCitingNotes(notes: readonly CitingNote[]): CitingNote[] {
	return [...notes].sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
