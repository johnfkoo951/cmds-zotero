// 0.6 references-refresh-rerender / OPT-13: the References sidebar's Refresh renders the rows again and fetches their
// bibliography text again; it never rebuilds the index (the "Refresh citekey index" command does). View-model test: the
// view runs against a mock plugin and a minimal synthetic DOM, never Obsidian.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type { ZoteroIndexEntry } from "../src/types";

// Just enough of Obsidian's element helpers for the view: a tree of nodes with text, attributes and click listeners.
const mockObsidian = `
class El {
	constructor(tag) { this.tag = tag; this.children = []; this.text = ""; this.attr = {}; this.cls = []; this.listeners = {}; this.disabled = false; }
	empty() { this.children = []; this.text = ""; }
	addClass(...names) { this.cls.push(...names); }
	toggleClass() {}
	setText(text) { this.text = text; }
	createEl(tag, options = {}) {
		const child = new El(tag);
		if (options.text !== undefined) child.text = options.text;
		if (options.cls) child.cls.push(...[].concat(options.cls));
		if (options.attr) Object.assign(child.attr, options.attr);
		this.children.push(child);
		return child;
	}
	createDiv(options) { return this.createEl("div", options); }
	createSpan(options) { return this.createEl("span", options); }
	addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
}
export class ItemView { constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = new El("div"); } registerEvent() {} }
export class MarkdownView {}
export class TFile {}
export class WorkspaceLeaf {}
export class Notice { constructor(message) { (globalThis.__notices ??= []).push(message); } }
export function setIcon(element, icon) { element.icon = icon; }
export function debounce(callback) { const debounced = () => { debounced.pending = true; }; debounced.cancel = () => { debounced.pending = false; return debounced; }; debounced.run = () => callback(); return debounced; }
`;

interface Node { tag: string; children: Node[]; text: string; attr: Record<string, string>; listeners: Record<string, (() => void)[]>; icon?: string }
type View = { render(options?: { refetch?: boolean }): Promise<void>; getIcon(): string; contentEl: Node; refresh: { pending?: boolean; (): void } };

async function loadView(): Promise<{ ReferencesView: new (leaf: unknown, plugin: unknown) => View; TFile: new () => object }> {
	const bundled = await build({ stdin: { contents: 'export { ReferencesView } from "./src/views/references-view"; export { TFile } from "obsidian";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, plugins: [{
		name: "mock-obsidian", setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
			b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: mockObsidian, loader: "js" }));
		},
	}] });
	return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`) as never;
}

function find(node: Node, predicate: (node: Node) => boolean): Node | null {
	if (predicate(node)) return node;
	for (const child of node.children) { const hit = find(child, predicate); if (hit) return hit; }
	return null;
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// Synthetic records only (AGENTS.md).
const entry = (id: string, citekey: string): ZoteroIndexEntry => ({ id, citekey, citekeyHistory: [], title: `Title ${citekey}`, authors: ["Doe, Jane"], year: "2020", zoteroSelectURI: `zotero://select/library/items/${id.slice(2)}` }) as ZoteroIndexEntry;

async function setup() {
	const { ReferencesView, TFile } = await loadView();
	const file = Object.assign(new TFile(), { path: "Notes/Draft.md", basename: "Draft", extension: "md" });
	const entries = [entry("1:AAAA0001", "doe2020"), entry("1:BBBB0001", "roe2021")];
	const state = { loaded: true, stale: false, backoff: false };
	const calls = { warm: [] as boolean[], batches: [] as { ids: string[]; options: unknown }[] };
	const plugin = {
		settings: { referencesFollowActiveNote: true },
		statusLine: () => "Zotero connected",
		indexLoaded: () => state.loaded,
		cachedIndexStale: () => state.stale,
		cachedIndexAgeMinutes: () => (state.stale ? 120 : 5),
		cachedEntries: () => entries,
		forcedWarmActive: () => false,
		warmBackoffActive: () => state.backoff,
		warmIndex: (force = false): Promise<void> => { calls.warm.push(force); return Promise.resolve(); },
		bibliographyBatch: (items: ZoteroIndexEntry[], _style?: string, options?: unknown) => {
			calls.batches.push({ ids: items.map(item => item.id), options });
			return Promise.resolve(items.map(item => ({ text: `Live ${item.citekey}.`, source: "live" })));
		},
		copyCslJson: async () => undefined, run: async (action: () => Promise<void>) => { await action(); },
		// 0.6.2: the note's style and locale (no csl/lang frontmatter here).
		bibliography: { noteFormat: async () => ({ style: "apa", locale: "", styleFrom: "settings", localeFrom: "settings", problems: [] }) },
		openNote: async () => undefined, openPdf: async () => undefined, copyLink: async () => undefined,
	};
	const app = { workspace: { getActiveViewOfType: () => null, getActiveFile: () => file, on: () => ({}) }, vault: { cachedRead: async () => "Cites [@doe2020] and @roe2021." } };
	const view = new ReferencesView({ app }, plugin);
	const refreshButton = (): Node => {
		const button = find(view.contentEl, node => node.tag === "button" && /^Refresh references/.test(node.attr["aria-label"] ?? ""));
		assert.ok(button, "the toolbar has a Refresh button");
		return button;
	};
	return { view, state, calls, refreshButton };
}

