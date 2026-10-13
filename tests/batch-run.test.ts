import test from "node:test";
import assert from "node:assert/strict";
import { batchProgressText, runBatch } from "../src/batch/batch-run";

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test("preparations run ahead up to the concurrency cap while writes run one at a time in item order", async () => {
	const items = Array.from({ length: 25 }, (_, i) => i);
	let preparing = 0;
	let maxPreparing = 0;
	let writing = 0;
	const writes: number[] = [];
	const run = await runBatch(items, {
		concurrency: 3,
		prepare: async item => {
			preparing++;
			maxPreparing = Math.max(maxPreparing, preparing);
			for (let i = 0; i < (item % 4) + 1; i++) await tick();
			preparing--;
			return item * 10;
		},
		apply: async (item, prepared) => {
			assert.equal(writing, 0, "never two writes at once");
			writing++;
			await tick();
			assert.deepEqual(prepared, { ok: true, value: item * 10 });
			writes.push(item);
			writing--;
			return `done ${item}`;
		},
		cancelled: () => false,
	});
	assert.equal(maxPreparing, 3, "the cap is reached and never exceeded");
	assert.deepEqual(writes, items);
	assert.deepEqual(run.results, items.map(item => `done ${item}`));
	assert.deepEqual(run.notRun, []);
	assert.equal(run.cancelled, false);
});

test("a cancel stops before the next write, finishes the current one, and reports the rest as not run", async () => {
	const items = ["a", "b", "c", "d", "e", "f"];
	let cancel = false;
	let preparing = 0;
	const prepared: string[] = [];
	const written: string[] = [];
	const current: string[] = [];
	const run = await runBatch(items, {
		concurrency: 2,
		prepare: async item => { preparing++; await tick(); await tick(); prepared.push(item); preparing--; return item; },
		apply: async item => {
			if (item === "c") cancel = true; // Cancel pressed while "c" is being written.
			await tick();
			written.push(item);
		},
		cancelled: () => cancel,
		onItem: item => { current.push(item); },
	});
	assert.deepEqual(written, ["a", "b", "c"], "the write in progress completes; nothing after it starts");
	assert.deepEqual(run.notRun, ["d", "e", "f"]);
	assert.equal(run.cancelled, true);
	assert.deepEqual(current, ["a", "b", "c"]);
	assert.equal(preparing, 0, "preparations in flight are awaited before the batch returns");
	assert.ok(!prepared.includes("e") && !prepared.includes("f"), "no preparation starts after the cancel");
});

test("a cancel while waiting for an item's preparation stops before that item's write", async () => {
	let cancel = false;
	const written: number[] = [];
	const run = await runBatch([1, 2, 3], {
		concurrency: 1,
		prepare: async item => { if (item === 2) { cancel = true; } await tick(); return item; },
		apply: async item => { written.push(item); },
		cancelled: () => cancel,
	});
	assert.deepEqual(written, [1]);
	assert.deepEqual(run.notRun, [2, 3]);
	assert.equal(run.cancelled, true);
});

test("a failed preparation reaches apply as a settled failure; a throwing apply ends the batch after in-flight work settles", async () => {
	const outcomes: unknown[] = [];
	await runBatch([1, 2], {
		concurrency: 2,
		prepare: item => item === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(item),
		apply: async (_item, outcome) => { outcomes.push(outcome.ok ? outcome.value : (outcome.error as Error).message); },
		cancelled: () => false,
	});
	assert.deepEqual(outcomes, ["offline", 2]);
	let settled = 0;
	await assert.rejects(runBatch([1, 2, 3], {
		concurrency: 3,
		prepare: async item => { await tick(); await tick(); settled++; return item; },
		apply: async () => { throw new Error("write failed"); },
		cancelled: () => false,
	}), /write failed/);
	assert.equal(settled, 3, "every started preparation settled before the error surfaced");
	const syncThrow = await runBatch([1], { concurrency: 1, prepare: () => { throw new Error("sync"); }, apply: async (_item, outcome) => outcome.ok, cancelled: () => false });
	assert.deepEqual(syncThrow.results, [false]);
});

test("the concurrency must be 1-8 and an empty batch does nothing", async () => {
	for (const concurrency of [0, 9, 1.5]) await assert.rejects(runBatch([1], { concurrency, prepare: async item => item, apply: async () => undefined, cancelled: () => false }), /between 1 and 8/);
	const run = await runBatch([], { concurrency: 2, prepare: async () => { throw new Error("never"); }, apply: async () => { throw new Error("never"); }, cancelled: () => true });
	assert.deepEqual(run, { results: [], notRun: [], cancelled: false });
});

test("progress text counts results and leaves out zero counts", () => {
	assert.equal(batchProgressText("Updating literature notes", 0, 40), "Updating literature notes: 0 of 40");
	assert.equal(batchProgressText("Updating literature notes", 12, 40, [["updated", 10], ["partial", 0], ["skipped", 2]]), "Updating literature notes: 12 of 40 · 10 updated · 2 skipped");
});
