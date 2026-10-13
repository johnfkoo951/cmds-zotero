import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { BbtService } from "../src/bbt";
import { IndexService } from "../src/index-service";
import { entryHash, validateAndSealIndexInChunks, validateIndex, verifyIndex } from "../src/identity";
import { normalizeEntry } from "../src/api/normalize";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

// identity.ts reaches createHash through the shared crypto module object, so a wrapper on it sees every SHA-256 pass.
const crypto = createRequire(__filename)("node:crypto") as { createHash: (...args: unknown[]) => unknown };
async function hashPasses(run: () => Promise<unknown> | unknown): Promise<number> {
	const original = crypto.createHash;
	let passes = 0;
	crypto.createHash = (...args: unknown[]) => { passes++; return original(...args); };
	try { await run(); } finally { crypto.createHash = original; }
	return passes;
}

/** Synthetic entries only (AGENTS.md). */
function entry(i: number): ZoteroIndexEntry {
	const itemKey = `ITEM${String(i).padStart(4, "0")}`;
	const value = normalizeEntry({ libraryID: 1, citationKey: `synthetic${i}`, itemKey, uri: `http://zotero.org/users/local/Example/items/${itemKey}`, itemType: "journalArticle", title: `Synthetic ${i}`, date: "2020", creators: [{ firstName: "Ann", lastName: "Example" }], tags: [], attachments: [], notes: [] });
	value.contentHash = entryHash(value);
	return value;
}
function index(count: number, generatedAt = "2026-10-01T00:00:00.000Z"): ZoteroIndex {
	const entries = Array.from({ length: count }, (_, i) => entry(i));
	return { schemaVersion: 2, generatedAt, source: "better-bibtex", count, entries, capabilities: { zotero: "10", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
}
/** A parsed copy, as bytes read from disk become: fresh objects, never sealed. */
const parsed = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
const noPause = (): Promise<void> => Promise.resolve();

test("chunked validation gives validateIndex's verdict for valid, damaged and malformed snapshots", async () => {
	const base = index(1234);
	const variants: [string, unknown][] = [["valid", base], ["empty", index(0)], ["one", index(1)], ["exactly one chunk", index(500)], ["one past a chunk", index(501)]];
	for (const at of [0, 499, 500, 501, 1233]) {
		const damaged = parsed(base) as ZoteroIndex;
		damaged.entries[at].title = "Changed without a new hash";
		variants.push([`damaged entry ${at}`, damaged]);
	}
	const duplicate = parsed(base) as ZoteroIndex;
	duplicate.entries[700] = duplicate.entries[3];
	variants.push(["duplicate id", duplicate]);
	variants.push(["count mismatch", { ...(parsed(base) as ZoteroIndex), count: 1233 }]);
	variants.push(["old schema", { ...(parsed(base) as ZoteroIndex), schemaVersion: 1 }]);
	variants.push(["bad timestamp", { ...(parsed(base) as ZoteroIndex), generatedAt: "yesterday" }]);
	variants.push(["bad capability", { ...(parsed(base) as ZoteroIndex), capabilities: { ...base.capabilities, bibliography: "yes" } }]);
	variants.push(["bad diagnostic", { ...(parsed(base) as ZoteroIndex), diagnostics: [{ code: "x", message: "y", severity: "fatal" }] }]);
	variants.push(["entries not an array", { ...(parsed(base) as ZoteroIndex), entries: {} }]);
	for (const value of [null, [], "index", 7]) variants.push([`not an index: ${JSON.stringify(value)}`, value]);
	for (const [name, value] of variants) {
		const expected = validateIndex(parsed(value));
		assert.equal(await validateAndSealIndexInChunks(parsed(value), noPause, 500), expected, name);
	}
	await assert.rejects(validateAndSealIndexInChunks(parsed(base), noPause, 0), /positive integer/);
});

test("chunked validation yields between chunks, hashes each entry once, and seals only a snapshot that passed", async () => {
	let pauses = 0;
	const pause = async (): Promise<void> => { pauses++; await new Promise(resolve => setImmediate(resolve)); };
	const good = parsed(index(1234)) as ZoteroIndex;
	assert.equal(await hashPasses(() => validateAndSealIndexInChunks(good, pause, 500)), 1234, "one SHA-256 pass per entry");
	assert.equal(pauses, 2, "1,234 entries in chunks of 500 yield twice");
	assert.equal(await hashPasses(() => verifyIndex(good)), 0, "a snapshot that passed is sealed");
	pauses = 0;
	const bad = parsed(index(1234)) as ZoteroIndex;
	bad.diagnostics = [{ code: "x", message: "y", severity: "fatal" as "info" }];
	assert.equal(await validateAndSealIndexInChunks(bad, pause, 500), false);
	assert.equal(await hashPasses(() => verifyIndex({ ...bad, diagnostics: [] })), 1234, "entries of a snapshot that failed are not sealed");
	pauses = 0;
	const early = parsed(index(1234)) as ZoteroIndex;
	early.entries[501].title = "Changed";
	assert.equal(await validateAndSealIndexInChunks(early, pause, 500), false);
	assert.equal(pauses, 1, "validation stops at the first damaged entry");
});

/** Storage whose fingerprint follows the stored text, as VaultIndexStorage's size:mtime does. */
function storage(initial: ZoteroIndex | null) {
	const state = { text: initial ? JSON.stringify(initial) : null as string | null, version: 0, reads: 0 };
	return {
		state,
		replace(next: ZoteroIndex) { state.text = JSON.stringify(next); state.version++; },
		read: async () => { state.reads++; return state.text; },
		fingerprint: async () => `v${state.version}`,
		writeValidated: async (content: string) => { state.text = content; state.version++; },
	};
}

/** A pause gate: validation chunks wait until `open()`. */
function gate() {
	let release!: () => void;
	let opened = new Promise<void>(resolve => { release = resolve; });
	let waiting = 0;
	return {
		pause: async () => { waiting++; await opened; waiting--; },
		open: () => { release(); },
		close: () => { opened = new Promise<void>(resolve => { release = resolve; }); },
		get waiting() { return waiting; },
	};
}

test("concurrent readers share one load; readers never see a snapshot before it passed", async () => {
	const store = storage(index(1200));
	const chunks = gate();
	const service = new IndexService({} as BbtService, store, () => 60, undefined, { pause: chunks.pause, chunkSize: 500 });
	const readers = [service.peek(), service.peek(), service.peek()];
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(store.state.reads, 1, "one read for every concurrent reader");
	assert.equal(chunks.waiting, 1, "one validation in progress");
	chunks.open();
	const results = await Promise.all(readers);
	assert.ok(results[0] && results.every(result => result === results[0]), "every reader gets the same validated snapshot");
	assert.equal(results[0]?.count, 1200);
});

test("the previous snapshot stays published while a changed file is validated, and a collected snapshot is never overwritten by an older load", async () => {
	const first = index(600, "2026-10-01T00:00:00.000Z");
	const store = storage(first);
	const chunks = gate();
	chunks.open();
	let release!: (value: ZoteroIndex) => void;
	const collected = index(3, new Date().toISOString());
	const bbt = { collect: () => new Promise<ZoteroIndex>(resolve => { release = resolve; }) } as unknown as BbtService;
	const service = new IndexService(bbt, store, () => 60, undefined, { pause: chunks.pause, chunkSize: 500 });
	const loaded = await service.peek();
	assert.equal(loaded?.generatedAt, first.generatedAt);
	// A forced refresh starts collecting; meanwhile the file changes on disk and a reader starts loading it.
	const refresh = service.refresh({ force: true });
	await new Promise(resolve => setImmediate(resolve));
	chunks.close();
	store.replace(index(700, "2026-10-02T00:00:00.000Z"));
	const reader = service.peek();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(chunks.waiting, 1, "the changed file is being validated");
	// The collection lands first and is written; the older load then finishes.
	release(collected);
	const outcome = await refresh;
	assert.equal(outcome.index, collected);
	chunks.open();
	const seen = await reader;
	assert.equal(seen, collected, "the reader ends with the collected snapshot, not the file it started loading");
	assert.equal(await service.peek(), collected);
});
