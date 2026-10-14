/**
 * 0.6.3 adopt-existing-notes: literature notes made by other plugins (Zotero Integration, ZotLit) or by hand
 * (citekey-named notes) become notes this plugin owns, without touching what is there. L1: the identity keys are added to
 * the frontmatter by a line patch (missing keys only; a key naming another item refuses). L2: the owner marker and the
 * managed sections are APPENDED below the note's own text. Matching uses frontmatter citekeys, DOIs, Zotero item links
 * and keys, and the file name; several matching items go to a chooser, never to the first. Pure: no `obsidian` import.
 */
import { RAW_SOURCES_ROOT } from "./agent/reconcile-core";
import { ITEM_KEY } from "./uris";
import { selectIdentity } from "./note-aliases";
import type { CmdsZoteroSettings, ZoteroIndexEntry } from "./types";
import { managedBlock, ownerMarker } from "./note-writer";
import { layoutOf } from "./layout";
import { editFrontmatterLines, type FrontmatterEdit } from "./note-frontmatter";

/** Frontmatter keys Better BibTeX citekeys are commonly stored under by other plugins and templates. */
const CITEKEY_KEYS = ["citekey", "citationKey", "citation-key", "citation_key", "zotero_citekey"] as const;
const DOI_KEYS = ["doi", "DOI", "zotero_doi"] as const;
/** Frontmatter keys Better Notes writes into the Markdown files it syncs; such a note belongs to Better Notes. */
export const BETTER_NOTES_KEYS: readonly string[] = ["$libraryID", "$itemKey"];
/** Note types this plugin's paper hubs and analyses use: they are never adopted as literature notes. */
const HUB_TYPES = ["paper-hub", "paper-analysis", "raw-source"];

export function hasBetterNotesSync(frontmatter: Record<string, unknown> | null | undefined): boolean {
	return !!frontmatter && BETTER_NOTES_KEYS.some(key => key in frontmatter);
}

export interface AdoptNote { path: string; basename: string; frontmatter: Record<string, unknown> | null }

/** Why a note cannot be adopted at all, or null. `text`: the note text, when read (an owner marker or managed block refuses). */
export function adoptRefusal(note: AdoptNote, text?: string): string | null {
	const fm = note.frontmatter ?? {};
	if (note.path === RAW_SOURCES_ROOT || note.path.startsWith(`${RAW_SOURCES_ROOT}/`)) return "notes under Raw Sources are never adopted";
	if (typeof fm.type === "string" && HUB_TYPES.includes(fm.type.trim())) return `a ${fm.type.trim()} note is not a literature note`;
	if (fm.bookendsID !== undefined && fm.bookendsID !== null && fm.bookendsID !== "") return "the note belongs to Bookends";
	if (hasBetterNotesSync(fm)) return "the note is synced by Better Notes";
	if (text !== undefined && /<!-- cmds-zotero-owner:/.test(text)) return "the note already belongs to CMDS Zotero";
	if (text !== undefined && /<!-- \/?cmds-zotero:/.test(text)) return "the note already holds CMDS Zotero sections";
	return null;
}

/** Lookups from evidence to entry ids; unlike the alias index, a key two items share keeps both (for the chooser). */
export class AdoptIndex {
	private readonly citekeys = new Map<string, Set<string>>();
	private readonly dois = new Map<string, Set<string>>();
	private readonly selects = new Map<string, Set<string>>();
	private readonly itemKeys = new Map<string, Set<string>>();
	readonly byId: ReadonlyMap<string, ZoteroIndexEntry>;

	constructor(entries: readonly ZoteroIndexEntry[]) {
		const add = (map: Map<string, Set<string>>, key: string, id: string): void => { if (!key) return; const set = map.get(key); if (set) set.add(id); else map.set(key, new Set([id])); };
		const byId = new Map<string, ZoteroIndexEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
			for (const key of new Set([entry.citekey, ...entry.citekeyHistory])) add(this.citekeys, key, entry.id);
			if (entry.doi.trim()) add(this.dois, entry.doi.trim().toLowerCase(), entry.id);
			if (ITEM_KEY.test(entry.itemKey)) {
				add(this.selects, `${entry.libraryType}/${entry.groupID ?? 0}/${entry.itemKey}`, entry.id);
				add(this.itemKeys, entry.itemKey, entry.id);
			}
		}
		this.byId = byId;
	}

	citekey(key: string): string[] { return [...this.citekeys.get(key) ?? []]; }
	doi(doi: string): string[] { return [...this.dois.get(doi.trim().toLowerCase()) ?? []]; }
	select(uri: string): string[] {
		const parsed = selectIdentity(uri);
		return parsed ? [...this.selects.get(`${parsed.libraryType}/${parsed.groupID ?? 0}/${parsed.itemKey}`) ?? []] : [];
	}
	itemKey(key: string): string[] { return [...this.itemKeys.get(key) ?? []]; }
}

