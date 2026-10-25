// 0.6.1 annotations sidebar: the real view, bundled with an `obsidian` mock and a small fake DOM. Rendering never touches
// Better BibTeX (its stub throws on any use), modes and facets are view state, and the selection is read only on demand.
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/types";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type { Annotation, Attachment, ZoteroIndexEntry } from "../src/types";

const OBSIDIAN_MOCK = `
export const notices = [];
export class FakeEl {
	constructor(tag, opts = {}) {
		this.tag = tag; this.classes = new Set(String(opts.cls ?? "").split(" ").filter(Boolean)); this.children = []; this.parent = null;
		this.text = opts.text === undefined ? "" : String(opts.text); this.attrs = { ...opts.attr }; this.listeners = {}; this.value = opts.value ?? ""; this.disabled = false;
		if (opts.type) this.attrs.type = opts.type;
	}
	createEl(tag, opts) { const el = new FakeEl(tag, opts); el.parent = this; this.children.push(el); return el; }
	createDiv(opts) { return this.createEl("div", opts); }
	createSpan(opts) { return this.createEl("span", opts); }
	empty() { for (const child of this.children) child.parent = null; this.children = []; }
	addClass(...names) { for (const name of names) this.classes.add(name); }
	toggleClass(name, value) { if (value) this.classes.add(name); else this.classes.delete(name); }
	setText(text) { this.text = String(text); }
	setAttribute(name, value) { this.attrs[name] = String(value); }
	getAttribute(name) { return this.attrs[name] ?? null; }
	all() { return [this, ...this.children.flatMap(child => child.all())]; }
	querySelectorAll(selector) { const attr = /^\\[([a-z-]+)\\]$/.exec(selector); return this.all().slice(1).filter(el => attr ? el.attrs[attr[1]] !== undefined : el.classes.has(selector.slice(1))); }
	querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
	addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
	dispatch(type) { for (const listener of this.listeners[type] ?? []) listener({}); }
}
export function setIcon(el, icon) { el.createEl("svg", { cls: "svg-icon lucide-" + icon }); }
const pending = new Set();
export function debounce(callback) {
	let args = null;
	const debounced = (...values) => { args = values; pending.add(debounced); return debounced; };
	debounced.cancel = () => { args = null; pending.delete(debounced); return debounced; };
	debounced.run = () => { if (!args) return; const values = args; args = null; pending.delete(debounced); return callback(...values); };
	return debounced;
}
export function flushDebounced() { for (const debounced of [...pending]) debounced.run(); }
export class TFile { constructor(path) { this.path = path; this.basename = path.split("/").pop().replace(".md", ""); this.extension = "md"; } }
export class Notice { constructor(message) { notices.push(message); } }
export class WorkspaceLeaf {}
export class Menu { addItem() { return this; } addSeparator() { return this; } showAtMouseEvent() { return this; } }
export class FuzzySuggestModal { constructor(app) { this.app = app; } setPlaceholder() {} open() { FuzzySuggestModal.opened.push(this); } }
FuzzySuggestModal.opened = [];
export class Setting { setName() { return this; } setHeading() { return this; } addButton() { return this; } }
export class Modal { constructor(app) { this.app = app; this.contentEl = new FakeEl("div"); } open() {} close() {} }
export class ItemView {
	constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = new FakeEl("div"); }
	registerEvent() {} registerDomEvent() {}
	getState() { return {}; }
	setState() { return Promise.resolve(); }
}
`;

interface FakeEl { tag: string; classes: Set<string>; children: FakeEl[]; text: string; attrs: Record<string, string>; value: string; disabled: boolean; dispatch(type: string): void; all(): FakeEl[] }
interface Mock { notices: string[]; flushDebounced(): void; TFile: new (path: string) => object; FuzzySuggestModal: { opened: { onChooseItem(item: unknown): void; getItems(): unknown[] }[] } }
interface View {
	contentEl: FakeEl; onOpen(): Promise<void>; onClose(): Promise<void>; render(): unknown; pin(entry: ZoteroIndexEntry | null): void; follow(mode: string): void;
	readSelection(): Promise<void>; getState(): Record<string, unknown>; setState(state: unknown, result: unknown): Promise<void>; shownEntry(): ZoteroIndexEntry | null; currentMode(): string;
}
interface ViewModule { AnnotationsView: new (leaf: unknown, plugin: unknown) => View; obs: Mock }

