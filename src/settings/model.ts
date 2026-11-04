/**
 * Declarative model of the settings tab. Each area describes its rows in its own file under `sections/` through a
 * {@link SectionBuilder}; `tab.ts` renders the resulting specs. The builder's method names mirror Obsidian's `Setting`
 * (`setName`, `setDesc`, `addOption`, `setButtonText`, `setPlaceholder`, `setText`) so UI text stays visible to the
 * sentence-case lint. Pure: no `obsidian` import.
 */
import type { Field, SettingKey, SettingsDraft } from "./fields";
import { normalizeSettings } from "../settings-data";

/** What a button row may ask of the plugin; each call resolves to the status text shown under the button. */
export interface SettingsActions {
	testConnection(): Promise<string>;
	refreshIndex(): Promise<string>;
	/** 0.6.2: opens the installed-style picker; a chosen style that Better BibTeX renders is put into the draft. */
	chooseStyle(): Promise<string>;
}

interface RowBase { name: string; desc: string }
export interface TextRowSpec extends RowBase { kind: "text" | "textarea"; field: Field<string>; placeholder: string }
export interface DropdownRowSpec extends RowBase { kind: "dropdown"; field: Field<string>; options: (draft: SettingsDraft) => [value: string, label: string][] }
export interface ToggleRowSpec extends RowBase { kind: "toggle"; field: Field<boolean> }
export interface ActionRowSpec extends RowBase { kind: "action"; button: string; run: (actions: SettingsActions) => Promise<string> }
export interface NoteRowSpec { kind: "note"; text: string }
export type ControlRowSpec = TextRowSpec | DropdownRowSpec | ToggleRowSpec;
export type RowSpec = ControlRowSpec | ActionRowSpec | NoteRowSpec;

export interface SectionSpec {
	id: string;
	heading: string;
	/** Rendered under the one collapsed "Advanced" heading. */
	advanced: boolean;
	rows: RowSpec[];
}

export class RowBuilder<R extends RowBase> {
	constructor(protected readonly row: R) {}
	setName(name: string): this { this.row.name = name; return this; }
	setDesc(desc: string): this { this.row.desc = desc; return this; }
}

export class TextRowBuilder extends RowBuilder<TextRowSpec> {
	setPlaceholder(text: string): this { this.row.placeholder = text; return this; }
}

export class DropdownRowBuilder extends RowBuilder<DropdownRowSpec> {
	private fixed: [string, string][] = [];
	private extra: ((draft: SettingsDraft) => [string, string][]) | null = null;
	constructor(row: DropdownRowSpec) {
		super(row);
		row.options = draft => {
			const options = [...this.fixed];
			for (const option of this.extra?.(draft) ?? []) if (!options.some(([value]) => value === option[0])) options.push(option);
			return options;
		};
	}
	addOption(value: string, label: string): this { this.fixed.push([value, label]); return this; }
	/** Options that depend on the draft (for example a stored value outside the fixed list); listed after the fixed ones. */
	addOptionsFrom(options: (draft: SettingsDraft) => [string, string][]): this { this.extra = options; return this; }
}

export class ActionRowBuilder extends RowBuilder<ActionRowSpec> {
	setButtonText(text: string): this { this.row.button = text; return this; }
}

export class NoteBuilder {
	constructor(private readonly row: NoteRowSpec) {}
	setText(text: string): void { this.row.text = text; }
}

/** Records one area's rows. A section file is a function of this builder and adds a control with one chained call. */
export class SectionBuilder {
	readonly spec: SectionSpec;
	constructor(id: string, advanced = false) { this.spec = { id, heading: "", advanced, rows: [] }; }
	/** The section heading. */
	setName(heading: string): this { this.spec.heading = heading; return this; }
	text(field: Field<string>): TextRowBuilder { return new TextRowBuilder(this.push({ kind: "text", field, name: "", desc: "", placeholder: "" })); }
	textArea(field: Field<string>): TextRowBuilder { return new TextRowBuilder(this.push({ kind: "textarea", field, name: "", desc: "", placeholder: "" })); }
	dropdown(field: Field<string>): DropdownRowBuilder { return new DropdownRowBuilder(this.push({ kind: "dropdown", field, name: "", desc: "", options: () => [] })); }
	toggle(field: Field<boolean>): RowBuilder<ToggleRowSpec> { return new RowBuilder(this.push({ kind: "toggle", field, name: "", desc: "" })); }
	button(run: ActionRowSpec["run"]): ActionRowBuilder { return new ActionRowBuilder(this.push({ kind: "action", run, name: "", desc: "", button: "" })); }
	note(): NoteBuilder { return new NoteBuilder(this.push({ kind: "note", text: "" })); }
	private push<R extends RowSpec>(row: R): R { this.spec.rows.push(row); return row; }
}

