// 0.5 R12: offline bibliography sidecar — validation, hash/version gating, eviction, debounced write-through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BIBLIOGRAPHY_SIDECAR, BibliographyStore, parseBibliographySidecar, serializeBibliographySidecar, type BibliographyStorage } from "../src/bibliography-store";

const entry = (id: string, contentHash: string) => ({ id, contentHash });
const record = (text: string, extra: Record<string, unknown> = {}) => ({ contentHash: "h1", bbtVersion: "7.0.1", text, renderedAt: "2026-09-14T10:00:00.000Z", ...extra });

function memoryStorage(initial: string | null = null): BibliographyStorage & { writes: string[]; failWrites: boolean; failReads: boolean } {
	const storage = {
		writes: [] as string[], failWrites: false, failReads: false, text: initial,
		read: (): Promise<string | null> => storage.failReads ? Promise.reject(new Error("EACCES")) : Promise.resolve(storage.text),
		write: (text: string): Promise<void> => { if (storage.failWrites) return Promise.reject(new Error("ENOSPC")); storage.writes.push(text); storage.text = text; return Promise.resolve(); },
	};
	return storage;
}

test("sidecar path is inside the plugin's private directory", () => {
	assert.equal(BIBLIOGRAPHY_SIDECAR, ".cmds-zotero/bibliography.json");
});

test("parse: malformed envelopes yield an empty sidecar and malformed records are dropped one by one", () => {
	assert.deepEqual(parseBibliographySidecar(null), { version: 1, styles: {} });
	assert.deepEqual(parseBibliographySidecar("not json"), { version: 1, styles: {} });
	assert.deepEqual(parseBibliographySidecar(JSON.stringify({ version: 2, styles: {} })), { version: 1, styles: {} });
	assert.deepEqual(parseBibliographySidecar(JSON.stringify({ version: 1, styles: [] })), { version: 1, styles: {} });
	const mixed = JSON.stringify({ version: 1, styles: {
		apa: {
			"1:GOOD": record("Doe, J. (2020). Title."),
			"1:NOTEXT": record(""),
			"1:HUGE": record("x".repeat(64 * 1024 + 1)),
			"1:BADDATE": record("ok", { renderedAt: "yesterday" }),
			"1:BADHASH": record("ok", { contentHash: "has space" }),
			"1:NUMTEXT": record("ok", { text: 42 }),
			"1:NOVERSION": record("ok", { bbtVersion: "" }),
		},
		"": { "1:GOOD": record("dropped: empty style") },
		chicago: "not a record",
	} });
	const parsed = parseBibliographySidecar(mixed);
	assert.deepEqual(Object.keys(parsed.styles), ["apa"]);
	assert.deepEqual(Object.keys(parsed.styles.apa).sort(), ["1:GOOD", "1:NOVERSION"]);
	assert.equal(parsed.styles.apa["1:GOOD"].text, "Doe, J. (2020). Title.");
	assert.equal(serializeBibliographySidecar(parsed).endsWith("\n"), true);
	assert.deepEqual(parseBibliographySidecar(serializeBibliographySidecar(parsed)), parsed);
});

test("get: a hit needs the entry's current content hash and, when the caller knows it, the same BBT version", async () => {
	const storage = memoryStorage(JSON.stringify({ version: 1, styles: { apa: { "1:A": record("A text"), "1:B": record("B text", { bbtVersion: "" }) } } }));
	const store = new BibliographyStore(storage);
	assert.equal(store.get("apa", entry("1:A", "h1")), null, "nothing answers before load()");
	await store.load();
	assert.equal(store.loaded, true);
	assert.equal(store.size, 2);
	assert.equal(store.get("apa", entry("1:A", "h1"))?.text, "A text", "unknown caller version: hash alone decides");
	assert.equal(store.get("apa", entry("1:A", "h1"), "7.0.1")?.text, "A text");
	assert.equal(store.get("apa", entry("1:A", "h2")), null, "content hash mismatch misses");
	assert.equal(store.get("apa", entry("1:A", "h1"), "7.1.0"), null, "BBT version mismatch misses");
	assert.equal(store.get("chicago", entry("1:A", "h1")), null, "another style misses");
});