// The view listens for the editor's selection changes on `document`; the mock's registerDomEvent ignores it.
(globalThis as { document?: unknown }).document ??= {};

let bundle: Promise<ViewModule> | null = null;
function loadView(): Promise<ViewModule> {
	bundle ??= build({
		stdin: { contents: 'export { AnnotationsView } from "./src/views/annotations-view.ts"; export * as obs from "obsidian";', resolveDir: process.cwd(), loader: "ts" },
		bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
		plugins: [{ name: "mock-obsidian", setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
			b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: OBSIDIAN_MOCK, loader: "js" }));
		} }],
	}).then(result => import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")) as Promise<ViewModule>);
	return bundle;
}

// Synthetic records only (AGENTS.md).
const note = (key: string, page: number, o: Partial<Annotation> = {}): Annotation => ({
	key, attachmentKey: "ATTA2345", type: "highlight", text: `Synthetic ${key}`, comment: "", color: "#ffd400", page, pageLabel: String(page), version: 1, uri: "", tags: [], dateModified: "2026-01-01T00:00:00Z", ...o,
});
const attachment = (key: string, annotations: Annotation[]): Attachment => ({ key, openURI: `zotero://open-pdf/library/items/${key}`, path: null, title: "Main PDF", annotations });
const item = (n: number, annotations: Annotation[]): ZoteroIndexEntry => ({
	id: `1:ITEM000${n}`, libraryID: 1, libraryType: "user", itemKey: `ITEM000${n}`, citekey: `synthetic2026item${n}`, citekeyHistory: [], title: `Synthetic item ${n}`, authors: [], year: "2026", doi: "", url: "", collections: [], tags: [],
	attachmentPath: "", zoteroSelectURI: "", attachments: [attachment("ATTA2345", annotations)], attachmentStatus: "complete", contentHash: "", metadata: {},
}) as ZoteroIndexEntry;
const one = item(1, [note("ANNO0001", 2, { color: "#ff6666" }), note("ANNO0002", 1)]);
const two = item(2, [note("ANNO0003", 4)]);

/** Throws on any use: rendering must not touch Better BibTeX or a fresh read. */
const forbidden = (name: string): unknown => new Proxy({}, { get: (_target, key) => { throw new Error(`render touched ${name}.${String(key)}`); } });

async function sidebar(options: { entries?: ZoteroIndexEntry[]; active?: { path: string; frontmatter?: Record<string, unknown> } | null; line?: string; ch?: number; bbt?: unknown; literature?: unknown } = {}) {
	const mod = await loadView();
	mod.obs.flushDebounced();
	mod.obs.notices.length = 0;
	const entries = options.entries ?? [one, two];
	const file = options.active ? new mod.obs.TFile(options.active.path) : null;
	let saves = 0;
	const app = {
		workspace: { getActiveFile: () => file, on: () => ({}), requestSaveLayout: () => { saves++; } },
		metadataCache: { getFileCache: () => (options.active?.frontmatter ? { frontmatter: options.active.frontmatter } : null), on: () => ({}) },
	};
	const editor = { getCursor: () => ({ line: 0, ch: options.ch ?? 0 }), getLine: () => options.line ?? "", getSelection: () => "" };
	const plugin = {
		cachedEntries: () => entries, statusLine: () => "Index: synthetic", indexLoaded: () => true, warmBackoffActive: () => false,
		warmIndex: () => { throw new Error("render warmed the index"); }, pick: () => Promise.resolve(), run: async (action: () => Promise<void>) => { await action(); }, copyLink: () => Promise.resolve(),
		lastMarkdownView: () => (options.line !== undefined ? { editor } : null), settings: { ...DEFAULT_SETTINGS }, bbt: options.bbt ?? forbidden("bbt"), literature: options.literature ?? forbidden("literature"),
		cachedIndexAgeMinutes: () => 12, lastIndex: { generatedAt: "G1" }, index: forbidden("index"), publish: () => { throw new Error("the saved index was rewritten"); },
	};
	const view = new mod.AnnotationsView({ app }, plugin);
	await view.onOpen();
	const find = (match: (el: FakeEl) => boolean): FakeEl[] => view.contentEl.all().filter(match);
	const cards = (): string[] => find(el => el.classes.has("cmds-zotero-annotation") && !el.classes.has("cmds-zotero-filtered-out")).map(el => el.children[1]?.text ?? "");
	const message = (): string => find(el => el.tag === "p").filter(el => !el.classes.has("cmds-zotero-filtered-out")).map(el => el.text).join(" | ");
	const title = (): string => find(el => el.classes.has("cmds-zotero-sidebar-title"))[0]?.text ?? "";
	const source = (): string => find(el => el.classes.has("cmds-zotero-annotation-source"))[0]?.text ?? "";
	return { view, mod, plugin, cards, message, title, find, source, saves: () => saves };
}

