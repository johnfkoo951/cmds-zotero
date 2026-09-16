// 0.5 R5: conflict resolution — soft/hard split, marker repair, detach (never re-own) and reset with backups.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { DEFAULT_SETTINGS, ZoteroIndexEntry, Annotation } from "../src/types";
import { detachSections, hashText, renderLiterature, resetSections } from "../src/note-writer";

const annotation: Annotation = { key: "ANNOT001", attachmentKey: "ATTACH01", type: "highlight", text: "Evidence", comment: "", color: "#ffd400", page: 3, pageLabel: "3", version: 1, uri: "", tags: [], dateModified: "" };
const second: Annotation = { ...annotation, key: "ANNOT002", text: "Second evidence", page: 4, pageLabel: "4" };
const entry: ZoteroIndexEntry = { id: "user:1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "Example2026", citekeyHistory: [], title: "Example", authors: ["Test Author"], year: "2026", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [{ key: "ATTACH01", openURI: "", path: null, title: "", annotations: [annotation, second] }], attachmentStatus: "complete", contentHash: "", metadata: {} };
const ID1 = "annotation-ATTACH01-ANNOT001";
const ID2 = "annotation-ATTACH01-ANNOT002";
const render = (previous: string | null, item = entry, context = {}) => renderLiterature(item, "Author (2026). Example.", DEFAULT_SETTINGS, previous, new Map(), context);
const state = (result: ReturnType<typeof render>, id: string) => result.sections.find(section => section.id === id);

test("text pasted after an opening marker is moved below the block and trailing whitespace before a closing marker is tolerated (T04)", () => {
	const initial = render(null).content;
	const opening = new RegExp(`(<!-- cmds-zotero:${ID1}:[a-f0-9]{64} -->)\\n`);
	// The live case: an image link pasted on the marker line, plus trailing spaces and an indented closing marker on another block.
	const damaged = initial.replace(opening, "$1![[pasted.png]]\n").replace(`\n<!-- /cmds-zotero:${ID2} -->`, `  \t\n  <!-- /cmds-zotero:${ID2} -->`);
	const result = render(damaged);
	assert.deepEqual(result.conflicts, []);
	assert.deepEqual(result.softConflicts, []);
	assert.match(result.content, new RegExp(`<!-- /cmds-zotero:${ID1} -->\\n!\\[\\[pasted.png\\]\\]\\n`));
	assert.doesNotMatch(result.content, /-->!\[\[pasted/);
	assert.equal(result.content.replace(`\n![[pasted.png]]`, ""), initial, "repair restores the canonical layout, the tail aside");
	assert.equal(state(result, ID1)?.state, "unchanged");
	assert.match(state(result, ID1)?.reason ?? "", /moved below the block/);
	assert.equal(state(result, ID1)?.line, damaged.slice(0, damaged.indexOf(`cmds-zotero:${ID1}:`)).split("\n").length);
	// Idempotent: a second render leaves the repaired note alone.
	assert.equal(render(result.content).content, result.content);
});

test("an edited block is a soft conflict: kept verbatim while the rest of the note is refreshed", () => {
	const initial = render(null).content;
	const edited = initial.replace(">Evidence<", ">My changed evidence<");
	const result = render(edited, { ...entry, title: "Renamed title" });
	assert.deepEqual(result.conflicts, []);
	assert.deepEqual(result.softConflicts, [`Edited generated section preserved: ${ID1}`]);
	assert.deepEqual(result.detached, []);
	assert.match(result.content, /My changed evidence/);
	assert.match(result.content, /^# Renamed title$/m);
	assert.match(result.content, /\*\*Title\*\*:: Renamed title/);
	assert.equal(state(result, ID1)?.state, "edited");
	assert.equal(state(result, ID2)?.state, "unchanged");
	assert.equal(state(result, "overview")?.state, "unchanged");
	assert.equal(state(result, "overview")?.body, "# Renamed title");
	// The stored hash of the edited block is untouched, so the next render still sees the edit.
	assert.equal(render(result.content).softConflicts.length, 1);
});

test("detach freezes a block as user-owned; idempotent across renders and immune to Zotero changes or deletions", () => {
	const initial = render(null).content;
	const edited = initial.replace(">Evidence<", ">My changed evidence<");
	const detachedRender = render(edited, entry, { detach: [ID1] });
	assert.deepEqual(detachedRender.conflicts, []);
	assert.deepEqual(detachedRender.softConflicts, []);
	assert.deepEqual(detachedRender.detached, [ID1]);
	assert.match(detachedRender.content, new RegExp(`<!-- cmds-zotero:${ID1}:detached -->\\n> \\[!Highlight\\][^\\n]*\\n> <mark[^\\n]*My changed evidence`));
	assert.equal(state(detachedRender, ID1)?.state, "detached");
	// Idempotent: a plain second render changes nothing and still lists the block as detached, never as edited or missing.
	const again = render(detachedRender.content, { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [{ ...annotation, text: "Changed in Zotero" }, second] }] });
	assert.equal(again.content, detachedRender.content);
	assert.deepEqual(again.detached, [ID1]);
	assert.deepEqual(again.softConflicts, []);
	assert.deepEqual(again.conflicts, []);
	assert.doesNotMatch(again.content, /Changed in Zotero/);
	// The annotation disappears from Zotero: the detached block is left alone and not reported.
	const gone = render(detachedRender.content, { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [second] }] });
	assert.equal(gone.content, detachedRender.content);
	assert.deepEqual(gone.conflicts, []);
	assert.equal(state(gone, ID1)?.state, "detached");
	// The pure helper produces the same grammar and is idempotent.
	const helper = detachSections(edited, [ID1]);
	assert.equal(detachSections(helper, [ID1]), helper);
	assert.equal(render(helper).content, detachedRender.content);
});