test("get: a record rendered by an unknown BBT version misses only when the caller knows the current version", async () => {
	const store = new BibliographyStore(memoryStorage(JSON.stringify({ version: 1, styles: { apa: { "1:B": record("B text", { bbtVersion: "" }) } } })));
	await store.load();
	assert.equal(store.get("apa", entry("1:B", "h1"))?.text, "B text");
	assert.equal(store.get("apa", entry("1:B", "h1"), "7.0.1"), null);
});

test("set writes through after a quiet period; flush writes at once; a failed write stays pending", async () => {
	const storage = memoryStorage();
	const store = new BibliographyStore(storage, { writeDelayMs: 5, now: () => new Date("2026-09-16T12:00:00.000Z") });
	assert.equal(store.set("apa", entry("1:A", "h1"), "A text", "7.0.1"), null, "nothing is stored before load()");
	await store.load();
	assert.equal(store.set("apa", entry("1:A", "h1"), "  ", "7.0.1"), null, "empty text is not stored");
	assert.equal(store.set("apa", entry("1:A", "h1"), "x".repeat(64 * 1024 + 1), "7.0.1"), null, "oversized text is not stored");
	const stored = store.set("apa", entry("1:A", "h1"), "  A text  ", "7.0.1");
	assert.deepEqual(stored, { contentHash: "h1", bbtVersion: "7.0.1", text: "A text", renderedAt: "2026-09-16T12:00:00.000Z" });
	store.set("apa", entry("1:B", "h2"), "B text", "7.0.1");
	assert.equal(storage.writes.length, 0, "the write is debounced");
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(storage.writes.length, 1, "one write covers both records");
	assert.deepEqual(Object.keys(parseBibliographySidecar(storage.writes[0]).styles.apa), ["1:A", "1:B"]);
	await store.flush();
	assert.equal(storage.writes.length, 1, "nothing dirty, nothing written");
	storage.failWrites = true;
	store.set("apa", entry("1:C", "h3"), "C text");
	await store.flush();
	assert.equal(storage.writes.length, 1);
	storage.failWrites = false;
	await store.flush();
	assert.equal(storage.writes.length, 2, "the failed write is retried on the next flush");
	assert.equal(parseBibliographySidecar(storage.writes[1]).styles.apa["1:C"].bbtVersion, "");
	store.dispose();
});

test("eviction drops the oldest renderings first once the size bound is exceeded", async () => {
	let clock = Date.parse("2026-09-10T00:00:00.000Z");
	const store = new BibliographyStore(memoryStorage(), { maxBytes: 900, writeDelayMs: 1, now: () => new Date(clock) });
	await store.load();
	for (const [id, text] of [["1:OLD", "o".repeat(200)], ["1:MID", "m".repeat(200)], ["1:NEW", "n".repeat(200)]] as const) {
		clock += 60_000;
		store.set("apa", entry(id, "h1"), text, "7.0.1");
	}
	assert.equal(store.get("apa", entry("1:OLD", "h1")), null, "oldest evicted");
	assert.equal(store.get("apa", entry("1:MID", "h1"))?.text.length, 200);
	assert.equal(store.get("apa", entry("1:NEW", "h1"))?.text.length, 200);
	assert.ok(store.estimatedBytes <= 900);
	assert.equal(store.size, 2);
	store.dispose();
});

test("a storage read fault starts an empty sidecar instead of failing the reader", async () => {
	const storage = memoryStorage("{}");
	storage.failReads = true;
	const store = new BibliographyStore(storage);
	assert.deepEqual(await store.load(), { version: 1, styles: {} });
	assert.equal(store.loaded, true);
});
