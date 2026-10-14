import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { CheckStatus, DoctorCheck } from "../doctor/checks";

const LABEL: Readonly<Record<CheckStatus, string>> = { ok: "OK", info: "Note", warning: "Warning", error: "Error", unknown: "Not checked" };

/**
 * 0.6.1 doctor: the setup checks, one row each, with the notes a row names as links that open them. Report-only: no row
 * offers a fix. Copy report copies the redacted plain-text report.
 */
export class DoctorModal extends Modal {
	constructor(app: App, private readonly checks: readonly DoctorCheck[], private readonly report: string) { super(app); }

	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName("Setup diagnosis").setHeading();
		for (const check of this.checks) {
			const row = new Setting(this.contentEl).setName(`${LABEL[check.status]} · ${check.title}`).setDesc(check.detail);
			row.settingEl.addClass("cmds-zotero-doctor-row", `is-${check.status}`);
			if (!check.paths?.length) continue;
			const list = row.descEl.createEl("ul", { cls: "cmds-zotero-doctor-paths" });
			for (const path of check.paths) {
				const link = list.createEl("li").createEl("a", { text: path, href: "#" });
				link.addEventListener("click", event => {
					event.preventDefault();
					const file = this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) { void this.app.workspace.getLeaf(false).openFile(file); this.close(); }
					else new Notice("This note no longer exists.");
				});
			}
		}
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Copy report").setCta().onClick(() => {
				void navigator.clipboard.writeText(this.report).then(() => { new Notice("Setup report copied."); }, () => { new Notice("Copy failed; the report could not reach the clipboard."); });
			}))
			.addButton(button => button.setButtonText("Close").onClick(() => this.close()));
	}

	onClose(): void { this.contentEl.empty(); }
}
