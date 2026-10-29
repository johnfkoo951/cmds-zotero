import { App, Notice, PluginSettingTab, Setting, requireApiVersion } from "obsidian";
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { describeBbtError } from "../api/transport";
import { draftOf, type Problem, type SettingsDraft } from "./fields";
import { buildSections, saveBlocker, savesAtOnce, withSetting, type ControlRowSpec, type RowSpec, type SectionSpec, type SettingsActions } from "./model";
import { SETTINGS_SECTIONS } from "./registry";
import { chooseInstalledStyle } from "../plugin/style-picker";

/**
 * The settings tab: the area sections of `registry.ts`, edited in a draft and stored by Save (inline problems block
 * it); 0.6.7: switches and menus are stored as soon as they change. Obsidian before 1.13 renders `display()`; 1.13 and
 * later render the same rows from `getSettingDefinitions()` (searchable), each row through the same `renderRow`.
 */
export class CmdsZoteroSettingsTab extends PluginSettingTab {
	private readonly sections: SectionSpec[] = buildSections(SETTINGS_SECTIONS);
	private draft: SettingsDraft;
	/** Open inline problems, keyed by control name. */
	private readonly problems = new Map<string, string>();
	/** 0.6.4: shows a draft value set outside its control (the style picker) in the last rendered control for that key. */
	private readonly refreshers = new Map<string, () => void>();
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
					new Notice(`${style.title} (${style.key}) renders in Better BibTeX. Save the configuration to use it.`);
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
		this.reset();
		this.refreshers.clear();
		this.draftStale = true;
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		if (!requireApiVersion("1.13.0")) return [];
		const group = (section: SectionSpec): SettingDefinitionGroup => ({ type: "group", heading: section.heading, items: section.rows.map(row => this.definition(row)) });
		// A value edited in Obsidian's settings search only reaches the draft, so Save is found by every row's name too.
		const rowNames = this.sections.flatMap(section => section.rows.flatMap(row => row.kind === "note" || row.kind === "action" ? [] : [row.name, row.field.key]));
		const save = (): SettingDefinition => ({ name: "Save configuration", aliases: rowNames, render: setting => this.renderSave(setting) });
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
		const problemEl = setting.infoEl.createDiv({ cls: "cmds-zotero-error", attr: { role: "alert" } });
		problemEl.hide();
		const savedEl = savesAtOnce(row) ? setting.infoEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } }) : null;
		const report = (problem: Problem): void => {
			if (problem) this.problems.set(row.name, problem); else this.problems.delete(row.name);
			problemEl.setText(problem ?? "");
			problemEl.toggle(problem !== null);
			if (problem === null && savedEl) this.saveAtOnce(row, savedEl);
		};
		switch (row.kind) {
			case "text":
				setting.addText(text => {
					text.setValue(row.field.read(this.draft)).onChange(value => report(row.field.write(this.draft, value)));
					if (row.placeholder) text.setPlaceholder(row.placeholder);
					this.refreshers.set(row.field.key, () => { text.setValue(row.field.read(this.draft)); report(null); });
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
	}

	/** Runs a save after the ones already started. */
	private enqueue(job: () => Promise<void>): Promise<void> {
		const run = this.saving.then(job, job);
		this.saving = run.catch(() => undefined);
		return run;
	}

	/**
	 * 0.6.7: stores the value a switch or menu just took, written over the stored settings at the moment it runs. The
	 * value is read now: closing the tab replaces the draft before a queued save starts. A refused save (for example while
	 * the index refreshes) is shown under the row; the draft keeps the value for Save.
	 */
	private saveAtOnce(row: ControlRowSpec, status: HTMLElement): void {
		const key = row.field.key;
		const value = this.draft[key];
		status.setText("");
		void this.enqueue(() => this.plugin.saveSettings(withSetting(this.plugin.settings, key, value))).catch((error: unknown) => {
			status.setText(`Not saved: ${error instanceof Error ? error.message : "the setting could not be saved."} Press Save configuration to try again.`);
		});
	}

	private renderSave(setting: Setting): void {
		setting.setName("Save configuration").setDesc("Switches and menus are saved as soon as they change. Typed values take effect only after saving.");
		const status = setting.infoEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		setting.addButton(button => button.setButtonText("Save").setCta().onClick(async () => {
			const blocked = saveBlocker(this.problems);
			if (blocked) { status.setText(blocked); return; }
			button.setDisabled(true);
			try {
				// 0.6.2 probe-validated-style-picker: a changed style or locale is rendered once by Better BibTeX before it is stored.
				const stored = this.plugin.settings;
				if (this.draft.bibliographyStyle !== stored.bibliographyStyle || this.draft.bibliographyLocale !== stored.bibliographyLocale) {
					status.setText("Checking the bibliography style with Better BibTeX…");
					const problem = await this.plugin.bibliography.probeFormat({ style: this.draft.bibliographyStyle || stored.bibliographyStyle, locale: this.draft.bibliographyLocale });
					if (problem) { status.setText(problem); return; }
				}
				const draft = this.draft;
				await this.enqueue(() => this.plugin.saveSettings(draft));
				status.setText("Configuration saved.");
			}
			catch (error) { status.setText(error instanceof Error ? error.message : "Configuration could not be saved."); }
			finally { button.setDisabled(false); }
		}));
	}
}
