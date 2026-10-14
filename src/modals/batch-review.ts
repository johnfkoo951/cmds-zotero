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
	constructor(app: App, private heading: string, rows: ReviewRow<T>[], private apply: (rows: ReviewRow<T>[]) => void, private options: BatchReviewOptions<T>) {
		super(app);
		this.rows = rows;
		this.since = options.changedSince?.initial ?? null;
	}
	onOpen(): void { this.render(); }

	private render(): void {
		this.contentEl.empty();
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName(this.heading).setHeading();
		this.contentEl.createEl("p", { text: "Nothing has been read from Zotero or written yet. Untick a row to leave it out." });
		if (this.options.changedSince && this.since) this.renderSince(this.options.changedSince.replan);
		const summary = this.contentEl.createDiv({ cls: "cmds-zotero-section-summary", attr: { role: "status", "aria-live": "polite" } });
		const refresh = (): void => { summary.setText(planSummary(this.rows)); };
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Select all").onClick(() => { for (const row of this.rows) if (row.action !== "skip") row.include = true; this.render(); }))
			.addButton(button => button.setButtonText("Select none").onClick(() => { for (const row of this.rows) row.include = false; this.render(); }));
		const list = this.contentEl.createDiv({ cls: ["cmds-zotero-section-list", "cmds-zotero-batch-review"] });
		for (const row of this.rows) {
			const item = list.createDiv({ cls: ["cmds-zotero-section", `cmds-zotero-review-${row.action}`] });
			const setting = new Setting(item).setName(`${ACTION_LABELS[row.action]} · ${row.label}`).setDesc(`${row.detail}${row.reason ? ` — ${row.reason}` : ""}`);
			if (row.action !== "skip") setting.addToggle(toggle => toggle.setValue(row.include).setTooltip("Include this note").onChange(value => { row.include = value; refresh(); }));
		}
		refresh();
		new Setting(this.contentEl).addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText(this.options.applyLabel).setCta().onClick(() => {
				const chosen = this.rows.filter(row => row.include && row.action !== "skip");
				if (!chosen.length) { summary.setText("Nothing is selected."); return; }
				this.close();
				this.apply(chosen);
			}));
	}

	private renderSince(replan: (since: ChangedSince) => ReviewRow<T>[]): void {
		const since = this.since ?? { kind: "any" };
		const row = new Setting(this.contentEl).setName("Changed in Zotero since").setDesc("Notes whose item and annotations did not change in Zotero since then are skipped (dates from the saved index).");
		row.addDropdown(dropdown => dropdown.addOption("any", "Any time (update all)").addOption("note", "The note was last written").addOption("date", "A date…")
			.setValue(since.kind).onChange(value => {
				this.since = value === "any" ? { kind: "any" } : value === "note" ? { kind: "note" } : { kind: "date", time: localDayStart(localDay(new Date())) ?? Date.now() };
				this.rows = replan(this.since);
				this.render();
			}));
		if (since.kind === "date") {
			row.addText(text => text.setPlaceholder("2026-01-31").setValue(localDay(new Date(since.time))).onChange(value => {
				const time = localDayStart(value);
				if (time === null) return;
				this.since = { kind: "date", time };
				this.rows = replan(this.since);
				this.render();
			}));
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
