import test from "node:test";
import assert from "node:assert/strict";
import { STARTUP_COLLECT_DELAY_MS, WARM_BACKOFF_MS, WarmState, failedRecently } from "../src/plugin/warm-state";

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
	let current = start;
	return { now: () => current, advance: ms => { current += ms; } };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

test("background warm-ups join any flight; a forced one joins only a forced flight and otherwise runs after", async () => {
	const state = new WarmState(clock().now);
	const calls: boolean[] = [];
	const gate = deferred();
	const warm = async (force: boolean): Promise<void> => { calls.push(force); await gate.promise; };
	const first = state.run(false, warm);
	assert.equal(state.run(false, warm), first, "a second background warm-up joins");
	assert.equal(state.forcedActive(), false);
	const forced = state.run(true, warm);
	assert.notEqual(forced, first);
	assert.equal(state.forcedActive(), true);
	assert.equal(state.run(true, warm), forced, "a forced warm-up joins a forced flight");
	assert.equal(state.run(false, warm), forced, "a background warm-up joins the forced flight");
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(calls, [false], "the forced warm-up waits for the background one");
	gate.resolve();
	await forced;
	assert.deepEqual(calls, [false, true]);
	assert.equal(state.forcedActive(), false, "settled flights are released");
});

test("after a failure background warm-ups back off for the window; forced ones never do", async () => {
	const time = clock();
	const state = new WarmState(time.now);
	let runs = 0;
	const warm = async (): Promise<void> => { runs++; };
	state.failed();
	assert.equal(state.backoffActive(), true);
	await state.run(false, warm);
	assert.equal(runs, 0, "nothing starts during the backoff");
	await state.run(true, warm);
	assert.equal(runs, 1);
	time.advance(WARM_BACKOFF_MS - 1);
	assert.equal(state.backoffActive(), true);
	time.advance(1);
	assert.equal(state.backoffActive(), false);
	await state.run(false, warm);
	assert.equal(runs, 2);
});

test("a generation is announced once; a forced warm-up always announces", () => {
	const state = new WarmState(clock().now);
	assert.equal(state.announce("g1"), true);
	assert.equal(state.announce("g1"), false);
	assert.equal(state.announce("g1", true), true);
	assert.equal(state.announce("none"), true);
	assert.equal(state.announce("g1"), true, "a different generation was announced in between");
});

test("the startup deferral ends after its delay, on endDeferral or on reset, and reset clears every state", () => {
	const time = clock();
	const state = new WarmState(time.now);
	assert.equal(state.collectionDeferred(), false);
	state.deferCollection();
	assert.equal(state.collectionDeferred(), true);
	time.advance(STARTUP_COLLECT_DELAY_MS - 1);
	assert.equal(state.collectionDeferred(), true);
	time.advance(1);
	assert.equal(state.collectionDeferred(), false);
	state.deferCollection(10_000);
	state.endDeferral();
	assert.equal(state.collectionDeferred(), false);
	state.deferCollection();
	state.failed();
	state.announce("g1");
	void state.run(true, () => new Promise(() => undefined));
	state.reset();
	assert.equal(state.collectionDeferred(), false);
	assert.equal(state.backoffActive(), false);
	assert.equal(state.forcedActive(), false);
	assert.equal(state.announce("g1"), true);
});

test("failedRecently: only a failure inside the window counts", () => {
	const now = 5_000_000;
	assert.equal(failedRecently(null, now), false);
	assert.equal(failedRecently({ ok: true, at: new Date(now - 10) }, now), false);
	assert.equal(failedRecently({ ok: false, at: new Date(now - 10) }, now), true);
	assert.equal(failedRecently({ ok: false, at: new Date(now - WARM_BACKOFF_MS) }, now), false);
	assert.equal(failedRecently({ ok: false, at: new Date(now + 1000) }, now), false, "a clock that went backwards does not suppress probes");
	assert.equal(failedRecently({ ok: false, at: new Date(now - 5000) }, now, 1000), false);
});
