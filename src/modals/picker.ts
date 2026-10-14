import { App, FuzzySuggestModal } from "obsidian";

export class PickerModal<T> extends FuzzySuggestModal<T> {
	constructor(app: App, private items: T[], private label: (item: T) => string, private choose: (item: T) => void, placeholder = "Search literature…") {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems(): T[] { return this.items; }
	getItemText(item: T): string { return this.label(item); }
	onChooseItem(item: T): void { this.choose(item); }
}
