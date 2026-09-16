import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { coreBuildOptions } from "../scripts/core-build.mjs";
import { build } from "esbuild";
import { scanText } from "../scripts/sanitize.mjs";

const run = (...args: string[]) => execFileSync(process.execPath, args, { encoding: "utf8" });

test("installed skill is copied, private-path placeholders are rendered, and check is read-only", async t => {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zotero-skill-")));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const target = join(root, "skill");
	run("scripts/install-skill.mjs", "--target", target);
	const file = join(target, "SKILL.md");
	const before = await fs.stat(file);
	const content = await fs.readFile(file, "utf8");
	assert.ok(content.includes(resolve(".")));
	assert.ok(!content.includes("${CMDS_ZOTERO_ROOT}"));
	assert.equal(before.isSymbolicLink(), false);
	assert.equal(JSON.parse(run("scripts/install-skill.mjs", "--target", target, "--check")).ok, true);
	assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
	assert.equal(await fs.readFile(file, "utf8"), content);
	await fs.appendFile(file, "\nlocal edit\n");
	assert.throws(() => run("scripts/install-skill.mjs", "--target", target, "--check"));
	assert.throws(() => run("scripts/install-skill.mjs", "--target", target));
	assert.ok((await fs.readFile(file, "utf8")).endsWith("local edit\n"));
});

test("skill source and generated reference are sanitized and synchronized", async () => {
	run("scripts/sync-contract.mjs", "--check");
	async function walk(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) assert.deepEqual(scanText(await fs.readFile(path, "utf8")), [], path);
		}
	}
	await walk("skills");
});

test("offline bundle matches current sources and has no runtime Obsidian dependency", async () => {
	const result = await build({ ...coreBuildOptions, write: false });
	const actual = await fs.readFile("scripts/ingest-core.mjs", "utf8");
	assert.equal(actual, result.outputFiles[0].text, "Run npm run build:core before shipping source changes.");
	assert.doesNotMatch(actual, /(?:from\s*|require\(\s*|import\(\s*)["']obsidian["']/);
	assert.match(actual, /export\s*\{[^}]*\brunAction\b/s);
});
