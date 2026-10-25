/**
 * 0.6.2 pasting or dropping Zotero links into a note: `zotero://select/library/items/KEY`,
 * `zotero://select/groups/N/items/KEY`, Zotero's `zotero://select/items/<libraryID>_KEY` and Better BibTeX's
 * `zotero://select/items/@citekey`. Items are matched against the saved index by library and item key (or, for the
 * Better BibTeX citekey form, by citekey), never by a first match. Pure: never imports `obsidian`.
 */
import type { ZoteroIndexEntry } from "../types";
import { ITEM_KEY } from "../uris";
import { UNICODE_KEY } from "./cluster";

export type PastedRef =
	| { kind: "item"; libraryType: "user" | "group"; groupID?: number; itemKey: string; text: string }
	| { kind: "library-item"; libraryID: number; itemKey: string; text: string }
	| { kind: "citekey"; citekey: string; text: string };

const LINK = new RegExp(`^<?zotero://select/(?:(library)/items/([A-Z0-9]{8})|groups/([1-9]\\d*)/items/([A-Z0-9]{8})|items/([1-9]\\d*)_([A-Z0-9]{8})|items/@(${UNICODE_KEY}))>?$`, "u");

/**
 * The Zotero item links of a pasted or dropped text, or null when the text is anything else: only text made entirely of
 * such links (separated by whitespace, commas or semicolons) is taken, so ordinary pastes are never touched.
 */
export function parsePastedLinks(text: string): PastedRef[] | null {
	const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
	if (!parts.length || parts.length > 50) return null;
	const refs: PastedRef[] = [];
	for (const part of parts) {
		const match = LINK.exec(part);
		if (!match) return null;
		if (match[1]) refs.push({ kind: "item", libraryType: "user", itemKey: match[2], text: part });
		else if (match[3]) refs.push({ kind: "item", libraryType: "group", groupID: Number(match[3]), itemKey: match[4], text: part });
		else if (match[5]) refs.push({ kind: "library-item", libraryID: Number(match[5]), itemKey: match[6], text: part });
		else refs.push({ kind: "citekey", citekey: match[7], text: part });
	}
	return refs.every(ref => ref.kind === "citekey" || ITEM_KEY.test(ref.itemKey)) ? refs : null;
}

export type PastedResolution =
	| { status: "resolved"; entry: ZoteroIndexEntry }
	| { status: "ambiguous"; candidates: ZoteroIndexEntry[] }
	| { status: "not-found" };

/** Finds the entry a pasted link names in `entries`: library and item key must both match (or the citekey for `@key`). */
export function resolvePastedRef(ref: PastedRef, entries: readonly ZoteroIndexEntry[]): PastedResolution {
	let matches: ZoteroIndexEntry[];
	if (ref.kind === "citekey") {
		matches = entries.filter(entry => entry.citekey === ref.citekey);
		if (!matches.length) matches = entries.filter(entry => entry.citekeyHistory.includes(ref.citekey));
	} else if (ref.kind === "library-item") matches = entries.filter(entry => entry.libraryID === ref.libraryID && entry.itemKey === ref.itemKey);
	else if (ref.libraryType === "group") matches = entries.filter(entry => entry.libraryType === "group" && entry.groupID === ref.groupID && entry.itemKey === ref.itemKey);
	else matches = entries.filter(entry => entry.libraryType === "user" && entry.itemKey === ref.itemKey);
	if (matches.length === 1) return { status: "resolved", entry: matches[0] };
	return matches.length ? { status: "ambiguous", candidates: matches } : { status: "not-found" };
}
