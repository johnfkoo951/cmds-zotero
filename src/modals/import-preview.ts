import { App, Modal, Setting } from "obsidian";
import type { ImportPreview } from "../importer";
import { SECTION_GROUPS, type SectionGroup, type SectionState } from "../note-writer";

// 0.5 R5: per-section choices collected by the preview modal.
export interface ApplyChoices { detach: string[]; reset: string[] }

const GROUP_LABELS: Record<SectionGroup, string> = { overview: "Title and abstract", citation: "Bibliography entry", metadata: "Metadata and links", notes: "Zotero notes", annotations: "Annotations" };
const HEADINGS: Record<NonNullable<ImportPreview["mode"]>, string> = { import: "Literature import preview", rebuild: "Rebuild literature note", adopt: "Adopt note as literature note" };

/**
 * The import/update preview. 0.6.3: the target path for a new note, warnings (Better Notes, adopt), the rebuild's marker
 * repairs, and for an existing note the section groups to refresh (selective-update-scope): changing them renders the
 * preview again without asking Zotero (`revise`).
 */
export class ImportPreviewModal extends Modal {
	constructor(app: App, private preview: ImportPreview, private apply: (choices: ApplyChoices, preview: ImportPreview) => Promise<void>, private revise?: (preview: ImportPreview, scope: SectionGroup[] | undefined) => Promise<ImportPreview>) { super(app); }
	onOpen(): void { this.render(); }

	private render(): void {
		this.contentEl.empty();
		this.modalEl.addClass("cmds-zotero-report-modal");
		const mode = this.preview.mode ?? "import";
		new Setting(this.contentEl).setName(HEADINGS[mode]).setHeading();
		const action = mode === "adopt" ? "Append generated sections to" : mode === "rebuild" ? "Repair and refresh" : this.preview.exists ? "Update managed sections in" : "Create";
		this.contentEl.createEl("p", { text: `${action}: ${this.preview.path}` });
		if (this.preview.backup) this.contentEl.createEl("p", { cls: "cmds-zotero-preview-note", text: "The note's current text is copied to the plugin's private backup folder before the write." });
		for (const warning of this.preview.warnings ?? []) this.contentEl.createDiv({ cls: ["cmds-zotero-status", "cmds-zotero-preview-warning"], text: warning });
		if (this.preview.repairs) {
			const repairs = this.contentEl.createDiv({ cls: "cmds-zotero-preview-repairs" });
			repairs.createDiv({ text: this.preview.repairs.length ? "Repairs:" : "The markers are sound; the rebuild only refreshes the sections." });
			const list = repairs.createEl("ul");
			for (const line of this.preview.repairs) list.createEl("li", { text: line });
		}
		const status = this.contentEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		const blocked = this.preview.conflicts.length > 0;
		if (blocked) {
			status.addClass("cmds-zotero-error");
			status.setText(`${mode === "adopt" ? "Adopt" : "Import"} blocked: ${this.preview.conflicts.join("; ")}`);
		} else if (this.preview.softConflicts.length) {
			status.setText("Edited sections are kept as they are unless you detach or reset them; the other sections are refreshed.");
		}
		if (this.revise && this.preview.exists && mode !== "adopt" && !blocked) this.renderScope();
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
			if ((section.state === "edited" || section.state === "detached") && section.reason !== "not in this update: left as it is") {
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
		const label = mode === "adopt" ? "Adopt note" : mode === "rebuild" ? "Rebuild note" : "Apply import";
		new Setting(this.contentEl).addButton(button => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(button => button.setButtonText(label).setCta().setDisabled(blocked).onClick(async () => {
				button.setDisabled(true); status.setText("Writing…");
				try { await this.apply({ detach: [...choices.detach], reset: [...choices.reset] }, this.preview); this.close(); }
				catch (error) { status.setText(error instanceof Error ? error.message : "Import failed."); status.addClass("cmds-zotero-error"); button.setDisabled(false); }
			}));
	}

	/** 0.6.3 selective-update-scope: one toggle per section group; at least one stays on. */
	private renderScope(): void {
		const revise = this.revise;
		if (!revise) return;
		const current = new Set<SectionGroup>(this.preview.scope ?? SECTION_GROUPS);
		const box = this.contentEl.createDiv({ cls: "cmds-zotero-preview-scope" });
		new Setting(box).setName("Refresh").setDesc("Sections you switch off are left exactly as they are in this update.");
		for (const group of SECTION_GROUPS) {
			new Setting(box).setName(GROUP_LABELS[group]).addToggle(toggle => toggle.setValue(current.has(group)).onChange(async on => {
				const next = new Set(current);
				if (on) next.add(group); else next.delete(group);
				if (!next.size) { toggle.setValue(true); return; }
				const scope = next.size === SECTION_GROUPS.length ? undefined : SECTION_GROUPS.filter(g => next.has(g));
				try { this.preview = await revise(this.preview, scope); this.render(); }
				catch (error) { this.contentEl.createDiv({ cls: ["cmds-zotero-status", "cmds-zotero-error"], text: error instanceof Error ? error.message : "The preview could not be updated." }); }
			}));
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
