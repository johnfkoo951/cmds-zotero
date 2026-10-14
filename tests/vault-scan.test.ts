// PERF-07: the ordered, bounded scan and the per-scan boundary walk shared by the live and offline vault readers.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYMLINK_REFUSAL, assertSegmentsInside, memoizedLstat, scanInOrder, type Settled } from "../src/vault-scan";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("scanInOrder visits outcomes in source order even when later work settles first, never exceeding the concurrency", async () => {
	const items = Array.from({ length: 20 }, (_, index) => index);
	let active = 0;
	let peak = 0;
	const visited: number[] = [];
	await scanInOrder(items, 4, async item => {
		active++; peak = Math.max(peak, active);
		await pause(item % 2 ? 1 : 8 - (item % 8)); // later items often finish before earlier ones
		active--;
		return item * 10;
	}, (item, outcome) => {
		assert.deepEqual(outcome, { ok: true, value: item * 10 });
		visited.push(item);
		return true;
	});
	assert.deepEqual(visited, items);
	assert.ok(peak <= 4 && peak > 1, `peak ${peak}`);
});

test("scanInOrder hands null for items without work, settles throws and rejections in order, and accepts async sources", async () => {
	async function* source(): AsyncGenerator<string> { yield "a"; yield "skip"; yield "reject"; yield "throw"; yield "b"; }
	const seen: [string, Settled<string> | null][] = [];
	await scanInOrder(source(), 2, item => {
		if (item === "skip") return null;
		if (item === "throw") throw new Error("sync");
		return item === "reject" ? Promise.reject(new Error("async")) : Promise.resolve(item.toUpperCase());
	}, (item, outcome) => { seen.push([item, outcome]); return true; });
	assert.deepEqual(seen.map(([item]) => item), ["a", "skip", "reject", "throw", "b"]);
	assert.deepEqual(seen[0][1], { ok: true, value: "A" });
	assert.equal(seen[1][1], null);
	assert.match(String((seen[2][1] as { error: unknown }).error), /async/);
	assert.match(String((seen[3][1] as { error: unknown }).error), /sync/);
	assert.deepEqual(seen[4][1], { ok: true, value: "B" });
});

test("scanInOrder stops when visit says so: nothing new starts, work in flight settles first, and the source is closed", async () => {
	const started: number[] = [];
	let settled = 0;
	let closed = false;
	async function* source(): AsyncGenerator<number> { try { for (let i = 0; i < 100; i++) yield i; } finally { closed = true; } }
	await scanInOrder(source(), 3, async item => { started.push(item); await pause(5); settled++; return item; }, item => item < 4);
	assert.ok(closed, "the source generator was closed");
	assert.equal(settled, started.length, "every started read settled before the scan resolved");
	assert.ok(Math.max(...started) <= 4 + 3, `read-ahead is bounded by the concurrency (started up to ${Math.max(...started)})`);
	const order: string[] = [];
	await assert.rejects(scanInOrder([1, 2, 3], 2, async item => { await pause(5); order.push(`settled ${item}`); return item; }, item => { if (item === 2) throw new Error("visit failed"); return true; }), /visit failed/);
	assert.ok(order.includes("settled 3"), "a throwing visit still waits for the read already in flight");
	await assert.rejects(scanInOrder([1], 0, async item => item, () => true), /positive integer/);
});

test("memoizedLstat asks each path once while it answers, and asks a failed path again", async () => {
	const calls: string[] = [];
	const lstat = memoizedLstat(async path => { calls.push(path); if (path === "/missing") throw Object.assign(new Error("absent"), { code: "ENOENT" }); return { isSymbolicLink: () => false } as Stats; });
	await lstat("/a"); await lstat("/a");
	await assert.rejects(lstat("/missing"), /absent/);
	await assert.rejects(lstat("/missing"), /absent/);
	assert.deepEqual(calls, ["/a", "/missing", "/missing"], "a folder missing at its first check may exist a moment later (0.6 review of PERF-07)");
});

test("memoizedLstat.changedSince names the cached folders that were replaced, removed or turned into a symbolic link", async t => {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-changed-")));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	for (const name of ["kept", "swapped", "removed", "renamed"]) await fs.mkdir(join(root, name));
	await fs.mkdir(join(root, "elsewhere"));
	const lstat = memoizedLstat();
	for (const name of ["kept", "swapped", "removed", "renamed"]) await lstat(join(root, name));
	await assert.rejects(lstat(join(root, "never")));
	assert.deepEqual(await lstat.changedSince(), []);
	await fs.rm(join(root, "swapped"), { recursive: true });
	await fs.symlink(join(root, "elsewhere"), join(root, "swapped"));
	await fs.rm(join(root, "removed"), { recursive: true });
	await fs.rename(join(root, "renamed"), join(root, "renamed-away"));
	await fs.mkdir(join(root, "renamed"));
	assert.deepEqual(await lstat.changedSince(), [join(root, "removed"), join(root, "renamed"), join(root, "swapped")]);
});

test("a folder missing at its first check still gets each file's own symlink check once it appears", async t => {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-late-folder-")));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-outside-")));
	t.after(() => fs.rm(outside, { recursive: true, force: true }));
	await fs.writeFile(join(outside, "n.md"), "outside");
	const shared = memoizedLstat();
	await assertSegmentsInside(root, "G/n.md", shared);
	await fs.mkdir(join(root, "G"));
	await fs.symlink(join(outside, "n.md"), join(root, "G", "n.md"));
	await fs.symlink(outside, join(root, "H"));
	await assert.rejects(assertSegmentsInside(root, "G/n.md", shared), new RegExp(SYMLINK_REFUSAL), "the file's own segment is checked");
	await assertSegmentsInside(root, "H/n.md", shared).then(() => assert.fail("H is a symbolic link"), error => assert.match(String(error), new RegExp(SYMLINK_REFUSAL)));
});

test("assertSegmentsInside refuses a symlinked folder or file, stops at an absent segment, and propagates other errors", async t => {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-boundary-")));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(join(root, "real"));
	await fs.writeFile(join(root, "real", "a.md"), "a");
	await fs.writeFile(join(root, "real", "b.md"), "b");
	await fs.symlink(join(root, "real"), join(root, "linked"));
	await fs.symlink(join(root, "real", "a.md"), join(root, "real", "link.md"));
	await assertSegmentsInside(root, "real/a.md");
	await assertSegmentsInside(root, "real/new/deeper/file.md");
	await assert.rejects(assertSegmentsInside(root, "linked/a.md"), new RegExp(SYMLINK_REFUSAL));
	await assert.rejects(assertSegmentsInside(root, "real/link.md"), new RegExp(SYMLINK_REFUSAL));
	await assert.rejects(assertSegmentsInside(root, "real/a.md/below.md"), (error: NodeJS.ErrnoException) => error.code === "ENOTDIR");
	// One scan shares the folder answers but still checks every file's own segment.
	const asked: string[] = [];
	const shared = memoizedLstat(path => { asked.push(path); return fs.lstat(path); });
	await assertSegmentsInside(root, "real/a.md", shared);
	await assertSegmentsInside(root, "real/b.md", shared);
	await assert.rejects(assertSegmentsInside(root, "real/link.md", shared), new RegExp(SYMLINK_REFUSAL));
	assert.deepEqual(asked, [join(root, "real")], "the parent folder was asked once for three files");
});