test("rendering in every mode never touches Better BibTeX and returns synchronously", async () => {
	const { view, title, cards } = await sidebar({ active: { path: "Lit/x.md", frontmatter: { zoteroID: "1:ITEM0001" } }, line: "See [@synthetic2026item2, p. 4].", ch: 8 });
	assert.equal(view.render(), undefined, "render is not async");
	assert.equal(title(), "Synthetic item 1");
	assert.deepEqual(cards(), ["Synthetic ANNO0002", "Synthetic ANNO0001"], "page order");
	view.follow("cursor");
	assert.equal(title(), "Synthetic item 2", "the citekey under the cursor");
	view.pin(one);
	assert.equal(view.currentMode(), "pinned");
	assert.equal(title(), "Synthetic item 1");
	view.follow("selection");
	assert.equal(view.currentMode(), "selection");
	assert.equal(view.shownEntry(), null);
});

test("view state: pin, facets, sort and group survive getState/setState; damaged state falls back to note mode", async () => {
	const first = await sidebar();
	first.view.pin(two);
	assert.ok(first.saves() > 0, "the layout is asked to save");
	const state = first.view.getState();
	assert.deepEqual(state.pinned, { libraryID: 1, itemKey: "ITEM0002" });
	const second = await sidebar();
	await second.view.setState({ ...state, facets: { colors: ["red"] }, sort: "reading" }, {});
	assert.equal(second.view.currentMode(), "pinned");
	assert.equal(second.title(), "Synthetic item 2");
	assert.deepEqual(second.cards(), [], "a colour facet with no match hides the item's cards");
	assert.equal(second.message(), "No annotations match the filter.");
	await second.view.setState({ mode: "pinned", pinned: { libraryID: 1, itemKey: "ITEM0001" }, facets: { colors: ["red"] } }, {});
	assert.deepEqual(second.cards(), ["Synthetic ANNO0001"]);
	await second.view.setState({ mode: "pinned", pinned: { libraryID: 1, itemKey: "nope" } }, {});
	assert.equal(second.view.currentMode(), "note");
	await second.view.setState({ mode: "pinned", pinned: { libraryID: 7, itemKey: "ITEM0001" } }, {});
	assert.equal(second.view.currentMode(), "pinned", "an unknown item keeps the mode");
	assert.match(second.message(), /pinned item is not in the index/);
});

