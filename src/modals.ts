import { App, FuzzySuggestModal, Modal, Notice, Setting } from "obsidian";
import type { ImportPreview } from "./importer";

export class PickerModal<T> extends FuzzySuggestModal<T> {
	constructor(app: App, private items: T[], private label: (item: T) => string, private choose: (item: T) => void, placeholder = "Search literature…") {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems(): T[] { return this.items; }
	getItemText(item: T): string { return this.label(item); }
	onChooseItem(item: T): void { this.choose(item); }
}

export class PageJumpModal extends Modal {
	constructor(app: App, private citekey: string, private onSubmit: (citekey: string, page: number) => void) { super(app); }
	onOpen(): void {
		new Setting(this.contentEl).setName("Source PDF page").setHeading();
		let page = "1";
		new Setting(this.contentEl).setName("Citekey").addText(text => text.setValue(this.citekey).onChange(value => { this.citekey = value.trim(); }));
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

export interface ModalAction { name: string; description?: string; action: () => Promise<void> | void }
export class ActionsModal extends Modal {
	constructor(app: App, private heading: string, private actions: ModalAction[]) { super(app); }
	onOpen(): void {
		new Setting(this.contentEl).setName(this.heading).setHeading();
		for (const item of this.actions) {
			new Setting(this.contentEl).setName(item.name).setDesc(item.description ?? "")
				.addButton(button => button.setButtonText("Select").onClick(async () => {
					button.setDisabled(true);
					try { await item.action(); this.close(); }
					catch (error) { new Notice(error instanceof Error ? error.message : "The action failed."); button.setDisabled(false); }
				}));
		}
		new Setting(this.contentEl).addButton(button => button.setButtonText("Close").onClick(() => this.close()));
	}
	onClose(): void { this.contentEl.empty(); }
}

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

export class ImportPreviewModal extends Modal {
	constructor(app: App, private preview: ImportPreview, private apply: () => Promise<void>) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName("Literature import preview").setHeading();
		this.contentEl.createEl("p", { text: `${this.preview.exists ? "Update managed sections in" : "Create"}: ${this.preview.path}` });
		const status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		if (this.preview.conflicts.length) {
			status.addClass("cmds-zotero-error");
			status.setText(`Import blocked: ${this.preview.conflicts.join("; ")}`);
		}
		this.contentEl.createEl("pre", { text: this.preview.content, cls: "cmds-zotero-report", attr: { tabindex: "0" } });
		new Setting(this.contentEl).addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText("Apply import").setCta().setDisabled(this.preview.conflicts.length > 0).onClick(async () => {
				button.setDisabled(true); status.setText("Importing…");
				try { await this.apply(); this.close(); }
				catch (error) { status.setText(error instanceof Error ? error.message : "Import failed."); status.addClass("cmds-zotero-error"); button.setDisabled(false); }
			}));
	}
	onClose(): void { this.contentEl.empty(); }
}