test("reset replaces an edited or detached block with the fresh render and reports it", () => {
	const initial = render(null).content;
	const edited = initial.replace(">Evidence<", ">My changed evidence<");
	const fromEdited = render(edited, entry, { reset: [ID1] });
	assert.deepEqual(fromEdited.conflicts, []);
	assert.deepEqual(fromEdited.softConflicts, []);
	assert.deepEqual(fromEdited.reset, [ID1]);
	assert.equal(fromEdited.content, initial);
	assert.equal(state(fromEdited, ID1)?.state, "fresh");
	const detached = render(edited, entry, { detach: [ID1] }).content;
	const fromDetached = render(detached, entry, { reset: [ID1] });
	assert.deepEqual(fromDetached.reset, [ID1]);
	assert.deepEqual(fromDetached.detached, []);
	assert.equal(fromDetached.content, initial);
	// A reset of a detached block whose annotation is gone from Zotero cannot be honoured: the block stays detached.
	const gone = render(detached, { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [second] }] }, { reset: [ID1] });
	assert.deepEqual(gone.reset, []);
	assert.deepEqual(gone.detached, [ID1]);
	assert.match(state(gone, ID1)?.reason ?? "", /cannot reset/);
	// Reset of an unedited block is a no-op; unknown ids are ignored.
	assert.equal(render(initial, entry, { reset: [ID1, "nope"] }).content, initial);
	// Pure helper.
	const body = /<!-- cmds-zotero:annotation-ATTACH01-ANNOT001:[a-f0-9]{64} -->\n([\s\S]*?)\n<!-- \/cmds-zotero:annotation-ATTACH01-ANNOT001 -->/.exec(initial)?.[1] ?? "";
	assert.equal(resetSections(edited, [ID1], new Map([[ID1, body]])), initial);
	assert.equal(resetSections(edited, [ID1], new Map()), edited);
});

