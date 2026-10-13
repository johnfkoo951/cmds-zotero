/**
 * Recently read Zotero items: Zotero 10 records `attachmentLastRead` when an attachment opens in its reader, and Better
 * BibTeX's `item.search` accepts the `lastRead` condition. `resultLevel: item` maps the attachment-level condition to the
 * parent item, so a search returns citable parents (CSL JSON plus citekey and library name).
 * Pure module: no `obsidian` import, so `tsx --test` loads it.
 */
import type { ItemIdentity, ZoteroIndexEntry } from "../types";
import { parseItemURI, text } from "../api/normalize";
import { record } from "../identity";
import { ownerMarker } from "../note-writer";
import { indexDerived } from "../index-derived";

export const RECENT_WINDOW_CHOICES: readonly number[] = [7, 30, 90, 365];
export const DEFAULT_RECENT_DAYS = 30;
export const MAX_RECENT_DAYS = 365;

export interface RecentRead {
	itemKey: string;
	libraryType: "user" | "group";
	groupID?: number;
	/** Library name as Better BibTeX reports it ("My Library" or a group name). */
	library: string;
	citekey: string;
	title: string;
	year: string;
	authors: string[];
	/** Local calendar day (YYYY-MM-DD) on which Zotero last opened one of the item's attachments; null when undetermined. */
	readOn: string | null;
}

export function clampRecentDays(value: unknown): number {
	const days = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(days) && days >= 1 ? Math.min(days, MAX_RECENT_DAYS) : DEFAULT_RECENT_DAYS;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }
function noon(day: string): Date {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) throw new Error("Invalid calendar day");
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

/** Zotero compares `DATE(lastRead, 'unixepoch', 'localtime')`, so day probes use the local calendar date, not UTC. */
export function localDay(date: Date): string { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
/** Calendar arithmetic at local noon, so a daylight-saving change never skips or repeats a day. */
export function addDays(day: string, delta: number): string {
	const date = noon(day);
	date.setDate(date.getDate() + delta);
	return localDay(date);
}
export function daysBetween(later: string, earlier: string): number { return Math.round((noon(later).getTime() - noon(earlier).getTime()) / 86_400_000); }

/** Search terms for parents whose attachment was read within the last `days` calendar days (today counts as one). */
export function windowTerms(days: number): unknown[] { return [["resultLevel", "item"], ["lastRead", "isInTheLast", `${clampRecentDays(days)} days`]]; }
/** Search terms for parents whose attachment was last read on one local calendar day. */
export function dayTerms(day: string): unknown[] { noon(day); return [["resultLevel", "item"], ["lastRead", "is", day]]; }

function cslYear(issued: unknown): string {
	if (!record(issued)) return "";
	const parts = issued["date-parts"];
	if (Array.isArray(parts) && Array.isArray(parts[0]) && parts[0][0] !== undefined) {
		const year = String(parts[0][0]);
		if (/^\d{4}$/.test(year)) return year;
	}
	return /\b\d{4}\b/.exec(text(issued.literal) || text(issued.raw))?.[0] ?? "";
}
function cslNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(name => {
		if (!record(name)) return [];
		const full = text(name.literal) || [text(name.family), text(name.given)].filter(Boolean).join(", ");
		return full ? [full] : [];
	});
}

/**
 * One BBT search row as a recent read. Null for rows that cannot become literature notes: no parsable item URI, or no
 * citekey (a standalone PDF or a note has none).
 */
export function parseRecentItem(raw: unknown): Omit<RecentRead, "readOn"> | null {
	if (!record(raw)) return null;
	let scope: ReturnType<typeof parseItemURI>;
	try { scope = parseItemURI(text(raw.id)); } catch { return null; }
	const citekey = text(raw.citekey) || text(raw.citationKey) || text(raw["citation-key"]);
	if (!citekey.trim()) return null;
	return { ...scope, library: text(raw.library), citekey, title: text(raw.title), year: cslYear(raw.issued), authors: cslNames(raw.author) };
}

/** Stable key for one Zotero item across libraries (the local library ID is not part of a BBT search row). */
export function recentKey(row: { itemKey: string; libraryType: string; groupID?: number }): string {
	return `${row.libraryType}:${row.groupID ?? 0}:${row.itemKey}`;
}

/** Newest-read first; undetermined days last; ties by title, then citekey. */
export function orderRecent<T extends { readOn: string | null; title: string; citekey: string }>(rows: readonly T[]): T[] {
	return [...rows].sort((a, b) => {
		if (a.readOn !== b.readOn) {
			if (a.readOn === null) return 1;
			if (b.readOn === null) return -1;
			return a.readOn < b.readOn ? 1 : -1;
		}
		return a.title.localeCompare(b.title) || a.citekey.localeCompare(b.citekey);
	});
}

