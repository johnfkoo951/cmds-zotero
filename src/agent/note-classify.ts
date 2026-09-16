/**
 * Classifies vault notes that belong to one Zotero item (vocabulary §4 `vaultNotes`). Pure: never imports `obsidian`.
 * Notes are matched to a resolved entry by frontmatter `zoteroID`, then `zoteroSelectURI`, then `citekey` equality with
 * the entry citekey or its history; identifier hints (DOI, arXiv, case-insensitive citekey) match hubs and raw sources
 * even when the item is not in the index, so a not-found DOI still finds the existing hub. Citekey evidence follows the
 * `note-aliases` ladder (0.5 R14): notes carrying a foreign identity never match, and an `@`-less basename needs a Zotero
 * note `type` or the output folder. Ownership stays with `note-aliases`; the ZotLit `zotero-key` is read here only to
 * point `literatureNote` at that note.
 */
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import { noteRef, type NoteRecord, type NoteRef, type VaultNotes } from "./types";
import { normalizeArxiv, normalizeDoi } from "./search";
import { citekeyEvidenceAllowed, hasForeignIdentity, selectIdentity } from "../note-aliases";

export interface NoteHints { doi?: string; arxiv?: string; citekey?: string }
export interface ClassifyOptions {
	/** `settings.outputFolder`: plugin-owned literature notes live here even when their `type` differs. */
	outputFolder?: string;
}

export type NoteKind = "hub" | "raw" | "atom" | "literature" | "other";

/**
 * Lookups over one vault listing; keys are exact (case-preserving) citekeys, matching-normalized DOIs and arXiv ids.
 * Citation keys are matched the way pandoc/BBT match them, so a camelCase hub key must not be folded; `citekey-check`
 * runs its own case-insensitive collision pass over its own lookup. Values are sorted by path.
 */
export interface NoteIndexes {
	hubByCitekey: Map<string, NoteRecord[]>;
	rawByCitekey: Map<string, NoteRecord[]>;
	hubByDoi: Map<string, NoteRecord[]>;
	rawByDoi: Map<string, NoteRecord[]>;
	hubByArxiv: Map<string, NoteRecord[]>;
	/** Notes omitted from all maps because their frontmatter could not be parsed. */
	skipped: string[];
}

const ITEM_KEY = /^[A-Z0-9]{8}$/;

