/**
 * The Annotations sidebar filter (0.6 PERF-15). Pure: no `obsidian` import, so `tsx --test` loads it.
 *
 * The sidebar builds every card once per render and keeps each card's haystack; typing in the filter re-runs
 * `annotationVisibility` over those haystacks and toggles a CSS class, instead of sorting, lower-casing and rebuilding
 * every card on each keystroke.
 */
import type { Annotation, Attachment, ZoteroIndexEntry } from "../types";
import { ANNOTATION_COLORS, colorName } from "./colors";

/** An attachment's annotations in page order; annotations on one page keep their indexed order (the sort is stable). */
export function annotationsByPage(attachment: Pick<Attachment, "annotations">): Annotation[] {
	return [...attachment.annotations].sort((a, b) => a.page - b.page);
}

/** The text the filter matches: text, comment, tags, page label and page number, lower-cased. */
export function annotationHaystack(annotation: Pick<Annotation, "text" | "comment" | "tags" | "pageLabel" | "page">): string {
	// NFC: Korean (and other composed) text matches whether Zotero or the keyboard produced composed or decomposed forms.
	return `${annotation.text} ${annotation.comment} ${annotation.tags.join(" ")} ${annotation.pageLabel} ${annotation.page}`.normalize("NFC").toLowerCase();
}

