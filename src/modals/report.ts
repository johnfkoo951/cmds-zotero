import { App, Modal, Setting, setIcon } from "obsidian";

/** 0.6.8 export-result-tones: how a report reads at a glance. */
export type ReportTone = "success" | "info" | "warning" | "error";

export interface ReportAction {
	text: string;
	cta?: boolean;
	/** `label` changes the button's text (for example to "Command copied"); `close` closes the report. */
	run(controls: { label(text: string): void; close(): void }): void | Promise<void>;
}

export interface ReportOptions {
	tone: ReportTone;
	/** Shown first: the outcome, then what needs attention. */
	summary: readonly string[];
	/** Shown open under the summary as code (the command, when it is the result). */
	code?: string;
	/** Buttons before Close. */
	actions?: readonly ReportAction[];
}

const TONE_ICONS: Readonly<Record<ReportTone, string>> = { success: "check-circle", info: "info", warning: "alert-triangle", error: "x-circle" };

/**
 * A plain-text report with a Close button. 0.6.8: with options, the outcome comes first in a block marked by its tone,
 * the report text is folded under Details and the actions sit beside Close.
 */
export class ReportModal extends Modal {
	constructor(app: App, private heading: string, private text: string, private options?: ReportOptions) { super(app); }
	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName(this.heading).setHeading();
		const options = this.options;
		if (!options) {
			this.contentEl.createEl("pre", { text: this.text, cls: "cmds-zotero-report", attr: { tabindex: "0" } });
			new Setting(this.contentEl).addButton(button => button.setButtonText("Close").onClick(() => this.close()));
			return;
		}
		this.modalEl.addClass(`cmds-zotero-report-${options.tone}`);
		const outcome = this.contentEl.createDiv({ cls: "cmds-zotero-report-outcome", attr: { role: options.tone === "warning" || options.tone === "error" ? "alert" : "status" } });
		setIcon(outcome.createDiv({ cls: "cmds-zotero-report-icon" }), TONE_ICONS[options.tone]);
		const body = outcome.createDiv({ cls: "cmds-zotero-report-outcome-text" });
		const [headline = "", ...rest] = options.summary;
		body.createEl("p", { text: headline, cls: "cmds-zotero-report-headline" });
		if (rest.length) {
			const list = body.createEl("ul");
			for (const line of rest) list.createEl("li", { text: line });
		}
		if (options.code) this.contentEl.createEl("pre", { text: options.code, cls: "cmds-zotero-report cmds-zotero-report-code", attr: { tabindex: "0" } });
		if (this.text) {
			const details = this.contentEl.createEl("details", { cls: "cmds-zotero-report-details" });
			details.createEl("summary", { text: "Details" });
			details.createEl("pre", { text: this.text, cls: "cmds-zotero-report", attr: { tabindex: "0" } });
		}
		const buttons = new Setting(this.contentEl);
		for (const action of options.actions ?? []) {
			buttons.addButton(button => {
				button.setButtonText(action.text).onClick(async () => {
					button.setDisabled(true);
					try { await action.run({ label: text => { button.setButtonText(text); }, close: () => this.close() }); }
					finally { button.setDisabled(false); }
				});
				if (action.cta) button.setCta();
			});
		}
		buttons.addButton(button => button.setButtonText("Close").onClick(() => this.close()));
	}
	onClose(): void { this.contentEl.empty(); }
}
