// PERF-07: the live reader's parallel scan and findNote, bundled against a minimal `obsidian` stand-in over a real
// temporary folder (the boundary check needs real lstat/realpath). Synthetic notes only.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parse as parseYaml } from "yaml";
import { parseNoteText } from "../src/frontmatter-read";
import { findNote } from "../src/agent/note-lookup";
import type { NoteRecord, ScanSkip } from "../src/agent/types";

interface FakeFile { path: string; basename: string; extension: string; stat: { size: number } }
interface ReaderModule {
	ObsidianVaultReader: new (app: unknown, limit?: number) => { listNotes(): Promise<NoteRecord[]>; scanWarnings(): { skipped: string[]; truncated: boolean; skippedDetail: ScanSkip[] }; findNote(path: string): Promise<NoteRecord | null>; readNote(path: string): Promise<string> };
	TFile: new (path: string, size: number) => FakeFile;
	FileSystemAdapter: new (base: string) => { getBasePath(): string; calls: number };
	MAX_LISTED_NOTES: number;
	MAX_NOTE_BYTES: number;
}

const temporary: string[] = [];
after(async () => { for (const path of temporary) { await fs.chmod(join(path, "Locked"), 0o755).catch(() => undefined); await fs.rm(path, { recursive: true, force: true }); } });

const OBSIDIAN_STAND_IN = `
import { parse } from "yaml";
export class App {}
export class TFile { constructor(path, size) { this.path = path; this.basename = path.split("/").pop().replace(/\\.md$/, ""); this.extension = path.split(".").pop(); this.stat = { size }; } }
export class FileSystemAdapter { constructor(base) { this.base = base; this.calls = 0; } getBasePath() { this.calls++; return this.base; } }
export function parseYaml(text) { return parse(text); }
export function normalizePath(path) { return path; }
`;

let loaded: Promise<ReaderModule> | undefined;
function readerModule(): Promise<ReaderModule> {
	loaded ??= (async () => {
		const out = await fs.mkdtemp(join(tmpdir(), "cmds-zotero-reader-bundle-"));
		temporary.push(out);
		const file = join(out, "reader.mjs");
		await build({ stdin: { contents: 'export * from "./src/obsidian-vault.ts"; export { TFile, FileSystemAdapter } from "obsidian";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: file, logLevel: "silent",
			// The yaml package is CommonJS: give the ESM bundle a lexical require, as scripts/core-build.mjs does.
			banner: { js: 'import { createRequire as __standInRequire } from "node:module"; const require = __standInRequire(import.meta.url);' }, plugins: [{
			name: "obsidian-stand-in", setup(builder) {
				builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stand-in" }));
				builder.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({ contents: OBSIDIAN_STAND_IN, resolveDir: process.cwd(), loader: "js" }));
			},
		}] });
		return import(pathToFileURL(file).href) as Promise<ReaderModule>;
	})();
	return loaded;
}

/** Obsidian's view of the folder: every Markdown file it can reach, symlinked folders followed, dot entries included. */
async function fakeApp(root: string, module: ReaderModule, extra: string[] = []): Promise<{ app: unknown; adapter: { calls: number } }> {
	const files = new Map<string, FakeFile>();
	const visit = async (dir: string, prefix: string): Promise<void> => {
		let names: string[];
		try { names = await fs.readdir(dir); } catch { return; }
		for (const name of names) {
			const stat = await fs.stat(join(dir, name)).catch(() => null);
			if (!stat) continue;
			const path = prefix ? `${prefix}/${name}` : name;
			if (stat.isDirectory()) await visit(join(dir, name), path);
			else if (name.endsWith(".md")) files.set(path, new module.TFile(path, stat.size));
		}
	};
	await visit(root, "");
	for (const path of extra) files.set(path, new module.TFile(path, 10));
	const adapter = new module.FileSystemAdapter(root);
	const app = { vault: { adapter, getName: () => "Fixture", getMarkdownFiles: () => [...files.values()], getAbstractFileByPath: (path: string) => files.get(path) ?? null, read: (file: FakeFile) => fs.readFile(join(root, file.path), "utf8") } };
	return { app, adapter };
}

// The 0.5.0 sequential scan, kept as the reference (reads through the reader's own readNote); 0.5 R8 adds the kind of each skip.
async function sequentialList(reader: { readNote(path: string): Promise<string> }, app: { vault: { getMarkdownFiles(): FakeFile[] } }, limit: number): Promise<{ notes: NoteRecord[]; skipped: string[]; truncated: boolean; skippedDetail: ScanSkip[] }> {
	const notes: NoteRecord[] = [];
	const report = { skipped: [] as string[], truncated: false, skippedDetail: [] as ScanSkip[] };
	const files = app.vault.getMarkdownFiles().filter(file => !file.path.split("/").some(part => part.startsWith("."))).sort((a, b) => a.path.localeCompare(b.path));
	for (const file of files) {
		if (notes.length >= limit) { report.truncated = true; break; }
		try {
			const parsed = parseNoteText(await reader.readNote(file.path), parseYaml);
			if (parsed.frontmatterParse === "error") { report.skipped.push(file.path); report.skippedDetail.push({ path: file.path, kind: "parse-error" }); }
			notes.push({ path: file.path, basename: file.basename, frontmatter: parsed.frontmatter, frontmatterParse: parsed.frontmatterParse });
		} catch { report.skipped.push(file.path); report.skippedDetail.push({ path: file.path, kind: "unreadable" }); }
	}
	return { notes, ...report };
}

