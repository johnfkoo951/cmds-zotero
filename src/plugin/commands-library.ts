import { Notice, type Editor } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { ActionsModal } from "../modals/actions";
import { ZOTERO_SCRIPT_TARGETS, zoteroActionScript } from "../zotero-script";
import { showDoctor } from "./doctor";
import { actOnZoteroSelection, citeZoteroSelection } from "./zotero-selection";

/** 0.6.1 library-integration commands (WP10), registered after the 0.6.0 commands. */
export function registerLibraryCommands(plugin: CMDSZoteroPlugin): void {
	plugin.addCommand({ id: "diagnose-setup", name: "Diagnose setup", callback: () => { void showDoctor(plugin); } });
	// zotero-selection-commands: the Zotero selection is read when the command runs; there is no listener.
	plugin.addCommand({ id: "open-zotero-selection", name: "Open Zotero selection", callback: () => { void actOnZoteroSelection(plugin, "open"); } });
	plugin.addCommand({ id: "import-zotero-selection", name: "Import Zotero selection", callback: () => { void actOnZoteroSelection(plugin, "import"); } });
	plugin.addCommand({ id: "cite-zotero-selection", name: "Cite Zotero selection", editorCallback: (editor: Editor, context) => { void citeZoteroSelection(plugin, editor, context); } });
	// zotero-menu-actions-recipe: a script the person pastes into Actions & Tags; nothing is installed into Zotero.
	plugin.addCommand({ id: "copy-zotero-action-script", name: "Copy Zotero action script", callback: () => { copyZoteroActionScript(plugin); } });
}

/** Lets the person choose what the Zotero-side action does, then copies its Actions & Tags customScript for this vault. */
function copyZoteroActionScript(plugin: CMDSZoteroPlugin): void {
	const vault = plugin.app.vault.getName();
	new ActionsModal(plugin.app, "Copy Zotero action script", ZOTERO_SCRIPT_TARGETS.map(row => ({
		name: row.name,
		description: row.description,
		action: async () => {
			await navigator.clipboard.writeText(zoteroActionScript(vault, row.target));
			new Notice(`Actions & Tags script copied for the vault "${vault}". In Zotero, add an Actions & Tags action with the Custom script operation and paste it as the data.`);
		},
	}))).open();
}
