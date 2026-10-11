import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type CmdsZoteroPlugin from "../main";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import { describeBbtError, mapBounded } from "../api/transport";
import {
	RECENT_WINDOW_CHOICES, describeNoteStatus, describeSendOutcome, literatureNoteStatus, localDay, needsSending, readLabel,
	type NoteStatus, type RecentRead,
} from "../recent/recent-reads";

interface Row {
	read: RecentRead;
	/** Fresh from Zotero when `fresh`, else the saved-index entry; null when neither is available. */
	entry: ZoteroIndexEntry | null;
	fresh: boolean;
	status: NoteStatus | null;
	problem: string | null;
	selected: boolean;
	result: string | null;
	setting: Setting;
	toggle: { setValue(value: boolean): unknown; setDisabled(disabled: boolean): unknown } | null;
}

/**
 * "Send recently read papers to notes": Zotero's reading history (PDFs opened in its reader), newest first, with the state
 * of each literature note; sending creates the note or refreshes its managed sections so new annotations arrive. Text the
 * user wrote is never replaced (edited generated sections are kept; unowned notes are refused).
 */
export class RecentReadsModal extends Modal {
	private days: number;
	private rows: Row[] = [];
	private index: ZoteroIndex | null = null;
	private busy = false;
	private closed = false;
	private generation = 0;
	private statusEl!: HTMLElement;
	private listEl!: HTMLElement;
	private sendButton: { setDisabled(disabled: boolean): unknown; setButtonText(text: string): unknown } | null = null;

	constructor(app: App, private plugin: CmdsZoteroPlugin) {
		super(app);
		this.days = plugin.settings.recentReadsDays;
	}

