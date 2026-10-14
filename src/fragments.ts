/**
 * 0.6.1 insert-item-content: parts of an item rendered for insertion into any note. Pure (no `obsidian` import).
 *
 * Every fragment comes from the same renderers as the built-in literature note (note-writer.ts), with the configured
 * callout types, so an inserted part reads exactly like the note's. The result is plain Markdown the user owns: it never
 * carries managed markers (`<!-- cmds-zotero:… -->`) or the owner marker, and HTML comment delimiters are escaped as a
 * last step. Unlike the note, a fragment is rendered whether or not its part is switched on in Note layout.
 */
import type { CmdsZoteroSettings, ZoteroIndexEntry } from "./types";
import {
	abstractCallout, annotationBody, annotationsInOrder, citationCallout, IMAGE_IN_ZOTERO, linksCallout, metadataCallout, noteBody,
	zoteroChildNotes,
} from "./note-writer";
import { layoutOf } from "./layout";

export type FragmentKind = "zotero-notes" | "citation" | "metadata" | "abstract" | "links" | "annotations";

/** The fragments in the chooser's order, with their labels. */
export const FRAGMENTS: readonly { kind: FragmentKind; label: string }[] = [
	{ kind: "zotero-notes", label: "Zotero notes" },
	{ kind: "citation", label: "Bibliography entry" },
	{ kind: "metadata", label: "Metadata fields" },
	{ kind: "abstract", label: "Abstract" },
	{ kind: "links", label: "Links" },
	{ kind: "annotations", label: "Annotations" },
];

export interface ChildNoteChoice {
	/** Position in the item's `notes` list (Zotero's order). */
	index: number;
	/** First line of the note's text, at most 80 characters, for the chooser. */
	title: string;
}

/** The item's non-empty Zotero child notes, for the chooser. */
export function childNoteChoices(entry: ZoteroIndexEntry): ChildNoteChoice[] {
	return zoteroChildNotes(entry).flatMap((note, index) => {
		// Unescaped plain text for a label (the chooser renders text, never Markdown).
		const text = note.html.replace(/<\s*(?:br\s*\/?|\/p|\/div|\/li|\/h[1-6])\s*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
		const first = text.split("\n").map(line => line.trim()).find(Boolean);
		if (!first) return [];
		return [{ index, title: first.length > 80 ? `${first.slice(0, 79)}…` : first }];
	});
}

export interface FragmentOptions {
	/** Bibliography text for `citation` (live, or the saved sidecar text offline). */
	bibliography?: string;
	/** Child notes for `zotero-notes`, by `ChildNoteChoice.index`; absent means every note. */
	notes?: readonly number[];
	/** HTML-to-Markdown converter for child notes (the plugin passes Obsidian's `htmlToMarkdown`). */
	noteMarkdown?: (html: string) => string;
	/** Citekeys of related items present in the index (the metadata `Zotero related` field). */
	related?: readonly string[];
}

/** HTML comment delimiters escaped, so inserted text can never open or close a managed block. Idempotent. */
export function userOwned(markdown: string): string {
	return markdown.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}

/** Why a fragment is empty for this item, as a sentence for the person. */
export function emptyFragmentMessage(kind: FragmentKind): string {
	switch (kind) {
		case "zotero-notes": return "This item has no Zotero notes to insert.";
		case "citation": return "No bibliography text is available for this item. Start Zotero and try again.";
		case "abstract": return "This item has no abstract.";
		case "annotations": return "This item has no annotations.";
		default: return "Nothing to insert for this item.";
	}
}

/**
 * The fragment as Markdown, or "" when the item has nothing for it (see `emptyFragmentMessage`). Image annotations are
 * linked to Zotero instead of embedding a copied image (the import copies images; insertion does not).
 */
export function renderFragment(kind: FragmentKind, entry: ZoteroIndexEntry, settings: CmdsZoteroSettings, options: FragmentOptions = {}): string {
	const callouts = layoutOf(settings).callouts;
	let text = "";
	switch (kind) {
		case "abstract": text = abstractCallout(entry, callouts.abstract); break;
		case "citation": text = citationCallout(options.bibliography ?? "", callouts.cite); break;
		case "metadata": text = metadataCallout(entry, settings, options.related ?? []); break;
		case "links": text = linksCallout(entry, callouts.links); break;
		case "zotero-notes": {
			const wanted = options.notes ? new Set(options.notes) : null;
			text = zoteroChildNotes(entry).filter((_, index) => !wanted || wanted.has(index))
				.map(note => note.html ? noteBody(note.html, options.noteMarkdown) : "").filter(Boolean).join("\n\n---\n\n");
			break;
		}
		case "annotations":
			text = annotationsInOrder(entry, settings).map(({ annotation }) => annotation.imagePath
				? annotationBody({ ...annotation, imagePath: undefined, type: "image" }, undefined, entry, settings, IMAGE_IN_ZOTERO)
				: annotationBody(annotation, undefined, entry, settings)).join("\n\n");
			break;
	}
	return userOwned(text);
}

/**
 * Inserted at a cursor, a fragment stands on its own lines (callouts only work at a line start): a blank line before it
 * when text precedes the cursor on its line, and one after it when text follows.
 */
export function framedForInsertion(text: string, beforeCursor: string, afterCursor: string): string {
	return `${beforeCursor.trim() ? "\n\n" : ""}${text}${afterCursor.trim() ? "\n\n" : "\n"}`;
}

export interface DiffLine { kind: "same" | "removed" | "added"; text: string }

/** Lines compared at most (each side); longer texts are shown as all removed, then all added. */
const MAX_DIFF_LINES = 500;

/** A line diff (longest common subsequence) of a selection and its replacement, for the replace preview. */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return [...a.map(text => ({ kind: "removed" as const, text })), ...b.map(text => ({ kind: "added" as const, text }))];
	// lcs[i][j]: common lines of a[i..] and b[j..].
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
		else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "removed", text: a[i++] });
		else out.push({ kind: "added", text: b[j++] });
	}
	while (i < a.length) out.push({ kind: "removed", text: a[i++] });
	while (j < b.length) out.push({ kind: "added", text: b[j++] });
	return out;
}