test("malformed markers are reported per id with the line number; missing and duplicate blocks stay hard", () => {
	const initial = render(null).content;
	const noClosing = initial.replace(`<!-- /cmds-zotero:${ID2} -->`, "");
	const result = render(noClosing);
	const line = noClosing.slice(0, noClosing.indexOf(`<!-- cmds-zotero:${ID2}:`)).split("\n").length;
	assert.deepEqual(result.conflicts, [`Malformed managed markers for ${ID2} (line ${line})`]);
	assert.equal(state(result, ID2)?.state, "malformed");
	assert.equal(state(result, ID2)?.line, line);
	assert.doesNotMatch(result.conflicts.join(" "), /Malformed or duplicate managed markers/);
	// Other blocks are still classified, and the damaged block is not duplicated by the splice.
	assert.equal(state(result, ID1)?.state, "unchanged");
	assert.equal((result.content.match(new RegExp(`cmds-zotero:${ID2}:`, "g")) ?? []).length, 1);
	// A bad hash on an opening marker is malformed for that id, not silently edited.
	const badHash = initial.replace(new RegExp(`(<!-- cmds-zotero:${ID1}:)[a-f0-9]{64}`), "$1deadbeef");
	assert.match(render(badHash).conflicts.join(" "), new RegExp(`Malformed managed markers for ${ID1} \\(line \\d+\\)`));
	// A duplicate full block carries its line; a removed core section is missing.
	const block = /<!-- cmds-zotero:citation:[\s\S]*?<!-- \/cmds-zotero:citation -->/.exec(initial)?.[0] ?? "";
	const duplicated = initial.replace(block, `${block}\n\n${block}`);
	assert.match(render(duplicated).conflicts.join(" "), /Duplicate managed section: citation \(line \d+\)/);
	assert.deepEqual(render(initial.replace(block, "")).conflicts, ["Missing managed section: citation"]);
	assert.equal(render(initial.replace(block, "")).sections.find(section => section.id === "citation")?.state, "missing");
});

test("a note without the owner marker is still refused as a hard conflict (legacy path)", () => {
	const foreign = "---\nzoteroID: \"user:1:ITEM0001\"\n---\n\n<!-- cmds-zotero:overview:" + hashText("# Mine") + " -->\n# Mine\n<!-- /cmds-zotero:overview -->\n";
	const result = render(foreign);
	assert.deepEqual(result.conflicts, ["Existing note is not owned by this Zotero item"]);
	assert.deepEqual(result.softConflicts, []);
	assert.deepEqual(result.sections, []);
	assert.equal(result.content, foreign);
	// Detach/reset requests cannot bypass ownership.
	assert.equal(render(foreign, entry, { detach: ["overview"], reset: ["overview"] }).conflicts.length, 1);
});

// Import service: soft conflicts apply, detach/reset travel with apply, reset backs the note up under the private folder.
const facade = `export function parseYaml(input) { return Object.fromEntries(input.split('\\n').map(line => { const i = line.indexOf(':'); return [line.slice(0,i),JSON.parse(line.slice(i+1))]; })); }
export function normalizePath(p) { return p; }
export class App {};
export class TFile { constructor(path) { this.path = path; this.stat = {size: 0}; } }
export class TFolder { constructor(path) { this.path = path; } }
const fs = require('node:fs/promises'); const nodePath = require('node:path');
export class FileSystemAdapter {
 constructor(root) { this.root = root; }
 getBasePath() { return this.root; }
 async exists(p) { try { await fs.access(nodePath.join(this.root, p)); return true; } catch { return false; } }
 async mkdir(p) { await fs.mkdir(nodePath.join(this.root, p), { recursive: true }); }
 async read(p) { return fs.readFile(nodePath.join(this.root, p), 'utf8'); }
 async write(p, data) { await fs.writeFile(nodePath.join(this.root, p), data); }
}
export class TestVault {
 constructor(root) { this.adapter = new FileSystemAdapter(root); this.files = new Map(); this.data = new Map(); this.writes = 0; }
 getAbstractFileByPath(path) { return this.files.get(path) || null; }
 getMarkdownFiles() { return [...this.files.values()].filter(file => file instanceof TFile && file.path.endsWith('.md')); }
 async read(file) { return this.data.get(file.path); }
 async readBinary(file) { return this.data.get(file.path); }
 async create(path, data) { if (this.files.has(path)) throw Error('exists'); this.writes++; const file = new TFile(path); this.files.set(path,file); this.data.set(path,data); return file; }
 async createBinary(path,data) { return this.create(path,data); }
 async createFolder(path) { this.writes++; this.files.set(path,new TFolder(path)); }
 async process(file, fn) { const next = fn(this.data.get(file.path)); this.writes++; this.data.set(file.path,next); }
}`;

