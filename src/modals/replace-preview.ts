import { App, Modal, Notice, Setting } from "obsidian";
import type { DiffLine } from "../fragments";

const MARK: Record<DiffLine["kind"], string> = { same: " ", removed: "-", added: "+" };

/** 0.6.1 insert-item-content: the selection and what replaces it, as a line diff, before anything changes. */
export class ReplacePreviewModal extends Modal {
	constructor(app: App, private heading: string, private lines: DiffLine[], private apply: () => void) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName(this.heading).setHeading();
		const removed = this.lines.filter(line => line.kind === "removed").length;
		const added = this.lines.filter(line => line.kind === "added").length;
		this.contentEl.createEl("p", { text: `The selection is replaced: ${removed} line${removed === 1 ? "" : "s"} removed, ${added} added. Text outside the selection stays as it is.` });
		const diff = this.contentEl.createEl("pre", { cls: "cmds-zotero-diff" });
		for (const line of this.lines) diff.createDiv({ cls: `cmds-zotero-diff-${line.kind}`, text: `${MARK[line.kind]} ${line.text}` });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Replace selection").setCta().onClick(() => {
				try { this.apply(); this.close(); }
				catch (error) { new Notice(error instanceof Error ? error.message : "The selection could not be replaced."); }
			}))
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()));
	}
	onClose(): void { this.contentEl.empty(); }
}
