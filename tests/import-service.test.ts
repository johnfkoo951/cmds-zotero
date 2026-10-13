import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { DEFAULT_SETTINGS, ZoteroIndexEntry } from "../src/types";
import { hashBytes } from "../src/import/images";

// Bundle a synthetic public-API facade; never launch or write into a real vault.
const facade = `export function parseYaml(input) { return Object.fromEntries(input.split('\\n').map(line => { const i = line.indexOf(':'); return [line.slice(0,i),JSON.parse(line.slice(i+1))]; })); }
export function normalizePath(p) { return p; }
export class App {};
export class TFile { constructor(path) { this.path = path; this.stat = {size: 0}; } }
export class TFolder { constructor(path) { this.path = path; } }
export class FileSystemAdapter { constructor(root) { this.root = root; } getBasePath() { return this.root; } }
export class TestVault {
 constructor(root) { this.adapter = new FileSystemAdapter(root); this.files = new Map(); this.data = new Map(); this.writes = 0; }
 getAbstractFileByPath(path) { return this.files.get(path) || null; }
 getMarkdownFiles() { return [...this.files.values()].filter(file => file instanceof TFile && file.path.endsWith('.md')); }
 async read(file) { return this.data.get(file.path); }
 async readBinary(file) { return this.data.get(file.path); }
 async create(path, data) { if (this.files.has(path)) throw Error('exists'); this.writes++; const file = new TFile(path); this.files.set(path,file); this.data.set(path,data); return file; }
 async createBinary(path,data) { return this.create(path,data); }
 async createFolder(path) { this.writes++; this.files.set(path,new TFolder(path)); }
 async process(file, fn) { if(this.beforeProcess) this.beforeProcess(file); const next = fn(this.data.get(file.path)); this.writes++; this.data.set(file.path,next); }
}`;
const entry: ZoteroIndexEntry = { id: "user:1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "Example2026", citekeyHistory: [], title: "Example", authors: ["Test Author"], year: "2026", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {} };

test("service preserves snapshots and canonical identity", async t => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-service-test-")));
	try {
		const output = join(directory, "service.cjs");
		await build({ stdin: { contents: 'export { ImportService } from "./src/importer"; export { TestVault } from "obsidian";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: output, plugins: [{ name: "synthetic-obsidian", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" })); b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: facade, loader: "js" })); } }] });
		const require = createRequire(resolve(output));
		const { ImportService, TestVault } = require(output);
		const vault = new TestVault(directory);
		const service = new ImportService({ vault }, { bibliography: async () => "Author. (2026). Example." }, () => DEFAULT_SETTINGS);
		const preview = await service.preview(entry);
		assert.equal(vault.writes, 0);
		preview.content = "tampered";
		preview.path = "elsewhere.md";
		await service.apply(preview);
		const notePath = `${DEFAULT_SETTINGS.outputFolder}/@Example2026.md`;
		assert.match(vault.data.get(notePath), /> \[!Cite\]/);
		assert.equal(vault.data.has("elsewhere.md"), false);
		const stale = await service.preview(entry);
		vault.data.set(notePath, vault.data.get(notePath) + "\nUser text");
		const writes = vault.writes;
		assert.match((await service.apply(stale)).conflicts.join(" "), /changed after preview/);
		assert.equal(vault.writes, writes);
		assert.match(vault.data.get(notePath), /User text/);
		const race = await service.preview(entry);
		vault.beforeProcess = () => vault.data.set(notePath, vault.data.get(notePath) + "\nRacing edit");
		await assert.rejects(service.apply(race), /changed after preview/);
		assert.match(vault.data.get(notePath), /Racing edit/);
		vault.beforeProcess = undefined;
		await t.test("citekey changes reuse the canonical identity path", async () => {
			const changed = await service.preview({ ...entry, citekey: "Changed2027" });
			assert.equal(changed.path, notePath);
			assert.equal(changed.exists, true);
			assert.deepEqual((await service.apply(changed)).conflicts, []);
			assert.equal(vault.files.has(`${DEFAULT_SETTINGS.outputFolder}/@Changed2027.md`), false);
		});
		const renamed = `${DEFAULT_SETTINGS.outputFolder}/My custom title.md`;
		await t.test("user-renamed notes retain their path on reimport", async () => {
			const file = vault.files.get(notePath);
			vault.files.delete(notePath);
			file.path = renamed;
			vault.files.set(renamed, file);
			vault.data.set(renamed, vault.data.get(notePath));
			vault.data.delete(notePath);
			const changed = await service.preview(entry);
			assert.equal(changed.path, renamed);
			assert.deepEqual((await service.apply(changed)).conflicts, []);
			assert.equal(vault.files.has(notePath), false);
			assert.match(vault.data.get(renamed), /Racing edit/);
		});
		await t.test("duplicate canonical identities refuse import without writes", async () => {
			await vault.create(`${DEFAULT_SETTINGS.outputFolder}/Copy.md`, vault.data.get(renamed));
			const writes = vault.writes;
			const ambiguous = await service.preview(entry);
			assert.match(ambiguous.conflicts.join(" "), /Multiple notes/);
			assert.match((await service.apply(ambiguous)).conflicts.join(" "), /Multiple notes/);
			assert.equal(vault.writes, writes);
		});
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("images are apply-only, deduplicated, versioned and library-scoped", async t => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-service-images-")));
	try {
		const output = join(directory, "service.cjs");
		await build({ stdin: { contents: 'export { ImportService } from "./src/importer"; export { TestVault } from "obsidian";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: output, plugins: [{ name: "synthetic-obsidian", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" })); b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: facade, loader: "js" })); } }] });
		const { ImportService, TestVault } = createRequire(output)(output);
		const vault = new TestVault(directory);
		const imagePath = join(directory, "image.png");
		await fs.writeFile(imagePath, Buffer.from("89504e470d0a1a0a00000000", "hex"));
		const item = { ...entry, attachments: [{ key: "ATTACH01", title: "PDF", path: null, openURI: "", annotations: [{ key: "ANNOT001", attachmentKey: "ATTACH01", type: "image", text: "", comment: "", color: "", page: 1, pageLabel: "1", version: 1, uri: "", imagePath, tags: [], dateModified: "" }] }] };
		const service = new ImportService({ vault }, { bibliography: async () => "APA" }, () => DEFAULT_SETTINGS);
		const initial = await service.preview(item);
		assert.equal(vault.writes, 0);
		await service.apply(initial);
		const initialBytes = await fs.readFile(imagePath);
		const imageTarget = `${DEFAULT_SETTINGS.imageFolder}/user-1-ATTACH01-ANNOT001-${hashBytes(initialBytes)}.png`;
		assert.ok(vault.files.has(imageTarget));
		const count = vault.files.size;
		await service.apply(await service.preview(item));
		assert.equal(vault.files.size, count);
		const next = await service.preview(item);
		vault.data.set(imageTarget, new Uint8Array([0, 1]).buffer);
		const writes = vault.writes;
		assert.match((await service.apply(next)).conflicts.join(" "), /Image conflict/);
		assert.equal(vault.writes, writes);
		let updatedTarget = "";
		await t.test("changed source images append a content-addressed version and preserve old user edits", async () => {
			const updatedBytes = Buffer.from("89504e470d0a1a0a11223344", "hex");
			await fs.writeFile(imagePath, updatedBytes);
			const changed = await service.preview(item);
			assert.deepEqual(changed.conflicts, []);
			assert.deepEqual((await service.apply(changed)).conflicts, []);
			updatedTarget = `${DEFAULT_SETTINGS.imageFolder}/user-1-ATTACH01-ANNOT001-${hashBytes(updatedBytes)}.png`;
			assert.ok(vault.files.has(updatedTarget));
			assert.ok(vault.files.has(imageTarget));
			assert.deepEqual(new Uint8Array(vault.data.get(imageTarget)), new Uint8Array([0, 1]));
			const note = vault.data.get(`${DEFAULT_SETTINGS.outputFolder}/@Example2026.md`);
			assert.ok(note.includes(updatedTarget));
			assert.equal(note.includes(imageTarget), false);
		});
		await t.test("identical attachment and annotation keys in another library cannot collide", async () => {
			const group = { ...item, id: "group:42:ITEM0001", libraryID: 9, libraryType: "group", groupID: 42, citekey: "GroupExample2026" };
			const groupPreview = await service.preview(group);
			assert.deepEqual(groupPreview.conflicts, []);
			assert.deepEqual((await service.apply(groupPreview)).conflicts, []);
			const groupTarget = updatedTarget.replace("/user-1-", "/group-42-");
			assert.notEqual(groupTarget, updatedTarget);
			assert.ok(vault.files.has(groupTarget));
			assert.ok(vault.files.has(updatedTarget));
			assert.ok(vault.data.get(`${DEFAULT_SETTINGS.outputFolder}/@GroupExample2026.md`).includes(groupTarget));
		});
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// 0.5 R12: offline bibliography — the injected provider decides; an owned note keeps its citation section, a new note refuses.
test("an empty bibliography keeps an owned note's citation section byte-identical and refuses a first import", async t => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-service-offline-")));
	try {
		const output = join(directory, "service.cjs");
		await build({ stdin: { contents: 'export { ImportService } from "./src/importer"; export { TestVault } from "obsidian";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: output, plugins: [{ name: "synthetic-obsidian", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" })); b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: facade, loader: "js" })); } }] });
		const { ImportService, TestVault } = createRequire(output)(output);
		const vault = new TestVault(directory);
		let text = "Author. (2026). Example.";
		const seen: unknown[] = [];
		const bbt = { bibliography: async () => { throw new Error("BBT must not be called when a provider is injected"); } };
		const service = new ImportService({ vault }, bbt, () => DEFAULT_SETTINGS, async (_entry: unknown, options: unknown) => { seen.push(options); return text; });
		await service.apply(await service.preview(entry));
		const notePath = `${DEFAULT_SETTINGS.outputFolder}/@Example2026.md`;
		const created: string = vault.data.get(notePath);
		const citation = /<!-- cmds-zotero:citation:[a-f0-9]{64} -->\n[\s\S]*?\n<!-- \/cmds-zotero:citation -->/.exec(created)?.[0];
		assert.ok(citation && citation.includes("Author. \\(2026\\). Example."));
		assert.equal(created.includes("Bibliography unavailable."), false);
		text = "";
		await t.test("owned note: no conflict, citation block unchanged, nothing rewritten", async () => {
			const writes = vault.writes;
			const preview = await service.preview(entry, undefined, { offline: true });
			assert.deepEqual(preview.conflicts, []);
			assert.equal(preview.exists, true);
			assert.ok(preview.content.includes(citation));
			assert.equal(preview.content.includes("Bibliography unavailable."), false);
			const result = await service.apply(preview);
			assert.deepEqual(result.conflicts, []);
			assert.equal(result.changed, false, "the fresh render equals the stored note, so the batch reports it unchanged");
			assert.equal(vault.data.get(notePath), created);
			assert.equal(vault.writes, writes + 1, "apply still goes through vault.process once (identical content)");
			assert.deepEqual(seen.at(-1), { offline: true }, "the offline flag reaches the provider");
		});
		await t.test("new note: refused with the Zotero-must-be-running message, nothing written", async () => {
			const writes = vault.writes;
			await assert.rejects(service.preview({ ...entry, id: "user:1:ITEM0002", itemKey: "ITEM0002", citekey: "Fresh2026" }), /Zotero must be running for the first import of this item/);
			assert.equal(vault.writes, writes);
			assert.equal(vault.files.has(`${DEFAULT_SETTINGS.outputFolder}/@Fresh2026.md`), false);
		});
		await t.test("text returning restores live rendering into the same section", async () => {
			text = "Author. (2026). Example, 2nd ed.";
			const preview = await service.preview(entry);
			assert.deepEqual(preview.conflicts, []);
			assert.ok(preview.content.includes("Example, 2nd ed."));
			assert.equal((await service.apply(preview)).changed, true);
		});
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// 0.6 OPT-02: one identity map per batch instead of one folder scan per preview.
test("a batch identity map gives the same previews as fresh scans, reads the folder once, and sees the batch's own writes", async () => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-service-map-")));
	try {
		const output = join(directory, "service.cjs");
		await build({ stdin: { contents: 'export { ImportService } from "./src/importer"; export { TestVault } from "obsidian";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", outfile: output, plugins: [{ name: "synthetic-obsidian", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" })); b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: facade, loader: "js" })); } }] });
		const { ImportService, TestVault } = createRequire(output)(output);
		const vault = new TestVault(directory);
		const service = new ImportService({ vault }, { bibliography: async () => "Author. (2026). Example." }, () => DEFAULT_SETTINGS);
		const item = (n: number): ZoteroIndexEntry => ({ ...entry, id: `user:1:ITEM000${n}`, itemKey: `ITEM000${n}`, citekey: `Example${n}` });
		const [owned, fresh, doubled] = [item(1), item(2), item(3)];
		for (const target of [owned, doubled]) await service.apply(await service.preview(target));
		const folder = DEFAULT_SETTINGS.outputFolder;
		await vault.create(`${folder}/Copy of Example3.md`, vault.data.get(`${folder}/@Example3.md`));
		for (let i = 0; i < 12; i++) await vault.create(`${folder}/filler ${i}.md`, i % 3 ? `---\nzoteroID: "user:1:OTHER0${i}"\n---\n\nText` : "No frontmatter");
		await vault.create("Elsewhere/@Example2.md", `---\nzoteroID: "${fresh.id}"\n---\n`);
		const reads: string[] = [];
		const read = vault.read.bind(vault);
		vault.read = async (file: { path: string }) => { reads.push(file.path); return read(file); };
		const shape = (preview: { path: string; content: string; conflicts: string[]; softConflicts: string[]; exists: boolean; sections: unknown[] }) => ({ path: preview.path, content: preview.content, conflicts: preview.conflicts, softConflicts: preview.softConflicts, exists: preview.exists, sections: preview.sections });
		const freshPreviews = [];
		for (const target of [owned, fresh, doubled]) freshPreviews.push(shape(await service.preview(target)));
		const notesInFolder = vault.getMarkdownFiles().filter((file: { path: string }) => file.path.startsWith(`${folder}/`)).length;
		assert.equal(reads.length, 3 * notesInFolder + 1, "fresh previews scan the whole folder each time (plus the owned note's text)");
		reads.length = 0;
		const identities = await service.identityMap();
		assert.equal(reads.length, notesInFolder, "the map reads each folder note once");
		assert.ok(reads.every(path => path.startsWith(`${folder}/`)), "notes outside the output folder are never read");
		reads.length = 0;
		const mapped = [];
		for (const target of [owned, fresh, doubled]) mapped.push(await service.preview(target, undefined, { identities }));
		assert.deepEqual(mapped.map(shape), freshPreviews, "map previews equal fresh previews");
		assert.deepEqual(reads, [`${folder}/@Example1.md`], "previews through the map read only their own note");
		assert.match(mapped[2].conflicts.join(" "), /Multiple notes have this Zotero identity/);
		// The batch creates a note: the next preview of that item finds it through the map without scanning the folder.
		reads.length = 0;
		assert.deepEqual((await service.apply(mapped[1])).conflicts, []);
		const again = await service.preview(fresh, undefined, { identities });
		assert.equal(again.path, `${folder}/@Example2.md`);
		assert.equal(again.exists, true);
		assert.deepEqual(reads, [`${folder}/@Example2.md`]);
		// A map built for another output folder is not used.
		reads.length = 0;
		const other = new ImportService({ vault }, { bibliography: async () => "Author. (2026). Example." }, () => ({ ...DEFAULT_SETTINGS, outputFolder: "Elsewhere" }));
		const elsewhere = await other.preview(fresh, undefined, { identities });
		assert.equal(elsewhere.path, "Elsewhere/@Example2.md", "the folder's own notes decide");
		assert.ok(reads.includes("Elsewhere/@Example2.md") && !reads.some(path => path.startsWith(`${folder}/`)));
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
