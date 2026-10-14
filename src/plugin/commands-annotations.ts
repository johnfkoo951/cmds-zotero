import { Notice } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "../views/annotations-view";
import { CARD_ACTIONS } from "../annotations/card-actions";
import { annotationInsertText, preparedSearchRows, searchEmptyText, type AnnotationSearchRow } from "../annotations/search";
import { sourceLabel } from "../annotations/overlay";
import { AnnotationSearchModal, type AnnotationSearchAction } from "../modals/annotation-search";

/** The open Annotations sidebar, opened and revealed first. */
async function annotationsView(plugin: CMDSZoteroPlugin): Promise<AnnotationsView> {
	await plugin.activateView(VIEW_TYPE_ANNOTATIONS);
	const view = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS).map(leaf => leaf.view).find((item): item is AnnotationsView => item instanceof AnnotationsView);
	if (!view) throw new Error("The annotations sidebar could not be opened.");
	return view;
}

/** 0.6.1 annotations-pdf: the Annotations sidebar's follow, pin, unpin and fetch-latest commands. No default hotkeys. */
export function registerAnnotationCommands(plugin: CMDSZoteroPlugin): void {
	const withView = (run: (view: AnnotationsView) => Promise<void> | void): void => { void plugin.run(async () => { await run(await annotationsView(plugin)); }); };
	plugin.addCommand({ id: "annotations-follow-note", name: "Annotations sidebar: follow the active note", callback: () => withView(view => view.follow("note")) });
	plugin.addCommand({ id: "annotations-follow-zotero-selection", name: "Annotations sidebar: show the item selected in Zotero", callback: () => withView(view => view.readSelection()) });
	plugin.addCommand({ id: "annotations-follow-cursor", name: "Annotations sidebar: follow the citekey at the cursor", callback: () => withView(view => view.follow("cursor")) });
	plugin.addCommand({ id: "annotations-pin-current", name: "Annotations sidebar: pin the shown item", callback: () => withView(view => {
		const entry = view.shownEntry();
		if (!entry) { new Notice("The annotations sidebar shows no item to pin."); return; }
		view.pin(entry);
	}) });
	plugin.addCommand({ id: "annotations-pin-item", name: "Annotations sidebar: pin an item…", callback: () => { void plugin.pick(entry => withView(view => view.pin(entry))); } });
	plugin.addCommand({ id: "annotations-fetch-latest", name: "Annotations sidebar: fetch the latest annotations from Zotero", callback: () => withView(view => view.fetchLatest()) });
	plugin.addCommand({ id: "annotations-unpin", name: "Annotations sidebar: unpin and follow the active note", callback: () => withView(view => view.pin(null)) });
	// 0.6.1 annotation-search-insert: the saved snapshot's annotations, prepared once per index generation; never calls BBT.
	plugin.addCommand({ id: "search-annotations", name: "Search annotations", callback: () => {
		const entries = plugin.cachedEntries();
		const rows = preparedSearchRows(entries);
		new AnnotationSearchModal(plugin.app, rows, searchEmptyText(plugin.indexLoaded(), rows.length), sourceLabel(null, plugin.cachedIndexAgeMinutes()), (row, action) => {
			void plugin.run(() => chooseSearchRow(plugin, row, action));
		}).open();
	} });
	// 0.6.1 annotation-card-actions: the card menu's actions on the card last clicked or focused in the sidebar.
	const focusedView = (): AnnotationsView | null => plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS).map(leaf => leaf.view).find((view): view is AnnotationsView => view instanceof AnnotationsView && view.focusedCard() !== null) ?? null;
	for (const action of CARD_ACTIONS) {
		plugin.addCommand({ id: `annotations-${action.id}`, name: `Annotations sidebar: ${action.name.charAt(0).toLowerCase()}${action.name.slice(1)} for the focused annotation`, checkCallback: checking => {
			const view = focusedView();
			if (!view) return false;
			if (!checking) void plugin.run(() => view.runFocusedAction(action.id));
			return true;
		} });
	}
}

/** Inserts the chosen annotation into the last Markdown editor, or pins its item in the annotations sidebar. */
async function chooseSearchRow(plugin: CMDSZoteroPlugin, row: AnnotationSearchRow, action: AnnotationSearchAction): Promise<void> {
	if (action === "pin") { (await annotationsView(plugin)).pin(row.entry); return; }
	const view = plugin.lastMarkdownView();
	if (!view) throw new Error("Open a Markdown note in edit mode to insert an annotation.");
	const text = annotationInsertText(action, row.annotation, row.entry, plugin.settings);
	view.editor.replaceSelection(action === "link" ? text : `${text}\n`);
	await plugin.app.workspace.revealLeaf(view.leaf);
}
