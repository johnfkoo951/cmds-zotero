import type { Editor, MarkdownFileInfo, MarkdownView } from "obsidian";
import { citationEditorExtension } from "../citations/editor-extension";
import { CITATION_FORMATS } from "../citations/formats";
import type CMDSZoteroPlugin from "../main";

/** 0.6.2 citations editor (WP5): the editor extension, reading-view rendering, editor menu, paste and the citation commands. */
export function registerCitationCommands(plugin: CMDSZoteroPlugin): void {
	const citations = plugin.citations;
	plugin.registerEditorExtension(citationEditorExtension(citations));
	plugin.registerMarkdownPostProcessor(element => { citations.renderReadingView(element); });
	plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu, editor, context) => { citations.addEditorMenuItems(menu, editor, context); }));
	plugin.registerEvent(plugin.app.workspace.on("editor-paste", (event, editor) => {
		if (event.defaultPrevented) return;
		if (citations.takePaste(event.clipboardData?.getData("text/plain") ?? "", editor)) event.preventDefault();
	}));

	const atCursor = (action: (editor: Editor, context: MarkdownView | MarkdownFileInfo) => Promise<void> | void) => (editor: Editor, context: MarkdownView | MarkdownFileInfo): void => {
		void plugin.run(async () => { await action(editor, context); });
	};
	const citekeyAtCursor = (editor: Editor): string => {
		const target = citations.citationAt(editor);
		if (!target) throw new Error("No citation under the cursor.");
		return target.item.citekey;
	};

	plugin.addCommand({ id: "open-note-at-cursor", name: "Open literature note for citation at cursor", editorCallback: atCursor(editor => citations.openNoteFor(citekeyAtCursor(editor))) });
	plugin.addCommand({ id: "open-pdf-at-locator", name: "Open PDF at citation locator", editorCallback: atCursor(editor => {
		const target = citations.citationAt(editor);
		if (!target) throw new Error("No citation under the cursor.");
		return citations.openPdfAt(target.item, false);
	}) });
	plugin.addCommand({ id: "copy-pdf-page-link-at-cursor", name: "Copy PDF page link for citation at cursor", editorCallback: atCursor(editor => {
		const target = citations.citationAt(editor);
		if (!target) throw new Error("No citation under the cursor.");
		return citations.openPdfAt(target.item, true);
	}) });
	plugin.addCommand({ id: "citation-actions", name: "Citation actions at cursor", editorCallback: atCursor((editor, context) => citations.showCitationActions(editor, context)) });
	plugin.addCommand({ id: "edit-citation-locator", name: "Edit citation locator", editorCallback: atCursor(editor => { citations.editLocator(editor); }) });
	plugin.addCommand({ id: "compose-citation", name: "Compose or edit citation cluster", editorCallback: atCursor(editor => { citations.composeCitation(editor); }) });
	plugin.addCommand({ id: "fix-renamed-citekey", name: "Fix renamed citekey in this note", editorCallback: atCursor((editor, context) => citations.fixRenamedCitekey(editor, context)) });
	plugin.addCommand({ id: "insert-citation-from-index", name: "Insert citation from the literature index", editorCallback: (editor, context) => { citations.insertFromPicker(editor, context, plugin.settings.citationFormat); } });
	for (const format of CITATION_FORMATS) {
		plugin.addCommand({ id: `insert-citation-${format.id}`, name: format.command, editorCallback: (editor, context) => { citations.insertFromPicker(editor, context, format.id); } });
	}
}