test("0.6 references-refresh-rerender: Refresh renders the rows again and asks for fresh text; it never forces an index rebuild", async () => {
	const { view, calls, refreshButton } = await setup();
	await view.render();
	assert.deepEqual(calls.batches, [{ ids: ["1:AAAA0001", "1:BBBB0001"], options: undefined }], "an ordinary render reuses remembered text");
	assert.deepEqual(calls.warm, [], "a fresh snapshot needs no warm-up");
	const button = refreshButton();
	assert.equal(button.icon, "refresh-cw");
	view.refresh();
	assert.equal(view.refresh.pending, true);
	for (const listener of button.listeners.click) listener();
	await tick();
	assert.equal(view.refresh.pending, false, "a pending debounced render is dropped so it cannot abort the refetch");
	assert.deepEqual(calls.batches[1], { ids: ["1:AAAA0001", "1:BBBB0001"], options: { refresh: true } });
	assert.equal(calls.warm.includes(true), false, "the sidebar never starts a forced index rebuild");
	// The rows were rebuilt: two references with the live text the batch returned.
	const list = find(view.contentEl, node => node.tag === "ol");
	assert.deepEqual(list?.children.map(item => item.children[0].text), ["Live doe2020.", "Live roe2021."]);
	assert.equal(view.getIcon(), "list-ordered", "the view no longer shares the recent-reads ribbon icon");
});

test("0.6 references-refresh-rerender: a stale snapshot still starts the ordinary background warm-up, also on Refresh", async () => {
	const { view, state, calls, refreshButton } = await setup();
	state.stale = true;
	await view.render();
	assert.deepEqual(calls.warm, [false]);
	for (const listener of refreshButton().listeners.click) listener();
	await tick();
	assert.deepEqual(calls.warm, [false, false], "Refresh starts the non-forced warm-up for a stale snapshot");
	state.backoff = true;
	for (const listener of refreshButton().listeners.click) listener();
	await tick();
	assert.deepEqual(calls.warm, [false, false], "during the warm-up backoff nothing is started");
	assert.deepEqual(calls.batches.map(batch => batch.options), [undefined, { refresh: true }, { refresh: true }]);
});

