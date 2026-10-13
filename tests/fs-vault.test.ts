import test, { after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configDirOf, FsVaultReader, parseFrontmatter, MAX_LISTED_NOTES, MAX_NOTE_BYTES, readEnabledPlugins, readInstalledPluginVersion, readPluginSettings } from "../src/cli/fs-vault";
import { findNote } from "../src/agent/note-lookup";
import type { NoteRecord, ScanSkip } from "../src/agent/types";
import { probeGit } from "../src/git-probe";

const execute = promisify(execFile);

test("note framing distinguishes absent, malformed, scalar, duplicate and BOM YAML", () => {
	assert.equal(parseFrontmatter("plain body").frontmatterParse, "ok");
	for (const text of ["---\ncitekey: x", "---\n[a,b]\n---\nbody", "---\na: [\n---\nbody", "---\na: 1\na: 2\n---\nbody"]) assert.equal(parseFrontmatter(text).frontmatterParse, "error");
	const parsed = parseFrontmatter("﻿---\ncitekey: example2024Graph\n---\nbody");
	assert.equal(parsed.frontmatter?.citekey, "example2024Graph");
	assert.equal(parsed.body, "body");
});

test("filesystem reader reports omissions and refuses internal as well as external symlinks", async t => {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zotero-vault-")));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.writeFile(join(root, "good.md"), "---\ntype: paper-hub\n---\nbody");
	await fs.writeFile(join(root, "broken.md"), "---\ntype: [\n---\nbody");
	await fs.writeFile(join(root, "large.md"), "x".repeat(MAX_NOTE_BYTES + 1));
	await fs.symlink(join(root, "good.md"), join(root, "linked.md"));
	await fs.writeFile(join(root, "empty.md"), "");
	const reader = new FsVaultReader(root, "Fixture");
	const notes = await reader.listNotes();
	assert.equal(notes.find(note => note.path === "broken.md")?.frontmatterParse, "error");
	assert.deepEqual(reader.scanWarnings().skipped.sort(), ["broken.md", "large.md", "linked.md"]);
	// 0.5 R8: each skipped path carries its kind so reconcile apply can tolerate parse errors outside its scope.
	assert.deepEqual([...reader.scanWarnings().skippedDetail].sort((a, b) => a.path.localeCompare(b.path)), [{ path: "broken.md", kind: "parse-error" }, { path: "large.md", kind: "unreadable" }, { path: "linked.md", kind: "symlink" }]);
	assert.equal(await reader.readNote("empty.md"), "");
	await assert.rejects(reader.readNote("linked.md"));
	await assert.rejects(reader.readNote("../escape.md"));
	assert.equal(await reader.readText("linked.md", 1000), null);
});

test("Git probe distinguishes tracked content from ignored content", async t => {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zotero-git-")));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await execute("git", ["init", "--quiet", root]);
	await fs.writeFile(join(root, "index.json"), "{}");
	await execute("git", ["-C", root, "add", "index.json"]);
	await fs.writeFile(join(root, ".gitignore"), "index.json\n");
	await fs.mkdir(join(root, ".cmds-zotero"));
	await fs.writeFile(join(root, ".cmds-zotero", ".gitignore"), "*\n");
	const info = await probeGit(root, "index.json");
	assert.equal(info.indexIgnored, true);
	assert.equal(info.indexTracked, true);
	assert.equal(info.cacheIgnored, true);
	assert.equal(info.cacheTracked, false);
});

