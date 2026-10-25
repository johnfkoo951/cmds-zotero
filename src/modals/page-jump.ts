import { App, Modal, Setting } from "obsidian";

export class PageJumpModal extends Modal {
	constructor(app: App, private citekey: string, private onSubmit: (citekey: string, page: number) => void) { super(app); }
	onOpen(): void {
		new Setting(this.contentEl).setName("Source PDF page").setHeading();
		let page = "1";
		new Setting(this.contentEl).setName("Citekey").addText(text => {
			text.setValue(this.citekey).onChange(value => { this.citekey = value.trim(); });
			text.inputEl.addEventListener("compositionend", () => { this.citekey = text.inputEl.value.trim(); });
		});
		new Setting(this.contentEl).setName("Page number").setDesc("PDF page position, starting at 1; not the printed page label.").addText(text => {
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.setValue(page).onChange(value => { page = value.trim(); });
		});
		const error = this.contentEl.createDiv({ cls: "cmds-zotero-error", attr: { role: "alert" } });
		new Setting(this.contentEl).addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText("Continue").setCta().onClick(() => {
				if (!this.citekey || !/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))) {
					error.setText("Enter a citekey and a positive whole page number.");
					return;
				}
				this.close(); this.onSubmit(this.citekey, Number(page));
			}));
	}
	onClose(): void { this.contentEl.empty(); }
}
