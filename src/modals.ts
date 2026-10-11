import { App, FuzzySuggestModal, Modal, Notice, Setting } from "obsidian";
import type { ImportPreview } from "./importer";
import type { SectionState } from "./note-writer";

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

// 0.5 R5: per-section choices collected by the preview modal.
export interface ApplyChoices { detach: string[]; reset: string[] }
export class ImportPreviewModal extends Modal {
	constructor(app: App, private preview: ImportPreview, private apply: (choices: ApplyChoices) => Promise<void>) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName("Literature import preview").setHeading();
		this.contentEl.createEl("p", { text: `${this.preview.exists ? "Update managed sections in" : "Create"}: ${this.preview.path}` });
		const status = this.contentEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		const blocked = this.preview.conflicts.length > 0;
		if (blocked) {
			status.addClass("cmds-zotero-error");
			status.setText(`Import blocked: ${this.preview.conflicts.join("; ")}`);
		} else if (this.preview.softConflicts.length) {
			status.setText("Edited sections are kept as they are unless you detach or reset them; the other sections are refreshed.");
		}
		const counts = new Map<SectionState, number>();
		for (const section of this.preview.sections) counts.set(section.state, (counts.get(section.state) ?? 0) + 1);
		const labels: Record<SectionState, string> = { fresh: "new", unchanged: "refreshed", edited: "edited (preserved)", detached: "detached", malformed: "malformed", missing: "missing" };
		const summary = [...counts].map(([state, count]) => `${count} ${labels[state]}`).join(", ");
		this.contentEl.createDiv({ cls: "cmds-zotero-section-summary", text: `${this.preview.sections.length} managed sections${summary ? `: ${summary}` : ""}` });
		const choices = { detach: new Set<string>(), reset: new Set<string>() };
		const list = this.contentEl.createDiv({ cls: "cmds-zotero-section-list" });
		for (const section of this.preview.sections) {
			const item = list.createDiv({ cls: ["cmds-zotero-section", `cmds-zotero-section-${section.state}`] });
			const row = new Setting(item).setName(section.id).setDesc(`${labels[section.state]}${section.line ? ` (line ${section.line})` : ""}: ${section.reason}`);
			if (section.state === "edited" || section.state === "detached") {
				row.addDropdown(dropdown => {
					if (section.state === "edited") dropdown.addOption("keep", "Keep this time").addOption("detach", "Detach (keep mine, never update)");
					else dropdown.addOption("keep", "Keep detached");
					dropdown.addOption("reset", "Reset from Zotero (backup kept)").setValue("keep").onChange(value => {
						choices.detach.delete(section.id); choices.reset.delete(section.id);
						if (value === "detach") choices.detach.add(section.id);
						if (value === "reset") choices.reset.add(section.id);
					});
				});
			}
			if (section.body) {
				const details = item.createEl("details", { cls: "cmds-zotero-section-details" });
				details.createEl("summary", { text: "Show section" });
				details.createEl("pre", { text: section.body, cls: ["cmds-zotero-report", "cmds-zotero-section-body"], attr: { tabindex: "0" } });
			}
		}
		new Setting(this.contentEl).addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText("Apply import").setCta().setDisabled(blocked).onClick(async () => {
				button.setDisabled(true); status.setText("Importing…");
				try { await this.apply({ detach: [...choices.detach], reset: [...choices.reset] }); this.close(); }
				catch (error) { status.setText(error instanceof Error ? error.message : "Import failed."); status.addClass("cmds-zotero-error"); button.setDisabled(false); }
			}));
	}
	onClose(): void { this.contentEl.empty(); }
}