test("IMP-CITED-BY-VIEW, IME guard, jump fallback, and referencesFollowActiveNote: false", async () => {
	const { ReferencesView, TFile } = await loadView();
	const litFile = Object.assign(new TFile(), { path: "Lit/@doe2020.md", basename: "@doe2020", extension: "md" });
	const citingA = Object.assign(new TFile(), { path: "Notes/PaperA.md", basename: "PaperA", extension: "md" });
	const citingB = Object.assign(new TFile(), { path: "Notes/PaperB.md", basename: "PaperB", extension: "md" });
	const entries = [entry("1:AAAA0001", "doe2020"), entry("1:BBBB0001", "roe2021")];
	const texts = new Map<unknown, string>([
		[litFile, "Cites [@roe2021] on line 0."],
		[citingA, "# Paper A\nFirst cites [@doe2020] here and @doe2020 again."],
		[citingB, "# Paper B\nLine 1\nCites [[@doe2020]] on line 2."],
	]);
	let activeFile: unknown = litFile;
	const opened: { file: unknown; state: unknown }[] = [];
	const scrolled: number[] = [];
	const lastEditor = {
		setCursor: (pos: { line: number }) => { scrolled.push(pos.line); },
		scrollIntoView: () => undefined,
	};
	const plugin = {
		settings: { referencesFollowActiveNote: false },
		statusLine: () => "Zotero connected",
		indexLoaded: () => true,
		cachedIndexStale: () => false,
		cachedIndexAgeMinutes: () => 5,
		cachedEntries: () => entries,
		forcedWarmActive: () => false,
		warmBackoffActive: () => false,
		warmIndex: () => Promise.resolve(),
		bibliographyBatch: (items: ZoteroIndexEntry[]) => Promise.resolve(items.map(item => ({ text: `Live ${item.citekey}.`, source: "live" }))),
		copyCslJson: async () => undefined,
		run: async (action: () => Promise<void>) => { await action(); },
		bibliography: { noteFormat: async () => ({ style: "apa", locale: "", styleFrom: "settings", localeFrom: "settings", problems: [] }) },
		openNote: async () => undefined,
		openPdf: async () => undefined,
		copyLink: async () => undefined,
		entryForFile: (f: unknown) => (f === litFile ? entries[0] : null),
		lastMarkdownView: () => ({ file: litFile, editor: lastEditor }),
	};
	const app = {
		workspace: {
			getActiveViewOfType: () => null,
			getActiveFile: () => activeFile,
			getLeavesOfType: () => [],
			getLeaf: () => ({ openFile: async (file: unknown, state: unknown) => { opened.push({ file, state }); } }),
			on: () => ({}),
		},
		vault: {
			cachedRead: async (f: unknown) => texts.get(f) ?? "",
			getMarkdownFiles: () => [litFile, citingA, citingB],
		},
	};
	const view = new ReferencesView({ app }, plugin);
	await view.render();

	// Outgoing row Enter keydown is guarded during IME composition, and falls back to lastMarkdownView when sidebar is focused.
	const list = find(view.contentEl, node => node.tag === "ol");
	const rowText = list?.children[0]?.children[0] as unknown as { listeners: Record<string, ((event: unknown) => void)[]> };
	for (const listener of rowText.listeners.keydown) listener({ key: "Enter", isComposing: true });
	for (const listener of rowText.listeners.keydown) listener({ key: "Enter", keyCode: 229 });
	assert.deepEqual(scrolled, [], "IME composition blocks Enter jump");
	for (const listener of rowText.listeners.keydown) listener({ key: "Enter", isComposing: false });
	assert.deepEqual(scrolled, [0], "jump falls back to scrolling this.file when sidebar leaf is focused");

	// Cited by in this vault section lists PaperA (2 citations) and PaperB (1 citation), excluding litFile itself.
	const citedSection = find(view.contentEl, node => (node as unknown as { cls: string[] }).cls.includes("cmds-zotero-cited-by"));
	assert.ok(citedSection, "renders Cited by in this vault section");
	assert.equal(citedSection.children[0].text, "Cited by in this vault (2)");
	const citedItems = citedSection.children[1].children;
	assert.equal(citedItems.length, 2);
	assert.match(citedItems[0].children[0].text, /PaperA · 2 citations — First cites \[@doe2020\] here/);
	assert.match(citedItems[1].children[0].text, /PaperB · 1 citation — Cites \[\[@doe2020\]\] on line 2\./);
	for (const listener of citedItems[1].children[0].listeners.click) listener();
	assert.deepEqual(opened, [{ file: citingB, state: { eState: { line: 2 } } }]);

	// When referencesFollowActiveNote is false, ordinary render keeps this.file; refetch updates to the new active file.
	activeFile = citingA;
	await view.render();
	const titleAfterRender = find(view.contentEl, node => (node as unknown as { cls: string[] }).cls.includes("cmds-zotero-sidebar-title"));
	assert.equal(titleAfterRender?.text, "@doe2020", "keeps pinned file when referencesFollowActiveNote is false");
	await view.render({ refetch: true });
	const titleAfterRefetch = find(view.contentEl, node => (node as unknown as { cls: string[] }).cls.includes("cmds-zotero-sidebar-title"));
	assert.equal(titleAfterRefetch?.text, "PaperA", "refetch updates to active file");
});

