import { Notice } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "../views/annotations-view";

/** The open Annotations sidebar, opened and revealed first. */
async function annotationsView(plugin: CMDSZoteroPlugin): Promise<AnnotationsView> {
	await plugin.activateView(VIEW_TYPE_ANNOTATIONS);
	const view = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS).map(leaf => leaf.view).find((item): item is AnnotationsView => item instanceof AnnotationsView);
	if (!view) throw new Error("The annotations sidebar could not be opened.");
	return view;
}

/** 0.6.1 annotations-pdf: the Annotations sidebar's follow, pin and unpin commands. No default hotkeys. */
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
	plugin.addCommand({ id: "annotations-unpin", name: "Annotations sidebar: unpin and follow the active note", callback: () => withView(view => view.pin(null)) });
}
