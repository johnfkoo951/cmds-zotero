/**
 * The items selected in Zotero's library pane, read on demand (0.6.1): Better BibTeX's pull export of the selection
 * (`GET /better-bibtex/export/selected?jzon`, BBT JSON with `libraryID` and `itemKey` per item; HTTP 404 "no selection"
 * when nothing is selected, live-probed on Zotero 10.0.6 / BBT 9.0.71). There is no listener: callers ask when the person acts, or poll with their own interval.
 * Read-only. Pure: the HTTP answer is passed in, and there is no `obsidian` import.
 */
import { BbtTransportError } from "../api/transport";
import { text } from "../api/normalize";
import { record } from "../identity";
import { positiveInteger } from "../uris";

export interface SelectedItem { libraryID: number; itemKey: string; citekey: string; title: string; itemType: string }

/** Item types that are never a source of their own: notes, attachments and annotations are skipped. */
const CHILD_TYPES: ReadonlySet<string> = new Set(["note", "attachment", "annotation"]);

/**
 * The regular items of one selection answer, in Zotero's order, each once. 404 "no selection" is an empty selection; any other status, or
 * a body that is not BBT JSON with an `items` list, is a typed fault. An item without a library ID, an eight-character
 * item key or a citekey is left out (it cannot be matched to the index).
 */
export function parseSelection(status: number, body: string, endpoint: string): SelectedItem[] {
	// BBT answers an empty selection with 404 "no selection"; any other 404 means the endpoint is missing.
	if (status === 404 && /no selection/i.test(body)) return [];
	if (status === 404) throw new BbtTransportError("http-404", endpoint, "BBT selection export HTTP 404", { status });
	if (status !== 200) throw new BbtTransportError("http-other", endpoint, `BBT selection export HTTP ${status}`, { status });
	let parsed: unknown;
	try { parsed = JSON.parse(body); } catch { throw new BbtTransportError("invalid-response", endpoint, "The selection export is not JSON"); }
	if (!record(parsed) || !Array.isArray(parsed.items)) throw new BbtTransportError("invalid-response", endpoint, "The selection export has no items list");
	const seen = new Set<string>();
	const items: SelectedItem[] = [];
	for (const raw of parsed.items) {
		if (!record(raw)) continue;
		const itemType = text(raw.itemType);
		const libraryID = raw.libraryID;
		const itemKey = text(raw.itemKey);
		const citekey = text(raw.citationKey) || text(raw.citekey);
		if (CHILD_TYPES.has(itemType) || !positiveInteger(libraryID) || !/^[A-Z0-9]{8}$/.test(itemKey) || !citekey) continue;
		const id = `${libraryID}:${itemKey}`;
		if (seen.has(id)) continue;
		seen.add(id);
		items.push({ libraryID, itemKey, citekey, title: text(raw.title), itemType });
	}
	return items;
}

/** The index id (`libraryID:itemKey`) of a selected item, as index entries carry it. */
export function selectedId(item: Pick<SelectedItem, "libraryID" | "itemKey">): string { return `${item.libraryID}:${item.itemKey}`; }

// 0.6.1 zotero-selection-commands: what Open, Import and Cite do with one selection answer.

/**
 * A selection matched to the saved index by exact id (`libraryID:itemKey`), never by citekey or title and never by a
 * first match: `empty` when nothing regular is selected, `unindexed` when none of the selected items is in the index,
 * otherwise the indexed entries in Zotero's order (`one` or `several`) plus the selected items the index lacks. An id the
 * index holds twice counts as not indexed.
 */
export type SelectionPlan<E> =
	| { kind: "empty" }
	| { kind: "unindexed"; unindexed: SelectedItem[] }
	| { kind: "one"; entry: E; unindexed: SelectedItem[] }
	| { kind: "several"; entries: E[]; unindexed: SelectedItem[] };

export function planSelection<E extends { id: string }>(entries: readonly E[], items: readonly SelectedItem[]): SelectionPlan<E> {
	if (!items.length) return { kind: "empty" };
	const byId = new Map<string, E | null>();
	for (const entry of entries) byId.set(entry.id, byId.has(entry.id) ? null : entry);
	const found: E[] = [];
	const unindexed: SelectedItem[] = [];
	for (const item of items) {
		const entry = byId.get(selectedId(item));
		if (entry) found.push(entry);
		else unindexed.push(item);
	}
	if (!found.length) return { kind: "unindexed", unindexed };
	return found.length === 1 ? { kind: "one", entry: found[0], unindexed } : { kind: "several", entries: found, unindexed };
}

/** What a person reads when Zotero has nothing selected. */
export const EMPTY_SELECTION_MESSAGE = "Nothing is selected in Zotero. Select one or more items in Zotero's library pane, then retry.";

/** What a person reads about selected items the saved index does not have yet (named by citekey, at most three). */
export function unindexedMessage(items: readonly Pick<SelectedItem, "citekey">[]): string {
	if (!items.length) return "";
	const named = items.slice(0, 3).map(item => `@${item.citekey}`).join(", ") + (items.length > 3 ? ` and ${items.length - 3} more` : "");
	return `${items.length === 1 ? "1 selected item is" : `${items.length} selected items are`} not in the saved index yet (${named}). Refresh the citekey index, then retry.`;
}

/** A Pandoc citation for the selected items, in Zotero's order, each citekey once: `[@a]` or `[@a; @b]`. */
export function selectionCitation(items: readonly Pick<SelectedItem, "citekey">[]): string {
	const keys = [...new Set(items.map(item => item.citekey).filter(Boolean))];
	return keys.length ? `[${keys.map(key => `@${key}`).join("; ")}]` : "";
}
