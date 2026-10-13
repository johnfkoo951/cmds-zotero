import { App, Modal, Setting } from "obsidian";

export class ReportModal extends Modal {
	constructor(app: App, private heading: string, private text: string) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName(this.heading).setHeading();
		this.contentEl.createEl("pre", { text: this.text, cls: "cmds-zotero-report", attr: { tabindex: "0" } });
		new Setting(this.contentEl).addButton(button => button.setButtonText("Close").onClick(() => this.close()));
	}
	onClose(): void { this.contentEl.empty(); }
}
