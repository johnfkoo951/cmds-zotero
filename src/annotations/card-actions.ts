/**
 * Text the Annotations sidebar's card actions copy (0.6.1 annotation-card-actions): a pandoc citation with the printed
 * page, library-scoped keys, the rename-safe identity link to the annotation, and the normalized annotation data shown
 * read-only (in place of a template data explorer; there is no template engine). Pure: no `obsidian` import.
 */
import type { Annotation, Attachment, ZoteroIndexEntry } from "../types";
import { annotationURI } from "../note-writer";
import { markdownLink, noteDeepLink } from "../uris";

/** The palette-reachable card actions, in menu order; the view runs them on the focused card. */
export const CARD_ACTIONS = [
	{ id: "copy-citation", name: "Copy as citation" },
	{ id: "copy-citation-link", name: "Copy as citation with Zotero link" },
	{ id: "copy-callout", name: "Copy callout" },
	{ id: "copy-bibliography", name: "Copy bibliography entry" },
	{ id: "copy-annotation-key", name: "Copy annotation key" },
	{ id: "copy-item-key", name: "Copy item key" },
	{ id: "copy-identity-link", name: "Copy identity link" },
	{ id: "show-data", name: "Show annotation data" },
] as const;
export type CardActionId = typeof CARD_ACTIONS[number]["id"];

/** A usable PDF page position: the annotation's, or 1. */
export function pagePosition(annotation: Pick<Annotation, "page">): number {
	return Number.isSafeInteger(annotation.page) && annotation.page > 0 ? annotation.page : 1;
}

/**
 * The printed page label as citations show it: Zotero's label when it carries a letter or digit (placeholders such as
 * "-" do not), else the PDF page position; on one line, without brackets or semicolons that would end a pandoc citation.
 */
export function citationPage(annotation: Pick<Annotation, "page" | "pageLabel">): string {
	const label = /[\p{L}\p{N}]/u.test(annotation.pageLabel) ? annotation.pageLabel : String(pagePosition(annotation));
	return label.replace(/[[\];]/g, "").replace(/\s+/g, " ").trim() || String(pagePosition(annotation));
}

/** `[@citekey, p. <label>]`; with `link`, followed by a Markdown link to the annotation in Zotero's PDF reader. */
export function citationFor(annotation: Annotation, entry: ZoteroIndexEntry, options: { link?: boolean } = {}): string {
	const citation = `[@${entry.citekey}, p. ${citationPage(annotation)}]`;
	return options.link ? `${citation} ${markdownLink("Zotero", annotationURI(annotation, entry))}` : citation;
}

/** A Zotero key as people paste it: bare in the personal library, `<libraryID>:<key>` in a group library. */
export function scopedKey(key: string, entry: Pick<ZoteroIndexEntry, "libraryID" | "libraryType">): string {
	return entry.libraryType === "group" ? `${entry.libraryID}:${key}` : key;
}

/** The rename-safe `obsidian://cmds-zotero` link that opens this annotation's PDF page. */
export function identityLinkFor(vault: string, annotation: Pick<Annotation, "key" | "page">, entry: ZoteroIndexEntry): string {
	return noteDeepLink(vault, entry, "pdf", pagePosition(annotation), annotation.key);
}

/** The normalized annotation with the item and attachment it belongs to (no local attachment path). */
export function annotationData(annotation: Annotation, attachment: Pick<Attachment, "key" | "title" | "contentType">, entry: ZoteroIndexEntry): Record<string, unknown> {
	return {
		item: { id: entry.id, libraryID: entry.libraryID, libraryType: entry.libraryType, ...(entry.groupID !== undefined ? { groupID: entry.groupID } : {}), itemKey: entry.itemKey, citekey: entry.citekey, title: entry.title },
		attachment: { key: attachment.key, title: attachment.title, ...(attachment.contentType ? { contentType: attachment.contentType } : {}) },
		annotation: { ...annotation },
	};
}

export function annotationDataText(annotation: Annotation, attachment: Pick<Attachment, "key" | "title" | "contentType">, entry: ZoteroIndexEntry): string {
	return JSON.stringify(annotationData(annotation, attachment, entry), null, 2);
}
