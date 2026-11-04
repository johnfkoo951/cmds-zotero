import { App, Notice, PluginSettingTab, Setting, requireApiVersion, type ButtonComponent } from "obsidian";
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { describeBbtError } from "../api/transport";
import { draftOf, type Problem, type SettingsDraft } from "./fields";
import { buildSections, closedUnsavedNotice, controlRows, isUnsaved, rowSaveButton, saveBlocker, savesAtOnce, unsavedRowNames, unsavedSummary, withSetting, type ControlRowSpec, type RowSpec, type SectionSpec, type SettingsActions } from "./model";
import { SETTINGS_SECTIONS } from "./registry";
import { chooseInstalledStyle } from "../plugin/style-picker";

/** How long "Saved." stays under a row. */
const SAVED_NOTE_MS = 3000;
/** The syncer of the Save configuration row; the rows' syncers are keyed by their setting key. */
const SUMMARY = "#save-configuration";

/**
 * The settings tab: the area sections of `registry.ts`, edited in a draft (inline problems keep a rejected input out of
 * it). 0.6.7: switches and menus are stored as soon as they change. 0.6.8: a typed value that differs from the stored
 * one says so under its row, beside a Save button (or Enter in a one-line field) that stores that value alone; Save all
 * stores the whole draft, and closing the tab while rows are unsaved names them in a Notice. Obsidian before 1.13
 * renders `display()`; 1.13 and later render the same rows from `getSettingDefinitions()` (searchable), each row through
 * the same `renderRow`.
 */
export class CmdsZoteroSettingsTab extends PluginSettingTab {
	private readonly sections: SectionSpec[] = buildSections(SETTINGS_SECTIONS);
	private readonly controls: ControlRowSpec[] = controlRows(this.sections);
	private draft: SettingsDraft;
	/** Open inline problems, keyed by control name. */
	private readonly problems = new Map<string, string>();
	/** 0.6.4: shows a draft value set outside its control (the style picker) in the last rendered control for that key. */
	private readonly refreshers = new Map<string, () => void>();
	/** 0.6.8: brings the last rendered control of each key, and the Save configuration row, up to date after a save. */
	private readonly syncers = new Map<string, () => void>();
	/**
	 * 0.6.4: Obsidian 1.13+ never calls display(), so the first row rendered after the tab opens takes a new draft; the
	 * stored settings may have changed while the tab was closed (Choose bibliography style from installed styles).
	 */
	private draftStale = true;
	/** 0.6.7: saves run one after another, so two quick switches never store over each other. */
	private saving: Promise<unknown> = Promise.resolve();
	private readonly actions: SettingsActions;

	constructor(app: App, private plugin: CMDSZoteroPlugin) {
		super(app, plugin);
		this.draft = draftOf(plugin.settings);
		this.actions = {
			testConnection: async () => {
				try {
					const capabilities = await this.plugin.bbt.capabilities();
					return `Connected: Zotero ${capabilities.zotero}; Better BibTeX ${capabilities.betterbibtex}.`;
				} catch (error) { return describeBbtError(error); }
			},
			// The index controller reports progress and the outcome in notices.
			refreshIndex: async () => { await this.plugin.refreshIndex(); return ""; },
			// 0.6.2 installed-csl-style-picker: a style Better BibTeX renders goes into the draft; Save stores it.
			chooseStyle: async () => {
				const draft = this.draft;
				await chooseInstalledStyle(this.plugin, style => {
					// The tab was closed while the picker was open: its draft is gone, so there is nothing to update.
					if (this.draft !== draft) return;
					this.draft.bibliographyStyle = style.key;
					// Obsidian 1.13+ never calls display() again, so the rendered field is updated in place on every version.
					this.refreshers.get("bibliographyStyle")?.();
					new Notice(`${style.title} (${style.key}) renders in Better BibTeX. Press Save beside Bibliography style to use it.`);
				}, this.draft.bibliographyLocale);
				return "";
			},
		};
	}

