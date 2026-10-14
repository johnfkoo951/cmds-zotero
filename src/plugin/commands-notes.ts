import type CMDSZoteroPlugin from "../main";
import { adoptExistingNotes, importByScope } from "./note-batches";
import { adoptCurrentNote, hasActiveNote, refreshFrontmatter, relinkMergedItem, removeLegacyKeys, reportLegacyKeys, updateCurrentNote } from "./note-maintenance";

/** 0.6.3 import and update pipeline (WP8). Called once from registerCommands; no default hotkeys. */
export function registerNoteCommands(plugin: CMDSZoteroPlugin): void {
	const onNote = (id: string, name: string, run: () => void): void => {
		plugin.addCommand({ id, name, checkCallback: checking => { if (!hasActiveNote(plugin)) return false; if (!checking) run(); return true; } });
	};
	plugin.addCommand({ id: "open-or-import-literature-note", name: "Open or import literature note", callback: () => { void plugin.navigation.pick(entry => { void plugin.run(() => plugin.literature.openOrImport(entry)); }); } });
	onNote("update-current-literature-note", "Update current literature note", () => { void updateCurrentNote(plugin); });
	onNote("rebuild-current-literature-note", "Rebuild current literature note", () => { void updateCurrentNote(plugin, true); });
	onNote("adopt-current-note", "Adopt current note as literature note", () => { void adoptCurrentNote(plugin); });
	plugin.addCommand({ id: "adopt-existing-literature-notes", name: "Adopt existing literature notes", callback: () => { void adoptExistingNotes(plugin); } });
	plugin.addCommand({ id: "import-literature-notes-by-search", name: "Import literature notes by search", callback: () => { void importByScope(plugin); } });
	plugin.addCommand({ id: "update-changed-literature-notes", name: "Update literature notes changed in Zotero", callback: () => { void plugin.literature.updateAllLiteratureNotes({ kind: "note" }); } });
	onNote("refresh-literature-frontmatter", "Refresh frontmatter of current note from Zotero", () => { void refreshFrontmatter(plugin); });
	onNote("remove-legacy-frontmatter-keys", "Remove legacy keys from current note", () => { void removeLegacyKeys(plugin); });
	plugin.addCommand({ id: "report-legacy-frontmatter-keys", name: "Report notes with legacy Zotero keys", callback: () => { reportLegacyKeys(plugin); } });
	onNote("relink-merged-zotero-item", "Relink current note to merged Zotero item", () => { void relinkMergedItem(plugin); });
}
