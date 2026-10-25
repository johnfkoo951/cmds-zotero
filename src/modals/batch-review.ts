import { App, Modal, Setting } from "obsidian";
import { localDay } from "../recent/recent-reads";
import { localDayStart, planSummary, type ChangedSince, type ReviewRow } from "../batch/plan";

const ACTION_LABELS: Record<ReviewRow["action"], string> = { create: "Create", update: "Update", adopt: "Adopt", skip: "Skip" };

export interface BatchReviewOptions<T> {
	/** The apply button's text. */
	applyLabel: string;
	/** 0.6.3 update-changed-since: shows the "Changed in Zotero since" control; the rows are planned again for a new choice. */
	changedSince?: { initial: ChangedSince; replan: (since: ChangedSince) => ReviewRow<T>[] };
}

/**
 * 0.6.3 batch-dry-run-review: what a batch will do to each note (create, update, adopt, or skip with a reason), before
 * anything is read from Zotero or written. Each row has an include box; Select all / Select none; Apply runs only the
 * included rows. Nothing happens on Cancel.
 */
export class BatchReviewModal<T> extends Modal {
	private rows: ReviewRow<T>[];
	private since: ChangedSince | null;
	private dateInvalid = false;
	private summaryEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private applyButton: { setDisabled(disabled: boolean): unknown } | null = null;
	constructor(app: App, private heading: string, rows: ReviewRow<T>[], private apply: (rows: ReviewRow<T>[]) => void, private options: BatchReviewOptions<T>) {
		super(app);
		this.rows = rows;
		this.since = options.changedSince?.initial ?? null;
	}
	onOpen(): void { this.render(); }

	private refresh(): void {
		this.summaryEl?.setText(planSummary(this.rows));
		const chosen = this.rows.filter(row => row.include && row.action !== "skip").length;
		this.applyButton?.setDisabled(this.dateInvalid || chosen === 0);
	}

	private renderRows(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		for (const row of this.rows) {
			const item = list.createDiv({ cls: ["cmds-zotero-section", `cmds-zotero-review-${row.action}`] });
			const setting = new Setting(item).setName(`${ACTION_LABELS[row.action]} · ${row.label}`).setDesc(`${row.detail}${row.reason ? ` — ${row.reason}` : ""}`);
			if (row.action !== "skip") setting.addToggle(toggle => toggle.setValue(row.include).setTooltip("Include this note").onChange(value => { row.include = value; this.refresh(); }));
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName(this.heading).setHeading();
		this.contentEl.createEl("p", { text: "Nothing has been read from Zotero or written yet. Untick a row to leave it out." });
		if (this.options.changedSince && this.since) this.renderSince(this.options.changedSince.replan);
		this.summaryEl = this.contentEl.createDiv({ cls: "cmds-zotero-section-summary", attr: { role: "status", "aria-live": "polite" } });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Select all").onClick(() => { for (const row of this.rows) if (row.action !== "skip") row.include = true; this.renderRows(); this.refresh(); }))
			.addButton(button => button.setButtonText("Select none").onClick(() => { for (const row of this.rows) row.include = false; this.renderRows(); this.refresh(); }));
		this.listEl = this.contentEl.createDiv({ cls: ["cmds-zotero-section-list", "cmds-zotero-batch-review"] });
		this.renderRows();
		new Setting(this.contentEl).addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => {
				this.applyButton = button;
				button.setButtonText(this.options.applyLabel).setCta().onClick(() => {
					if (this.dateInvalid) return;
					const chosen = this.rows.filter(row => row.include && row.action !== "skip");
					if (!chosen.length) { this.summaryEl?.setText("Nothing is selected."); return; }
					this.close();
					this.apply(chosen);
				});
			});
		this.refresh();
	}

	private renderSince(replan: (since: ChangedSince) => ReviewRow<T>[]): void {
		const since = this.since ?? { kind: "any" };
		const row = new Setting(this.contentEl).setName("Changed in Zotero since").setDesc("Notes whose item and annotations did not change in Zotero since then are skipped (dates from the saved index).");
		const problemEl = row.infoEl.createDiv({ cls: "cmds-zotero-error", attr: { role: "alert" } });
		problemEl.hide();
		this.dateInvalid = false;
		let dateInputEl: HTMLInputElement | null = null;
		const applyDate = (value: string): void => {
			const time = localDayStart(value);
			if (time === null) {
				this.dateInvalid = true;
				problemEl.setText("Enter a valid date (for example 2026-01-31).");
				problemEl.show();
				this.refresh();
				return;
			}
			this.dateInvalid = false;
			problemEl.setText("");
			problemEl.hide();
			this.since = { kind: "date", time };
			this.rows = replan(this.since);
			this.renderRows();
			this.refresh();
		};
		row.addDropdown(dropdown => dropdown.addOption("any", "Any time (update all)").addOption("note", "The note was last written").addOption("date", "A date…")
			.setValue(since.kind).onChange(value => {
				this.dateInvalid = false;
				problemEl.setText("");
				problemEl.hide();
				const defaultTime = this.since?.kind === "date" ? this.since.time : (localDayStart(localDay(new Date())) ?? Date.now());
				this.since = value === "any" ? { kind: "any" } : value === "note" ? { kind: "note" } : { kind: "date", time: defaultTime };
				if (dateInputEl) {
					dateInputEl.toggle(value === "date");
					if (value === "date") dateInputEl.value = localDay(new Date(defaultTime));
				}
				this.rows = replan(this.since);
				this.renderRows();
				this.refresh();
			}));
		const initialTime = since.kind === "date" ? since.time : (localDayStart(localDay(new Date())) ?? Date.now());
		row.addText(text => {
			dateInputEl = text.inputEl;
			text.setPlaceholder("2026-01-31").setValue(localDay(new Date(initialTime))).onChange(value => applyDate(value));
			text.inputEl.addEventListener("compositionend", () => applyDate(text.getValue()));
			text.inputEl.toggle(since.kind === "date");
		});
	}

	onClose(): void { this.contentEl.empty(); }
}
