// 0.6.1 library review follow-ups: the live host paths that pure tests cannot reach, bundled against a mock `obsidian`.
// (1) `diagnostics --env` on the live agent host reads the snapshot the host peeked and never loads or publishes one, even
// before the warm-up has set `lastIndex`. (2) The literature picker and the `[@` suggester ignore an empty field still being
// typed (`tag:`), so the list ranks like the query without it. Synthetic records only (AGENTS.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { entry, indexOf, NOW } from "./agent-fixtures";
import { DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";

const mockObsidian = `
class Base { constructor(app) { this.app = app; } }
export class App {}
export class Component {}
export class Plugin extends Base {}
export class PluginSettingTab extends Base {}
export class Modal extends Base { open() {} close() {} }
export class ItemView extends Base {}
export class MarkdownView {}
export class WorkspaceLeaf {}
export class Menu {}
export class Setting {}
export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class FileSystemAdapter {}
export class Notice { hide() {} }
export class EditorSuggest extends Base {}
export class FuzzySuggestModal extends Base {
	setPlaceholder() {} setInstructions() {}
	// Stands in for Obsidian's fuzzy search: every word of the query must occur in the item text.
	getSuggestions(query) {
		const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
		return this.getItems().filter(item => words.every(word => this.getItemText(item).toLowerCase().includes(word))).map(item => ({ item, match: { score: 0, matches: [] } }));
	}
}
export function loadPdfJs() { return Promise.resolve({}); }
export function parseYaml() { return {}; }
export function stringifyYaml() { return ""; }
export function normalizePath(path) { return path; }
export function htmlToMarkdown(html) { return html; }
export function setIcon() {}
export function debounce(callback) { return callback; }
export function requireApiVersion() { return true; }
`;

interface Loaded {
	agentHost: (...args: unknown[]) => Promise<{ environmentFacts?: () => Promise<{ outputFolder: { unmatched: string[] } | null }> }>;
	runAction: (host: unknown, action: string, request: unknown) => Promise<Record<string, any>>;
	LiteraturePickerModal: new (...args: unknown[]) => { getSuggestions(query: string): { item: ZoteroIndexEntry }[] };
	CitekeySuggest: new (plugin: unknown) => { getSuggestions(context: { query: string }): ZoteroIndexEntry[] };
}

async function load(): Promise<Loaded> {
	const contents = [
		'export { agentHost } from "./src/plugin/agent-host";',
		'export { runAction } from "./src/agent/actions";',
		'export { LiteraturePickerModal } from "./src/modals/literature-picker";',
		'export { CitekeySuggest } from "./src/citations/suggest";',
	].join("\n");
	const bundled = await build({ stdin: { contents, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent", plugins: [{
		name: "mock-obsidian", setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
			b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: mockObsidian, loader: "js" }));
		},
	}] });
	return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`) as Loaded;
}

const SMITH = entry({ itemKey: "SMIT2345", citekey: "smith2020", title: "Knowledge sharing", authors: ["Smith, Ann"], year: "2020", tags: ["method"] });
const JONES = entry({ itemKey: "JONE2345", citekey: "jones2019", title: "A second paper", authors: ["Jones, Bo"], year: "2019", tags: ["draft"] });

test("diagnostics --env on the live host uses the peeked snapshot and never loads or publishes the index", async () => {
	const { agentHost, runAction } = await load();
	const peeked: ZoteroIndex = indexOf([SMITH]);
	const calls = { savedIndex: 0, publish: 0, localFilesFor: [] as (ZoteroIndex | null)[] };
	const file = (path: string) => ({ path, extension: "md" });
	const plugin = {
		active: true, lastIndex: null as ZoteroIndex | null,
		settings: { ...DEFAULT_SETTINGS, outputFolder: "References/Zotero" },
		manifest: { version: "0.6.1" },
		app: {
			vault: {
				adapter: { exists: async () => true },
				getName: () => "Synthetic",
				getMarkdownFiles: () => [file("References/Zotero/smith2020.md"), file("References/Zotero/stray.md")],
				getFiles: () => [],
			},
			metadataCache: { getFileCache: () => null },
		},
		bbt: { capabilities: async () => ({ zotero: "10.0.6", betterbibtex: "9.0.71" }) },
		legacyPluginEnabled: () => false,
		links: {
			localFilesByEntry: (index: ZoteroIndex) => { calls.localFilesFor.push(index); return new Map(index.entries.map(item => [item.id, [file(`References/Zotero/${item.citekey}.md`)]])); },
			peerMapStatus: async () => [],
		},
		// The publishing paths: neither may run for a read-only agent action.
		savedIndex: async () => { calls.savedIndex++; plugin.lastIndex = indexOf([SMITH, JONES]); calls.publish++; return plugin.lastIndex; },
	};
	const indexToken = { peek: async () => peeked, isStale: () => false };
	const host = await agentHost(plugin, "diagnostics", { env: true }, NOW, async () => { calls.publish++; }, indexToken, {});
	const answer = await runAction(host, "diagnostics", { env: true });
	assert.equal(calls.savedIndex, 0, "no index load from a read-only action");
	assert.equal(calls.publish, 0, "no note-map publication from a read-only action");
	assert.equal(plugin.lastIndex, null);
	assert.deepEqual(calls.localFilesFor, [peeked], "the output-folder check reads the same snapshot as the rest of the payload");
	const folder = (answer.environment.checks as { id: string; code?: string; detail: string; paths?: string[] }[]).find(check => check.id === "output-folder");
	assert.equal(folder?.code, "foreign-notes-in-output");
	assert.deepEqual(folder?.paths, ["References/Zotero/stray.md"], "the peeked snapshot claims smith2020");
	assert.match(folder?.detail ?? "", /^1 note in References\/Zotero belongs to no index entry\./);

	// Without a snapshot nothing is loaded either: no note can be claimed, so the unmatched list stays empty.
	const empty = await agentHost(plugin, "diagnostics", { env: true }, NOW, async () => { calls.publish++; }, { peek: async () => null, isStale: () => true }, {});
	const facts = await empty.environmentFacts?.();
	assert.deepEqual(facts?.outputFolder?.unmatched, []);
	assert.equal(calls.savedIndex + calls.publish, 0);
});

test("the picker and the [@ suggester ignore an empty field still being typed", async () => {
	const { LiteraturePickerModal, CitekeySuggest } = await load();
	const label = (item: ZoteroIndexEntry): string => `${item.title} ${item.authors.join(" ")} ${item.citekey}`;
	const picker = new LiteraturePickerModal({}, [SMITH, JONES], label, () => undefined, () => ({ libraryName: () => null }));
	const picked = (query: string): string[] => picker.getSuggestions(query).map(match => match.item.citekey);
	assert.deepEqual(picked("tag:"), picked(""));
	assert.deepEqual(picked("tag:"), ["smith2020", "jones2019"]);
	assert.deepEqual(picked("smith tag:"), picked("smith"));
	assert.deepEqual(picked("smith tag:"), ["smith2020"]);
	assert.deepEqual(picked("smith"), ["smith2020"], "a plain query keeps the fuzzy path");
	assert.deepEqual(picked("tag:draft"), ["jones2019"]);

	const plugin = { settings: { citationTrigger: "bracket" }, lastIndex: indexOf([SMITH, JONES]), cachedEntries: () => [SMITH, JONES], warmBackoffActive: () => false, warmIndex: async () => undefined };
	const suggest = new CitekeySuggest(plugin);
	const completed = (query: string): string[] => suggest.getSuggestions({ query }).map(item => item.citekey);
	assert.deepEqual(completed("tag:"), completed(""));
	assert.equal(completed("tag:").length, 2);
	assert.deepEqual(completed("tag:method"), ["smith2020"]);
	assert.deepEqual(completed("jones"), ["jones2019"]);
});
