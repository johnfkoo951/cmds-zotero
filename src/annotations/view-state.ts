/**
 * The Annotations sidebar's persistent state (0.6.1 annotation-sidebar-modes): what it follows, the pinned or selected
 * item, and its facets, sort and grouping, as the workspace layout stores them. Also resolves each source to an index
 * entry by identity (library ID and item key), never by citekey alone and never by taking the first of several matches.
 * Pure: no `obsidian` import.
 */
import type { ZoteroIndexEntry } from "../types";
import { ITEM_KEY, positiveInteger } from "../uris";
import { indexDerived } from "../index-derived";
import { ANNOTATION_COLORS } from "./colors";
import { ANNOTATION_GROUPS, ANNOTATION_SORTS, COMMENT_FACETS, NO_COLOR, noFacets, type AnnotationFacets, type AnnotationGroup, type AnnotationSort, type CommentFacet } from "./filter";
import type { SelectedItem } from "../library/selection";

/**
 * note: the active literature note. selection: the item last read from Zotero's library-pane selection (read on demand,
 * never by a listener). cursor: the citekey under the editor cursor. pinned: one chosen item.
 */
export const SIDEBAR_MODES = ["note", "selection", "cursor", "pinned"] as const;
export type SidebarMode = typeof SIDEBAR_MODES[number];

/** An item by identity, as the layout stores it. */
export interface ItemRef { libraryID: number; itemKey: string }

export interface AnnotationsViewState {
	mode: SidebarMode;
	/** The pinned item; pinned mode always has one. */
	pinned: ItemRef | null;
	/** The item last read from the Zotero selection; null when nothing usable was selected (the mode stays). */
	selected: ItemRef | null;
	facets: AnnotationFacets;
	sort: AnnotationSort;
	group: AnnotationGroup;
}

export function defaultViewState(): AnnotationsViewState {
	return { mode: "note", pinned: null, selected: null, facets: noFacets(), sort: "page", group: "attachment" };
}

/** Bounds for stored facet lists and the filter text: a damaged layout cannot grow the sidebar's state without limit. */
const MAX_VALUES = 64;
const MAX_QUERY = 500;
const COLOR_VALUES: readonly string[] = [...ANNOTATION_COLORS, NO_COLOR];

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}
function strings(value: unknown, keep: (item: string) => boolean = () => true): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim() !== "" && item.length <= 200).filter(keep))].slice(0, MAX_VALUES);
}

/** A stored item identity, or null unless it has a positive library ID and an eight-character item key. */
export function parseItemRef(value: unknown): ItemRef | null {
	const raw = record(value);
	if (!raw || !positiveInteger(raw.libraryID) || typeof raw.itemKey !== "string" || !ITEM_KEY.test(raw.itemKey)) return null;
	return { libraryID: raw.libraryID, itemKey: raw.itemKey };
}

export function parseFacets(value: unknown): AnnotationFacets {
	const raw = record(value);
	if (!raw) return noFacets();
	return {
		colors: strings(raw.colors, item => COLOR_VALUES.includes(item)),
		types: strings(raw.types).map(item => item.toLowerCase()),
		tags: strings(raw.tags),
		attachments: strings(raw.attachments, item => ITEM_KEY.test(item)),
		comment: oneOf<CommentFacet>(raw.comment, COMMENT_FACETS, "any"),
		query: typeof raw.query === "string" ? raw.query.slice(0, MAX_QUERY) : "",
	};
}

/**
 * The state a layout stored, or the defaults. An unknown mode, or pinned mode without a valid pinned identity, falls back
 * to note mode; each other field falls back on its own, so one damaged field does not reset the rest.
 */
export function parseViewState(value: unknown): AnnotationsViewState {
	const raw = record(value);
	const state = defaultViewState();
	if (!raw) return state;
	const pinned = parseItemRef(raw.pinned);
	const mode = oneOf<SidebarMode>(raw.mode, SIDEBAR_MODES, "note");
	return {
		mode: mode === "pinned" && !pinned ? "note" : mode,
		pinned,
		selected: parseItemRef(raw.selected),
		facets: parseFacets(raw.facets),
		sort: oneOf<AnnotationSort>(raw.sort, ANNOTATION_SORTS, state.sort),
		group: oneOf<AnnotationGroup>(raw.group, ANNOTATION_GROUPS, state.group),
	};
}

