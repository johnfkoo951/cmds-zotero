import test from "node:test";
import assert from "node:assert/strict";
import { STARTUP_COLLECT_DELAY_MS, WARM_BACKOFF_MS, WarmState, failedRecently, unreachableRecently } from "../src/plugin/warm-state";

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

test("0.6 OPT-13: unreachableRecently counts only 'Zotero is not answering' failures inside the window", () => {
	const now = 5_000_000;
	const at = (ageMs: number): Date => new Date(now - ageMs);
	for (const reason of ["connection-refused", "timeout", "http-404"]) {
		assert.equal(unreachableRecently({ ok: false, at: at(10), reason }, now), true, reason);
		assert.equal(unreachableRecently({ ok: false, at: at(WARM_BACKOFF_MS), reason }, now), false, `${reason} at the window's end`);
	}
	for (const reason of ["rpc", "invalid-response", "http-other", "aborted", undefined]) {
		assert.equal(unreachableRecently({ ok: false, at: at(10), ...(reason ? { reason } : {}) }, now), false, `${reason ?? "no reason"} says nothing about the next request`);
	}
	assert.equal(unreachableRecently({ ok: true, at: at(10), reason: "connection-refused" }, now), false);
	assert.equal(unreachableRecently(null, now), false);
	assert.equal(unreachableRecently({ ok: false, at: new Date(now + 1000), reason: "timeout" }, now), false, "a clock that went backwards does not suppress probes");
	assert.equal(unreachableRecently({ ok: false, at: at(5000), reason: "timeout" }, now, 1000), false);
});

test("IndexController.refreshIndex and loadIndexForRead start warm backoff and mark the generation announced on non-cancelled errors", async () => {
	const { build } = await import("esbuild");
	const bundled = await build({
		entryPoints: ["src/plugin/index-controller.ts"],
		bundle: true, platform: "node", format: "esm", write: false,
		plugins: [{
			name: "mock-obsidian",
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
				b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
					contents: `export const notices = []; export class Notice { constructor(msg) { notices.push(msg); } hide() {} } export class TAbstractFile {} export class TFile extends TAbstractFile {} export class TFolder extends TAbstractFile {}`,
				}));
			},
		}],
	});
	const mod = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
	const { IndexController } = mod;

	let failWith: Error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
	let ensureCalls = 0;
	const makePlugin = () => ({
		active: true,
		lastIndex: null as { generatedAt: string } | null,
		settings: { bbtEndpoint: "http://127.0.0.1:23119/better-bibtex/json-rpc" },
		index: { isStale: () => true, ageMinutes: () => null },
		cachedIndexAgeMinutes: () => null,
		publish: async () => {},
		run: async (fn: () => Promise<void>) => fn(),
		service: {
			peekIndex: async () => null,
			ensureIndex: async () => { ensureCalls++; throw failWith; },
		},
	});

	const plugin1 = makePlugin();
	const controller1 = new IndexController(plugin1);
	await assert.rejects(controller1.loadIndexForRead(), /not reachable/);
	assert.equal(controller1.warmBackoffActive(), true, "loadIndexForRead failure starts warm backoff");
	const callsAfterLoad = ensureCalls;
	await controller1.warmIndex(false);
	assert.equal(ensureCalls, callsAfterLoad, "background warmIndex backs off after loadIndexForRead failure");

	const plugin2 = makePlugin();
	const controller2 = new IndexController(plugin2);
	await assert.rejects(controller2.refreshIndex(), /not reachable/);
	assert.equal(controller2.warmBackoffActive(), true, "refreshIndex failure starts warm backoff");

	const plugin3 = makePlugin();
	const controller3 = new IndexController(plugin3);
	failWith = new Error("BBT collection cancelled");
	await assert.rejects(controller3.refreshIndex(), /cancelled/);
	assert.equal(controller3.warmBackoffActive(), false, "cancelled refresh does not start warm backoff");
});