// PERF-07: the 0.5.0 sequential walk, kept verbatim as the reference the parallel scan must reproduce exactly.
// 0.5 R8: the reference also classifies every skipped path (unreadable, symlink, parse-error).
async function sequentialList(reader: FsVaultReader, root: string, limit: number): Promise<{ notes: NoteRecord[]; skipped: string[]; truncated: boolean; skippedDetail: ScanSkip[] }> {
	const notes: NoteRecord[] = [];
	const report = { skipped: [] as string[], truncated: false, skippedDetail: [] as ScanSkip[] };
	const skip = (path: string, kind: ScanSkip["kind"]): void => { report.skipped.push(path); report.skippedDetail.push({ path, kind }); };
	const walk = async (dir: string): Promise<void> => {
		if (notes.length >= limit) { report.truncated = true; return; }
		let entries: Dirent[];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { skip(relative(root, dir).split(sep).join("/"), "unreadable"); return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (notes.length >= limit) { report.truncated = true; return; }
			if (entry.isSymbolicLink()) { skip(relative(root, join(dir, entry.name)).split(sep).join("/"), "symlink"); continue; }
			const full = join(dir, entry.name);
			if (entry.isDirectory()) { if (!entry.name.startsWith(".")) await walk(full); continue; }
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const relPath = relative(root, full).split(sep).join("/");
			let text: string;
			try { text = await reader.readNote(relPath); } catch { skip(relPath, "unreadable"); continue; }
			const parsed = parseFrontmatter(text);
			if (parsed.frontmatterParse === "error") skip(relPath, "parse-error");
			notes.push({ path: relPath, basename: entry.name.replace(/\.md$/, ""), frontmatter: parsed.frontmatter, frontmatterParse: parsed.frontmatterParse });
		}
	};
	await walk(root);
	return { notes, ...report };
}

/** Every shape the walk treats differently: nesting, sort order, dot folders/files, symlinks, unreadable folders, size, YAML. Shared by the tests below. */
let sharedFixture: Promise<string> | undefined;
after(async () => {
	if (!sharedFixture) return;
	const root = await sharedFixture;
	await fs.chmod(join(root, "Locked"), 0o755).catch(() => undefined);
	await fs.rm(root, { recursive: true, force: true });
});
function scanFixture(): Promise<string> {
	sharedFixture ??= createScanFixture();
	return sharedFixture;
}
async function createScanFixture(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zotero-scan-")));
	const write = async (path: string, text: string) => { await fs.mkdir(join(root, path, ".."), { recursive: true }); await fs.writeFile(join(root, path), text); };
	await write("a.md", "---\ncitekey: alpha2020\n---\nbody");
	await write("B note.md", "plain");
	await write("b/inner.md", "---\ntype: [\n---\nbroken yaml");
	await write("b/zeta.md", "---\ntype: paper-hub\n---\n");
	await write("b/deep/x.md", "x");
	await write("b/deep/x.md.md", "double extension");
	await write("b/image.png", "not a note");
	await write(".hidden/secret.md", "dot folder");
	await write(".dotfile.md", "dot file at the root");
	await write("c/big.md", "x".repeat(MAX_NOTE_BYTES + 1));
	await write("c/empty.md", "");
	await write("c/with\\backslash.md", "a backslash in the name");
	await write("Locked/inside.md", "unreadable folder");
	await write("z/last.md", "last");
	await write("z/later.txt", "trailing non-note");
	await fs.symlink(join(root, "a.md"), join(root, "c", "linked.md"));
	await fs.symlink(join(root, "b"), join(root, "linked-folder"));
	await fs.chmod(join(root, "Locked"), 0o000);
	return root;
}

test("PERF-07: the parallel offline scan lists, skips and truncates exactly like the sequential walk at every cap", async () => {
	const root = await scanFixture();
	const unrestricted = await sequentialList(new FsVaultReader(root, "Fixture"), root, MAX_LISTED_NOTES);
	assert.ok(unrestricted.notes.length >= 8 && unrestricted.skipped.includes("linked-folder") && unrestricted.skipped.includes("c/big.md"), JSON.stringify(unrestricted.skipped));
	// The caps where it matters what comes next: nothing (0), a non-note (4), a note that is also skipped (5), a folder
	// whose first entry is skipped (7), a skipped symlink (8), only a trailing non-note (9), and no cap at all.
	for (const limit of [0, 4, 5, 7, 8, 9, MAX_LISTED_NOTES]) {
		const reader = new FsVaultReader(root, "Fixture", limit);
		const expected = await sequentialList(new FsVaultReader(root, "Fixture"), root, limit);
		const notes = await reader.listNotes();
		assert.deepEqual(notes, expected.notes, `notes at limit ${limit}`);
		assert.deepEqual(reader.scanWarnings(), { skipped: expected.skipped, truncated: expected.truncated, skippedDetail: expected.skippedDetail }, `report at limit ${limit}`);
	}
});