test("the Zotero selection is read on demand; empty, unindexed, several and failing reads keep the mode", async () => {
	let answer: () => Promise<unknown[]> = () => Promise.resolve([{ libraryID: 1, itemKey: "ITEM0002", citekey: "synthetic2026item2", title: "", itemType: "journalArticle" }]);
	let calls = 0;
	const bbt = { selectedItems: () => { calls++; return answer(); } };
	const { view, title, message, mod } = await sidebar({ bbt });
	assert.equal(calls, 0, "opening the sidebar reads nothing");
	await view.readSelection();
	assert.equal(calls, 1);
	assert.equal(title(), "Synthetic item 2");
	view.render();
	assert.equal(calls, 1, "a render does not read the selection again");
	answer = () => Promise.resolve([]);
	await view.readSelection();
	assert.equal(view.currentMode(), "selection");
	assert.match(message(), /Nothing is selected in Zotero/);
	answer = () => Promise.resolve([{ libraryID: 9, itemKey: "ZZZZ9999" }]);
	await view.readSelection();
	assert.match(message(), /not in the index/);
	answer = () => Promise.resolve([{ libraryID: 1, itemKey: "ITEM0001" }, { libraryID: 1, itemKey: "ITEM0002" }]);
	mod.obs.FuzzySuggestModal.opened.length = 0;
	await view.readSelection();
	const picker = mod.obs.FuzzySuggestModal.opened[0];
	assert.equal(picker.getItems().length, 2, "several selected items are a choice");
	picker.onChooseItem(picker.getItems()[0]);
	assert.equal(title(), "Synthetic item 1");
	answer = () => Promise.reject(new Error("BBT down"));
	await view.readSelection();
	assert.equal(title(), "Synthetic item 1", "a failed read keeps what was shown");
	assert.match(mod.obs.notices.at(-1) ?? "", /Could not read the Zotero selection: BBT down/);
});

test("colour chips and the filter box toggle cards without rebuilding them", async () => {
	const { view, find, cards } = await sidebar();
	view.pin(one);
	const before = find(el => el.classes.has("cmds-zotero-annotation"));
	const chip = find(el => el.attrs["data-facet"] === "red")[0];
	chip.dispatch("click");
	(await loadView()).obs.flushDebounced();
	assert.deepEqual(cards(), ["Synthetic ANNO0001"]);
	assert.equal(chip.attrs["aria-pressed"], "true");
	chip.dispatch("click");
	(await loadView()).obs.flushDebounced();
	assert.deepEqual(cards(), ["Synthetic ANNO0002", "Synthetic ANNO0001"]);
	assert.deepEqual(find(el => el.classes.has("cmds-zotero-annotation")), before, "the same card elements");
});

test("Fetch latest shows a fresh read in memory until the index changes; failures keep the snapshot", async () => {
	const fresh = item(1, [note("ANNO0001", 2, { color: "#ff6666" }), note("ANNO0002", 1), note("ANNO0009", 7, { text: "Synthetic new" })]);
	let reply: () => Promise<unknown> = () => Promise.resolve({ entry: fresh, fresh: true });
	const requested: string[] = [];
	const literature = { freshEntry: (entry: ZoteroIndexEntry) => { requested.push(entry.id); return reply(); } };
	const entries = [one, two];
	const { view, plugin, cards, source, mod } = await sidebar({ entries, literature });
	view.pin(one);
	assert.equal(source(), "Saved snapshot · 12 min old");
	assert.deepEqual(requested, [], "rendering does not read");
	await view.fetchLatest();
	assert.deepEqual(requested, ["1:ITEM0001"]);
	assert.deepEqual(cards(), ["Synthetic ANNO0002", "Synthetic ANNO0001", "Synthetic new"]);
	assert.match(source(), /^Live from Zotero · \d\d:\d\d$/);
	assert.equal(entries[0], one, "the saved index keeps its entry");
	assert.equal(one.attachments[0].annotations.length, 2, "and the entry its annotations");
	view.render();
	assert.deepEqual(cards(), ["Synthetic ANNO0002", "Synthetic ANNO0001", "Synthetic new"], "a re-render keeps the live entry");
	plugin.lastIndex = { generatedAt: "G2" };
	view.render();
	assert.deepEqual(cards(), ["Synthetic ANNO0002", "Synthetic ANNO0001"], "a new index generation drops it");
	reply = () => Promise.resolve({ entry: one, fresh: false, error: new Error("connection refused") });
	await view.fetchLatest();
	assert.deepEqual(cards(), ["Synthetic ANNO0002", "Synthetic ANNO0001"]);
	assert.match(mod.obs.notices.at(-1) ?? "", /keeps the saved snapshot: connection refused/);
	reply = () => Promise.resolve({ entry: two, fresh: true });
	await view.fetchLatest();
	assert.match(mod.obs.notices.at(-1) ?? "", /another item/);
	assert.equal(source(), "Saved snapshot · 12 min old");
	reply = () => { plugin.lastIndex = { generatedAt: "G3" }; return Promise.resolve({ entry: fresh, fresh: true }); };
	await view.fetchLatest();
	assert.match(mod.obs.notices.at(-1) ?? "", /index changed/);
	assert.deepEqual(cards(), ["Synthetic ANNO0002", "Synthetic ANNO0001"], "a read that outlived its generation is dropped");
});

