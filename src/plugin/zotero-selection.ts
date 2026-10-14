import { Editor, Notice, type MarkdownFileInfo, type MarkdownView, type TFile } from "obsidian";
import { describeBbtError } from "../api/transport";
import { EMPTY_SELECTION_MESSAGE, planSelection, selectionCitation, unindexedMessage, type SelectedItem } from "../library/selection";
import type CMDSZoteroPlugin from "../main";
import { PickerModal } from "../modals/picker";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import { copyOrShow, placeCitation, stillOpen, unchanged } from "./picker";

/**
 * 0.6.1 zotero-selection-commands: open, import or cite the items selected in Zotero's library pane. The selection is
 * read once, when the command runs (Better BibTeX's export of it); there is no listener and no polling. Items are matched
 * to the saved index by library ID and item key only (`planSelection`), never by a first search match.
 */

async function readSelection(plugin: CMDSZoteroPlugin): Promise<SelectedItem[]> {
	try { return await plugin.bbt.selectedItems(); }
	catch (error) { throw new Error(`Could not read the Zotero selection. ${describeBbtError(error)}`); }
}

const label = (entry: ZoteroIndexEntry): string => `${entry.title} — @${entry.citekey} · ${entry.year} · library ${entry.libraryID}`;

/** Opens the literature note, or the import preview when this vault has no note for the entry yet (0.6.3: shared with Open or import literature note). */
function openOrPreview(plugin: CMDSZoteroPlugin, entry: ZoteroIndexEntry): Promise<void> {
	return plugin.literature.openOrImport(entry);
}

/**
 * "Open Zotero selection" (`open`) and "Import Zotero selection" (`import`): one indexed item opens its note (or the
 * import preview) or its import preview; several are listed to pick one. An empty selection, or one the index does not
 * have, says so.
 */
export async function actOnZoteroSelection(plugin: CMDSZoteroPlugin, mode: "open" | "import"): Promise<void> {
	await plugin.run(async () => {
		const items = await readSelection(plugin);
		if (!items.length) { new Notice(EMPTY_SELECTION_MESSAGE); return; }
		const index = await plugin.indexing.loadIndexForRead();
		const plan = planSelection(index.entries, items);
		if (plan.kind === "empty") { new Notice(EMPTY_SELECTION_MESSAGE); return; }
		if (plan.kind === "unindexed") throw new Error(unindexedMessage(plan.unindexed));
		if (plan.unindexed.length) new Notice(unindexedMessage(plan.unindexed));
		const act = (entry: ZoteroIndexEntry): Promise<void> => mode === "import" ? plugin.literature.previewImport(entry) : openOrPreview(plugin, entry);
		if (plan.kind === "one") { await act(plan.entry); return; }
		new PickerModal(plugin.app, plan.entries, label, entry => { void plugin.run(() => act(entry)); }, `Choose one of the ${plan.entries.length} items selected in Zotero…`).open();
	});
}

/**
 * "Cite Zotero selection": a Pandoc citation (`[@a; @b]`, Zotero's current citekeys) replaces the editor selection or goes
 * at the cursor, as they were when the command ran; when that note or text changed while Zotero was read, the citation is
 * copied instead. Cited items without a literature note in this vault are named afterwards (no import is started).
 */
export async function citeZoteroSelection(plugin: CMDSZoteroPlugin, editor: Editor, context: MarkdownView | MarkdownFileInfo): Promise<void> {
	await plugin.run(async () => {
		const file: TFile | null = context.file;
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const selected = editor.getSelection();
		const items = await readSelection(plugin);
		const citation = selectionCitation(items);
		if (!citation) { new Notice(EMPTY_SELECTION_MESSAGE); return; }
		if (stillOpen(plugin, context, file) && unchanged(editor, from, to, selected)) {
			placeCitation(editor, from, to, citation); // 0.6.2: joins the cluster at the cursor
		} else {
			await copyOrShow(citation, "The note changed while Zotero was read, so the citation was copied to the clipboard instead.", "The note changed while Zotero was read. Copy the citation from here:");
		}
		const missing = await withoutNotes(plugin, items);
		if (missing.length) new Notice(`${missing.length === 1 ? "1 cited item has" : `${missing.length} cited items have`} no literature note in this vault (${missing.slice(0, 3).map(key => `@${key}`).join(", ")}${missing.length > 3 ? "…" : ""}). Run Import Zotero selection to preview ${missing.length === 1 ? "it" : "them"}.`);
	});
}

/** Citekeys of selected items with no literature note in this vault (unindexed items included); [] when the index cannot be read. */
async function withoutNotes(plugin: CMDSZoteroPlugin, items: readonly SelectedItem[]): Promise<string[]> {
	let index: ZoteroIndex;
	try { index = await plugin.indexing.loadIndexForRead(); } catch { return []; }
	const plan = planSelection(index.entries, items);
	if (plan.kind === "empty") return [];
	const entries = plan.kind === "one" ? [plan.entry] : plan.kind === "several" ? plan.entries : [];
	return [...entries.filter(entry => !plugin.links.localFiles(entry, index).length).map(entry => entry.citekey), ...plan.unindexed.map(item => item.citekey)];
}
