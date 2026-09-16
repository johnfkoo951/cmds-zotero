import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FsVaultReader, parseFrontmatter, MAX_NOTE_BYTES } from "../src/cli/fs-vault";
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