test("card actions run on the card last clicked; a re-render keeps the focus while the card is shown", async () => {
	const copied: string[] = [];
	Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } }, configurable: true });
	const { view, find } = await sidebar();
	view.pin(one);
	const v = view as unknown as { focusedCard(): unknown; runFocusedAction(id: string): Promise<void> };
	assert.equal(v.focusedCard(), null);
	await assert.rejects(v.runFocusedAction("copy-citation"), /Click an annotation card/);
	const card = find(el => el.classes.has("cmds-zotero-annotation"))[1];
	card.dispatch("click");
	assert.ok(card.classes.has("is-focused"));
	await v.runFocusedAction("copy-citation");
	await v.runFocusedAction("copy-annotation-key");
	assert.deepEqual(copied, ["[@synthetic2026item1, p. 2]", "ANNO0001"]);
	view.render();
	assert.ok(v.focusedCard(), "still shown after a render");
	view.pin(two);
	assert.equal(v.focusedCard(), null, "another item has no such card");
});

test("cards are draggable: text/plain is the callout, the custom type names the annotation by identity", async () => {
	const { view, find } = await sidebar();
	view.pin(one);
	const card = find(el => el.classes.has("cmds-zotero-annotation"))[0] as FakeEl & { listeners: Record<string, ((event: unknown) => void)[]> };
	assert.equal(card.attrs.draggable, "true");
	const data: Record<string, string> = {};
	const transfer = { effectAllowed: "", setData: (type: string, value: string) => { data[type] = value; } };
	for (const listener of card.listeners.dragstart) listener({ dataTransfer: transfer });
	assert.equal(transfer.effectAllowed, "copy");
	assert.match(data["text/plain"], /^> \[!Highlight\] yellow · p\. 1\n> <mark class="cmds-zotero-hl-yellow">Synthetic ANNO0002<\/mark> \(\[p\. 1\]\(zotero:\/\/open-pdf\/library\/items\/ATTA2345\?page=1&annotation=ANNO0002\)\)\n$/);
	assert.deepEqual(JSON.parse(data["application/x-cmds-zotero-annotation"]), { v: 1, id: "1:ITEM0001", attachmentKey: "ATTA2345", key: "ANNO0002" });
});

test("following the Zotero selection: opt-in polls, quiet reads, unchanged does nothing, failures pause without a Notice", async () => {
	let answer: () => Promise<unknown[]> = () => Promise.resolve([{ libraryID: 1, itemKey: "ITEM0002" }]);
	const reads: unknown[] = [];
	const bbt = { selectedItems: (_signal: unknown, options: unknown) => { reads.push(options); return answer(); } };
	const { view, plugin, title, find, mod } = await sidebar({ bbt });
	const follow = view as unknown as View & { followSelection(trigger: string): Promise<void>; containerEl: unknown };
	follow.containerEl = { isShown: () => true };
	view.follow("selection");
	await follow.followSelection("focus");
	assert.equal(reads.length, 0, "off by default: nothing is read");
	(plugin as { settings: unknown }).settings = { ...DEFAULT_SETTINGS, followZoteroSelection: "focus", followZoteroSelectionSeconds: 10 };
	await follow.followSelection("tick");
	assert.equal(reads.length, 0, "focus mode ignores ticks");
	await follow.followSelection("focus");
	assert.deepEqual(reads, [{ timeoutMs: 1500, quiet: true }], "short, quiet read");
	assert.equal(title(), "Synthetic item 2");
	assert.ok(find(el => el.classes.has("cmds-zotero-selection-follow"))[0]?.text.includes("when Obsidian gets focus"));
	const before = view.contentEl.children[0];
	await follow.followSelection("focus");
	assert.equal(view.contentEl.children[0], before, "an unchanged selection does not re-render");
	answer = () => Promise.resolve([]);
	await follow.followSelection("focus");
	assert.equal(title(), "Synthetic item 2", "an empty selection keeps what is shown");
	answer = () => Promise.reject(new Error("refused"));
	const notices = mod.obs.notices.length;
	await follow.followSelection("focus");
	assert.equal(mod.obs.notices.length, notices, "no Notice");
	assert.match(find(el => el.classes.has("cmds-zotero-selection-follow"))[0]?.text ?? "", /paused for a minute/);
	await follow.followSelection("focus");
	assert.equal(reads.length, 4, "paused: no read");
	view.follow("note");
	follow.containerEl = { isShown: () => true };
	(plugin as { settings: unknown }).settings = { ...DEFAULT_SETTINGS, followZoteroSelection: "interval", followZoteroSelectionSeconds: 3 };
	await follow.followSelection("tick");
	assert.equal(reads.length, 4, "only while the sidebar follows the selection");
});