test("import service: soft conflicts apply, detach and reset are honoured, a reset backs up the note", async t => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-conflicts-")));
	try {
		const output = join(directory, "service.cjs");
		await build({ stdin: { contents: 'export { ImportService, NOTE_BACKUP_DIR } from "./src/importer"; export { TestVault } from "obsidian";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: output, plugins: [{ name: "synthetic-obsidian", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" })); b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: facade, loader: "js" })); } }] });
		const { ImportService, TestVault, NOTE_BACKUP_DIR } = createRequire(resolve(output))(output);
		const vault = new TestVault(directory);
		const service = new ImportService({ vault }, { bibliography: async () => "Author. (2026). Example." }, () => DEFAULT_SETTINGS);
		const notePath = `${DEFAULT_SETTINGS.outputFolder}/@Example2026.md`;
		await service.apply(await service.preview(entry));
		const initial: string = vault.data.get(notePath);
		vault.data.set(notePath, initial.replace(">Evidence<", ">My changed evidence<"));
		await t.test("preview exposes states and apply proceeds with only soft conflicts", async () => {
			const preview = await service.preview({ ...entry, title: "Renamed" });
			assert.deepEqual(preview.conflicts, []);
			assert.deepEqual(preview.softConflicts, [`Edited generated section preserved: ${ID1}`]);
			assert.equal(preview.sections.find((s: { id: string }) => s.id === ID1)?.state, "edited");
			const result = await service.apply(preview);
			assert.deepEqual(result.conflicts, []);
			assert.equal(result.changed, true);
			assert.deepEqual(result.preserved, [ID1]);
			assert.deepEqual(result.detached, []);
			assert.deepEqual(result.reset, []);
			assert.match(vault.data.get(notePath), /My changed evidence/);
			assert.match(vault.data.get(notePath), /^# Renamed$/m);
		});
		await t.test("detach at apply time freezes the block; no backup is written", async () => {
			const preview = await service.preview(entry);
			const result = await service.apply(preview, { detach: [ID1] });
			assert.deepEqual(result.conflicts, []);
			assert.deepEqual(result.detached, [ID1]);
			assert.deepEqual(result.preserved, []);
			assert.match(vault.data.get(notePath), new RegExp(`<!-- cmds-zotero:${ID1}:detached -->`));
			assert.equal(await vault.adapter.exists(NOTE_BACKUP_DIR), false);
			const again = await service.preview(entry);
			assert.deepEqual(again.detached, [ID1]);
			assert.deepEqual(again.softConflicts, []);
		});
		await t.test("reset restores the fresh block and backs the previous note text up in the ignored private folder", async () => {
			const before: string = vault.data.get(notePath);
			const preview = await service.preview(entry);
			const result = await service.apply(preview, { reset: [ID1] });
			assert.deepEqual(result.conflicts, []);
			assert.deepEqual(result.reset, [ID1]);
			assert.deepEqual(result.detached, []);
			assert.equal(vault.data.get(notePath), initial);
			const backups = (await fs.readdir(join(directory, NOTE_BACKUP_DIR))).filter(name => /^@Example2026-\d+\.md$/.test(name));
			assert.equal(backups.length, 1);
			assert.equal(await fs.readFile(join(directory, NOTE_BACKUP_DIR, backups[0]!), "utf8"), before);
			assert.match(await fs.readFile(join(directory, ".cmds-zotero/.gitignore"), "utf8"), /^\*$/m);
		});
		await t.test("hard conflicts still refuse, even with reset choices", async () => {
			vault.data.set(notePath, initial.replace(`<!-- /cmds-zotero:${ID2} -->`, ""));
			const preview = await service.preview(entry);
			assert.match(preview.conflicts.join(" "), new RegExp(`Malformed managed markers for ${ID2} \\(line \\d+\\)`));
			const writes = vault.writes;
			const result = await service.apply(preview, { reset: [ID2] });
			assert.match(result.conflicts.join(" "), /Malformed managed markers/);
			assert.equal(vault.writes, writes);
		});
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