/** Plain JSON for the layout; `parseViewState(serializeViewState(s))` equals `s` for every parsed state. */
export function serializeViewState(state: AnnotationsViewState): Record<string, unknown> {
	const ref = (item: ItemRef | null): ItemRef | null => item ? { libraryID: item.libraryID, itemKey: item.itemKey } : null;
	const { colors, types, tags, attachments, comment, query } = state.facets;
	return { mode: state.mode, pinned: ref(state.pinned), selected: ref(state.selected), facets: { colors: [...colors], types: [...types], tags: [...tags], attachments: [...attachments], comment, query }, sort: state.sort, group: state.group };
}

export function itemRef(entry: Pick<ZoteroIndexEntry, "libraryID" | "itemKey">): ItemRef { return { libraryID: entry.libraryID, itemKey: entry.itemKey }; }

/** The index entry with exactly this identity, or null (no citekey fallback). */
export function entryForRef(entries: readonly ZoteroIndexEntry[], ref: ItemRef | null): ZoteroIndexEntry | null {
	if (!ref || !entries.length) return null;
	const found = indexDerived(entries).entriesWithId(`${ref.libraryID}:${ref.itemKey}`);
	const matches = found.filter(entry => entry.libraryID === ref.libraryID && entry.itemKey === ref.itemKey);
	return matches.length === 1 ? matches[0] : null;
}

export type CursorTarget =
	| { kind: "none" }
	| { kind: "resolved"; entry: ZoteroIndexEntry }
	| { kind: "ambiguous"; citekey: string; count: number }
	| { kind: "not-found"; citekey: string };

/**
 * The entry a citekey under the cursor names: the one entry whose current citekey it is, else the one entry that used it
 * before. Several candidates (a citekey is unique only within a library) are ambiguous, never the first.
 */
export function cursorTarget(entries: readonly ZoteroIndexEntry[], citekey: string): CursorTarget {
	if (!citekey) return { kind: "none" };
	const all = entries.length ? indexDerived(entries).entriesWithCitekey(citekey) : [];
	const current = all.filter(entry => entry.citekey === citekey);
	const pool = current.length ? current : all;
	if (pool.length === 1) return { kind: "resolved", entry: pool[0] };
	return pool.length ? { kind: "ambiguous", citekey, count: pool.length } : { kind: "not-found", citekey };
}

export type SelectionTarget =
	| { kind: "empty" }
	| { kind: "resolved"; entry: ZoteroIndexEntry }
	| { kind: "several"; entries: ZoteroIndexEntry[] }
	| { kind: "not-indexed"; count: number };

/** The indexed entries of a Zotero selection, by identity. Several are offered as a choice; none is never guessed. */
export function selectionTarget(entries: readonly ZoteroIndexEntry[], selected: readonly Pick<SelectedItem, "libraryID" | "itemKey">[]): SelectionTarget {
	if (!selected.length) return { kind: "empty" };
	const found = selected.map(item => entryForRef(entries, item)).filter((entry): entry is ZoteroIndexEntry => entry !== null);
	if (!found.length) return { kind: "not-indexed", count: selected.length };
	return found.length === 1 ? { kind: "resolved", entry: found[0] } : { kind: "several", entries: found };
}

/** The in-place explanation for a mode whose source shows nothing; the mode itself does not change. */
export function emptySourceText(mode: SidebarMode, detail: { cursor?: CursorTarget; selected?: boolean } = {}): string {
	if (mode === "pinned") return "The pinned item is not in the index. Refresh the index, or choose another item.";
	if (mode === "selection") return detail.selected ? "The item read from the Zotero selection is not in the index. Refresh the index, or select another item and read the selection again." : "Select an item in Zotero, then read the Zotero selection.";
	if (mode === "cursor") {
		const cursor = detail.cursor;
		if (cursor?.kind === "ambiguous") return `@${cursor.citekey} names ${cursor.count} items in different libraries. Pin one of them instead.`;
		if (cursor?.kind === "not-found") return `@${cursor.citekey} is not in the index.`;
		return "Put the cursor on a @citekey in a note to see that item's annotations.";
	}
	return "Open a literature note, or pin a Zotero item, to see its annotations.";
}
