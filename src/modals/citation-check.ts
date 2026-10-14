import { App, Modal, Notice, Setting } from "obsidian";
import { checkRowDetail, checkRowsInReportOrder, checkSummary, type CheckReport, type CheckRow, type CheckStatus } from "../citations/check";

const LABEL: Readonly<Record<CheckStatus, string>> = { ok: "OK", renamed: "Former key", ambiguous: "Ambiguous", unknown: "Unknown", unchecked: "Not checked" };
/** Occurrence links shown per row; the rest are summarised. */
const MAX_LINKS = 12;

/**
 * 0.6.2 check-citations: one row per cited key, problems first. Each occurrence (and a nocite mention) is a link that puts
 * the cursor on it. Report-only: nothing in the note or in Zotero is changed.
 */
export class CitationCheckModal extends Modal {
	constructor(app: App, private readonly heading: string, private readonly report: CheckReport, private readonly jump: (line: number, column: number) => void, private readonly text: string) { super(app); }

	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-report-modal");
		new Setting(this.contentEl).setName(this.heading).setHeading();
		this.contentEl.createEl("p", { cls: "setting-item-description", text: checkSummary(this.report) });
		if (!this.report.rows.length) this.contentEl.createEl("p", { text: "This note cites no keys (pandoc citations, [[@citekey]] links or nocite)." });
		for (const row of checkRowsInReportOrder(this.report.rows)) this.renderRow(row);
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Copy report").setCta().onClick(() => {
				void navigator.clipboard.writeText(this.text).then(() => { new Notice("Citation report copied."); }, () => { new Notice("Copy failed; the report could not reach the clipboard."); });
			}))
			.addButton(button => button.setButtonText("Close").onClick(() => this.close()));
	}

	private renderRow(row: CheckRow): void {
		const problem = row.status !== "ok" || row.noNote === true;
		const setting = new Setting(this.contentEl).setName(`${LABEL[row.status]} · @${row.citekey}${row.noNote === true ? " · no literature note" : ""}`).setDesc(checkRowDetail(row, this.report.snapshot));
		setting.settingEl.addClass("cmds-zotero-check-row", problem ? "is-warning" : "is-ok");
		const links = setting.descEl.createDiv({ cls: "cmds-zotero-check-links" });
		const link = (label: string, line: number, column: number): void => {
			const anchor = links.createEl("a", { text: label, href: "#" });
			anchor.addEventListener("click", event => { event.preventDefault(); this.jump(line, column); this.close(); });
		};
		for (const occurrence of row.occurrences.slice(0, MAX_LINKS)) link(`Line ${occurrence.line + 1}`, occurrence.line, occurrence.column);
		if (row.occurrences.length > MAX_LINKS) links.createSpan({ text: `+${row.occurrences.length - MAX_LINKS} more` });
		if (row.nociteLine !== undefined) link("nocite", row.nociteLine, 0);
		if (row.candidates?.length) links.createSpan({ cls: "cmds-zotero-check-candidates", text: row.candidates.map(entry => `${entry.title} (library ${entry.libraryID})`).join("; ") });
	}

	onClose(): void { this.contentEl.empty(); }
}

/** Plain-text form of the report for the clipboard (no paths beyond the note's own name). */
export function checkReportText(name: string, report: CheckReport): string {
	const lines = [`Citations in ${name}: ${checkSummary(report)}`];
	for (const row of checkRowsInReportOrder(report.rows)) {
		const where = row.occurrences.map(item => item.line + 1).slice(0, MAX_LINKS).join(", ");
		lines.push(`- ${LABEL[row.status]}${row.noNote === true ? " (no literature note)" : ""} @${row.citekey}${where ? ` — lines ${where}` : ""}${row.nocite ? " — nocite" : ""}`);
	}
	return lines.join("\n");
}
