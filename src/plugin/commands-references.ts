import type { Editor } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { citedKeySet } from "../citations/cited-keys";
import { referenceRowsFromSet } from "../citations/check";
import { resolvedEntries } from "../citations/reference-rows";
import { withoutReferencesBlock } from "../citations/references-block";
import { chooseAndSaveStyle } from "./style-picker";

/** 0.6.2 WP6 commands (references, bibliography and export kit), registered after the 0.6.1 commands. No default hotkeys. */
export function registerReferenceCommands(plugin: CMDSZoteroPlugin): void {
	plugin.addCommand({ id: "check-citations", name: "Check citations in current note", checkCallback: whenNote(() => plugin.currentNote() !== null, () => { void plugin.run(() => plugin.references.checkCitations()); }) });
	plugin.addCommand({ id: "next-citation-occurrence", name: "Go to next occurrence of the citation at cursor", editorCallback: (editor: Editor) => { plugin.references.goToOccurrenceAtCursor(editor, "next"); } });
	plugin.addCommand({ id: "previous-citation-occurrence", name: "Go to previous occurrence of the citation at cursor", editorCallback: (editor: Editor) => { plugin.references.goToOccurrenceAtCursor(editor, "previous"); } });
	plugin.addCommand({ id: "copy-bibliography", name: "Copy bibliography for current note", checkCallback: whenNote(() => !!plugin.lastMarkdownView()?.file, () => { void plugin.run(() => copyBibliographyOfActiveNote(plugin)); }) });
	plugin.addCommand({ id: "insert-references-section", name: "Insert or update references section", checkCallback: whenNote(() => plugin.currentNote() !== null, () => { void plugin.run(() => plugin.references.insertReferencesSection()); }) });
	plugin.addCommand({ id: "export-pandoc-kit", name: "Export pandoc kit for current note", checkCallback: whenNote(() => plugin.currentNote() !== null, () => { void plugin.run(() => plugin.references.exportKit()); }) });
	plugin.addCommand({ id: "choose-bibliography-style", name: "Choose bibliography style from installed styles", callback: () => { void plugin.run(() => chooseAndSaveStyle(plugin)); } });
	// 0.6.6 word-zotero-fields
	plugin.addCommand({ id: "export-word-zotero-kit", name: "Export Word kit with live Zotero citations for current note", checkCallback: whenNote(() => plugin.currentNote() !== null, () => { void plugin.run(() => plugin.references.exportWordKit()); }) });
}

/** 0.6.4: a command that needs a note is offered only while `available()` holds (Plugin guidelines: checkCallback). */
export function whenNote(available: () => boolean, run: () => void): (checking: boolean) => boolean {
	return checking => {
		if (!available()) return false;
		if (!checking) run();
		return true;
	};
}

/** The References sidebar's Copy bibliography for the active note: the saved index resolves, the note's style and locale apply. */
async function copyBibliographyOfActiveNote(plugin: CMDSZoteroPlugin): Promise<void> {
	const view = plugin.lastMarkdownView();
	const file = view?.file ?? null;
	if (!view || !file) throw new Error("Open a Markdown note first.");
	const rows = referenceRowsFromSet(citedKeySet(withoutReferencesBlock(view.editor.getValue())), plugin.cachedEntries(), plugin.indexLoaded());
	await plugin.bibliography.copyBibliography(resolvedEntries(rows), await plugin.bibliography.noteFormat(file));
}
