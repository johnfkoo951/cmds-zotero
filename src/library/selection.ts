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
