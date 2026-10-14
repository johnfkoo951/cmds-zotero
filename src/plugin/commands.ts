import { Editor } from "obsidian";
import { CitekeySuggest } from "../citations/suggest";
import type CMDSZoteroPlugin from "../main";
import { PageJumpModal } from "../modals/page-jump";
import { citekeyAtCursor, parseProtocolRequest } from "../protocol";
import { insertCitationFromPicker } from "./picker";
import { registerLiteratureCommands } from "./commands-literature";
import { registerAnnotationCommands } from "./commands-annotations";
import { registerLibraryCommands } from "./commands-library";
import { registerNoteCommands } from "./commands-notes";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "../views/annotations-view";
import { ReferencesView, VIEW_TYPE_REFERENCES } from "../views/references-view";

/**
 * The sidebar views, the citekey suggester, every command and ribbon icon, and the `cmds-zotero` protocol handler, in
 * the registration order onload has always used; keep that order when adding entries.
 */
export function registerCommands(plugin: CMDSZoteroPlugin): void {
	plugin.registerView(VIEW_TYPE_REFERENCES, leaf => new ReferencesView(leaf, plugin));
	plugin.registerView(VIEW_TYPE_ANNOTATIONS, leaf => new AnnotationsView(leaf, plugin));
	plugin.registerEditorSuggest(new CitekeySuggest(plugin));

	plugin.addCommand({ id: "insert-citation", name: "Insert citation from Zotero", editorCallback: (editor: Editor, context) => {
		void plugin.run(() => insertCitationFromPicker(plugin, editor, context)); // 0.6 OPT-14
	} });
	plugin.addCommand({ id: "refresh-index", name: "Refresh citekey index", callback: () => { void plugin.indexing.refreshIndex(); } });
	plugin.addCommand({ id: "search-library", name: "Search literature", callback: () => { void plugin.navigation.pick(entry => plugin.navigation.showActions(entry)); } });
	plugin.addCommand({ id: "open-pdf-at-page", name: "Open source PDF at page", editorCallback: (editor: Editor) => {
		const cursor = editor.getCursor();
		new PageJumpModal(plugin.app, citekeyAtCursor(editor.getLine(cursor.line), cursor.ch, editor.getSelection()), (key, page) => {
			void plugin.run(async () => { await plugin.navigation.openPdf(await plugin.navigation.requireEntry(key), page); });
		}).open();
	} });
	plugin.addCommand({ id: "import-literature-note", name: "Import literature note", callback: () => { void plugin.navigation.pick(entry => { void plugin.literature.previewImport(entry); }); } });
	plugin.addCommand({ id: "send-recent-reads", name: "Send recently read papers to notes", callback: () => { plugin.literature.openRecentReads(); } });
	plugin.addCommand({ id: "update-all-literature-notes", name: "Update all owned literature notes", callback: () => { void plugin.literature.updateAllLiteratureNotes(); } });
	plugin.addCommand({ id: "insert-bibliography", name: "Insert bibliography", editorCallback: (editor: Editor) => {
		void plugin.navigation.pick(entry => { void plugin.run(() => plugin.bibliography.insertBibliography(editor, entry)); }); // 0.5 R12
	} });
	plugin.addCommand({ id: "open-references", name: "Open references sidebar", callback: () => { void plugin.activateView(VIEW_TYPE_REFERENCES); } });
	plugin.addCommand({ id: "open-annotations", name: "Open annotations sidebar", callback: () => { void plugin.activateView(VIEW_TYPE_ANNOTATIONS); } });
	plugin.addCommand({ id: "find-citing-notes", name: "Find notes citing a source", callback: () => { void plugin.navigation.pick(entry => { void plugin.navigation.showCitingNotes(entry); }); } });
	plugin.addCommand({ id: "copy-hookmark-link", name: "Copy Zotero item link (Hookmark-compatible)", callback: () => { void plugin.navigation.pick(entry => { void plugin.navigation.copyLink(entry.title, entry.zoteroSelectURI, true); }); } });
	plugin.addCommand({ id: "copy-note-link", name: "Copy literature note identity link (rename-safe)", callback: () => { void plugin.navigation.pick(entry => { void plugin.run(() => plugin.navigation.copyNoteLink(entry)); }); } });
	plugin.addCommand({ id: "diagnose-links", name: "Diagnose index and links", callback: () => { void plugin.status.showDiagnostics(); } });
	plugin.addCommand({ id: "find-vault-links", name: "Find literature across vaults", callback: () => { void plugin.navigation.pick(entry => { void plugin.navigation.showVaultLinks(entry); }); } });
	// 0.5 R15
	plugin.addCommand({ id: "copy-file-link", name: "Copy Obsidian file link (Hookmark-native)", callback: () => { void plugin.navigation.pick(entry => { void plugin.run(() => plugin.navigation.copyFileLink(entry)); }); } });
	plugin.addCommand({ id: "open-link-under-cursor", name: "Open link under cursor", editorCallback: (editor: Editor) => { void plugin.navigation.openLinkUnderCursor(editor); } });
	// 0.5 R10: pandoc-ready bibliography for the active note (index-local citation rows, one BBT export per library).
	plugin.addCommand({ id: "copy-csl-json", name: "Copy CSL-JSON for cited sources", callback: () => { void plugin.run(() => plugin.bibliography.copyCslJsonForActiveNote()); } });
	plugin.addCommand({ id: "write-bibliography-sidecar", name: "Write pandoc bibliography sidecar for current note", callback: () => { void plugin.run(() => plugin.bibliography.writeBibliographySidecar()); } });
	registerLiteratureCommands(plugin); // 0.6.1 WP7
	registerAnnotationCommands(plugin); // 0.6.1 annotations sidebar: follow, pin, live read and card actions
	registerLibraryCommands(plugin); // 0.6.1 WP10
	registerNoteCommands(plugin); // 0.6.3 WP8 import and update pipeline
	plugin.addRibbonIcon("library", "Search literature", () => { void plugin.navigation.pick(entry => plugin.navigation.showActions(entry)); });
	plugin.addRibbonIcon("highlighter", "Zotero annotations", () => { void plugin.activateView(VIEW_TYPE_ANNOTATIONS); });
	plugin.addRibbonIcon("book-open", "Send recently read papers to notes", () => { plugin.literature.openRecentReads(); });

	plugin.registerObsidianProtocolHandler("cmds-zotero", params => {
		void plugin.run(async () => {
			const request = parseProtocolRequest(params, plugin.app.vault.getName());
			const result = await plugin.service.resolve({ itemKey: request.itemKey, libraryID: request.libraryID });
			if (result.status !== "resolved") throw new Error(`Could not resolve this source: ${result.status}. Refresh the index and retry.`);
			if (request.target === "pdf") await plugin.navigation.openPdf(result.entry, request.page, request.annotation);
			else if (request.target === "import") await plugin.literature.previewImport(result.entry);
			else await plugin.navigation.openNote(result.entry);
		});
	});
}