	/** A new draft from the stored settings: every time the tab opens, unsaved edits are dropped. */
	private reset(): void {
		this.draft = draftOf(this.plugin.settings);
		this.problems.clear();
		this.draftStale = false;
	}

	display(): void {
		this.reset();
		this.render();
	}

	/** Renders the rows from the current draft (Obsidian before 1.13). */
	private render(): void {
		this.problems.clear();
		this.refreshers.clear();
		this.syncers.clear();
		const { containerEl } = this;
		containerEl.empty();
		for (const section of this.sections.filter(item => !item.advanced)) this.renderSection(containerEl, section);
		const advanced = this.sections.filter(item => item.advanced);
		if (advanced.length) {
			const heading = new Setting(containerEl).setName("Advanced").setHeading();
			const body = containerEl.createDiv({ cls: "cmds-zotero-settings-advanced" });
			for (const section of advanced) this.renderSection(body, section);
			let open = false;
			heading.addExtraButton(button => {
				const sync = (): void => {
					body.toggle(open);
					button.setIcon(open ? "chevron-down" : "chevron-right").setTooltip(open ? "Hide advanced controls" : "Show advanced controls");
					button.extraSettingsEl.setAttr("aria-expanded", String(open));
				};
				button.onClick(() => { open = !open; sync(); });
				sync();
			});
		}
		this.renderSave(new Setting(containerEl));
		containerEl.createEl("p", { text: `${this.plugin.manifest.name} ${this.plugin.manifest.version}`, cls: "setting-item-description" });
	}

	hide(): void {
		// 0.6.8: the rows still unsaved once the saves already started have ended are named; their input is dropped.
		if (!this.draftStale) {
			const draft = this.draft;
			const problems = new Map(this.problems);
			void this.saving.then(() => {
				const message = closedUnsavedNotice(unsavedRowNames(this.controls, draft, this.plugin.settings, problems));
				if (message) new Notice(message, 15000);
			});
		}
		this.reset();
		this.refreshers.clear();
		this.syncers.clear();
		this.draftStale = true;
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		if (!requireApiVersion("1.13.0")) return [];
		const group = (section: SectionSpec): SettingDefinitionGroup => ({ type: "group", heading: section.heading, items: section.rows.map(row => this.definition(row)) });
		// 0.6.8: every row found by settings search has its own Save, so this row is no longer found by their names.
		const save = (): SettingDefinition => ({ name: "Save configuration", render: setting => this.renderSave(setting) });
		const advanced = this.sections.filter(item => item.advanced);
		return [
			...this.sections.filter(item => !item.advanced).map(group),
			...(advanced.length ? [{ type: "page" as const, name: "Advanced", desc: advanced.map(section => section.heading).join(", "), items: [...advanced.map(group), { type: "group" as const, items: [save()] }] }] : []),
			{ type: "group", items: [save(), { name: `${this.plugin.manifest.name} ${this.plugin.manifest.version}`, searchable: false }] },
		];
	}

	private definition(row: RowSpec): SettingDefinition {
		if (row.kind === "note") return { name: "", desc: row.text, searchable: false, render: setting => this.renderRow(setting, row) };
		return { name: row.name, desc: row.desc, ...(row.kind === "action" ? {} : { aliases: [row.field.key] }), render: setting => this.renderRow(setting, row) };
	}

	private renderSection(container: HTMLElement, section: SectionSpec): void {
		new Setting(container).setName(section.heading).setHeading();
		for (const row of section.rows) this.renderRow(new Setting(container), row);
	}

