/**
 * Search every indexed annotation and the text inserting one writes (0.6.1 annotation-search-insert). Rows are prepared
 * once per index generation from the saved snapshot; searching never calls Better BibTeX. Matching is word by word
 * (every word of the query must occur), on NFC-normalized, lower-cased text, so Korean typed or stored in composed or
 * decomposed form matches. Pure: no `obsidian` import.
 */
import type { Annotation, Attachment, CmdsZoteroSettings, ZoteroIndexEntry } from "../types";
import { annotationBody, annotationURI, noteInline, readingOrder, renderedAnnotation } from "../note-writer";
import { userOwned } from "../fragments";
import { richTextPlain } from "./rich-text";
import { markdownLink } from "../uris";
import { colorName } from "./colors";
import { citationFor, citationPage } from "./card-actions";

export interface AnnotationSearchRow {
	entry: ZoteroIndexEntry;
	attachment: Attachment;
	annotation: Annotation;
	/** What the row shows first: the highlighted text, else the comment, else the annotation kind. */
	snippet: string;
	/** `p. 12 · @citekey · yellow`. */
	label: string;
	/** Annotation text, comment and tags (matched first), then page label, colour, citekey and title. */
	primary: string;
	secondary: string;
}

const normalized = (value: string): string => value.normalize("NFC").toLowerCase();

/** The row for one annotation. */
export function annotationSearchRow(entry: ZoteroIndexEntry, attachment: Attachment, annotation: Annotation, excludedTags: readonly string[] = []): AnnotationSearchRow {
	const excluded = new Set(excludedTags.map(tag => tag.toLowerCase()));
	const color = colorName(annotation.color);
	const type = (annotation.type || "highlight").toLowerCase();
	const text = richTextPlain(annotation.text);
	const comment = richTextPlain(annotation.comment);
	const snippet = (text || comment || (annotation.imagePath || type === "image" ? "Image annotation" : type === "ink" ? "Ink annotation" : "Empty annotation")).replace(/\s+/g, " ").trim();
	const label = [`p. ${citationPage(annotation)}`, `@${entry.citekey}`, ...(color ? [color] : [])].join(" · ");
	return {
		entry, attachment, annotation, snippet, label,
		primary: normalized(`${text} ${comment} ${annotation.tags.filter(tag => !excluded.has(tag.trim().toLowerCase())).join(" ")}`),
		secondary: normalized(`${annotation.pageLabel} ${color ?? ""} ${type} @${entry.citekey} ${entry.citekey} ${entry.title}`),
	};
}

/** Every annotation of every entry, entry by entry in reading order. */
export function annotationSearchRows(entries: readonly ZoteroIndexEntry[], excludedTags: readonly string[] = []): AnnotationSearchRow[] {
	return entries.flatMap(entry => readingOrder(entry).map(({ attachment, annotation }) => annotationSearchRow(entry, attachment, annotation, excludedTags)));
}

const prepared = new WeakMap<readonly ZoteroIndexEntry[], { excluded: string; rows: AnnotationSearchRow[] }>();

/** The rows of one index generation (its entries array), built on first use and reused after that. */
export function preparedSearchRows(entries: readonly ZoteroIndexEntry[], excludedTags: readonly string[] = []): AnnotationSearchRow[] {
	const excluded = excludedTags.join("\n");
	let cached = prepared.get(entries);
	if (!cached || cached.excluded !== excluded) { cached = { excluded, rows: annotationSearchRows(entries, excludedTags) }; prepared.set(entries, cached); }
	return cached.rows;
}

/**
 * The rows matching every word of `query`, best first: rows whose words all occur in the annotation's own text, comment
 * or tags come before rows that need the page, colour, citekey or title; ties keep reading order. An empty query lists
 * the first `limit` rows.
 */
export function searchAnnotations(rows: readonly AnnotationSearchRow[], query: string, limit = 100): AnnotationSearchRow[] {
	const words = normalized(query).split(/\s+/).filter(Boolean);
	if (!words.length) return rows.slice(0, limit);
	const own: AnnotationSearchRow[] = [];
	const other: AnnotationSearchRow[] = [];
	for (const row of rows) {
		if (words.every(word => row.primary.includes(word))) own.push(row);
		else if (words.every(word => row.primary.includes(word) || row.secondary.includes(word))) other.push(row);
		if (own.length >= limit) break;
	}
	return [...own, ...other].slice(0, limit);
}

/** What the search shows when it lists nothing. */
export function searchEmptyText(indexLoaded: boolean, rowCount: number): string {
	if (!indexLoaded) return "The index is not loaded yet. Open the annotations sidebar or refresh the index, then search again.";
	if (!rowCount) return "No annotations are indexed. Refresh the index after annotating PDFs in Zotero.";
	return "No annotations match.";
}

/**
 * callout: the CMDS callout an import writes (an image only when `image` names its copied vault file).
 * quote: the text as a blockquote ending in `[@citekey, p. label]` and a link to the annotation.
 * link: only the Markdown link that opens the annotation in Zotero's PDF reader.
 */
export type InsertMode = "callout" | "quote" | "link";

/** True for annotations without quotable text: images and drawings insert links only. */
export function linkOnly(annotation: Annotation): boolean {
	const type = (annotation.type || "highlight").toLowerCase();
	return Boolean(annotation.imagePath) || type === "image" || type === "ink" || !annotation.text.trim();
}

/** The text inserting `annotation` writes in `mode`. `image` is the vault path of its copied image, when there is one. */
export function annotationInsertText(mode: InsertMode, annotation: Annotation, entry: ZoteroIndexEntry, settings: CmdsZoteroSettings, image?: string): string {
	// The text is the user's once inserted: what the note renders for this annotation, with marker-like comments defused.
	return userOwned(insertText(mode, renderedAnnotation(entry, annotation, settings), entry, settings, image));
}

function insertText(mode: InsertMode, annotation: Annotation, entry: ZoteroIndexEntry, settings: CmdsZoteroSettings, image?: string): string {
	const link = markdownLink(`${entry.title} — p. ${citationPage(annotation)}`, annotationURI(annotation, entry));
	if (mode === "link") return link;
	if (mode === "callout") {
		if (annotation.imagePath && !image) return markdownLink(`Image annotation, p. ${citationPage(annotation)}`, annotationURI(annotation, entry));
		return annotationBody(annotation, annotation.imagePath ? image : undefined, entry, settings);
	}
	if (linkOnly(annotation)) return link;
	// Escaped like the note's own annotation text (Zotero rich text only when the layout reads it).
	const lines = annotation.text.replace(/\r\n?/g, "\n").split("\n").map(line => noteInline(line, settings.noteRichText === true)).filter(Boolean);
	return [...lines.map(line => `> ${line}`), `> — ${citationFor(annotation, entry, { link: true })}`].join("\n");
}
