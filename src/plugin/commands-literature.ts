import { Editor, Notice, htmlToMarkdown, type EditorPosition } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { childNoteChoices, emptyFragmentMessage, FRAGMENTS, framedForInsertion, lineDiff, renderFragment, type FragmentKind } from "../fragments";
import { requireChoice } from "../modals/choose-entry";
import { PickerModal } from "../modals/picker";
import { ReplacePreviewModal } from "../modals/replace-preview";
import { citekeyAtCursor } from "../protocol";
import { relatedCitekeys } from "../related";
import type { ZoteroIndexEntry } from "../types";

/** 0.6.1 literature-note content commands (WP7). Called once from registerCommands. */
export function registerLiteratureCommands(plugin: CMDSZoteroPlugin): void {
	plugin.addCommand({ id: "insert-item-content", name: "Insert item content from Zotero", editorCallback: (editor: Editor) => {
		void plugin.run(() => insertItemContent(plugin, editor));
	} });
}

/** Where the command was run: the selection (possibly empty) it may replace. */
interface Target { editor: Editor; from: EditorPosition; to: EditorPosition; selection: string }

/**
 * The citekey under the cursor (or the selected citekey), else the literature picker; then the part to insert. The item
 * is read fresh from Zotero, falling back to the saved index when Zotero does not answer. With a selection, a line diff
 * is shown and the selection is replaced only after confirmation; otherwise the part is inserted at the cursor. Inserted
 * text is plain Markdown the user owns (no managed markers).
 */
async function insertItemContent(plugin: CMDSZoteroPlugin, editor: Editor): Promise<void> {
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	const target: Target = { editor, from, to, selection: editor.getRange(from, to) };
	const cursor = editor.getCursor();
	const citekey = citekeyAtCursor(editor.getLine(cursor.line), cursor.ch, target.selection);
	if (citekey) {
		const result = await plugin.service.resolve({ citekey });
		if (result.status === "resolved") return chooseFragment(plugin, target, result.entry);
		if (result.status === "ambiguous") return chooseFragment(plugin, target, await requireChoice(plugin.app, result.candidates ?? [], plugin.lastIndex, citekey)); // 0.6.2
	}
	await plugin.navigation.pick(entry => { void plugin.run(() => chooseFragment(plugin, target, entry)); });
}

async function chooseFragment(plugin: CMDSZoteroPlugin, target: Target, indexed: ZoteroIndexEntry): Promise<void> {
	const { entry, fresh } = await plugin.literature.freshEntry(indexed);
	if (!fresh) new Notice("Zotero is not answering; using the saved index.");
	new PickerModal(plugin.app, [...FRAGMENTS], fragment => fragment.label, fragment => {
		if (fragment.kind !== "zotero-notes") { void plugin.run(() => insertFragment(plugin, target, entry, fresh, fragment.kind)); return; }
		const notes = childNoteChoices(entry);
		if (notes.length <= 1) { void plugin.run(() => insertFragment(plugin, target, entry, fresh, "zotero-notes")); return; }
		const all = { index: -1, title: `All ${notes.length} notes` };
		new PickerModal(plugin.app, [all, ...notes], note => note.title, note => {
			void plugin.run(() => insertFragment(plugin, target, entry, fresh, "zotero-notes", note.index < 0 ? undefined : [note.index]));
		}, "Choose a Zotero note…").open();
	}, `Insert from @${entry.citekey}…`).open();
}

async function insertFragment(plugin: CMDSZoteroPlugin, target: Target, entry: ZoteroIndexEntry, fresh: boolean, kind: FragmentKind, notes?: number[]): Promise<void> {
	const bibliography = kind === "citation"
		? (await plugin.bibliography.bibliographyDetail(entry, plugin.settings.bibliographyStyle, { offline: !fresh })).text
		: undefined;
	const related = kind === "metadata" && plugin.lastIndex ? relatedCitekeys(entry, plugin.lastIndex) : [];
	const text = renderFragment(kind, entry, plugin.settings, { ...(bibliography !== undefined ? { bibliography } : {}), ...(notes ? { notes } : {}), noteMarkdown: html => htmlToMarkdown(html), related });
	if (!text) throw new Error(emptyFragmentMessage(kind));
	const { editor, from, to, selection } = target;
	if (selection) {
		new ReplacePreviewModal(plugin.app, "Replace the selection", lineDiff(selection, text), () => {
			if (editor.getRange(from, to) !== selection) throw new Error("The selection changed. Run the command again.");
			editor.replaceRange(text, from, to);
		}).open();
		return;
	}
	// Inserted where the cursor is now, without replacing anything selected since the command started.
	const at = editor.getCursor("to");
	const line = editor.getLine(at.line);
	editor.replaceRange(framedForInsertion(text, line.slice(0, at.ch), line.slice(at.ch)), at);
}