	/** One row: a control bound to the draft with its inline problem, a button with its own status, or a note. */
	private renderRow(setting: Setting, row: RowSpec): void {
		if (this.draftStale) this.reset();
		if (row.kind === "note") { setting.setDesc(row.text); return; }
		setting.setName(row.name).setDesc(row.desc);
		if (row.kind === "action") {
			const status = setting.infoEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
			setting.addButton(button => button.setButtonText(row.button).onClick(async () => {
				button.setDisabled(true);
				status.setText("");
				try { status.setText(await row.run(this.actions)); }
				catch (error) { status.setText(error instanceof Error ? error.message : "The action failed."); }
				finally { button.setDisabled(false); }
			}));
			return;
		}
		// A re-rendered row shows the draft's last accepted value, so an earlier rejected input no longer blocks Save.
		this.problems.delete(row.name);
		const key = row.field.key;
		const problemEl = setting.infoEl.createDiv({ cls: "cmds-zotero-error", attr: { role: "alert" } });
		problemEl.hide();
		// 0.6.8: "Not saved yet", the progress of a save, "Saved." for a moment, or why the last save failed.
		const statusEl = setting.infoEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		const notSaved = row.kind === "text" ? "Not saved yet: press Save or Enter." : "Not saved yet: press Save.";
		let saveButton: ButtonComponent | null = null;
		let pending = 0;
		let outcome: { text: string; failed: boolean } | null = null;
		let clearOutcome = 0;
		const buttonState = (unsaved: boolean): ReturnType<typeof rowSaveButton> => rowSaveButton({ unsaved, problem: this.problems.has(row.name), saving: pending > 0, atOnce: savesAtOnce(row) });
		const sync = (): void => {
			const problem = this.problems.has(row.name);
			const unsaved = isUnsaved(this.draft, this.plugin.settings, key);
			const button = buttonState(unsaved);
			saveButton?.buttonEl.toggle(button !== "hidden");
			saveButton?.setDisabled(button !== "enabled");
			setting.settingEl.toggleClass("cmds-zotero-unsaved", unsaved || problem);
			if (pending > 0) return;
			// A failure is shown while the value is still unsaved, "Saved." while it is stored.
			statusEl.setText(outcome && outcome.failed === unsaved ? outcome.text : unsaved ? notSaved : "");
		};
		// Stores the draft's value of this key alone, read now: closing the tab replaces the draft before a queued save starts.
		const save = (): void => {
			const value = this.draft[key];
			pending += 1;
			outcome = null;
			window.clearTimeout(clearOutcome);
			statusEl.setText("Saving…");
			sync();
			void this.store(stored => withSetting(stored, key, value), text => statusEl.setText(text)).then(() => {
				outcome = { text: "Saved.", failed: false };
				clearOutcome = window.setTimeout(() => { outcome = null; sync(); }, SAVED_NOTE_MS);
			}, (error: unknown) => {
				const reason = error instanceof Error ? error.message : "the setting could not be saved.";
				outcome = { text: `Not saved: ${reason}${savesAtOnce(row) ? " Press Save to try again." : ""}`, failed: true };
			}).finally(() => { pending -= 1; this.syncAll(); });
		};
		const report = (problem: Problem): void => {
			if (problem) this.problems.set(row.name, problem); else this.problems.delete(row.name);
			problemEl.setText(problem ?? "");
			problemEl.toggle(problem !== null);
			outcome = null;
			// 0.6.7: every change of a switch or menu is stored in order, even one that only undoes a queued save.
			if (problem === null && savesAtOnce(row)) save(); else sync();
			this.syncers.get(SUMMARY)?.();
		};
		switch (row.kind) {
			case "text":
				setting.addText(text => {
					text.setValue(row.field.read(this.draft)).onChange(value => report(row.field.write(this.draft, value)));
					if (row.placeholder) text.setPlaceholder(row.placeholder);
					this.refreshers.set(row.field.key, () => { text.setValue(row.field.read(this.draft)); report(null); });
					// Enter while an input method composes (Korean, Japanese …) commits the composition, not the value.
					text.inputEl.addEventListener("keydown", event => {
						if (event.key !== "Enter" || event.isComposing) return;
						event.preventDefault();
						if (buttonState(isUnsaved(this.draft, this.plugin.settings, key)) === "enabled") save();
					});
				});
				break;
			case "textarea":
				setting.addTextArea(text => {
					text.setValue(row.field.read(this.draft)).onChange(value => report(row.field.write(this.draft, value)));
					if (row.placeholder) text.setPlaceholder(row.placeholder);
				});
				break;
			case "dropdown":
				setting.addDropdown(dropdown => {
					for (const [value, label] of row.options(this.draft)) dropdown.addOption(value, label);
					dropdown.setValue(row.field.read(this.draft)).onChange(value => report(row.field.write(this.draft, value)));
				});
				break;
			case "toggle":
				setting.addToggle(toggle => toggle.setValue(row.field.read(this.draft)).onChange(value => report(row.field.write(this.draft, value))));
				break;
		}
		// 0.6.8: shown while the row is unsaved; a switch or menu shows it only after its save was refused.
		setting.addButton(button => { saveButton = button; button.setButtonText("Save").setCta().onClick(save); });
		this.syncers.set(key, sync);
		sync();
	}