	onOpen(): void {
		this.modalEl.addClass("cmds-zotero-recent-modal");
		new Setting(this.contentEl).setName("Recently read in Zotero").setHeading();
		this.contentEl.createEl("p", { cls: "setting-item-description", text: "Papers whose PDF you opened in Zotero's reader, newest first. Sending creates the literature note, or adds what it is missing (new annotations, notes, metadata); text you wrote is kept." });
		new Setting(this.contentEl).setName("Reading window").addDropdown(dropdown => {
			const choices = RECENT_WINDOW_CHOICES.includes(this.days) ? RECENT_WINDOW_CHOICES : [...RECENT_WINDOW_CHOICES, this.days].sort((a, b) => a - b);
			for (const days of choices) dropdown.addOption(String(days), `Last ${days} days`);
			dropdown.setValue(String(this.days)).onChange(value => { this.days = Number(value); void this.load(); });
		}).addExtraButton(button => button.setIcon("refresh-cw").setTooltip("Reload from Zotero").onClick(() => { void this.load(); }));
		this.statusEl = this.contentEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		this.listEl = this.contentEl.createDiv({ cls: "cmds-zotero-recent-list" });
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Close").onClick(() => this.close()))
			.addButton(button => {
				this.sendButton = button;
				button.setButtonText("Send selected to notes").setCta().setDisabled(true).onClick(() => { void this.send(); });
			});
		void this.load();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	private setStatus(text: string, error = false): void {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("cmds-zotero-error", error);
	}

	private refreshSendButton(): void {
		const count = this.rows.filter(row => row.selected && row.entry && !row.problem).length;
		this.sendButton?.setButtonText(count ? `Send ${count} to notes` : "Send selected to notes");
		this.sendButton?.setDisabled(this.busy || count === 0);
	}

	private async load(): Promise<void> {
		if (this.busy) return;
		const generation = ++this.generation;
		this.rows = [];
		this.listEl.empty();
		this.refreshSendButton();
		this.setStatus("Reading Zotero's reading history…");
		let reads: RecentRead[];
		try { reads = await this.plugin.recentReads(this.days); }
		catch (error) {
			if (generation !== this.generation || this.closed) return;
			this.setStatus(`${describeBbtError(error)} Zotero must be running to list recently read papers; "Import literature note" still works from the saved index.`, true);
			return;
		}
		if (generation !== this.generation || this.closed) return;
		if (!reads.length) { this.setStatus(`No PDF was opened in Zotero's reader in the last ${this.days} days.`); return; }
		this.index = await this.plugin.savedIndex();
		const today = localDay(new Date());
		this.rows = reads.map(read => this.renderRow(read, today));
		this.setStatus(`${reads.length} recently read paper${reads.length === 1 ? "" : "s"}. Checking their literature notes…`);
		const notes = this.plugin.literatureNoteFiles();
		await mapBounded(this.rows, 2, async row => {
			if (generation !== this.generation || this.closed) return;
			await this.inspect(row, notes);
		});
		if (generation !== this.generation || this.closed) return;
		const waiting = this.rows.filter(row => row.status && needsSending(row.status)).length;
		const offline = this.rows.filter(row => row.entry && !row.fresh).length;
		this.setStatus([
			`${this.rows.length} recently read paper${this.rows.length === 1 ? "" : "s"}; ${waiting ? `${waiting} can be sent` : "every note is up to date"}.`,
			offline ? `${offline} could not be read fresh from Zotero and use the saved index.` : "",
		].filter(Boolean).join(" "));
		this.refreshSendButton();
	}

	private renderRow(read: RecentRead, today: string): Row {
		const setting = new Setting(this.listEl).setName(read.title || `@${read.citekey}`);
		setting.settingEl.addClass("cmds-zotero-recent-row");
		const row: Row = { read, entry: null, fresh: false, status: null, problem: null, selected: false, result: null, setting, toggle: null };
		setting.addToggle(toggle => {
			row.toggle = toggle;
			toggle.setTooltip("Send this paper").setDisabled(true).setValue(false).onChange(value => { row.selected = value; this.refreshSendButton(); });
		});
		setting.addExtraButton(button => button.setIcon("file-text").setTooltip("Open literature note").onClick(() => { void this.openNote(row); }));
		this.describe(row, today);
		return row;
	}

	private describe(row: Row, today = localDay(new Date())): void {
		const { read } = row;
		const authors = read.authors.length > 2 ? `${read.authors[0]} et al.` : read.authors.join("; ");
		const meta = [authors, read.year, `@${read.citekey}`, readLabel(read.readOn, today)].filter(Boolean).join(" · ");
		const state = row.result ?? row.problem ?? (row.status ? `${describeNoteStatus(row.status)}${row.entry && !row.fresh ? " (saved index)" : ""}` : "Checking…");
		const fragment = createFragment(frag => {
			frag.createDiv({ text: meta });
			frag.createDiv({ text: state, cls: ["cmds-zotero-recent-state", `cmds-zotero-recent-${row.problem ? "problem" : row.result ? "done" : row.status?.state ?? "pending"}`] });
		});
		row.setting.setDesc(fragment);
	}

	private async inspect(row: Row, notes: Map<string, TFile[]>): Promise<void> {
		const found = await this.plugin.entryForRecent(row.read, this.index);
		row.entry = found.entry;
		row.fresh = found.fresh;
		if (!found.entry) {
			row.problem = `${describeBbtError(found.error)} This paper is not in the saved index yet and could not be read from Zotero.`;
		} else {
			const files = notes.get(found.entry.id) ?? [];
			row.status = literatureNoteStatus(found.entry, await Promise.all(files.map(async file => ({ path: file.path, text: await this.app.vault.cachedRead(file) }))));
			if (row.status.state === "foreign" || row.status.state === "duplicate") row.problem = describeNoteStatus(row.status);
		}
		row.selected = !!row.entry && !row.problem && !!row.status && needsSending(row.status);
		row.toggle?.setDisabled(!row.entry || !!row.problem);
		row.toggle?.setValue(row.selected);
		this.describe(row);
	}

	private async send(): Promise<void> {
		if (this.busy) return;
		if (this.plugin.recentSendActive) { new Notice("Recently read papers are already being sent to notes."); return; }
		const chosen = this.rows.filter(row => row.selected && row.entry && !row.problem);
		if (!chosen.length) return;
		this.busy = true;
		this.plugin.recentSendActive = true;
		this.refreshSendButton();
		for (const row of this.rows) row.toggle?.setDisabled(true);
		const counts = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
		try {
			for (const [position, row] of chosen.entries()) {
				if (this.closed) break;
				this.setStatus(`Sending ${position + 1} of ${chosen.length}: @${row.read.citekey}…`);
				const entry = row.entry;
				if (!entry) continue;
				try {
					const outcome = await this.plugin.sendToNote(entry, this.index, { offline: !row.fresh });
					counts[outcome.status]++;
					row.result = describeSendOutcome(outcome);
					if (outcome.status !== "refused") {
						const files = this.plugin.literatureNoteFiles().get(entry.id) ?? [];
						row.status = literatureNoteStatus(entry, await Promise.all(files.map(async file => ({ path: file.path, text: await this.app.vault.read(file) }))));
					}
				} catch (error) {
					counts.failed++;
					row.result = `Not written: ${error instanceof Error ? error.message : "the send failed"}`;
				}
				row.selected = false;
				row.toggle?.setValue(false);
				this.describe(row);
			}
		} finally {
			this.busy = false;
			this.plugin.recentSendActive = false;
			for (const row of this.rows) row.toggle?.setDisabled(!row.entry || !!row.problem);
		}
		if (this.closed) return;
		const parts = [counts.created && `${counts.created} created`, counts.updated && `${counts.updated} updated`, counts.unchanged && `${counts.unchanged} already up to date`, counts.refused && `${counts.refused} refused`, counts.failed && `${counts.failed} failed`].filter(Boolean);
		this.setStatus(`Done: ${parts.join(", ")}. Open a row's note with its note button.`, counts.refused + counts.failed > 0);
		this.refreshSendButton();
	}

	private async openNote(row: Row): Promise<void> {
		const path = row.status?.path ?? (row.entry ? this.plugin.literatureNoteFiles().get(row.entry.id)?.[0]?.path : undefined);
		if (!path) { new Notice("This paper has no literature note yet; send it first."); return; }
		await this.app.workspace.openLinkText(path, "", true);
	}
}
