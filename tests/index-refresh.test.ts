import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createRequire } from "node:module";
import { BbtService } from "../src/bbt";
import { normalizeSettings } from "../src/settings-data";
import { IndexService } from "../src/index-service";
import { DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";
import { entryHash, sealEntry, validateAndSealIndex, validateEntry, validateEntryStructure, validateIndex, verifyEntry, verifyIndex } from "../src/identity";
import { normalizeAttachments, normalizeEntry, normalizeEntryUnhashed } from "../src/api/normalize";
import { indexDiagnostics } from "../src/diagnostics";

// identity.ts reaches createHash through the shared crypto module object, so a wrapper on it sees every SHA-256 pass.
const crypto = createRequire(__filename)("node:crypto") as { createHash: (...args: unknown[]) => unknown };
async function hashPasses(run: () => Promise<unknown>): Promise<number> {
	const original = crypto.createHash;
	let passes = 0;
	crypto.createHash = (...args: unknown[]) => { passes++; return original(...args); };
	try { await run(); } finally { crypto.createHash = original; }
	return passes;
}

const key = (prefix: string, i: number) => `${prefix}${String(i).padStart(7, "0")}`;
/** Synthetic BetterBibTeX JSON export rows (no real library data). */
function rawItem(i: number, citationKey = `Synthetic${i}`): Record<string, unknown> {
	const itemKey = key("A", i);
	return {
		libraryID: 1, citationKey, itemKey, uri: `http://zotero.org/users/local/Example/items/${itemKey}`, itemType: "journalArticle", title: `Synthetic item ${i}`, date: "2026-03-01",
		creators: [{ firstName: "Example", lastName: "Author" }], tags: [{ tag: "synthetic" }], abstractNote: "Synthetic abstract text.".repeat(4), extra: { nested: [3, 1, 2], b: 1, a: 2 },
		attachments: [{ select: `zotero://select/library/items/${key("B", i)}`, title: "Synthetic PDF", contentType: "application/pdf", filename: `${citationKey}.pdf` }], notes: [],
	};
}
function attachmentsOf(i: number): unknown[] {
	const attachment = key("B", i);
	return [{ open: `zotero://open-pdf/library/items/${attachment}`, path: `/synthetic/${attachment}.pdf`, annotations: [0, 1].map(n => ({ key: key(n ? "D" : "C", i), parentItem: attachment, annotationType: "highlight", annotationText: `Synthetic text ${i}.${n}`, annotationComment: "", annotationColor: "#ffd400", annotationPageLabel: String(n + 1), annotationPosition: { pageIndex: n }, version: 1, tags: [], dateModified: "2026-03-01T10:00:00Z" })) }];
}

interface MockOptions { renamed?: Map<number, string>; failAttachments?: Set<number>; attachmentsInFlight?: number; exportsInFlight?: number }
/** A local Better BibTeX JSON-RPC mock that records the largest number of concurrent calls per method. */
async function mockBbt(count: number, options: MockOptions = {}) {
	const citekey = (i: number) => options.renamed?.get(i) ?? `Synthetic${i}`;
	const byKey = () => new Map(Array.from({ length: count }, (_, i) => [citekey(i), i]));
	const inFlight = new Map<string, number>();
	const peak = new Map<string, number>();
	// A held method answers a round only once `expected` calls wait (so the peak proves the client keeps that many in
	// flight, however slow the machine) plus a 30 ms grace in which a call over the limit would raise the peak.
	const held = new Map<string, { waiting: (() => void)[]; timer?: NodeJS.Timeout }>();
	const hold = (method: string, expected: number | undefined, answer: () => void): void => {
		if (!expected) { answer(); return; }
		const slot = held.get(method) ?? { waiting: [] };
		held.set(method, slot);
		slot.waiting.push(answer);
		const release = () => { clearTimeout(slot.timer); slot.timer = undefined; for (const send of slot.waiting.splice(0)) send(); };
		if (slot.waiting.length > expected) release();
		else if (slot.waiting.length === expected) { clearTimeout(slot.timer); slot.timer = setTimeout(release, 30); }
		else slot.timer ??= setTimeout(release, 5000);
	};
	const batchSizes: number[] = [];
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", chunk => { body += String(chunk); });
		request.on("end", () => {
			const parsed = JSON.parse(body) as unknown;
			// 0.6 OPT-10: item.attachments arrive as JSON-RPC batch arrays; a batch is one request in flight.
			if (Array.isArray(parsed)) {
				const calls = parsed as { id: number; method: string; params: unknown[] }[];
				batchSizes.push(calls.length);
				const method = `${calls[0].method}[]`;
				inFlight.set(method, (inFlight.get(method) ?? 0) + 1);
				peak.set(method, Math.max(peak.get(method) ?? 0, inFlight.get(method) ?? 0));
				hold(method, options.attachmentsInFlight, () => {
					inFlight.set(method, (inFlight.get(method) ?? 0) - 1);
					response.end(JSON.stringify(calls.map(call => {
						const i = byKey().get(call.params[0] as string)!;
						return options.failAttachments?.has(i) ? { jsonrpc: "2.0", error: { code: -32603, message: "synthetic attachment failure" }, id: null } : { jsonrpc: "2.0", id: call.id, result: attachmentsOf(i) };
					})));
				});
				return;
			}
			const call = parsed as { method: string; params: unknown[] };
			inFlight.set(call.method, (inFlight.get(call.method) ?? 0) + 1);
			peak.set(call.method, Math.max(peak.get(call.method) ?? 0, inFlight.get(call.method) ?? 0));
			const send = (result: unknown, status = 200) => {
				inFlight.set(call.method, (inFlight.get(call.method) ?? 0) - 1);
				response.statusCode = status;
				response.end(status === 200 ? JSON.stringify({ jsonrpc: "2.0", id: 1, result }) : "unavailable");
			};
			if (call.method === "api.ready") send({ zotero: "8", betterbibtex: "9" });
			else if (call.method === "user.groups") send([{ id: 1, name: "Synthetic User", collections: [] }]);
			else if (call.method === "item.search" && (call.params[0] as unknown[][]).some(term => term[0] === "retracted")) send([]);
			else if (call.method === "item.search") send(Array.from({ length: count }, (_, i) => ({ citekey: citekey(i), library: "Synthetic User", id: rawItem(i).uri })));
			else if (call.method === "item.export") {
				const index = byKey();
				hold("item.export", options.exportsInFlight, () => send(JSON.stringify({ items: (call.params[0] as string[]).map(citationKey => rawItem(index.get(citationKey)!, citationKey)) })));
			} else if (call.method === "item.attachments") {
				const i = byKey().get(call.params[0] as string)!;
				options.failAttachments?.has(i) ? send(null, 500) : send(attachmentsOf(i));
			} else send(null, 500);
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Mock did not expose a port");
	return { endpoint: `http://127.0.0.1:${address.port}`, peak, batchSizes, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** What the unoptimised pipeline stored: normalize, hash, add attachments, hash again; the bytes must not change. */
function expectedEntries(count: number, previous: Map<string, ZoteroIndexEntry>, options: MockOptions = {}): ZoteroIndexEntry[] {
	return Array.from({ length: count }, (_, i) => {
		const entry = normalizeEntry(rawItem(i, options.renamed?.get(i) ?? `Synthetic${i}`), previous.get(`1:${key("A", i)}`));
		if (options.failAttachments?.has(i)) {
			const old = previous.get(entry.id);
			entry.attachments = old ? old.attachments : [];
			entry.attachmentPath = old ? old.attachmentPath : "";
			entry.attachmentStatus = "unavailable";
		} else {
			entry.attachments = normalizeAttachments(attachmentsOf(i), entry);
			entry.attachmentPath = entry.attachments[0].path ?? "";
		}
		entry.contentHash = entryHash(entry);
		return entry;
	}).sort((left, right) => left.id.localeCompare(right.id));
}
// 0.6: the additive libraries/collections/retracted fields follow the 0.5 fields; entries and their hashes are unchanged.
const expectedIndex = (entries: ZoteroIndexEntry[], actual: ZoteroIndex): ZoteroIndex => ({ schemaVersion: 2, generatedAt: actual.generatedAt, source: "better-bibtex", count: entries.length, entries, capabilities: { zotero: "8", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: indexDiagnostics(entries), complete: entries.every(entry => entry.attachmentStatus === "complete"), libraries: [{ libraryID: 1, name: "Synthetic User", kind: "user", items: entries.length, indexed: entries.length }], collections: [], retracted: [] });

test("a refresh hashes each entry once and stores the same bytes and hashes as before", async () => {
	const count = 60;
	const renamed = new Map<number, string>();
	const failAttachments = new Set<number>();
	const api = await mockBbt(count, { renamed, failAttachments });
	const bbt = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	let saved = "";
	let writes = 0;
	const storage = { read: async () => saved || null, writeValidated: async (content: string) => { saved = content; writes++; } };
	try {
		const service = new IndexService(bbt, storage, () => 60);
		assert.equal(await hashPasses(() => service.refresh({ force: true })), count, "first refresh: one SHA-256 pass per entry");
		const first = JSON.parse(saved) as ZoteroIndex;
		assert.ok(validateIndex(first), "the saved bytes pass full validation at the trust boundary");
		assert.ok(first.entries.every(entry => entry.contentHash === entryHash(entry)), "every stored hash equals a full re-hash");
		assert.equal(saved, JSON.stringify(expectedIndex(expectedEntries(count, new Map()), first), null, 2), "byte-identical to the unoptimised pipeline");

		// Later refresh: the previous snapshot is trusted without re-hashing, yet still carries history and old attachments.
		renamed.set(3, "Renamed3");
		failAttachments.add(5);
		const previous = new Map(first.entries.map(entry => [entry.id, entry]));
		assert.equal(await hashPasses(() => service.refresh({ force: true })), count, "later refresh: still one pass per entry");
		const second = JSON.parse(saved) as ZoteroIndex;
		assert.ok(validateIndex(second));
		const renamedEntry = second.entries.find(entry => entry.citekey === "Renamed3");
		assert.deepEqual(renamedEntry?.citekeyHistory, ["Synthetic3"], "citekey history comes from the trusted previous snapshot");
		const unavailable = second.entries.find(entry => entry.itemKey === key("A", 5));
		assert.equal(unavailable?.attachmentStatus, "unavailable");
		assert.equal(unavailable?.attachments.length, 1, "a failed attachments call keeps the previous attachments");
		assert.equal(second.complete, false);
		assert.equal(saved, JSON.stringify(expectedIndex(expectedEntries(count, previous, { renamed, failAttachments }), second), null, 2));

		// Cold load: bytes from storage are validated in full once, then a refresh trusts them.
		const cold = new IndexService(bbt, storage, () => 60);
		assert.equal(await hashPasses(() => cold.peek()), count, "a snapshot read from storage is fully re-hashed");
		assert.equal(await hashPasses(() => cold.refresh({ force: true })), count, "and is not re-hashed again as the previous index");
		assert.equal(writes, 3);
	} finally { bbt.dispose(); await api.close(); }
});

test("fresh single-item collection hashes once and stores the same entry as before", async () => {
	const api = await mockBbt(3);
	const bbt = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	try {
		let entry: ZoteroIndexEntry | undefined;
		const target = { citekey: "Synthetic1", libraryID: 1, itemKey: key("A", 1), libraryType: "user" as const };
		assert.equal(await hashPasses(async () => { entry = await bbt.collectEntry(target); }), 1);
		assert.ok(entry && validateEntry(entry) && verifyEntry(entry));
		assert.equal(JSON.stringify(entry), JSON.stringify(expectedEntries(3, new Map())[1]));
	} finally { bbt.dispose(); await api.close(); }
});

test("structure checks match the full check except for the hash, and sealing hashes after the last change", () => {
	const hashed = normalizeEntry(rawItem(1));
	assert.ok(validateEntryStructure(hashed) && validateEntry(hashed));
	const tampered = { ...hashed, title: "Changed without rehash" };
	assert.ok(validateEntryStructure(tampered) && !validateEntry(tampered), "only the hash comparison tells a tampered copy apart");
	const unhashed = normalizeEntryUnhashed(rawItem(1));
	assert.equal(unhashed.contentHash, "");
	assert.ok(validateEntryStructure(unhashed) && !validateEntry(unhashed));
	assert.equal(JSON.stringify({ ...unhashed, contentHash: hashed.contentHash }), JSON.stringify(hashed), "same fields in the same order");
	for (const broken of [{ ...hashed, itemKey: hashed.citekey }, { ...hashed, attachmentPath: "/synthetic/missing.pdf" }, { ...hashed, authors: [1] }, { ...hashed, attachmentStatus: "partial" }]) {
		assert.equal(validateEntryStructure(broken), false);
		assert.equal(validateEntry(broken), false);
	}

	const built = normalizeEntryUnhashed(rawItem(2));
	built.attachments = normalizeAttachments(attachmentsOf(2), built);
	built.attachmentPath = built.attachments[0].path ?? "";
	assert.equal(sealEntry(built), true);
	assert.equal(built.contentHash, entryHash(built));
	assert.ok(validateEntry(built));
	for (const badAttachment of [{ ...built.attachments[0], contentType: 123 }, { ...built.attachments[0], filename: true }, { ...built.attachments[0], annotations: [{ ...built.attachments[0].annotations[0], sortIndex: 42 }] }]) {
		const invalidEntry = { ...built, attachments: [badAttachment as never] };
		assert.equal(validateEntryStructure(invalidEntry), false);
		assert.equal(validateEntry(invalidEntry), false);
	}

	const invalid = normalizeEntryUnhashed(rawItem(3));
	invalid.attachmentPath = "/synthetic/missing.pdf";
	assert.equal(sealEntry(invalid), false, "an invalid structure is never sealed");
	assert.equal(invalid.contentHash, "", "and its hash is left untouched");
	assert.equal(verifyEntry(invalid), false);
});

test("only objects this process sealed skip the hash; copies, parsed bytes and unsealed entries are validated in full", () => {
	const sealed = normalizeEntryUnhashed(rawItem(4));
	assert.ok(sealEntry(sealed));
	assert.ok(verifyEntry(sealed));
	assert.equal(verifyEntry({ ...sealed, title: "Changed without rehash" }), false, "a copy is not sealed");
	assert.equal(verifyEntry(JSON.parse(JSON.stringify({ ...sealed, title: "Changed" }))), false, "parsed bytes are not sealed");
	const unsealed = normalizeEntry(rawItem(5));
	assert.ok(verifyEntry(unsealed));
	unsealed.title = "Changed in place";
	assert.equal(verifyEntry(unsealed), false, "an entry nobody sealed is re-hashed");

	const entries = [sealed];
	const index: ZoteroIndex = { schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: 1, entries, capabilities: { zotero: "8", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
	assert.ok(verifyIndex(index) && validateIndex(index));
	assert.equal(verifyIndex({ ...index, entries: [sealed, sealed], count: 2 }), false, "index-level checks (unique IDs) always run");
	assert.equal(verifyIndex({ ...index, count: 2 }), false);
	assert.equal(verifyIndex({ ...index, diagnostics: [{ code: 1 }] }), false);

	const parsed = JSON.parse(JSON.stringify(index)) as ZoteroIndex;
	assert.equal(verifyEntry(parsed.entries[0]), true, "valid parsed entries pass by a full check");
	assert.ok(validateAndSealIndex(parsed));
	const tamperedBytes = JSON.parse(JSON.stringify(index)) as ZoteroIndex;
	tamperedBytes.entries[0].title = "Changed on disk";
	assert.equal(validateAndSealIndex(tamperedBytes), false, "bytes from disk are always re-hashed");
	assert.equal(verifyEntry(tamperedBytes.entries[0]), false, "and a rejected snapshot's entries are not sealed");
});

test("bibliography and the index service still refuse entries and candidates this process did not validate", async () => {
	let calls = 0;
	const server = http.createServer((_request, response) => { calls++; response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "Synthetic bibliography" })); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const bbt = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: `http://127.0.0.1:${address.port}` });
	try {
		const stale = { ...normalizeEntry(rawItem(6)), title: "Changed without rehash" };
		await assert.rejects(bbt.bibliography(stale), /Bibliography requires a validated item/);
		assert.equal(calls, 0, "an unvalidated item never reaches Better BibTeX");
		const sealed = normalizeEntryUnhashed(rawItem(6));
		assert.ok(sealEntry(sealed));
		assert.equal(await bbt.bibliography(sealed), "Synthetic bibliography");
		assert.equal(await bbt.bibliography(normalizeEntry(rawItem(7))), "Synthetic bibliography", "a valid unsealed entry passes the full check");

		const candidate: ZoteroIndex = { schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: 1, entries: [stale], capabilities: { zotero: "8", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
		let writes = 0;
		const service = new IndexService({ collect: async () => candidate } as unknown as BbtService, { read: async () => null, writeValidated: async () => { writes++; } }, () => 60);
		await assert.rejects(service.refresh({ force: true }), /Refusing to save invalid Zotero index/);
		assert.equal(writes, 0);
	} finally { bbt.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("0.6 OPT-10: attachment reads go out in batches of collectConcurrency requests, one batch in flight; exports keep the configured value", async () => {
	assert.equal(normalizeSettings({ concurrency: 1 }).collectConcurrency, 1, "a 0.5 settings file keeps its attachment bound");
	assert.equal(normalizeSettings({ concurrency: 3 }).collectConcurrency, 3);
	assert.equal(normalizeSettings({}).collectConcurrency, 4, "fresh installs get the 0.6 default");
	for (const [collectConcurrency, items] of [[2, 9], [1, 3], [4, 10]] as const) {
		const batches = Math.ceil(items / collectConcurrency);
		const api = await mockBbt(items, { attachmentsInFlight: 1 });
		const bbt = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint, collectConcurrency });
		try {
			const index = await bbt.collect();
			assert.equal(index.count, items);
			assert.equal(index.complete, true);
			assert.deepEqual(api.batchSizes, Array.from({ length: batches }, (_, i) => Math.min(collectConcurrency, items - i * collectConcurrency)), `${items} parents: POSTs of at most ${collectConcurrency} requests`);
			assert.equal(api.peak.get("item.attachments[]"), 1, "one attachment batch in flight");
			assert.equal(api.peak.get("item.attachments"), undefined, "no single attachment calls when the batches succeed");
		} finally { bbt.dispose(); await api.close(); }
	}
	for (const concurrency of [2, 1]) {
		// 100 parents in two export batches of 50.
		const api = await mockBbt(100, { exportsInFlight: concurrency });
		const bbt = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint, concurrency });
		try {
			assert.equal((await bbt.collect()).count, 100);
			assert.equal(api.peak.get("item.export"), concurrency, `concurrency ${concurrency}: item.export calls in flight`);
		} finally { bbt.dispose(); await api.close(); }
	}
});

test("a non-forced caller joining a failing forced flight receives a stale-fallback when cached, and normalizeAttachments parses string positions once", async () => {
	const entry = normalizeEntryUnhashed(rawItem(1));
	const stringPosAttachments = [{ open: `zotero://open-pdf/library/items/${key("B", 1)}`, path: `/synthetic/${key("B", 1)}.pdf`, annotations: [{ key: key("C", 1), parentItem: key("B", 1), annotationType: "highlight", annotationText: "Synthetic", annotationComment: "", annotationColor: "#ffd400", annotationPageLabel: "1", annotationPosition: JSON.stringify({ pageIndex: 0 }), version: 1, tags: [], dateModified: "2026-03-01T10:00:00Z" }] }];
	const origParse = JSON.parse;
	let parses = 0;
	JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => { parses++; return origParse(text, reviver); }) as typeof JSON.parse;
	try {
		const normalized = normalizeAttachments(stringPosAttachments, entry);
		assert.equal(normalized[0].annotations[0].page, 1);
		assert.equal(parses, 1, "string annotationPosition is parsed once");
	} finally { JSON.parse = origParse; }

	assert.ok(sealEntry(entry));
	const validIndex: ZoteroIndex = { schemaVersion: 2, generatedAt: new Date(Date.now() - 120_000).toISOString(), source: "better-bibtex", count: 1, entries: [entry], capabilities: { zotero: "8", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
	let shouldFail = false;
	let releaseCollect!: () => void;
	const service = new IndexService(
		{ collect: async () => { await new Promise<void>(resolve => { releaseCollect = resolve; }); if (shouldFail) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); return validIndex; } } as unknown as BbtService,
		{ read: async () => null, writeValidated: async () => {} },
		() => 1,
	);
	const firstFlight = service.refresh({ force: true });
	await new Promise(resolve => setImmediate(resolve));
	releaseCollect();
	await firstFlight;

	shouldFail = true;
	const forced = service.refresh({ force: true });
	const joinedNonForced = service.refresh({ force: false });
	await new Promise(resolve => setImmediate(resolve));
	releaseCollect();
	await assert.rejects(forced, /ECONNREFUSED/);
	const fallback = await joinedNonForced;
	assert.equal(fallback.refreshed, false);
	assert.equal(fallback.reason, "stale-fallback");
	assert.equal(fallback.failure, "bbt-unreachable");
	assert.equal(fallback.index, validIndex);
});
