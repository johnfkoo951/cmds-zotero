import { App, Modal, Setting } from "obsidian";
import type { DiffLine } from "../fragments";

const MARK: Record<DiffLine["kind"], string> = { same: " ", removed: "-", added: "+" };
/** Unchanged lines shown around each change; longer unchanged runs are folded. */
const CONTEXT = 2;

/**
 * 0.6.3 per-note line patches (frontmatter refresh, legacy-key cleanup, merged-item relink): the lines that change, with
 * a little context, before anything is written. Apply backs the note up, checks it did not change since this preview and
 * reads it back after the write.
 */
export class PatchPreviewModal extends Modal {
	constructor(app: App, private heading: string, private summary: string, private lines: DiffLine[], private apply: () => Promise<void>, private applyLabel = "Apply") { super(app); }
	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName(this.heading).setHeading();
		this.contentEl.createEl("p", { text: this.summary });
		this.contentEl.createEl("p", { cls: "cmds-zotero-preview-note", text: "Only the lines marked - and + change. The note's current text is copied to the plugin's private backup folder first." });
		const diff = this.contentEl.createEl("pre", { cls: "cmds-zotero-diff" });
		const near = (index: number): boolean => this.lines.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some(line => line.kind !== "same");
		let folded = false;
		for (const [index, line] of this.lines.entries()) {
			if (line.kind === "same" && !near(index)) { if (!folded) diff.createDiv({ cls: "cmds-zotero-diff-same", text: "  …" }); folded = true; continue; }
			folded = false;
			diff.createDiv({ cls: `cmds-zotero-diff-${line.kind}`, text: `${MARK[line.kind]} ${line.text}` });
		}
		const status = this.contentEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText(this.applyLabel).setCta().onClick(async () => {
				button.setDisabled(true); status.setText("Writing…");
				try { await this.apply(); this.close(); }
				catch (error) { status.setText(error instanceof Error ? error.message : "The note was not changed."); status.addClass("cmds-zotero-error"); button.setDisabled(false); }
			}));
	}
	onClose(): void { this.contentEl.empty(); }
}

/** 0.6.3 batch-import-by-scope: a fielded search (`col:`, `tag:`, …) whose matching items are listed for the review. */
export class ScopeQueryModal extends Modal {
	constructor(app: App, private count: (query: string) => number, private submit: (query: string) => void) { super(app); }
	onOpen(): void {
		new Setting(this.contentEl).setName("Import literature notes by search").setHeading();
		this.contentEl.createEl("p", { text: "Items of the saved index that match, for example col:methods, tag:method, type:book or year:2020-. Only items without a literature note are imported; a review list comes first." });
		const status = this.contentEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		let query = "";
		const go = (): void => { if (!query.trim()) { status.setText("Enter a search."); return; } this.close(); this.submit(query); };
		new Setting(this.contentEl).setName("Search").addText(text => {
			text.setPlaceholder("For example tag:method").onChange(value => { query = value; status.setText(value.trim() ? `${this.count(value)} matching items` : ""); });
			text.inputEl.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); go(); } });
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText("Review").setCta().onClick(go));
	}
	onClose(): void { this.contentEl.empty(); }
}
