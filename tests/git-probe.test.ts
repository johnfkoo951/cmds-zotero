// PERF-09: the per-session git probe cache. A counting probe pins when the cache answers and when it must probe again;
// one run against real git checks that the cached answer is the probe's answer and follows an index change.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cachedGitProbe, gitProbeInputs, type GitProbe } from "../src/git-probe";
import type { GitInfo } from "../src/agent/types";

const execute = promisify(execFile);
const INDEX = "80. References/zotero-index.json";

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<{ root: string; home: string }> {
	const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-git-cache-")));
	t.after(() => fs.rm(base, { recursive: true, force: true }));
	const root = join(base, "vault");
	const home = join(base, "home");
	await fs.mkdir(join(root, ".git", "info"), { recursive: true });
	await fs.mkdir(join(root, "80. References"), { recursive: true });
	await fs.mkdir(home);
	await fs.writeFile(join(root, ".git", "index"), "index v1");
	return { root, home };
}

function counting(): { probe: GitProbe; calls: () => number } {
	let calls = 0;
	return { probe: async () => { calls++; return { repo: true, indexIgnored: calls % 2 === 0, cacheIgnored: true, indexTracked: false, cacheTracked: false }; }, calls: () => calls };
}

// Content changes always move the size or the change time; the explicit utimes keeps the check honest on coarse clocks.
async function change(path: string, text: string, step: number): Promise<void> {
	await fs.writeFile(path, text);
	const when = new Date(Date.UTC(2030, 0, 1, 0, 0, step));
	await fs.utimes(path, when, when);
}

test("the cache answers repeated probes until a watched file changes, and hands out copies", async t => {
	const { root, home } = await sandbox(t);
	const counter = counting();
	const probe = cachedGitProbe({ probe: counter.probe, home, env: {} });
	const first = await probe(root, INDEX);
	const second = await probe(root, INDEX);
	assert.equal(counter.calls(), 1);
	assert.deepEqual(second, first);
	assert.notEqual(second, first, "callers never share the cached object");
	second.indexIgnored = null;
	assert.deepEqual(await probe(root, INDEX), first, "a caller's mutation does not reach the cache");
	assert.equal(counter.calls(), 1);
	let step = 0;
	for (const path of [join(root, ".gitignore"), join(root, ".git", "index"), join(root, ".cmds-zotero", ".gitignore"), join(root, "80. References", ".gitignore"), join(root, ".git", "info", "exclude"), join(root, ".git", "config"), join(home, ".gitconfig"), join(home, ".config", "git", "ignore")]) {
		const before = counter.calls();
		await fs.mkdir(join(path, ".."), { recursive: true });
		await change(path, `rule ${++step}\n`, step);
		await probe(root, INDEX);
		assert.equal(counter.calls(), before + 1, `a change to ${path.slice(root.length - 5)} is noticed`);
		await probe(root, INDEX);
		assert.equal(counter.calls(), before + 1, "and then cached again");
	}
	await probe(root, "Elsewhere/index.json");
	assert.equal(counter.calls(), step + 2, "another index path is its own entry");
});

test("the cache expires after maxAgeMs, shares one probe between concurrent callers, and never caches a failure", async t => {
	const { root, home } = await sandbox(t);
	let clock = 1_000;
	const counter = counting();
	const probe = cachedGitProbe({ probe: counter.probe, home, env: {}, maxAgeMs: 100, now: () => clock });
	await Promise.all([probe(root, INDEX), probe(root, INDEX), probe(root, INDEX)]);
	assert.equal(counter.calls(), 1, "concurrent callers share one probe");
	clock += 99;
	await probe(root, INDEX);
	assert.equal(counter.calls(), 1);
	clock += 1;
	await probe(root, INDEX);
	assert.equal(counter.calls(), 2, "an answer older than maxAgeMs is probed again");
	let fail = true;
	const flaky = cachedGitProbe({ probe: async (): Promise<GitInfo> => { if (fail) throw new Error("probe failed"); return { repo: true, indexIgnored: true, cacheIgnored: true }; }, home, env: {} });
	await assert.rejects(flaky(root, INDEX), /probe failed/);
	fail = false;
	assert.equal((await flaky(root, INDEX)).indexIgnored, true, "the failure was not cached");
});

test("a vault without a .git folder (absent, or a linked worktree's pointer file) is probed every time", async t => {
	const { root, home } = await sandbox(t);
	const counter = counting();
	const probe = cachedGitProbe({ probe: counter.probe, home, env: {} });
	await fs.rm(join(root, ".git"), { recursive: true });
	await fs.writeFile(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/vault\n");
	await probe(root, INDEX); await probe(root, INDEX);
	assert.equal(counter.calls(), 2);
	await fs.rm(join(root, ".git"));
	await probe(root, INDEX); await probe(root, INDEX);
	assert.equal(counter.calls(), 4);
});

test("watched inputs cover the index, every ignore file on the index path, the private cache folder and user configuration", () => {
	const inputs = gitProbeInputs("/vault", "a/b/index.json", "/synthetic-home", {});
	for (const path of ["/vault/.git/index", "/vault/.gitignore", "/vault/a/.gitignore", "/vault/a/b/.gitignore", "/vault/.cmds-zotero/.gitignore", "/vault/.git/info/exclude", "/vault/.git/config", "/synthetic-home/.gitconfig", "/synthetic-home/.config/git/config", "/synthetic-home/.config/git/ignore"]) assert.ok(inputs.includes(path), path);
	assert.ok(gitProbeInputs("/vault", "index.json", "/synthetic-home", { XDG_CONFIG_HOME: "/xdg" }).includes("/xdg/git/ignore"));
});

test("against real git the cached probe follows a change to the index", async t => {
	const { root, home } = await sandbox(t);
	await fs.rm(join(root, ".git"), { recursive: true });
	await execute("git", ["init", "--quiet", root]);
	await fs.writeFile(join(root, INDEX), "{}");
	await execute("git", ["-C", root, "add", INDEX]);
	const probe = cachedGitProbe({ home, env: {} });
	const first = await probe(root, INDEX);
	assert.equal(first.repo, true);
	assert.equal(first.indexTracked, true);
	assert.deepEqual(await probe(root, INDEX), first, "the warm answer is the probe's answer");
	await execute("git", ["-C", root, "rm", "--cached", "--quiet", INDEX]);
	assert.equal((await probe(root, INDEX)).indexTracked, false, "untracking rewrites .git/index, which invalidates the cached answer");
});
