// 0.6.3 WP8: ImportService modes against a synthetic vault facade — moved notes, path patterns, update scope (revise),
// rebuild with backup, adopt with backup and refusals. Never launches or writes a real vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { DEFAULT_SETTINGS, type CmdsZoteroSettings, type ZoteroIndexEntry } from "../src/types";
import { ownerMarker } from "../src/note-writer";

const facade = `import { parse } from "yaml";
export function parseYaml(input) { return parse(input); }
export function normalizePath(p) { return p; }
export class App {};
export class TFile { constructor(path) { this.path = path; this.stat = {size: 0, mtime: 0}; } }
export class TFolder { constructor(path) { this.path = path; } }
export class FileSystemAdapter { constructor(root) { this.root = root; this.written = new Map(); } getBasePath() { return this.root; } async write(path, data) { this.written.set(path, data); } async exists() { return false; } async read(path) { return this.written.get(path); } async mkdir() {} }
export class TestVault {
 constructor(root) { this.adapter = new FileSystemAdapter(root); this.files = new Map(); this.data = new Map(); this.writes = 0; }
 getAbstractFileByPath(path) { return this.files.get(path) || null; }
 getMarkdownFiles() { return [...this.files.values()].filter(file => file instanceof TFile && file.path.endsWith('.md')); }
 async read(file) { return this.data.get(file.path); }
 async readBinary(file) { return this.data.get(file.path); }
 async create(path, data) { if (this.files.has(path)) throw Error('exists'); this.writes++; const file = new TFile(path); this.files.set(path,file); this.data.set(path,data); return file; }
 async createBinary(path,data) { return this.create(path,data); }
 async createFolder(path) { this.files.set(path,new TFolder(path)); }
 async process(file, fn) { const next = fn(this.data.get(file.path)); this.writes++; this.data.set(file.path,next); }
}
export function cacheFor(vault) { return { getFileCache(file) { const text = vault.data.get(file.path) || ''; const m = /^---\\n([\\s\\S]*?)\\n---/.exec(text); if (!m) return null; try { return { frontmatter: parse(m[1]) }; } catch { return null; } } }; }`;

