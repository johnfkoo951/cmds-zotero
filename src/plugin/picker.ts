import { Editor, MarkdownView, Notice, type EditorPosition, type MarkdownFileInfo, type TFile } from "obsidian";
import { formatWait, PickerWaitError } from "../bbt";
import { isBbtTransportError } from "../api/transport";
import type CMDSZoteroPlugin from "../main";

/**
 * "Insert citation from Zotero" (0.6 cayw-picker-wait-cancel): Zotero's citation picker with its own wait and a Cancel
 * button. The citation replaces the selection (or goes at the cursor) as it was when the command ran. When that note is no
 * longer open in the same view, or that text changed meanwhile, the citation is copied to the clipboard instead, so a slow
 * pick never writes into another note or over text chosen later.
 */
export async function insertCitationFromPicker(plugin: CMDSZoteroPlugin, editor: Editor, context: MarkdownView | MarkdownFileInfo): Promise<void> {
	const file: TFile | null = context.file;
	// Where the citation goes: the selection (or cursor) when the command ran, and the text it covered then.
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	const selected = editor.getSelection();
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
	if (stillOpen(plugin, context, file) && unchanged(editor, from, to, selected)) { editor.replaceRange(answer.text, from, to); return; }
	await copyOrShow(answer.text, "The note changed while the picker was open, so the citation was copied to the clipboard instead.");
}

/** True when the range still exists and holds the text it held when the command ran. */
export function unchanged(editor: Editor, from: EditorPosition, to: EditorPosition, selected: string): boolean {
	const last = editor.lastLine();
	if (from.line > last || to.line > last) return false;
	try { return editor.getRange(from, to) === selected; } catch { return false; }
}

/**
 * Copies the citation; Electron refuses the clipboard while another app (Zotero, just after the pick) has focus, so a
 * refusal shows the citation in a notice with a Copy button instead of losing it.
 */
export async function copyOrShow(text: string, copied: string, shown = "The note changed while the picker was open. Copy the citation from here:"): Promise<void> {
	try { await navigator.clipboard.writeText(text); new Notice(copied); return; }
	catch { /* not focused: shown below */ }
	const fragment = createFragment();
	const body = fragment.createDiv({ cls: "cmds-zotero-batch-progress" });
	body.createDiv({ text: shown });
	body.createEl("code", { text });
	const button = body.createEl("button", { text: "Copy" });
	body.addEventListener("click", event => { event.stopPropagation(); });
	const notice = new Notice(fragment, 0);
	button.addEventListener("click", () => {
		void navigator.clipboard.writeText(text).then(() => { notice.hide(); new Notice("Citation copied."); }, () => { button.setText("Copy failed; select the text"); });
	});
}

/** True when `context` still shows `file` (and, for a Markdown view, is still open in the workspace). */
export function stillOpen(plugin: CMDSZoteroPlugin, context: MarkdownView | MarkdownFileInfo, file: TFile | null): boolean {
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
