import { App, Modal, Notice, Setting } from "obsidian";
import type { RenamePlan } from "../citations/problems";

/** 0.6.2 renamed-citekey-fix: every line of the current note that changes, before anything is written. */
export class RenamePreviewModal extends Modal {
	constructor(app: App, private readonly plan: RenamePlan, private readonly apply: () => void) { super(app); }

	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		const { plan } = this;
		new Setting(this.contentEl).setName(`Replace @${plan.oldKey} with @${plan.newKey}`).setHeading();
		this.contentEl.createEl("p", { text: `${plan.count} citation${plan.count === 1 ? "" : "s"} on ${plan.lines.length} line${plan.lines.length === 1 ? "" : "s"} of this note change. Other notes, the frontmatter and code blocks are not touched; undo restores the old key.` });
		const diff = this.contentEl.createEl("pre", { cls: "cmds-zotero-diff" });
		for (const row of plan.lines) {
			diff.createDiv({ cls: "cmds-zotero-diff-removed", text: `- ${row.line + 1}: ${row.before}` });
			diff.createDiv({ cls: "cmds-zotero-diff-added", text: `+ ${row.line + 1}: ${row.after}` });
		}
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Replace in this note").setCta().onClick(() => {
				try { this.apply(); this.close(); }
				catch (error) { new Notice(error instanceof Error ? error.message : "The citekey could not be replaced."); }
			}))
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void { this.contentEl.empty(); }
}