export interface SectionDefinition {
	id: string;
	advanced?: boolean;
	define(section: SectionBuilder): void;
}

export function buildSections(definitions: readonly SectionDefinition[]): SectionSpec[] {
	return definitions.map(definition => {
		const builder = new SectionBuilder(definition.id, definition.advanced === true);
		definition.define(builder);
		return builder.spec;
	});
}

/** The control rows of a section list, in order. */
export function controlRows(sections: readonly SectionSpec[]): ControlRowSpec[] {
	return sections.flatMap(section => section.rows.filter((row): row is ControlRowSpec => row.kind === "text" || row.kind === "textarea" || row.kind === "dropdown" || row.kind === "toggle"));
}

/**
 * 0.6.7 save-switches-at-once: a switch or a menu is stored as soon as it changes, so a setting never looks on while the
 * stored one is off (Obsidian 1.13+ shows Save far from the row in settings search). Typed values still wait for Save.
 */
export function savesAtOnce(row: ControlRowSpec): boolean {
	return row.kind === "toggle" || row.kind === "dropdown";
}

/** The stored settings with one value written over them; other unsaved edits stay in the draft. */
export function withSetting<K extends keyof SettingsDraft>(stored: SettingsDraft, key: K, value: SettingsDraft[K]): SettingsDraft {
	return { ...stored, [key]: value };
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * 0.6.8 unsaved-row-save: true when saving the draft's value of `key` would change the stored settings. The value is
 * compared after the normalisation Save applies, so a value set back to the stored one, or an emptied field whose
 * default is the stored value, is not an unsaved change.
 */
export function isUnsaved(draft: SettingsDraft, stored: SettingsDraft, key: SettingKey): boolean {
	if (sameValue(draft[key], stored[key])) return false;
	return !sameValue(normalizeSettings(withSetting(stored, key, draft[key]))[key], stored[key]);
}

/**
 * The names of the rows whose input is not stored, in the tab's order: a value that differs from the stored one, or an
 * input the field rejected (`problems`, keyed by row name).
 */
export function unsavedRowNames(rows: readonly ControlRowSpec[], draft: SettingsDraft, stored: SettingsDraft, problems: ReadonlyMap<string, string>): string[] {
	return rows.filter(row => problems.has(row.name) || isUnsaved(draft, stored, row.field.key)).map(row => row.name);
}

/**
 * The Save button beside a control: hidden while the row holds the stored value, disabled while the input is rejected
 * or the row is being saved, enabled otherwise. A switch or menu (`atOnce`) saves itself, so its button stays hidden
 * while that save runs and appears only when the value is still unsaved afterwards (the save was refused).
 */
export function rowSaveButton(state: { unsaved: boolean; problem: boolean; saving: boolean; atOnce?: boolean }): "hidden" | "enabled" | "disabled" {
	if (state.saving && state.atOnce) return "hidden";
	if (state.problem || state.saving) return "disabled";
	return state.unsaved ? "enabled" : "hidden";
}

/** What the Save configuration row says about the rows that are not saved yet; empty when every value is stored. */
export function unsavedSummary(names: readonly string[]): string {
	if (!names.length) return "";
	return `${names.length === 1 ? "1 value is" : `${names.length} values are`} not saved yet: ${names.join(", ")}.`;
}

/** 0.6.8: the Notice shown when the tab closes while rows are not saved (their input is dropped); null when none are. */
export function closedUnsavedNotice(names: readonly string[]): string | null {
	if (!names.length) return null;
	return `Settings closed without saving ${names.join(", ")}. The stored ${names.length === 1 ? "value stays" : "values stay"} in use; enter ${names.length === 1 ? "it" : "them"} again and press Save to change ${names.length === 1 ? "it" : "them"}.`;
}

/**
 * Why the draft cannot be saved: the inline problems still open (named after their controls), else null. Each control
 * keeps its own message; this is the summary the Save button shows.
 */
export function saveBlocker(problems: ReadonlyMap<string, string>): string | null {
	if (!problems.size) return null;
	return `Fix ${problems.size === 1 ? "this value" : `these ${problems.size} values`} first: ${[...problems.keys()].join(", ")}.`;
}