/** Short human label for the day an item was read, relative to `today` (both local calendar days). */
export function readLabel(readOn: string | null, today: string): string {
	if (!readOn) return "read recently";
	const days = daysBetween(today, readOn);
	if (days <= 0) return "read today";
	if (days === 1) return "read yesterday";
	if (days < 14) return `read ${days} days ago`;
	return `read on ${readOn}`;
}

/**
 * The index entry for a recent row: same item key and library scope, or null when the saved index predates the item.
 * The first such entry in index order; candidates come from the generation's item-key map (0.6 PERF-12), not a scan.
 */
export function indexEntryFor(row: { itemKey: string; libraryType: string; groupID?: number }, entries: readonly ZoteroIndexEntry[]): ZoteroIndexEntry | null {
	return indexDerived(entries).entriesWithItemKey(row.itemKey).find(entry => entry.itemKey === row.itemKey && entry.libraryType === row.libraryType && (entry.groupID ?? 0) === (row.groupID ?? 0)) ?? null;
}

/**
 * The literature picker's order: entries read recently first (in the order of `reads`, each entry once, with the day of
 * its first read in that list), then every other entry in index order. Reads the saved index does not know are skipped.
 * Lookups go through the generation's maps (0.6 PERF-12) instead of a scan of every entry per read.
 */
export function recentFirst(entries: readonly ZoteroIndexEntry[], reads: readonly Pick<RecentRead, "itemKey" | "libraryType" | "groupID" | "readOn">[]): { ordered: ZoteroIndexEntry[]; readOn: Map<string, string | null> } {
	const readOn = new Map<string, string | null>();
	for (const read of reads) {
		const entry = indexEntryFor(read, entries);
		if (entry && !readOn.has(entry.id)) readOn.set(entry.id, read.readOn);
	}
	const derived = indexDerived(entries);
	const recent = [...readOn.keys()].flatMap(id => derived.entriesWithId(id));
	return { ordered: [...recent, ...entries.filter(entry => !readOn.has(entry.id))], readOn };
}

/**
 * `none`: no literature note has this identity. `current`: the owned note carries a block for every Zotero annotation.
 * `behind`: Zotero has annotations the note does not show yet. `foreign`: a note has the identity but not this plugin's
 * owner marker (another plugin's or a hand-made note; never overwritten). `duplicate`: several notes claim the identity.
 */
export type NoteState = "none" | "current" | "behind" | "foreign" | "duplicate";
export interface NoteStatus {
	state: NoteState;
	/** The single matching note, when there is exactly one. */
	path: string | null;
	/** Zotero annotations without a block in the note. */
	missing: number;
	/** Annotation blocks whose annotation is no longer in Zotero (kept, never deleted). */
	orphaned: number;
	/** Annotations Zotero has for the item. */
	annotations: number;
}

// Key parts are bounded (Zotero keys are 8 characters) so a damaged marker cannot make the scan quadratic.
const ANNOTATION_MARKER = /<!-- cmds-zotero:(annotation-[A-Za-z0-9]{1,32}-[A-Za-z0-9]{1,32}):(?:[a-f0-9]{64}|detached) -->/g;

/** Annotation section IDs present in a literature note, detached blocks included. */
export function noteAnnotationIDs(text: string): Set<string> {
	return new Set([...text.matchAll(ANNOTATION_MARKER)].map(match => match[1]));
}

/** Compares a literature note's annotation blocks with the item's annotations; no BBT call and no write. */
export function literatureNoteStatus(entry: ZoteroIndexEntry, notes: readonly { path: string; text: string }[]): NoteStatus {
	const expected = new Set(entry.attachments.flatMap(attachment => attachment.annotations.map(annotation => `annotation-${attachment.key}-${annotation.key}`)));
	const base = { missing: 0, orphaned: 0, annotations: expected.size };
	if (!notes.length) return { ...base, state: "none", path: null, missing: expected.size };
	if (notes.length > 1) return { ...base, state: "duplicate", path: null };
	const [note] = notes;
	if (!note.text.includes(ownerMarker(entry.id))) return { ...base, state: "foreign", path: note.path };
	const present = noteAnnotationIDs(note.text);
	const missing = [...expected].filter(id => !present.has(id)).length;
	const orphaned = [...present].filter(id => !expected.has(id)).length;
	return { state: missing ? "behind" : "current", path: note.path, missing, orphaned, annotations: expected.size };
}

/** One-line description of a note status for list rows and CLI messages. */
export function describeNoteStatus(status: NoteStatus): string {
	const kept = status.orphaned ? `; ${status.orphaned} block${status.orphaned === 1 ? "" : "s"} for annotations deleted in Zotero kept` : "";
	switch (status.state) {
		case "none": return status.annotations ? `No literature note yet · ${status.annotations} annotation${status.annotations === 1 ? "" : "s"} in Zotero` : "No literature note yet";
		case "behind": return `${status.missing} new annotation${status.missing === 1 ? "" : "s"} not in the note${kept}`;
		case "current": return `Note is up to date${kept}`;
		case "foreign": return "A note with this Zotero identity exists but was not created by CMDS Zotero; it is never overwritten";
		case "duplicate": return "Several notes claim this Zotero identity; resolve the duplicate first";
	}
}

