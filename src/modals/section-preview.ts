import { App, Modal, Notice, Setting } from "obsidian";
import type { DiffLine } from "../fragments";

const MARK: Record<DiffLine["kind"], string> = { same: " ", removed: "-", added: "+" };

/** 0.6.2 managed-references-section: the change to the note as a line diff, with notes, before anything is written. */
export class SectionPreviewModal extends Modal {
	constructor(app: App, private heading: string, private intro: string, private notes: readonly string[], private lines: DiffLine[], private applyLabel: string, private apply: () => Promise<void>) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName(this.heading).setHeading();
		this.contentEl.createEl("p", { text: this.intro });
		if (this.notes.length) {
			const list = this.contentEl.createEl("ul", { cls: "cmds-zotero-preview-notes" });
			for (const note of this.notes) list.createEl("li", { text: note });
		}
		const diff = this.contentEl.createEl("pre", { cls: "cmds-zotero-diff" });
		for (const line of this.lines) diff.createDiv({ cls: `cmds-zotero-diff-${line.kind}`, text: `${MARK[line.kind]} ${line.text}` });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText(this.applyLabel).setCta().onClick(async () => {
				button.setDisabled(true);
				try { await this.apply(); this.close(); }
				catch (error) { new Notice(error instanceof Error ? error.message : "The note could not be changed."); button.setDisabled(false); }
			}))
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()));
	}
	onClose(): void { this.contentEl.empty(); }
}
