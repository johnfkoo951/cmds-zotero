import { App, Modal, Notice, Setting } from "obsidian";

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