export type AdoptStrength = "strong" | "doi";
export interface AdoptMatch {
	/** Matching entries, in index order; one entry means a unique match. */
	candidates: ZoteroIndexEntry[];
	/** What matched, for the preview and the review list. */
	evidence: string[];
	/** `doi`: only a DOI matched (the batch review leaves such rows unticked). */
	strength: AdoptStrength;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string" && !!item.trim()).map(item => item.trim());
/** `zotero://select/…/items/KEY` links anywhere in a frontmatter value (ZotLit, Zotero Integration templates). */
const SELECT_LINK = /zotero:\/\/select\/(?:library|groups\/\d+)\/items\/[A-Z0-9]{8}/g;

/**
 * The items a note could be the literature note of. Strong evidence: `zoteroID`, a `zotero://select` link, `zotero-key`
 * (ZotLit; any library), a citekey in the frontmatter or as the file name (`@key` or `key`). A DOI alone is weak evidence.
 * Strong evidence wins over the DOI; all strong matches are kept (several → a chooser).
 */
export function adoptCandidates(note: AdoptNote, index: AdoptIndex): AdoptMatch {
	const fm = note.frontmatter ?? {};
	const strong = new Map<string, string[]>();
	const note_ = (map: Map<string, string[]>, ids: readonly string[], why: string): void => { for (const id of ids) map.set(id, [...map.get(id) ?? [], why]); };
	if (typeof fm.zoteroID === "string" && index.byId.has(fm.zoteroID)) note_(strong, [fm.zoteroID], "zoteroID");
	for (const value of Object.values(fm)) for (const text of strings(value)) for (const link of text.match(SELECT_LINK) ?? []) note_(strong, index.select(link), "Zotero link");
	for (const key of strings(fm["zotero-key"])) if (ITEM_KEY.test(key)) note_(strong, index.itemKey(key), "zotero-key");
	for (const field of CITEKEY_KEYS) for (const key of strings(fm[field]).map(value => value.replace(/^@/, ""))) note_(strong, index.citekey(key), `${field} @${key}`);
	const fileKey = note.basename.startsWith("@") ? note.basename.slice(1) : note.basename;
	note_(strong, index.citekey(fileKey), `file name @${fileKey}`);
	const order = (ids: Iterable<string>): ZoteroIndexEntry[] => [...ids].map(id => index.byId.get(id)).filter((entry): entry is ZoteroIndexEntry => !!entry);
	if (strong.size) return { candidates: order(strong.keys()), evidence: [...new Set([...strong.values()].flat())], strength: "strong" };
	const weak = new Map<string, string[]>();
	for (const field of DOI_KEYS) for (const doi of strings(fm[field])) note_(weak, index.doi(doi), `DOI ${doi}`);
	return { candidates: order(weak.keys()), evidence: [...new Set([...weak.values()].flat())], strength: "doi" };
}

/** L1: the identity keys an adopted note gets; only missing keys are added. A present key naming another item refuses. */
export function adoptIdentityEdit(frontmatter: Record<string, unknown> | null, entry: ZoteroIndexEntry): { edit: FrontmatterEdit } | { refuse: string } {
	const fm = frontmatter ?? {};
	const wanted: [string, string][] = [["zoteroID", entry.id], ["zoteroSelectURI", entry.zoteroSelectURI], ["zotero-key", entry.itemKey], ["citekey", entry.citekey]];
	const set: Record<string, string> = {};
	for (const [key, value] of wanted) {
		if (!(key in fm) || fm[key] === null || fm[key] === "") { if (value) set[key] = value; continue; }
		const raw = fm[key];
		const current = typeof raw === "string" ? raw.trim() : raw;
		if (key === "citekey") continue; // a citekey the note already has is kept (it may be a former key of the item)
		if (key === "zoteroSelectURI" ? selectIdentity(current)?.itemKey !== entry.itemKey : current !== value) return { refuse: `${key} in the note names another item (${typeof current === "string" ? current : JSON.stringify(current)})` };
	}
	// An empty key line (`zoteroID:`) cannot be appended twice: it is replaced instead (the R8 patch keeps its position).
	return { edit: { set, append: true, create: true } };
}

/**
 * L2: the note text with the owner marker and the managed sections appended below the note's own text (which stays byte
 * for byte, apart from trailing blank lines). Order as in a new note: overview, citation, metadata, notes, the annotations
 * heading, the annotation blocks. No Synthesis scaffold and no `## Notes` heading: the note's own text is the notes.
 */
export function appendManagedSections(text: string, entry: ZoteroIndexEntry, sections: ReadonlyMap<string, string>, settings: Pick<CmdsZoteroSettings, "annotationsHeading"> & Partial<CmdsZoteroSettings>): string {
	const layout = layoutOf(settings);
	const core = ["overview", "citation", "metadata", "notes"].map(id => managedBlock(id, sections.get(id) ?? "")).join("\n\n");
	const annotations = [...sections].filter(([id]) => id.startsWith("annotation-")).map(([id, body]) => managedBlock(id, body));
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const appended = [ownerMarker(entry.id), core, `## ${layout.annotationsHeading}`, ...annotations].join("\n\n").replace(/\n/g, eol);
	const own = text.replace(/[\r\n\s]*$/, "");
	return `${own}${own ? `${eol}${eol}` : ""}${appended}${eol}`;
}

/** The adopted note: L1 frontmatter patch, then L2 append. `body` is the patched note's body as the verification expects it. */
export function adoptedNoteText(text: string, frontmatter: Record<string, unknown> | null, entry: ZoteroIndexEntry, sections: ReadonlyMap<string, string>, settings: Pick<CmdsZoteroSettings, "annotationsHeading"> & Partial<CmdsZoteroSettings>): { text: string; edit: FrontmatterEdit; added: string[] } | { refuse: string } {
	const identity = adoptIdentityEdit(frontmatter, entry);
	if ("refuse" in identity) return identity;
	const patched = editFrontmatterLines(text, identity.edit);
	if (!patched.ok) return { refuse: patched.message };
	return { text: appendManagedSections(patched.text, entry, sections, settings), edit: identity.edit, added: [...patched.appended, ...patched.replaced] };
}
