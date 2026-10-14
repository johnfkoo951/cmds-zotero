import type { Editor } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { showDoctor } from "./doctor";
import { actOnZoteroSelection, citeZoteroSelection } from "./zotero-selection";

/** 0.6.1 library-integration commands (WP10), registered after the 0.6.0 commands. */
export function registerLibraryCommands(plugin: CMDSZoteroPlugin): void {
	plugin.addCommand({ id: "diagnose-setup", name: "Diagnose setup", callback: () => { void showDoctor(plugin); } });
	// zotero-selection-commands: the Zotero selection is read when the command runs; there is no listener.
	plugin.addCommand({ id: "open-zotero-selection", name: "Open Zotero selection", callback: () => { void actOnZoteroSelection(plugin, "open"); } });
	plugin.addCommand({ id: "import-zotero-selection", name: "Import Zotero selection", callback: () => { void actOnZoteroSelection(plugin, "import"); } });
	plugin.addCommand({ id: "cite-zotero-selection", name: "Cite Zotero selection", editorCallback: (editor: Editor, context) => { void citeZoteroSelection(plugin, editor, context); } });
}