test("a selection read before the index loads is resolved when it loads; not-indexed items resolve after a refresh", async () => {
	let answer: unknown[] = [{ libraryID: 1, itemKey: "ITEM0002" }];
	let reads = 0;
	const bbt = { selectedItems: () => { reads++; return Promise.resolve(answer); } };
	const { view, plugin, title, message } = await sidebar({ bbt });
	const p = plugin as { indexLoaded: () => boolean; warmBackoffActive: () => boolean; cachedEntries: () => ZoteroIndexEntry[]; settings: unknown; lastIndex: unknown };
	let loaded = false;
	let entries: ZoteroIndexEntry[] = [];
	p.indexLoaded = () => loaded;
	p.warmBackoffActive = () => true;
	p.cachedEntries = () => entries;
	await view.readSelection();
	assert.equal(message(), "The index is not loaded yet.");
	loaded = true;
	entries = [one, two];
	view.render();
	assert.equal(title(), "Synthetic item 2", "resolved at render against the loaded index");
	assert.deepEqual(view.getState().selected, { libraryID: 1, itemKey: "ITEM0002" }, "and remembered for the layout");
	// Read with the index loaded, but the item is not indexed yet: a later generation that has it shows it.
	answer = [{ libraryID: 1, itemKey: "ITEM0003" }];
	await view.readSelection();
	assert.match(message(), /not in the index/);
	const three = item(3, [note("ANNO0004", 1)]);
	entries = [one, two, three];
	view.render();
	assert.equal(title(), "Synthetic item 3");
	// The poll path: a change seen before the index loads is not judged, and an unchanged selection is never read again.
	loaded = false;
	entries = [];
	const follow = view as unknown as View & { followSelection(trigger: string): Promise<void>; containerEl: unknown };
	follow.containerEl = { isShown: () => true };
	p.settings = { ...DEFAULT_SETTINGS, followZoteroSelection: "focus", followZoteroSelectionSeconds: 10 };
	answer = [{ libraryID: 1, itemKey: "ITEM0001" }];
	await follow.followSelection("focus");
	assert.equal(message(), "The index is not loaded yet.");
	loaded = true;
	entries = [one, two, three];
	view.render(); // what the plugin's refreshViews() does when the index is published
	assert.equal(title(), "Synthetic item 1", "the polled selection resolves once the index is loaded");
	await follow.followSelection("focus");
	assert.equal(title(), "Synthetic item 1", "a later unchanged poll keeps it");
});

test("a restored attachment filter survives the restore; another item clears it", async () => {
	const { view } = await sidebar();
	await view.setState({ mode: "pinned", pinned: { libraryID: 1, itemKey: "ITEM0001" }, facets: { attachments: ["ATTA2345"] } }, {});
	assert.deepEqual((view.getState().facets as { attachments: string[] }).attachments, ["ATTA2345"]);
	view.follow("note");
	view.pin(one);
	assert.deepEqual((view.getState().facets as { attachments: string[] }).attachments, ["ATTA2345"], "showing nothing in between keeps it");
	view.pin(two);
	assert.deepEqual((view.getState().facets as { attachments: string[] }).attachments, [], "another item clears it");
});

