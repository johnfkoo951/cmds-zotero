// A stand-in for the parts of Obsidian's UI that the settings tab, the report modal and the export controller use: a tree
// of elements with text, classes, visibility and listeners, settings rows that record their components, and Notices and
// modals collected on globalThis. Tests drive the components (input, click, keydown) and read the tree, never Obsidian.
import { build, type Plugin } from "esbuild";

const MOCK = `
class El {
	constructor(tag) { this.tag = tag; this.children = []; this.text = ""; this.attr = {}; this.cls = new Set(); this.listeners = {}; this.shown = true; }
	empty() { this.children = []; this.text = ""; }
	addClass(...names) { for (const name of names) for (const part of String(name).split(/\\s+/).filter(Boolean)) this.cls.add(part); }
	removeClass(...names) { for (const name of names) this.cls.delete(name); }
	toggleClass(name, on) { if (on) this.cls.add(name); else this.cls.delete(name); }
	hasClass(name) { return this.cls.has(name); }
	setText(text) { this.text = String(text); }
	getText() { return this.text; }
	setAttr(name, value) { this.attr[name] = value; }
	toggle(show) { this.shown = show; }
	hide() { this.shown = false; }
	show() { this.shown = true; }
	createEl(tag, options = {}) {
		const child = new El(tag);
		if (options.text !== undefined) child.text = String(options.text);
		if (options.cls) child.addClass(...[].concat(options.cls));
		if (options.attr) Object.assign(child.attr, options.attr);
		this.children.push(child);
		return child;
	}
	createDiv(options) { return this.createEl("div", options); }
	createSpan(options) { return this.createEl("span", options); }
	addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
	dispatch(type, init = {}) {
		const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init };
		for (const listener of this.listeners[type] ?? []) listener(event);
		return event;
	}
}
class ValueComponent {
	constructor(kind, el) { this.kind = kind; this.inputEl = el; this.value = undefined; this.handler = null; }
	setValue(value) { this.value = value; return this; }
	getValue() { return this.value; }
	onChange(handler) { this.handler = handler; return this; }
	setPlaceholder() { return this; }
	input(value) { this.value = value; this.handler?.(value); }
}
class DropdownComponent extends ValueComponent {
	constructor(el) { super("dropdown", el); this.options = []; }
	addOption(value, label) { this.options.push([value, label]); return this; }
}
class ButtonComponent {
	constructor(el) { this.kind = "button"; this.buttonEl = el; this.disabled = false; this.cta = false; this.handler = null; }
	setButtonText(text) { this.buttonEl.text = text; return this; }
	setCta() { this.cta = true; return this; }
	setDisabled(disabled) { this.disabled = disabled; return this; }
	setIcon() { return this; }
	setTooltip() { return this; }
	onClick(handler) { this.handler = handler; return this; }
	click() { return this.disabled ? undefined : this.handler?.(); }
}
class ExtraButtonComponent {
	constructor(el) { this.kind = "extra"; this.extraSettingsEl = el; }
	setIcon() { return this; }
	setTooltip() { return this; }
	onClick(handler) { this.handler = handler; return this; }
}
export class Setting {
	constructor(containerEl) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
		this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
		this.nameEl = this.infoEl.createDiv();
		this.descEl = this.infoEl.createDiv();
		this.controlEl = this.settingEl.createDiv();
		this.components = [];
		this.name = "";
		(globalThis.__settings ??= []).push(this);
	}
	setName(name) { this.name = name; this.nameEl.text = name; return this; }
	setDesc(desc) { this.desc = desc; return this; }
	setHeading() { this.heading = true; return this; }
	add(component, callback) { this.components.push(component); callback(component); return this; }
	addText(callback) { return this.add(new ValueComponent("text", this.controlEl.createEl("input")), callback); }
	addTextArea(callback) { return this.add(new ValueComponent("textarea", this.controlEl.createEl("textarea")), callback); }
	addToggle(callback) { return this.add(new ValueComponent("toggle", this.controlEl.createDiv()), callback); }
	addDropdown(callback) { return this.add(new DropdownComponent(this.controlEl.createEl("select")), callback); }
	addButton(callback) { return this.add(new ButtonComponent(this.controlEl.createEl("button")), callback); }
	addExtraButton(callback) { return this.add(new ExtraButtonComponent(this.controlEl.createDiv()), callback); }
}
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new El("div"); } hide() {} }
export class Modal {
	constructor(app) { this.app = app; this.modalEl = new El("div"); this.contentEl = new El("div"); }
	open() { (globalThis.__modals ??= []).push(this); this.onOpen?.(); }
	close() { this.closed = true; this.onClose?.(); }
}
export class FuzzySuggestModal extends Modal {}
export class Notice {
	constructor(message, duration) { this.message = message; this.duration = duration; (globalThis.__notices ??= []).push(this); }
	hide() { this.hidden = true; }
	setMessage(message) { this.message = message; return this; }
}
export class App {}
export class TFile {}
export class TFolder {}
export class MarkdownView {}
export class FileSystemAdapter {}
export function requireApiVersion() { return false; }
export function setIcon(el, icon) { el.icon = icon; }
export function normalizePath(path) { return path; }
export function parseYaml() { return {}; }
export function createFragment() { return new El("#fragment"); }
`;