async function fixture(maxBytes: number): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-live-scan-")));
	temporary.push(root);
	const write = async (path: string, text: string) => { await fs.mkdir(join(root, path, ".."), { recursive: true }); await fs.writeFile(join(root, path), text); };
	await write("a.md", "---\ncitekey: alpha2020\n---\nbody");
	await write("B note.md", "plain");
	await write("b/inner.md", "---\ntype: [\n---\nbroken yaml");
	await write("b/zeta.md", "---\ntype: paper-hub\n---\n");
	await write("b/deep/x.md", "x");
	await write("b/deep/x.md.md", "double extension");
	await write(".hidden/secret.md", "dot folder");
	await write("c/.dotfile.md", "dot file");
	await write("c/big.md", "x".repeat(maxBytes + 1));
	await write("c/empty.md", "");
	await write("c/with\\backslash.md", "a backslash in the name");
	await write("z/last.md", "last");
	await fs.symlink(join(root, "a.md"), join(root, "c", "linked.md"));
	await fs.symlink(join(root, "b"), join(root, "linked-folder"));
	return root;
}

test("PERF-07: the live scan lists, skips and truncates exactly like the 0.5.0 sequential scan, resolving the vault root once", async () => {
	const module = await readerModule();
	const root = await fixture(module.MAX_NOTE_BYTES);
	const { app, adapter } = await fakeApp(root, module, ["ghost.md"]);
	const full = await sequentialList(new module.ObsidianVaultReader(app), app as never, module.MAX_LISTED_NOTES);
	for (const skipped of ["b/inner.md", "c/big.md", "c/linked.md", "c/with\\backslash.md", "ghost.md", "linked-folder/zeta.md"]) assert.ok(full.skipped.includes(skipped), `${skipped} in ${JSON.stringify(full.skipped)}`);
	// Caps before a note that is also skipped (3), before a skipped note (6), before a skipped run (7), and none at all.
	for (const limit of [0, 3, 6, 7, module.MAX_LISTED_NOTES]) {
		const expected = await sequentialList(new module.ObsidianVaultReader(app), app as never, limit);
		const reader = new module.ObsidianVaultReader(app, limit);
		adapter.calls = 0;
		assert.deepEqual(await reader.listNotes(), expected.notes, `notes at limit ${limit}`);
		assert.deepEqual(reader.scanWarnings(), { skipped: expected.skipped, truncated: expected.truncated, skippedDetail: expected.skippedDetail }, `report at limit ${limit}`);
		assert.ok(adapter.calls <= 1, `the vault root was resolved ${adapter.calls} times in one scan`);
	}
});

test("PERF-07: the live findNote gives the listing's answer, reading only candidates under the cap and deferring to the scan past it", async () => {
	const module = await readerModule();
	const root = await fixture(module.MAX_NOTE_BYTES);
	const { app } = await fakeApp(root, module, ["ghost.md"]);
	const requests = ["a", "a.md", "/a/", "B note", "b/inner", "b/zeta.md", "b/deep/x", "b/deep/x.md", "b/deep/x.md.md", ".hidden/secret", "c/.dotfile", "c/big", "c/empty", "c/linked", "linked-folder/zeta", "ghost", "z/last", "A", "b/missing", "", "/"];
	for (const limit of [0, 3, module.MAX_LISTED_NOTES]) {
		const listed = (await sequentialList(new module.ObsidianVaultReader(app), app as never, limit)).notes;
		for (const request of requests) {
			const reader = new module.ObsidianVaultReader(app, limit);
			assert.deepEqual(await reader.findNote(request), findNote(listed, request), `findNote(${JSON.stringify(request)}) at limit ${limit}`);
		}
	}
	const reads: string[] = [];
	const counting = { vault: { ...(app as { vault: object }).vault, read: (file: FakeFile) => { reads.push(file.path); return fs.readFile(join(root, file.path), "utf8"); } } };
	const reader = new module.ObsidianVaultReader(counting);
	assert.equal((await reader.findNote("b/zeta"))?.frontmatter?.type, "paper-hub");
	assert.equal(await reader.findNote("b/missing"), null);
	assert.deepEqual(reads, ["b/zeta.md"], "only the candidate note was read");
	assert.deepEqual(reader.scanWarnings(), { skipped: [], truncated: false, skippedDetail: [] }, "no scan ran");
});