/** Rows that sending would change by default: no note yet, or new annotations waiting. */
export function needsSending(status: NoteStatus): boolean { return status.state === "none" || status.state === "behind"; }

/** What sending one item to its literature note did; shared by the recent-reads modal and the agent `import` action. */
export interface SendOutcome {
	status: "created" | "updated" | "unchanged" | "refused";
	path: string;
	/** Edited generated sections kept verbatim (0.5 R5 soft conflicts). */
	preserved: string[];
	/** Hard conflicts or the refusal reason. */
	message?: string;
}

/**
 * What one send did, from its import preview and the apply result (0.6 STRUCT-02: shared by the recent-reads send and the
 * agent `import`). For a preview refused before apply, pass the preview's path and conflicts as the result.
 */
export function sendOutcome(preview: { exists: boolean }, result: { path: string; conflicts: readonly string[]; changed: boolean; preserved: readonly string[] }): SendOutcome {
	if (result.conflicts.length) return { status: "refused", path: result.path, preserved: [], message: result.conflicts.join("; ") };
	return { status: !preview.exists ? "created" : result.changed ? "updated" : "unchanged", path: result.path, preserved: [...result.preserved] };
}

/** The texts `literatureNoteStatus` compares, read concurrently (0.6 STRUCT-02: one loader for the modal and both agent actions). */
export function readNoteTexts<F extends { path: string }>(files: readonly F[], read: (file: F) => Promise<string>): Promise<{ path: string; text: string }[]> {
	return Promise.all(files.map(async file => ({ path: file.path, text: await read(file) })));
}

/** One-line result text for a send. */
export function describeSendOutcome(outcome: SendOutcome): string {
	const kept = outcome.preserved.length ? `; your edits kept in ${outcome.preserved.length} section${outcome.preserved.length === 1 ? "" : "s"}` : "";
	switch (outcome.status) {
		case "created": return `Created ${outcome.path}`;
		case "updated": return `Updated ${outcome.path}${kept}`;
		case "unchanged": return `Already up to date${kept}`;
		case "refused": return `Not written: ${outcome.message ?? "conflict"}`;
	}
}

/** Fresh-collection target for an index entry (the identity the export must reproduce). */
export function freshTargetOf(entry: ItemIdentity & { citekey: string }): { citekey: string; itemKey: string; libraryType: "user" | "group"; groupID?: number; libraryID: number } {
	return { citekey: entry.citekey, itemKey: entry.itemKey, libraryType: entry.libraryType, ...(entry.groupID !== undefined ? { groupID: entry.groupID } : {}), libraryID: entry.libraryID };
}

/**
 * Fresh-collection target for a recent read the saved index does not know yet. Zotero's personal library always has local
 * ID 1; a group library is addressed by the BBT library name, or by the local ID another entry of that group carries.
 */
export function freshTargetOfRead(read: RecentRead, entries: readonly ZoteroIndexEntry[]): { citekey: string; itemKey: string; libraryType: "user" | "group"; groupID?: number; libraryID?: number; library?: string } {
	const base = { citekey: read.citekey, itemKey: read.itemKey, libraryType: read.libraryType, ...(read.groupID !== undefined ? { groupID: read.groupID } : {}) };
	if (read.libraryType === "user") return { ...base, libraryID: 1 };
	const sibling = entries.find(entry => entry.libraryType === "group" && entry.groupID === read.groupID);
	return sibling ? { ...base, libraryID: sibling.libraryID } : { ...base, library: read.library };
}

/** One recently read paper as the live host reports it to the agent `recent` action. */
export interface RecentReport {
	read: RecentRead;
	/** `libraryID:itemKey` when the paper could be read (fresh or from the saved index), else null. */
	id: string | null;
	/** The saved index already has this paper. */
	inIndex: boolean;
	/** The entry came straight from Zotero (current annotations), not from the saved index. */
	fresh: boolean;
	note: NoteStatus | null;
	/** Why the paper could not be read at all. */
	problem?: string;
}

/** What the live host did for one agent `import` request (the action turns it into the contract payload). */
export interface ImportNoteResult {
	/** Set when no single item matched or the request was refused before rendering. */
	failure?: { reason: string; message: string; candidates?: unknown[]; bbtError?: { reason: string; endpoint: string } };
	item?: { id: string; citekey: string; title: string; year: string; libraryID: number; itemKey: string };
	fresh?: boolean;
	/** Note state before the import, and after it when `apply` wrote. */
	before?: NoteStatus;
	after?: NoteStatus;
	preview?: { path: string; exists: boolean; conflicts: string[]; softConflicts: string[]; sections: { id: string; state: string }[]; changes: boolean };
	/** Null on a dry run. */
	outcome?: SendOutcome | null;
	warnings?: string[];
}