export function comparePath(a: { path: string }, b: { path: string }): number {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

/** Frontmatter `type` mapped to the §4 buckets. */
export function noteKind(note: NoteRecord): NoteKind {
	switch (text(note.frontmatter?.type)) {
		case "paper-hub": return "hub";
		case "raw-source": return "raw";
		case "paper-analysis": return "atom";
		case "zotero": return "literature";
		default: return "other";
	}
}

function noteCitekey(note: NoteRecord): string { return text(note.frontmatter?.citekey); }
function noteDoi(note: NoteRecord): string { return normalizeDoi(text(note.frontmatter?.doi)); }
function noteArxiv(note: NoteRecord): string {
	const fm = note.frontmatter;
	return normalizeArxiv(text(fm?.arxiv)) || normalizeArxiv(text(fm?.arxivId)) || normalizeArxiv(text(fm?.url));
}

function push(map: Map<string, NoteRecord[]>, key: string, note: NoteRecord): void {
	if (!key) return;
	const list = map.get(key);
	if (list) list.push(note); else map.set(key, [note]);
}

/** Builds the hub and raw-source lookups once per call so `cites` and `reconcile` share them. */
export function buildNoteIndexes(notes: NoteRecord[]): NoteIndexes {
	const indexes: NoteIndexes = { hubByCitekey: new Map(), rawByCitekey: new Map(), hubByDoi: new Map(), rawByDoi: new Map(), hubByArxiv: new Map(), skipped: [] };
	for (const note of [...notes].sort(comparePath)) {
		if (note.frontmatterParse !== "ok") { indexes.skipped.push(note.path); continue; }
		if (!note.frontmatter) continue;
		const kind = noteKind(note);
		if (kind !== "hub" && kind !== "raw") continue;
		const citekey = noteCitekey(note);
		const doi = noteDoi(note);
		if (kind === "hub") {
			push(indexes.hubByCitekey, citekey, note);
			push(indexes.hubByDoi, doi, note);
			push(indexes.hubByArxiv, noteArxiv(note), note);
		} else {
			push(indexes.rawByCitekey, citekey, note);
			push(indexes.rawByDoi, doi, note);
		}
	}
	return indexes;
}

interface Matcher {
	entry: ZoteroIndexEntry | null;
	keys: Set<string>;
	keysCi: Set<string>;
	doi: string;
	arxiv: string;
	/** Item key usable for the ZotLit `zotero-key` read: unique in the index and the index holds one library. */
	zotLitKey: string;
	outputFolder: string;
}

function buildMatcher(entry: ZoteroIndexEntry | null, hints: NoteHints, index: ZoteroIndex, options: ClassifyOptions): Matcher {
	const keys = new Set<string>();
	if (entry) for (const key of [entry.citekey, ...entry.citekeyHistory]) if (key) keys.add(key);
	const keysCi = new Set<string>();
	const hintKey = text(hints.citekey).toLowerCase();
	if (hintKey) keysCi.add(hintKey);
	const doi = normalizeDoi(text(hints.doi));
	const arxiv = normalizeArxiv(text(hints.arxiv));
	let zotLitKey = "";
	if (entry && ITEM_KEY.test(entry.itemKey)) {
		const sameKey = index.entries.filter(e => e.itemKey === entry.itemKey).length;
		const libraries = new Set(index.entries.map(e => e.libraryID)).size;
		if (sameKey === 1 && libraries === 1) zotLitKey = entry.itemKey;
	}
	const folder = text(options.outputFolder).replace(/^\/+|\/+$/g, "");
	return { entry, keys, keysCi, doi, arxiv, zotLitKey, outputFolder: folder };
}

/** 0.5 R14: a `zotero://select` URI naming the entry's library scope and item key. */
function selectMatches(uri: unknown, entry: ZoteroIndexEntry): boolean {
	const select = selectIdentity(uri);
	return select !== null && select.itemKey === entry.itemKey && select.libraryType === entry.libraryType && select.groupID === entry.groupID;
}

/** Whether the note is about the item: `zoteroID`, `zoteroSelectURI`, citekey equality (entry or hints), DOI/arXiv hints for hubs and raw sources. */
function matches(note: NoteRecord, kind: NoteKind, m: Matcher): boolean {
	const fm = note.frontmatter;
	if (!fm) return false;
	const zoteroID = text(fm.zoteroID);
	if (m.entry && zoteroID && zoteroID === m.entry.id) return true;
	// 0.5 R14: foreign conventions (Bookends, DEVONthink, other `type`s) never match on weaker evidence.
	if (hasForeignIdentity(fm)) return false;
	if (m.entry && selectMatches(fm.zoteroSelectURI, m.entry)) return true;
	// An `@<citekey>` basename is citekey evidence too (ZotLit-style notes carry no `citekey` key), as in `note-aliases`.
	const citekey = noteCitekey(note) || (note.basename.startsWith("@") ? note.basename.slice(1) : "");
	const citekeyAllowed = citekeyEvidenceAllowed(note.basename, fm) || underFolder(note.path, m.outputFolder);
	if (citekeyAllowed && citekey && (m.keys.has(citekey) || m.keysCi.has(citekey.toLowerCase()))) return true;
	if (kind === "hub" || kind === "raw") {
		if (m.doi && noteDoi(note) === m.doi) return true;
		if (kind === "hub" && m.arxiv && noteArxiv(note) === m.arxiv) return true;
	}
	if (kind === "literature" || kind === "other") {
		const zotero = text(fm["zotero-key"]);
		if (m.zotLitKey && zotero === m.zotLitKey) return true;
	}
	return false;
}

function underFolder(path: string, folder: string): boolean {
	return folder !== "" && path.startsWith(`${folder}/`);
}

function pickFirst(kind: string, refs: NoteRef[], warnings: string[]): NoteRef | null {
	if (!refs.length) return null;
	if (refs.length > 1) warnings.push(`More than one ${kind} note matches (${refs.length}); using ${refs[0].path}. Others: ${refs.slice(1).map(r => r.path).join(", ")}.`);
	return refs[0];
}

function pickHub(refs: NoteRef[], warnings: string[]): NoteRef | null {
	if (refs.length <= 1) return refs[0] ?? null;
	warnings.push(`More than one hub note matches (${refs.length}); no hub selected. Matches: ${refs.map(r => r.path).join(", ")}.`);
	return null;
}

/** Literature-note precedence: plugin-owned `type: zotero`, then `settings.outputFolder`, then a ZotLit `zotero-key`. */
type LiteratureTier = 0 | 1 | 2;

function literatureTier(note: NoteRecord, kind: NoteKind, m: Matcher): LiteratureTier | null {
	if (kind === "literature") return 0;
	if (kind !== "other") return null;
	if (underFolder(note.path, m.outputFolder)) return 1;
	if (m.zotLitKey && text(note.frontmatter?.["zotero-key"]) === m.zotLitKey) return 2;
	return null;
}

/**
 * Splits the notes that belong to the item into the §4 buckets. `entry` is the resolved index entry (null when
 * not-found or ambiguous); `hints` carry the identifiers the caller asked with (`--doi`, `--arxiv`, `--citekey`).
 * More than one hub leaves `hub` null and records every matching path in a warning. `literatureNote` is the first by path within the
 * best tier (plugin-owned, output folder, ZotLit key); remaining literature candidates land in `other`.
 */
export function classifyNotes(vault: string, notes: NoteRecord[], entry: ZoteroIndexEntry | null, hints: NoteHints, index: ZoteroIndex, options: ClassifyOptions = {}): VaultNotes {
	const m = buildMatcher(entry, hints, index, options);
	const hubs: NoteRef[] = [];
	const raw: NoteRef[] = [];
	const atoms: NoteRef[] = [];
	const literature: { ref: NoteRef; tier: LiteratureTier }[] = [];
	const other: NoteRef[] = [];
	const warnings: string[] = [];
	for (const note of [...notes].sort(comparePath)) {
		if (note.frontmatterParse !== "ok") {
			warnings.push(`Frontmatter could not be parsed for ${note.path}; it was not classified.`);
			continue;
		}
		const kind = noteKind(note);
		if (!matches(note, kind, m)) continue;
		const ref = noteRef(vault, note.path);
		const tier = literatureTier(note, kind, m);
		if (tier !== null) literature.push({ ref, tier });
		else if (kind === "hub") hubs.push(ref);
		else if (kind === "raw") raw.push(ref);
		else if (kind === "atom") atoms.push(ref);
		else other.push(ref);
	}
	const best = literature.reduce<LiteratureTier>((min, item) => (item.tier < min ? item.tier : min), 2);
	const literatureNote = pickFirst("literature", literature.filter(item => item.tier === best).map(item => item.ref), warnings);
	for (const item of literature) if (item.ref !== literatureNote) other.push(item.ref);
	other.sort(comparePath);
	return { hub: pickHub(hubs, warnings), raw, atoms, literatureNote, other, warnings };
}