/** The filter box value as matched: trimmed and lower-cased; an empty query shows every annotation. */
export function annotationQuery(filter: string): string {
	return filter.normalize("NFC").trim().toLowerCase();
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

// ---- 0.6.1 annotation-sidebar-facets: colour, type, tag, attachment and comment facets, sort and group ---------------

/** Sort orders: page (the 0.6.0 order), Zotero's reading order, most recently modified first, or by colour. */
export const ANNOTATION_SORTS = ["page", "reading", "modified", "color"] as const;
export type AnnotationSort = typeof ANNOTATION_SORTS[number];
/** Groupings: by attachment (the 0.6.0 layout: headings only with several attachments), by page, or by colour. */
export const ANNOTATION_GROUPS = ["attachment", "page", "color"] as const;
export type AnnotationGroup = typeof ANNOTATION_GROUPS[number];
export const COMMENT_FACETS = ["any", "with", "without"] as const;
export type CommentFacet = typeof COMMENT_FACETS[number];
/** The colour facet value of an annotation whose colour is empty or unreadable. */
export const NO_COLOR = "none";

/**
 * What the sidebar shows. Within one facet the values are alternatives (any of them); facets combine (all of them). An
 * empty list leaves that facet open; `query` is the filter box text.
 */
export interface AnnotationFacets {
	colors: string[];
	types: string[];
	tags: string[];
	attachments: string[];
	comment: CommentFacet;
	query: string;
}

export function noFacets(): AnnotationFacets { return { colors: [], types: [], tags: [], attachments: [], comment: "any", query: "" }; }

/** True when a facet or the filter text narrows the list. */
export function facetsActive(facets: AnnotationFacets): boolean {
	return !!(facets.colors.length || facets.types.length || facets.tags.length || facets.attachments.length || facets.comment !== "any" || annotationQuery(facets.query));
}

/** One annotation as the sidebar lists it, with everything the facets, sorts and groups read computed once. */
export interface AnnotationRow {
	attachment: Attachment;
	annotation: Annotation;
	/** Position of the attachment in the entry. */
	attachmentIndex: number;
	/** Position of the annotation in its attachment as indexed. */
	position: number;
	/** Position in Zotero's reading order (`readingOrder`) over the whole entry. */
	readingRank: number;
	/** Palette name, or NO_COLOR. */
	color: string;
	/** Lower-cased type; an empty type counts as highlight. */
	type: string;
	haystack: string;
}

/** Zotero reading order (note-writer `readingOrder`, restated here so this module stays light): attachments as listed, sortIndex within. */
function readingRanks(attachment: Attachment): number[] {
	const sortable = attachment.annotations.every(annotation => annotation.sortIndex);
	const order = attachment.annotations.map((annotation, position) => ({ annotation, position }));
	if (sortable) order.sort((a, b) => a.annotation.sortIndex === b.annotation.sortIndex ? a.position - b.position : (a.annotation.sortIndex ?? "") < (b.annotation.sortIndex ?? "") ? -1 : 1);
	const ranks: number[] = new Array<number>(order.length);
	order.forEach((item, rank) => { ranks[item.position] = rank; });
	return ranks;
}

/** Every annotation of the entry as a row, attachments as listed and annotations as indexed. */
export function annotationRows(entry: Pick<ZoteroIndexEntry, "attachments">): AnnotationRow[] {
	const rows: AnnotationRow[] = [];
	let offset = 0;
	entry.attachments.forEach((attachment, attachmentIndex) => {
		const ranks = readingRanks(attachment);
		attachment.annotations.forEach((annotation, position) => {
			rows.push({ attachment, annotation, attachmentIndex, position, readingRank: offset + ranks[position], color: colorName(annotation.color) ?? NO_COLOR, type: (annotation.type || "highlight").toLowerCase(), haystack: annotationHaystack(annotation) });
		});
		offset += attachment.annotations.length;
	});
	return rows;
}

/** True when the row passes every facet and the filter text. */
export function rowMatches(row: AnnotationRow, facets: AnnotationFacets, query = annotationQuery(facets.query)): boolean {
	if (facets.colors.length && !facets.colors.includes(row.color)) return false;
	if (facets.types.length && !facets.types.includes(row.type)) return false;
	if (facets.tags.length && !row.annotation.tags.some(tag => facets.tags.includes(tag))) return false;
	if (facets.attachments.length && !facets.attachments.includes(row.attachment.key)) return false;
	const commented = row.annotation.comment.trim() !== "";
	if (facets.comment === "with" && !commented) return false;
	if (facets.comment === "without" && commented) return false;
	return annotationMatches(row.haystack, query);
}

export function filterAnnotations(rows: readonly AnnotationRow[], facets: AnnotationFacets): AnnotationRow[] {
	const query = annotationQuery(facets.query);
	return rows.filter(row => rowMatches(row, facets, query));
}

const COLOR_ORDER: readonly string[] = [...ANNOTATION_COLORS, NO_COLOR];
const colorRank = (color: string): number => { const rank = COLOR_ORDER.indexOf(color); return rank < 0 ? COLOR_ORDER.length : rank; };
const byPage = (a: AnnotationRow, b: AnnotationRow): number => a.attachmentIndex - b.attachmentIndex || a.annotation.page - b.annotation.page || a.position - b.position;
const byReading = (a: AnnotationRow, b: AnnotationRow): number => a.readingRank - b.readingRank;
const COMPARE: Record<AnnotationSort, (a: AnnotationRow, b: AnnotationRow) => number> = {
	page: byPage,
	reading: byReading,
	// ISO timestamps compare as text; newest first, reading order on ties and for missing dates.
	modified: (a, b) => (a.annotation.dateModified === b.annotation.dateModified ? 0 : a.annotation.dateModified < b.annotation.dateModified ? 1 : -1) || byReading(a, b),
	color: (a, b) => colorRank(a.color) - colorRank(b.color) || byPage(a, b),
};

/** A sorted copy; ties keep a defined order (page: attachment, page, indexed position; reading: Zotero's order). */
export function sortAnnotations(rows: readonly AnnotationRow[], by: AnnotationSort): AnnotationRow[] {
	return [...rows].sort(COMPARE[by]);
}

/** One group of the list: its heading (null when the list has no headings) and its rows in display order. */
export interface AnnotationSection { key: string; heading: string | null; rows: AnnotationRow[] }

function pageLabel(annotation: Annotation): string { return annotation.pageLabel || String(annotation.page); }

/**
 * The list's sections. `attachment` is the 0.6.0 layout: one section per attachment with annotations, a heading only when
 * the entry has several attachments. `page` sections follow attachment and page order; `color` sections the palette
 * order, uncoloured last. Rows keep the order of `rows` within a section.
 */
export function groupAnnotations(rows: readonly AnnotationRow[], by: AnnotationGroup, attachmentCount: number): AnnotationSection[] {
	const sections = new Map<string, AnnotationSection & { rank: number[] }>();
	for (const row of rows) {
		const { attachment, annotation } = row;
		const name = attachment.title || attachment.key;
		const key = by === "attachment" ? attachment.key : by === "page" ? `${attachment.key}:${annotation.page}` : row.color;
		let section = sections.get(key);
		if (!section) {
			const heading = by === "attachment" ? (attachmentCount > 1 ? name : null)
				: by === "page" ? `p. ${pageLabel(annotation)}${attachmentCount > 1 ? ` · ${name}` : ""}`
				: row.color === NO_COLOR ? "No color" : row.color.charAt(0).toUpperCase() + row.color.slice(1);
			const rank = by === "attachment" ? [row.attachmentIndex] : by === "page" ? [row.attachmentIndex, annotation.page] : [colorRank(row.color)];
			section = { key, heading, rows: [], rank };
			sections.set(key, section);
		}
		section.rows.push(row);
	}
	return [...sections.values()].sort((a, b) => a.rank[0] - b.rank[0] || (a.rank[1] ?? 0) - (b.rank[1] ?? 0)).map(({ key, heading, rows: list }) => ({ key, heading, rows: list }));
}

/** Which cards and section headings the facets show, given the sections in display order. */
export function sectionVisibility(sections: readonly AnnotationSection[], facets: AnnotationFacets): AnnotationVisibility {
	const query = annotationQuery(facets.query);
	const cards = sections.map(section => section.rows.map(row => rowMatches(row, facets, query)));
	return { cards, headings: cards.map(group => group.includes(true)), shown: cards.reduce((count, group) => count + group.filter(Boolean).length, 0) };
}

/** Value → count over `rows`, in first-seen order (colours: palette order). */
export interface FacetCounts { colors: [string, number][]; types: [string, number][]; tags: [string, number][]; attachments: [string, number][] }

export function facetCounts(rows: readonly AnnotationRow[]): FacetCounts {
	const count = (values: Iterable<string>, into: Map<string, number>): void => { for (const value of values) into.set(value, (into.get(value) ?? 0) + 1); };
	const colors = new Map<string, number>(), types = new Map<string, number>(), tags = new Map<string, number>(), attachments = new Map<string, number>();
	for (const row of rows) {
		count([row.color], colors);
		count([row.type], types);
		count(new Set(row.annotation.tags), tags);
		count([row.attachment.key], attachments);
	}
	return { colors: [...colors].sort((a, b) => colorRank(a[0]) - colorRank(b[0])), types: [...types], tags: [...tags], attachments: [...attachments] };
}

/** The list's message when no card is shown, with facets counted as a filter. */
export function emptyListText(facets: AnnotationFacets, attachmentStatus: ZoteroIndexEntry["attachmentStatus"]): string {
	return emptyAnnotationsText(facetsActive(facets) ? "filtered" : "", attachmentStatus);
}