export interface MockEl {
	tag: string; text: string; children: MockEl[]; attr: Record<string, string>; cls: Set<string>; shown: boolean; icon?: string;
	dispatch(type: string, init?: Record<string, unknown>): { defaultPrevented: boolean };
}
export interface MockComponent {
	kind: string; value?: unknown; disabled?: boolean; cta?: boolean; buttonEl: MockEl; inputEl: MockEl;
	input(value: unknown): void; click(): unknown;
}
export interface MockSetting { name: string; desc?: string; heading?: boolean; settingEl: MockEl; infoEl: MockEl; components: MockComponent[] }
export interface MockNotice { message: string | MockEl; duration?: number; hidden?: boolean }
export interface MockModal { modalEl: MockEl; contentEl: MockEl; closed?: boolean }

interface UiGlobals { __settings?: MockSetting[]; __notices?: MockNotice[]; __modals?: MockModal[]; createFragment?: () => MockEl }
export const ui = globalThis as unknown as UiGlobals;

/** Every element under `node` (itself included) that `predicate` accepts, in document order. */
export function findAll(node: MockEl, predicate: (node: MockEl) => boolean): MockEl[] {
	return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, predicate))];
}

/** The text of `node` and everything under it. */
export function textOf(node: MockEl): string {
	return [node.text, ...node.children.map(textOf)].filter(Boolean).join("\n");
}

/**
 * Bundles `contents` (a module that re-exports what the test needs) with `obsidian` replaced by the stand-in; `modules`
 * replaces further imports whose path matches a key's regular expression with the given source.
 */
export async function loadWithMockObsidian<T>(contents: string, modules: Record<string, string> = {}): Promise<T> {
	const replacements: Plugin = {
		name: "mock-modules", setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
			for (const [index, pattern] of Object.keys(modules).entries()) b.onResolve({ filter: new RegExp(pattern) }, () => ({ path: `module-${index}`, namespace: "mock" }));
			b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian" ? MOCK : Object.values(modules)[Number(args.path.slice("module-".length))], loader: "js" }));
		},
	};
	const bundled = await build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent", plugins: [replacements] });
	ui.createFragment = (await import(`data:text/javascript;base64,${Buffer.from(`${MOCK}\nexport const fragment = createFragment;`).toString("base64")}`) as { fragment: () => MockEl }).fragment;
	return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`) as T;
}

/** Lets queued promise callbacks (saves, clipboard writes, pandoc runs) finish. */
export async function settle(rounds = 20): Promise<void> {
	for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve));
}