test("PERF-07: findNote gives the listing's answer for every spelling without reading the vault, and defers to the scan past the cap", async () => {
	const root = await scanFixture();
	const requests = ["a", "a.md", "/a/", "B note", "b/inner", "b/zeta.md", "b/deep/x", "b/deep/x.md", "b/deep/x.md.md", ".hidden/secret", ".dotfile", "c/big", "c/empty", "c/linked", "linked-folder/zeta", "Locked/inside", "z/last", "A", "b/missing", "", "/", "b//zeta", "./a"];
	for (const limit of [0, 3, 7, MAX_LISTED_NOTES]) {
		const listed = (await sequentialList(new FsVaultReader(root, "Fixture"), root, limit)).notes;
		for (const request of requests) {
			const reader = new FsVaultReader(root, "Fixture", limit);
			assert.deepEqual(await reader.findNote(request), findNote(listed, request), `findNote(${JSON.stringify(request)}) at limit ${limit}`);
		}
	}
	// Under the cap the lookup reads only the note it returns and leaves the scan report untouched.
	const reader = new FsVaultReader(root, "Fixture");
	const reads: string[] = [];
	const readNote = reader.readNote.bind(reader);
	reader.readNote = async (path: string) => { reads.push(path); return readNote(path); };
	assert.equal((await reader.findNote("b/zeta"))?.frontmatter?.type, "paper-hub");
	assert.equal(await reader.findNote("b/missing"), null);
	assert.deepEqual(reads, ["b/zeta.md"]);
	assert.deepEqual(reader.scanWarnings(), { skipped: [], truncated: false, skippedDetail: [] });
});

test("HYG-02: the offline readers take the vault's configuration folder as a parameter; no plugin source names a default", async t => {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zotero-config-")));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const custom = join(root, ".config-custom");
	await fs.mkdir(join(custom, "plugins", "cmds-zotero"), { recursive: true });
	await fs.writeFile(join(custom, "plugins", "cmds-zotero", "data.json"), JSON.stringify({ zoteroIndexPath: "Custom/index.json" }));
	await fs.writeFile(join(custom, "plugins", "cmds-zotero", "manifest.json"), JSON.stringify({ version: "0.5.0" }));
	await fs.writeFile(join(custom, "community-plugins.json"), JSON.stringify(["cmds-zotero"]));
	const read = await readPluginSettings(root, ".config-custom");
	assert.equal(read.present, true);
	assert.equal(read.settings.zoteroIndexPath, "Custom/index.json");
	assert.deepEqual(await readEnabledPlugins(root, ".config-custom"), ["cmds-zotero"]);
	assert.equal(await readInstalledPluginVersion(root, ".config-custom"), "0.5.0");
	assert.equal((await readPluginSettings(root, ".obsidian")).present, false, "another folder name reads nothing from this vault");
	assert.equal(await readEnabledPlugins(root, ".obsidian"), null);
	assert.equal(configDirOf(".config-custom"), ".config-custom");
	// The folder is never defaulted here: the command line wrapper supplies Obsidian's default (tests/cli-offline.test.ts).
	for (const bad of ["", ".", "..", "plain", ".a/b", "../.obsidian", ".a\\b", ".a\0b", "/.obsidian", null, undefined]) assert.throws(() => configDirOf(bad as never), /--config-dir/, JSON.stringify(bad));
});