test("an item without annotations says so whatever filter is carried over", async () => {
	const failed = { ...item(4, []), attachments: [], attachmentStatus: "unavailable" } as ZoteroIndexEntry;
	const { view, message } = await sidebar({ entries: [one, two, failed] });
	await view.setState({ mode: "pinned", pinned: { libraryID: 1, itemKey: "ITEM0001" }, facets: { colors: ["red"] } }, {});
	view.pin(failed);
	assert.equal(message(), "Attachment lookup failed at the last refresh. Refresh the index.");
});

test("copy-quote action, attachment-scoped continuations, search compositionend, and IME-guarded card keyboard navigation", async () => {
	const copied: string[] = [];
	Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } }, configurable: true });
	const multiAttachmentItem: ZoteroIndexEntry = {
		...item(5, []),
		attachments: [
			attachment("ATTA0001", [
				note("SAME0001", 1, { attachmentKey: "ATTA0001", text: "First part" }),
				note("SAME0002", 1, { attachmentKey: "ATTA0001", text: "Second part", comment: "+ continued" }),
			]),
			attachment("ATTA0002", [
				note("SAME0002", 2, { attachmentKey: "ATTA0002", text: "Independent highlight in second attachment" }),
			]),
		],
	};
	const { view, plugin, find, cards, mod } = await sidebar({ entries: [multiAttachmentItem] });
	(plugin as { settings: typeof DEFAULT_SETTINGS }).settings = { ...DEFAULT_SETTINGS, joinContinuations: true };
	view.pin(multiAttachmentItem);

	// Attachment-scoped continuations: only ATTA0001:SAME0002 has the continuation badge, not ATTA0002:SAME0002.
	const renderedCards = find(el => el.classes.has("cmds-zotero-annotation"));
	assert.equal(renderedCards.length, 3);
	const badgesPerCard = renderedCards.map(card => card.all().some(el => el.classes.has("cmds-zotero-annotation-continuation")));
	assert.deepEqual(badgesPerCard, [false, true, false]);

	// Search compositionend updates the filter query.
	const search = find(el => el.tag === "input")[0];
	search.value = "Independent";
	search.dispatch("compositionend");
	mod.obs.flushDebounced();
	assert.deepEqual(cards(), ["Independent highlight in second attachment"]);
	search.value = "";
	search.dispatch("compositionend");
	mod.obs.flushDebounced();
	assert.equal(cards().length, 3);

	// Keyboard navigation (ArrowDown / ArrowUp) and IME guard on cards.
	const firstCard = renderedCards[0] as FakeEl & { listeners: Record<string, ((event: unknown) => void)[]> };
	const secondCard = renderedCards[1] as FakeEl & { listeners: Record<string, ((event: unknown) => void)[]> };
	firstCard.dispatch("focusin");
	assert.ok(firstCard.classes.has("is-focused"));
	for (const listener of firstCard.listeners.keydown) listener({ key: "ArrowDown", isComposing: true });
	for (const listener of firstCard.listeners.keydown) listener({ key: "ArrowDown", keyCode: 229 });
	assert.ok(firstCard.classes.has("is-focused"), "IME composition blocks ArrowDown navigation");
	for (const listener of firstCard.listeners.keydown) listener({ key: "ArrowDown", isComposing: false });
	assert.ok(secondCard.classes.has("is-focused"), "ArrowDown moves focus to next visible card");
	for (const listener of secondCard.listeners.keydown) listener({ key: "ArrowUp", isComposing: false });
	assert.ok(firstCard.classes.has("is-focused"), "ArrowUp moves focus to previous visible card");

	// copy-quote action copies the joined quote with citation.
	const v = view as unknown as { runFocusedAction(id: string): Promise<void> };
	await v.runFocusedAction("copy-quote");
	assert.equal(copied.length, 1);
	assert.match(copied[0], /^> First part … Second part\n> — \[@synthetic2026item5, p\. 1\]/);
});

