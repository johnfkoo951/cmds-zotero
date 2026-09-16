/**
 * Resolves which Zotero item a vault note is about (0.5 R14 ladder). Pure: never imports `obsidian`.
 * Evidence, strongest first: `zoteroID`, then `zoteroSelectURI`, then the ZotLit `zotero-key` (only while the index holds
 * exactly one library), then citekey equality against the current key or its history — and citekey evidence counts only
 * for notes whose basename starts with `@` or whose `type` is one of `ZOTERO_NOTE_TYPES`. Notes carrying a foreign identity
 * (Bookends, DEVONthink, any other `type`) are never claimed: Bookends auto-citekeys share the lastname+year shape of BBT keys.
 */
import type { ZoteroIndexEntry } from "./types";
import { ZOTERO_NOTE_TYPES } from "./agent/types";
import { ITEM_KEY, parseZoteroURI } from "./uris";

export interface AliasIndex {
	ids: Set<string>;
	/** Current citekeys and history → entry id; `null` once two items claim the same key. */
	aliases: Map<string, string | null>;
	/** `libraryType/groupID/itemKey` (the identity a `zotero://select` URI carries) → entry id; `null` on collision. */
	selects: Map<string, string | null>;
	/** Bare item key → entry id; usable as ZotLit evidence only while `singleLibrary` holds. */
	itemKeys: Map<string, string | null>;
	singleLibrary: boolean;
}

const FOREIGN_LINK = /\b(?:bookends|x-devonthink-item):\/\//;
type Frontmatter = Record<string, unknown>;

function claim(map: Map<string, string | null>, key: string, id: string): void {
	if (!map.has(key)) map.set(key, id);
	else if (map.get(key) !== id) map.set(key, null);
}

function selectKey(libraryType: string, groupID: number | undefined, itemKey: string): string {
	return `${libraryType}/${groupID ?? 0}/${itemKey}`;
}

export function buildAliasIndex(entries: ZoteroIndexEntry[]): AliasIndex {
	const ids = new Set(entries.map(entry => entry.id));
	const aliases = new Map<string, string | null>();
	const selects = new Map<string, string | null>();
	const itemKeys = new Map<string, string | null>();
	for (const entry of entries) {
		for (const alias of new Set([entry.citekey, ...entry.citekeyHistory])) claim(aliases, alias, entry.id);
		if (typeof entry.itemKey === "string" && ITEM_KEY.test(entry.itemKey)) {
			claim(selects, selectKey(entry.libraryType, entry.groupID, entry.itemKey), entry.id);
			claim(itemKeys, entry.itemKey, entry.id);
		}
	}
	return { ids, aliases, selects, itemKeys, singleLibrary: new Set(entries.map(entry => entry.libraryID)).size === 1 };
}

function typeOf(frontmatter: Frontmatter): string {
	return typeof frontmatter.type === "string" ? frontmatter.type.trim() : "";
}

function isZoteroType(type: string): boolean {
	return (ZOTERO_NOTE_TYPES as readonly string[]).includes(type);
}

/**
 * True for notes that belong to another reference manager's convention: a `bookendsID`, a `bookends://` or
 * `x-devonthink-item://` link anywhere in the frontmatter, or a `type` outside `ZOTERO_NOTE_TYPES`.
 */
export function hasForeignIdentity(frontmatter: Frontmatter | undefined): boolean {
	if (!frontmatter) return false;
	const bookends = frontmatter.bookendsID;
	if (bookends !== undefined && bookends !== null && bookends !== "") return true;
	const type = typeOf(frontmatter);
	if (type && !isZoteroType(type)) return true;
	for (const value of Object.values(frontmatter)) {
		for (const item of Array.isArray(value) ? value : [value]) if (typeof item === "string" && FOREIGN_LINK.test(item)) return true;
	}
	return false;
}

/** Citekey equality identifies a note only when its basename starts with `@` or its `type` is a Zotero note type. */
export function citekeyEvidenceAllowed(basename: string, frontmatter: Frontmatter | undefined): boolean {
	return basename.startsWith("@") || (frontmatter !== undefined && isZoteroType(typeOf(frontmatter)));
}

/** The item a valid `zotero://select` URI names, or null for absent, malformed or non-select URIs. */
export function selectIdentity(uri: unknown): { libraryType: "user" | "group"; groupID?: number; itemKey: string } | null {
	if (typeof uri !== "string" || !uri.trim()) return null;
	try {
		const parsed = parseZoteroURI(uri.trim());
		return parsed.action === "select" ? parsed : null;
	} catch {
		return null;
	}
}

export function noteIdentity(basename: string, frontmatter: Frontmatter | undefined, lookup: AliasIndex): string | null {
	const fm = frontmatter ?? {};
	if (typeof fm.zoteroID === "string") return lookup.ids.has(fm.zoteroID) ? fm.zoteroID : null;
	if (hasForeignIdentity(fm)) return null;
	const select = selectIdentity(fm.zoteroSelectURI);
	if (select) return lookup.selects.get(selectKey(select.libraryType, select.groupID, select.itemKey)) ?? null;
	const zotLitKey = typeof fm["zotero-key"] === "string" ? fm["zotero-key"].trim() : "";
	if (lookup.singleLibrary && ITEM_KEY.test(zotLitKey)) return lookup.itemKeys.get(zotLitKey) ?? null;
	if (!citekeyEvidenceAllowed(basename, fm)) return null;
	const candidates = [basename.startsWith("@") ? basename.slice(1) : undefined, fm.citekey];
	const matches = new Set<string>();
	for (const alias of candidates) {
		if (typeof alias !== "string" || !lookup.aliases.has(alias)) continue;
		const id = lookup.aliases.get(alias);
		if (id === null) return null;
		if (id) matches.add(id);
	}
	return matches.size === 1 ? [...matches][0] : null;
}
