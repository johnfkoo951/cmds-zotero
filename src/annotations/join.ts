/**
 * 0.6.1 zi-annot-concat: highlights continued with a leading `+` in their comment. Pure (no `obsidian` import).
 *
 * Runs on the reading-order list (`readingOrder` in note-writer). A text annotation (highlight or underline) whose
 * comment starts with `+` joins the open chain of the same attachment: the last text annotation before it. Image
 * annotations never join and are skipped over (they stay separate blocks); notes and ink drawings end the chain. The
 * joined annotation keeps the first annotation's key, colour, type and link, so the managed section ID stays
 * `annotation-<attachment>-<first annotation>` (no new ID kinds). Texts are joined with ` … `, comments lose the `+`,
 * tags are merged and the page label spans the chain (`3–4`). Order comes from `annotationSortIndex`, which narrows but
 * does not remove the ordering caveat for annotations made out of reading order.
 */
import type { Annotation } from "../types";

/** The page label a note shows: Zotero's label when it carries a letter or digit, else the PDF page position. */
export function displayPageLabel(a: Pick<Annotation, "page" | "pageLabel">): string {
	const page = Number.isSafeInteger(a.page) && a.page > 0 ? a.page : 1;
	return /[\p{L}\p{N}]/u.test(a.pageLabel) ? a.pageLabel : String(page);
}

const CONTINUATION = /^\s*\+/;
/** True when the annotation's comment marks it as the continuation of the previous highlight. */
export function isContinuation(a: Pick<Annotation, "comment">): boolean { return CONTINUATION.test(a.comment ?? ""); }

/** Highlights and underlines with text: the only annotations a chain can hold. */
function joinable(a: Annotation): boolean {
	const type = (a.type || "highlight").toLowerCase();
	return (type === "highlight" || type === "underline") && !!a.text && !a.imagePath;
}
const isImage = (a: Annotation): boolean => (a.type || "").toLowerCase() === "image" || !!a.imagePath;

export interface Joined<T> {
	/** The first annotation of the chain (or the lone annotation), with its attachment. */
	item: T;
	/** The annotation as rendered: the first one's identity with the chain's text, comments, tags and page span. */
	annotation: Annotation;
	/** Keys of the annotations joined into this one (empty for a lone annotation). */
	continuations: string[];
}

function merge(chain: Annotation[]): Annotation {
	const [first, ...rest] = chain;
	if (!rest.length) return first;
	const comments = [first.comment.trim(), ...rest.map(a => a.comment.replace(CONTINUATION, "").trim())].filter(Boolean);
	const seen = new Set<string>();
	const tags = chain.flatMap(a => a.tags).filter(tag => { const lower = tag.trim().toLowerCase(); if (!lower || seen.has(lower)) return false; seen.add(lower); return true; });
	const from = displayPageLabel(first);
	const to = displayPageLabel(rest[rest.length - 1]);
	return { ...first, text: chain.map(a => a.text.trim()).join(" … "), comment: comments.join(" · "), tags, pageLabel: from === to ? from : `${from}–${to}` };
}

/**
 * Joins `+` continuations in reading order. `items` carry the annotation and its attachment key; order is kept, a joined
 * chain sits where its first annotation was. A `+` with no open chain (first of its attachment, after a note or ink, or
 * not a text highlight) stays a separate annotation with its comment untouched.
 */
export function joinContinuations<T extends { attachment: { key: string }; annotation: Annotation }>(items: readonly T[]): Joined<T>[] {
	const out: { item: T; chain: Annotation[] }[] = [];
	let open: { attachment: string; at: number } | null = null;
	for (const item of items) {
		const a = item.annotation;
		if (open && open.attachment !== item.attachment.key) open = null;
		if (open && joinable(a) && isContinuation(a)) { out[open.at].chain.push(a); continue; }
		out.push({ item, chain: [a] });
		if (joinable(a)) open = { attachment: item.attachment.key, at: out.length - 1 };
		else if (!isImage(a)) open = null;
	}
	return out.map(({ item, chain }) => ({ item, annotation: merge(chain), continuations: chain.slice(1).map(a => a.key) }));
}