	private syncAll(): void {
		for (const sync of this.syncers.values()) sync();
	}

	/** Runs a save after the ones already started. */
	private enqueue(job: () => Promise<void>): Promise<void> {
		const run = this.saving.then(job, job);
		this.saving = run.catch(() => undefined);
		return run;
	}

	/**
	 * Stores `next(stored)` after the saves already started, computed from the stored settings when it runs, so a row's
	 * save never stores over another row's. 0.6.2 probe-validated-style-picker: a changed style or locale is rendered once
	 * by Better BibTeX first, and a style it refuses is not stored (the reason is thrown). A refused save (for example
	 * while the index refreshes) throws too; the draft keeps the value.
	 */
	private store(next: (stored: SettingsDraft) => SettingsDraft, progress: (text: string) => void): Promise<void> {
		return this.enqueue(async () => {
			const stored = this.plugin.settings;
			const settings = next(stored);
			if (settings.bibliographyStyle !== stored.bibliographyStyle || settings.bibliographyLocale !== stored.bibliographyLocale) {
				progress("Checking the bibliography style with Better BibTeX…");
				const problem = await this.plugin.bibliography.probeFormat({ style: settings.bibliographyStyle || stored.bibliographyStyle, locale: settings.bibliographyLocale });
				if (problem) throw new Error(problem);
				progress("Saving…");
			}
			await this.plugin.saveSettings(settings);
		});
	}

	private renderSave(setting: Setting): void {
		// Obsidian 1.13+: settings search may show this row without any other, so it takes the new draft itself.
		if (this.draftStale) this.reset();
		setting.setName("Save configuration").setDesc("Switches and menus are saved as soon as they change. A typed value is saved with the button beside it, or with the return key in a one-line field. This button stores every value at once.");
		const unsavedEl = setting.infoEl.createDiv({ cls: "cmds-zotero-status cmds-zotero-unsaved-summary" });
		const status = setting.infoEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		const sync = (): void => { unsavedEl.setText(unsavedSummary(unsavedRowNames(this.controls, this.draft, this.plugin.settings, this.problems))); };
		this.syncers.set(SUMMARY, sync);
		sync();
		setting.addButton(button => button.setButtonText("Save all").setCta().onClick(async () => {
			const blocked = saveBlocker(this.problems);
			if (blocked) { status.setText(blocked); return; }
			button.setDisabled(true);
			status.setText("Saving…");
			try {
				const draft = this.draft;
				await this.store(() => draft, text => status.setText(text));
				status.setText("Configuration saved.");
			}
			catch (error) { status.setText(error instanceof Error ? error.message : "Configuration could not be saved."); }
			finally { button.setDisabled(false); this.syncAll(); }
		}));
	}
}
