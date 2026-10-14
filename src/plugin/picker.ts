import { Editor, MarkdownView, Notice, type MarkdownFileInfo, type TFile } from "obsidian";
import { formatWait, PickerWaitError } from "../bbt";
import { isBbtTransportError } from "../api/transport";
import type CMDSZoteroPlugin from "../main";

/**
 * "Insert citation from Zotero" (0.6 cayw-picker-wait-cancel): Zotero's citation picker with its own wait and a Cancel
 * button. The citation goes where the cursor was when the command ran. When that note is no longer open in the same view
 * by then, the citation is copied to the clipboard instead, so a slow pick never writes into another note.
 */
export async function insertCitationFromPicker(plugin: CMDSZoteroPlugin, editor: Editor, context: MarkdownView | MarkdownFileInfo): Promise<void> {
	const file: TFile | null = context.file;
	const controller = new AbortController();
	const waiting = waitingNotice(`Waiting for Zotero's citation picker (up to ${formatWait(plugin.settings.pickerWaitSeconds)})…`, () => controller.abort());
	let answer;
	try { answer = await plugin.bbt.pickCitation(controller.signal); }
	catch (error) {
		if (controller.signal.aborted && isBbtTransportError(error) && error.reason === "aborted") { new Notice("Citation picker cancelled; nothing was inserted."); return; }
		if (error instanceof PickerWaitError) { new Notice(error.message); return; }
		throw error;
	} finally { waiting.hide(); }
	if (answer.kind === "empty") { new Notice("No citation was picked."); return; }
	if (stillOpen(plugin, context, file)) { editor.replaceSelection(answer.text); return; }
	await navigator.clipboard.writeText(answer.text);
	new Notice("The note changed while the picker was open, so the citation was copied to the clipboard instead.");
}

/** True when `context` still shows `file` (and, for a Markdown view, is still open in the workspace). */
function stillOpen(plugin: CMDSZoteroPlugin, context: MarkdownView | MarkdownFileInfo, file: TFile | null): boolean {
	if (!file || context.file !== file) return false;
	return !(context instanceof MarkdownView) || plugin.app.workspace.getLeavesOfType("markdown").some(leaf => leaf.view === context);
}

/** A Notice that stays until hidden, with a Cancel button; a click elsewhere on it does not dismiss it. */
function waitingNotice(message: string, cancel: () => void): Notice {
	const fragment = createFragment();
	const body = fragment.createDiv({ cls: "cmds-zotero-batch-progress" });
	body.createDiv({ text: message });
	const button = body.createEl("button", { text: "Cancel", attr: { "aria-label": "Stop waiting for the citation picker" } });
	// A click on a Notice dismisses it; this one must stay while the picker is open, so clicks inside it stop here.
	body.addEventListener("click", event => { event.stopPropagation(); });
	button.addEventListener("click", () => { cancel(); });
	return new Notice(fragment, 0);
}
