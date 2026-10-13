/**
 * The Annotations sidebar filter (0.6 PERF-15). Pure: no `obsidian` import, so `tsx --test` loads it.
 *
 * The sidebar builds every card once per render and keeps each card's haystack; typing in the filter re-runs
 * `annotationVisibility` over those haystacks and toggles a CSS class, instead of sorting, lower-casing and rebuilding
 * every card on each keystroke.
 */
import type { Annotation, Attachment, ZoteroIndexEntry } from "../types";

/** An attachment's annotations in page order; annotations on one page keep their indexed order (the sort is stable). */
export function annotationsByPage(attachment: Pick<Attachment, "annotations">): Annotation[] {
	return [...attachment.annotations].sort((a, b) => a.page - b.page);
}

/** The text the filter matches: text, comment, tags, page label and page number, lower-cased. */
export function annotationHaystack(annotation: Pick<Annotation, "text" | "comment" | "tags" | "pageLabel" | "page">): string {
	return `${annotation.text} ${annotation.comment} ${annotation.tags.join(" ")} ${annotation.pageLabel} ${annotation.page}`.toLowerCase();
}

/** The filter box value as matched: trimmed and lower-cased; an empty query shows every annotation. */
export function annotationQuery(filter: string): string {
	return filter.trim().toLowerCase();
}

export function annotationMatches(haystack: string, query: string): boolean {
	return !query || haystack.includes(query);
}

export interface AnnotationVisibility {
	/** Per attachment group, per card (in display order): shown. */
	cards: boolean[][];
	/** Per attachment group: its heading is shown, which it is while one of its cards is. */
	headings: boolean[];
	/** Cards shown in all; the list's message shows when none is. */
	shown: number;
}

/** Which cards and attachment headings `query` shows, given each group's card haystacks in display order. */
export function annotationVisibility(groups: readonly (readonly string[])[], query: string): AnnotationVisibility {
	const cards = groups.map(haystacks => haystacks.map(haystack => annotationMatches(haystack, query)));
	return { cards, headings: cards.map(group => group.includes(true)), shown: cards.reduce((count, group) => count + group.filter(Boolean).length, 0) };
}

/** The list's message when no card is shown. */
export function emptyAnnotationsText(query: string, attachmentStatus: ZoteroIndexEntry["attachmentStatus"]): string {
	if (query) return "No annotations match the filter.";
	return attachmentStatus === "unavailable" ? "Attachment lookup failed at the last refresh. Refresh the index." : "No annotations are indexed for this item.";
}
