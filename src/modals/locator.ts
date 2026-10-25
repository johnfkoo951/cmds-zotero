import { App, Modal, Setting } from "obsidian";
import { LOCATOR_LABELS, type Locator } from "../citations/cluster";

/**
 * 0.6.2 citation-locators-affixes: the locator of one citation (label and value). Save with an empty value, or Remove,
 * takes the locator out; prefix and suffix text stay as written.
 */
export class LocatorModal extends Modal {
	constructor(app: App, private readonly citekey: string, private readonly current: Locator | null, private readonly onSubmit: (locator: Locator | null) => void) { super(app); }

	onOpen(): void {
		new Setting(this.contentEl).setName(`Locator for @${this.citekey}`).setHeading();
		let label = this.current ? this.current.label : "p.";
		let value = this.current?.value ?? "";
		const labels = [...LOCATOR_LABELS];
		if (this.current && this.current.label && !labels.includes(this.current.label)) labels.push(this.current.label);
		new Setting(this.contentEl).setName("Label").setDesc("Printed page labels, chapters, sections, figures or paragraphs.").addDropdown(dropdown => {
			for (const option of labels) dropdown.addOption(option, option);
			dropdown.addOption("", "None (a number means a page)");
			dropdown.setValue(label).onChange(next => { label = next; });
		});
		new Setting(this.contentEl).setName("Value").setDesc("For example 33, 33–35 or xii.").addText(text => {
			text.setValue(value).onChange(next => { value = next; });
			text.inputEl.addEventListener("compositionend", () => { value = text.inputEl.value; });
			text.inputEl.addEventListener("keydown", event => {
				if (event.isComposing || (event as { keyCode?: number }).keyCode === 229) return;
				if (event.key === "Enter") { event.preventDefault(); this.submit(label, value); }
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Remove locator").setDisabled(!this.current).onClick(() => { this.close(); this.onSubmit(null); }))
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText("Save").setCta().onClick(() => this.submit(label, value)));
	}

	private submit(label: string, value: string): void {
		this.close();
		this.onSubmit(value.trim() ? { label, value: value.trim() } : null);
	}

	onClose(): void { this.contentEl.empty(); }
}