const entry: ZoteroIndexEntry = { id: "user:1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "Example2026", citekeyHistory: [], title: "Example title", authors: ["Test Author"], year: "2026", doi: "10.1234/ex", url: "", collections: ["Thesis/Methods"], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: { itemType: "journalArticle" } };

async function load(directory: string): Promise<{ ImportService: new (...args: unknown[]) => any; TestVault: new (root: string) => any; cacheFor: (vault: unknown) => unknown }> { // eslint-disable-line @typescript-eslint/no-explicit-any
	const output = join(directory, "service.cjs");
	await build({ stdin: { contents: 'export { ImportService } from "./src/importer"; export { TestVault, cacheFor } from "obsidian";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: output, plugins: [{ name: "synthetic-obsidian", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" })); b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: facade, loader: "js", resolveDir: process.cwd() })); } }] });
	return createRequire(resolve(output))(output);
}

test("0.6.3 ImportService: patterns, moved notes, scope, rebuild and adopt", async () => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-modes-test-")));
	try {
		const { ImportService, TestVault, cacheFor } = await load(directory);
		const vault = new TestVault(directory);
		let settings: CmdsZoteroSettings = { ...DEFAULT_SETTINGS, noteFilenamePattern: "{firstAuthor} {year}", noteFolderPattern: "{collection}" };
		const service = new ImportService({ vault, metadataCache: cacheFor(vault) }, { bibliography: async () => "Author. (2026). Example." }, () => settings);
		// filename-folder-pattern
		const created = await service.preview(entry);
		assert.equal(created.path, "References/Zotero/Thesis/Methods/Test Author 2026.md");
		assert.deepEqual((await service.apply(created)).conflicts, []);
		// find-moved-notes: the note moved out of the folder is updated where it is, not created again.
		const text = vault.data.get(created.path);
		vault.files.delete(created.path); vault.data.delete(created.path);
		await vault.create("Projects/Moved.md", text);
		await vault.create("Hubs/hub.md", `---\ntype: paper-hub\nzoteroID: "${entry.id}"\n---\nhub`);
		settings = { ...DEFAULT_SETTINGS };
		const moved = await service.preview({ ...entry, title: "New title" });
		assert.equal(moved.path, "Projects/Moved.md");
		assert.equal(moved.exists, true);
		assert.deepEqual(moved.conflicts, [], "the paper hub naming the item is not a second literature note");
		// selective-update-scope: revise renders again without the overview group; the old preview is spent.
		const limited = await service.revise(moved, ["metadata"]);
		assert.match(limited.content, /# Example title/);
		assert.match(limited.content, /\*\*Title\*\*:: New title/);
		await assert.rejects(service.apply(moved), /Unknown or already applied import preview/, "a revised preview's predecessor cannot be applied");
		assert.deepEqual((await service.apply(limited)).conflicts, []);
		assert.match(vault.data.get("Projects/Moved.md"), /# Example title/);
		// rebuild-or-repair-note: a damaged marker is repaired after a backup.
		const damaged = vault.data.get("Projects/Moved.md").replace("<!-- /cmds-zotero:citation -->", "");
		vault.data.set("Projects/Moved.md", damaged);
		assert.ok((await service.preview(entry)).conflicts.length, "the damaged note blocks a normal update");
		const rebuilt = await service.preview(entry, undefined, { rebuild: true });
		assert.equal(rebuilt.mode, "rebuild");
		assert.ok(rebuilt.repairs.some((line: string) => /damaged marker of citation/.test(line)));
		assert.deepEqual(rebuilt.conflicts, []);
		const result = await service.apply(rebuilt);
		assert.deepEqual(result.conflicts, []);
		assert.match(result.backup, /^\.cmds-zotero\/backups\/notes\/Moved-\d+\.md$/);
		assert.equal(vault.adapter.written.get(result.backup), damaged, "the backup holds the damaged text");
		assert.equal(result.unverified, undefined);
		await assert.rejects(service.preview({ ...entry, id: "user:1:ITEM0009", itemKey: "ITEM0009", citekey: "Other" }, undefined, { rebuild: true }), /no literature note to rebuild/);
		// adopt-existing-notes
		const zotlit = "---\ntitle: My ZotLit note\nzotero-key: ITEM0002\n---\n\n# Reading notes\n\nMine.\n";
		await vault.create("ZotLit/Example2027.md", zotlit);
		const second: ZoteroIndexEntry = { ...entry, id: "user:1:ITEM0002", itemKey: "ITEM0002", citekey: "Example2027", zoteroSelectURI: "zotero://select/library/items/ITEM0002" };
		const adopt = await service.adoptPreview(second, "ZotLit/Example2027.md");
		assert.equal(adopt.mode, "adopt");
		assert.deepEqual(adopt.conflicts, []);
		assert.ok(adopt.content.startsWith("---\ntitle: My ZotLit note\nzotero-key: ITEM0002\nzoteroID: user:1:ITEM0002\nzoteroSelectURI: zotero://select/library/items/ITEM0002\ncitekey: Example2027\n---\n\n# Reading notes\n\nMine.\n\n" + ownerMarker(second.id)));
		const adopted = await service.apply(adopt);
		assert.deepEqual(adopted.conflicts, []);
		assert.equal(vault.adapter.written.get(adopted.backup), zotlit);
		// The adopted note now updates like any owned note.
		assert.deepEqual((await service.preview(second)).conflicts, []);
		assert.equal((await service.preview(second)).path, "ZotLit/Example2027.md");
		const again = await service.adoptPreview(second, "ZotLit/Example2027.md");
		assert.match(again.conflicts.join(" "), /already belongs to CMDS Zotero/);
		await vault.create("Other/dup.md", "---\ncitekey: Example2026\n---\nx");
		assert.match((await service.adoptPreview(entry, "Other/dup.md")).conflicts.join(" "), /already has a literature note: Projects\/Moved\.md/);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
