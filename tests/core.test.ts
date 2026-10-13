import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { BbtService } from "../src/bbt";
import { DEFAULT_SETTINGS, type ZoteroIndex } from "../src/types";
import { contentHash, entryHash, validateEntry, validateIndex } from "../src/identity";
import { normalizeAttachments, normalizeEntry } from "../src/api/normalize";
import { identityKey, markdownLink, noteDeepLink, parseZoteroURI, pdfURI, selectURI } from "../src/uris";
import { IndexRefusalError, IndexService, classifyRefreshError, describeRefreshFailure, formatIndexAge, resolveInIndex } from "../src/index-service";
import { httpRequest, rpc } from "../src/api/transport";

const parent = (libraryID = 1, citationKey = "Example2026", itemKey = "ABCD2345") => ({ libraryID, citationKey, itemKey, uri: libraryID === 1 ? `http://zotero.org/users/local/Example/items/${itemKey}` : `http://zotero.org/groups/12345/items/${itemKey}`, itemType: "journalArticle", title: "Synthetic example", date: "2026", creators: [{ firstName: "Example", lastName: "Author" }], tags: [{ tag: "synthetic" }], attachments: [{ select: libraryID === 1 ? "zotero://select/library/items/EFGH2345" : "zotero://select/groups/12345/items/EFGH2345", title: "Synthetic PDF" }], notes: [] });
const fixtureIndex = (): ZoteroIndex => ({ schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: 1, entries: [normalizeEntry(parent())], capabilities: { zotero: "8", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true });

/** STRUCT-03: IndexService.get/resolve were test-only (and resolve could start a collection); reads resolve against the loaded snapshot. */
async function resolveLoaded(service: IndexService, query: string, options?: { libraryID?: number; itemKey?: string }) {
	const index = await service.peek();
	assert.ok(index, "a validated snapshot is loaded");
	return resolveInIndex(index, query, options);
}

async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ endpoint: string; close: () => Promise<void> }> {
	const server = http.createServer(handler);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	return { endpoint: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test("URIs keep local library ID separate from public group ID", () => {
	const identity = { libraryID: 9, libraryType: "group" as const, groupID: 12345, itemKey: "ABCD2345" };
	assert.equal(identityKey(identity), "9:ABCD2345");
	assert.equal(selectURI(identity), "zotero://select/groups/12345/items/ABCD2345");
	const open = "zotero://open-pdf/groups/12345/items/EFGH2345";
	assert.equal(pdfURI(open, 3, "JKLM2345"), `${open}?page=3&annotation=JKLM2345`);
	assert.equal(parseZoteroURI(pdfURI(open, 3)).groupID, 12345);
	assert.throws(() => pdfURI(selectURI(identity)));
	assert.throws(() => pdfURI(open, 0));
	assert.throws(() => parseZoteroURI(`${open}?page=1&page=2`));
	assert.throws(() => parseZoteroURI("zotero://open-pdf/library/items/Example2026"));
	const deep = new URL(noteDeepLink("Vault & Space", identity, "pdf", 3));
	assert.equal(deep.searchParams.get("vault"), "Vault & Space");
	assert.equal(deep.searchParams.get("libraryID"), "9");
	assert.equal(markdownLink("A [title]", "zotero://example"), "[A \\[title\\]](<zotero://example>)");
});

test("identity validation rejects fabricated and legacy keys and protects hash integrity", () => {
	const entry = normalizeEntry(parent());
	assert(validateEntry(entry));
	assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }));
	assert(!validateEntry({ ...entry, itemKey: entry.citekey }));
	assert(!validateEntry({ ...entry, title: "Changed without rehash" }));
	assert(!validateIndex({ entries: [entry], count: 1 }));
	assert.throws(() => normalizeEntry({ ...parent(), libraryID: "1" }));
	assert.throws(() => normalizeEntry({ ...parent(), uri: "" }));
	assert.throws(() => normalizeEntry({ ...parent(), itemType: "note" }));
});

test("collector groups exports, preserves citekey history, parses actual attachment arrays and isolates attachment failures", async () => {
	const calls: { method: string; params: unknown[] }[] = [];
	const api = await serve((request, response) => {
		let body = "";
		request.on("data", chunk => { body += String(chunk); });
		request.on("end", () => {
			const call = JSON.parse(body) as { method: string; params: unknown[] };
			calls.push(call);
			let result: unknown;
			if (call.method === "api.ready") result = { zotero: "8", betterbibtex: "9" };
			if (call.method === "item.search") {
				assert.equal(call.params[1], "*");
				result = [{ citekey: "Renamed2026", library: "Synthetic User", id: parent().uri }, { citekey: "Renamed2026", library: "Synthetic Group", id: parent(9).uri }];
			}
			if (call.method === "item.export") {
				assert.equal(call.params[1], "BetterBibTeX JSON");
				result = JSON.stringify({ items: [parent(call.params[2] === "Synthetic User" ? 1 : 9, "Renamed2026")], collections: {}, config: {}, version: {} });
			}
			if (call.method === "item.bibliography") {
				assert.deepEqual(call.params, [["Renamed2026"], { id: "apa", contentType: "text" }, 1]);
				result = "Synthetic bibliography";
			}
			if (call.method === "item.attachments") {
				if (call.params[1] === 9) { response.statusCode = 500; response.end("unavailable"); return; }
				result = [{ open: "zotero://open-pdf/library/items/EFGH2345", path: "/synthetic/example.pdf", annotations: [{ key: "JKLM2345", parentItem: "EFGH2345", annotationType: "highlight", annotationText: "Synthetic annotation", annotationPosition: { pageIndex: 2 }, annotationPageLabel: "iii", version: 1 }] }];
			}
			response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
		});
	});
	try {
		const index = await new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint }).collect(fixtureIndex());
		assert(validateIndex(index));
		assert.equal(index.count, 2);
		assert.equal(index.complete, false);
		assert.deepEqual(index.entries[0].citekeyHistory, ["Example2026"]);
		assert.equal(index.entries[0].attachments[0].annotations[0].page, 3);
		assert.equal(index.entries[0].attachments[0].annotations[0].text, "Synthetic annotation");
		assert.equal(await new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint }).bibliography(index.entries[0]), "Synthetic bibliography");
		assert.equal(index.entries[1].groupID, 12345);
		assert.equal(index.entries[1].attachmentStatus, "unavailable");
		assert.equal(calls.filter(call => call.method === "item.export").length, 2);
		assert.equal(calls.filter(call => call.method === "item.search").length, 1);
	} finally { await api.close(); }
});

test("concurrent non-forced loads share one flight, persist the valid candidate only, and refresh errors do not overwrite the cache", async () => {
	let collections = 0;
	let writes = 0;
	let fail = false;
	const index = fixtureIndex();
	const bbt = { collect: async () => { collections++; await new Promise(resolve => setTimeout(resolve, 10)); if (fail) throw new Error("offline"); return index; } } as unknown as BbtService;
	const service = new IndexService(bbt, { read: async () => JSON.stringify({ entries: [], count: 0 }), writeValidated: async () => { writes++; } }, () => 60);
	await Promise.all([service.refresh(), service.refresh()]);
	assert.equal(collections, 1); assert.equal(writes, 1);
	await service.refresh({ force: true });
	assert.equal(collections, 2, "a forced request always collects"); assert.equal(writes, 2);
	fail = true;
	await assert.rejects(service.refresh({ force: true }), /offline/);
	assert.equal((await service.refresh()).index, index);
	assert.equal(writes, 2);
	assert.equal((await resolveLoaded(service, "Example2026")).status, "resolved");
	assert.equal((await resolveLoaded(service, "missing")).status, "not-found");
});

const staleIndex = (hoursOld = 3): ZoteroIndex => ({ ...fixtureIndex(), generatedAt: new Date(Date.now() - hoursOld * 3600000).toISOString() });
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("a stale validated cache is served as stale-fallback when collection fails; a forced refresh still throws; nothing is written", async () => {
	const stale = staleIndex();
	let collections = 0;
	let writes = 0;
	const bbt = { collect: async () => { collections++; throw new Error("connect ECONNREFUSED 127.0.0.1:23119"); } } as unknown as BbtService;
	const service = new IndexService(bbt, { read: async () => JSON.stringify(stale), writeValidated: async () => { writes++; } }, () => 60);
	const outcome = await service.refresh();
	assert.equal(outcome.reason, "stale-fallback");
	assert.equal(outcome.refreshed, false);
	assert.equal(outcome.failure, "bbt-unreachable");
	assert.match(outcome.error ?? "", /ECONNREFUSED/);
	assert.equal(outcome.index.generatedAt, stale.generatedAt);
	assert.ok((outcome.ageMinutesBefore ?? 0) >= 179);
	assert.equal((await service.refresh()).index.generatedAt, stale.generatedAt);
	assert.equal((await resolveLoaded(service, "Example2026")).status, "resolved");
	await assert.rejects(service.refresh({ force: true }), (error: unknown) => error instanceof IndexRefusalError && error.reason === "bbt-unreachable" && /ECONNREFUSED/.test(error.message), "a forced request reports the same structured reason as the fallback");
	assert.equal(await service.peek(), outcome.index, "the failed forced refresh leaves the cache intact");
	assert.equal(writes, 0);
	assert.equal(collections, 3, "only the three refreshes tried to collect; resolving reads the snapshot");
	assert.equal(service.collecting, false);
	const none = new IndexService(bbt, { read: async () => null, writeValidated: async () => { writes++; } }, () => 60);
	await assert.rejects(none.refresh(), /ECONNREFUSED/, "without any snapshot there is nothing to fall back to");
	assert.equal(await none.peek(), null, "no snapshot to resolve against: readers report the index unavailable");
	assert.equal(writes, 0);
});

test("legacy-plugin gate refuses collection before contacting BBT: stale cache still serves reads, forced refresh throws a structured reason", async () => {
	const stale = staleIndex();
	let collections = 0;
	const bbt = { collect: async () => { collections++; return fixtureIndex(); } } as unknown as BbtService;
	const refusal = { ok: false as const, reason: "legacy-plugin-enabled" as const, message: "The legacy cmds-link-zotero plugin is enabled beside CMDS Zotero; disable it before refreshing." };
	const service = new IndexService(bbt, { read: async () => JSON.stringify(stale), writeValidated: async () => { throw new Error("must not write"); } }, () => 60, () => refusal);
	const outcome = await service.refresh();
	assert.equal(outcome.reason, "stale-fallback");
	assert.equal(outcome.failure, "legacy-plugin-enabled");
	assert.equal(outcome.error, refusal.message);
	assert.equal(outcome.index.generatedAt, stale.generatedAt);
	await assert.rejects(service.refresh({ force: true }), (error: unknown) => error instanceof IndexRefusalError && error.reason === "legacy-plugin-enabled" && /legacy cmds-link-zotero/.test(error.message));
	const empty = new IndexService(bbt, { read: async () => null, writeValidated: async () => undefined }, () => 60, () => refusal);
	await assert.rejects(empty.refresh(), /legacy cmds-link-zotero/, "no snapshot and a refused collection is a hard failure");
	assert.equal(await empty.peek(), null, "no snapshot to resolve against: readers report the index unavailable");
	assert.equal(collections, 0, "the gate is consulted before collect");
	const fresh = new IndexService(bbt, { read: async () => JSON.stringify(fixtureIndex()), writeValidated: async () => undefined }, () => 60, () => refusal);
	assert.equal((await fresh.refresh()).reason, "fresh", "a fresh cache never consults the gate");
});

test("a forced refresh never joins a non-forced flight; later non-forced callers share the forced flight", async () => {
	const releases: (() => void)[] = [];
	let collections = 0;
	const bbt = { collect: async () => {
		collections++;
		await new Promise<void>(resolve => { releases.push(resolve); });
		return { ...fixtureIndex(), generatedAt: new Date().toISOString() };
	} } as unknown as BbtService;
	const service = new IndexService(bbt, { read: async () => JSON.stringify(staleIndex()), writeValidated: async () => undefined }, () => 60);
	const first = service.refresh();
	while (collections < 1) await settle();
	const forced = service.refresh({ force: true });
	const joined = service.refresh();
	assert.equal(collections, 1, "the forced request waits for the running flight instead of racing it");
	releases[0]();
	while (collections < 2) await settle();
	releases[1]();
	const [a, b, c] = await Promise.all([first, forced, joined]);
	assert.equal(a.reason, "stale");
	assert.equal(b.reason, "forced");
	assert.equal(b.refreshed, true);
	assert.equal(c, b, "a non-forced request joins the stricter forced flight");
	assert.equal(collections, 2);
	assert.equal((await service.refresh()).reason, "fresh");
});

test("a forced refresh chained after a failing non-forced flight still runs and cleanup is identity-guarded", async () => {
	let collections = 0;
	const bbt = { collect: async () => { collections++; await settle(); if (collections === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:23119"); return fixtureIndex(); } } as unknown as BbtService;
	const service = new IndexService(bbt, { read: async () => null, writeValidated: async () => undefined }, () => 60);
	const first = service.refresh();
	const forced = service.refresh({ force: true });
	await assert.rejects(first, /ECONNREFUSED/);
	assert.equal((await forced).reason, "forced");
	assert.equal(collections, 2);
	assert.equal((await service.refresh()).reason, "fresh", "no stale flight reference survives the chain");
});

test("collection errors are classified: cancellation is not a failure, timeouts are distinct from unreachable, and forced requests carry the reason", async () => {
	const stale = staleIndex();
	let error: Error = new Error("BBT request timed out");
	let released = () => {};
	const bbt = { collect: async () => { await new Promise<void>(resolve => { released = resolve; }); throw error; } } as unknown as BbtService;
	const service = new IndexService(bbt, { read: async () => JSON.stringify(stale), writeValidated: async () => { throw new Error("must not write"); } }, () => 60);
	const pending = service.refresh();
	while (!service.collecting) await settle();
	assert.equal(service.collecting, true, "collecting reflects the in-flight BBT call");
	released();
	const timeout = await pending;
	assert.equal(service.collecting, false);
	assert.equal(timeout.reason, "stale-fallback");
	assert.equal(timeout.failure, "timeout");
	const forcedTimeout = service.refresh({ force: true });
	while (!service.collecting) await settle();
	released();
	await assert.rejects(forcedTimeout, (rejection: unknown) => rejection instanceof IndexRefusalError && rejection.reason === "timeout");
	const abort = new Error("The operation was aborted");
	abort.name = "AbortError";
	for (const cancellation of [abort, new Error("BBT collection cancelled"), new Error("BBT response aborted")]) {
		error = cancellation;
		const outcome = service.refresh();
		while (!service.collecting) await settle();
		released();
		const cancelled = await outcome;
		assert.equal(cancelled.reason, "stale-fallback");
		assert.equal(cancelled.failure, undefined, `${cancellation.message} is the plugin's own cancellation, not a BBT failure`);
		assert.equal(cancelled.error, cancellation.message);
		assert.equal(classifyRefreshError(cancellation), "cancelled");
	}
	const forcedAbort = service.refresh({ force: true });
	while (!service.collecting) await settle();
	released();
	await assert.rejects(forcedAbort, (rejection: unknown) => rejection === error, "a cancelled forced request rethrows the original error unwrapped");
	assert.equal(classifyRefreshError(new Error("connect ECONNREFUSED 127.0.0.1:23119")), "bbt-unreachable");
	assert.equal(classifyRefreshError(new Error("BBT request timed out")), "timeout");
	assert.equal(classifyRefreshError(new IndexRefusalError("legacy-plugin-enabled", "legacy")), "legacy-plugin-enabled");
	assert.equal(classifyRefreshError(new Error("Refusing to save invalid Zotero index")), null);
});

test("index age labels and refresh failures map to one human sentence", () => {
	assert.equal(describeRefreshFailure(new Error("BBT request timed out"), "http://127.0.0.1:23119", 90), "Zotero/Better BibTeX at http://127.0.0.1:23119 did not respond in time; using the saved index from 2 h ago.");
	assert.equal(describeRefreshFailure(new IndexRefusalError("timeout", "BBT request timed out"), "http://127.0.0.1:23119", 90), "Zotero/Better BibTeX at http://127.0.0.1:23119 did not respond in time; using the saved index from 2 h ago.");
	assert.equal(describeRefreshFailure(new Error("BBT collection cancelled"), "http://127.0.0.1:23119", 5), "The index refresh was cancelled; using the saved index from 5 min ago.");
	assert.equal(describeRefreshFailure(new IndexRefusalError("bbt-unreachable", "connect ECONNREFUSED 127.0.0.1:23119"), "http://127.0.0.1:23119", null), "Zotero/Better BibTeX is not reachable at http://127.0.0.1:23119; no saved index is available yet. Start Zotero and refresh the index.");
	assert.equal(formatIndexAge(null), "unknown age");
	assert.equal(formatIndexAge(0), "under a minute");
	assert.equal(formatIndexAge(12), "12 min");
	assert.equal(formatIndexAge(27 * 60 + 20), "27 h");
	assert.equal(formatIndexAge(3 * 1440), "3 d");
	assert.equal(describeRefreshFailure(new Error("connect ECONNREFUSED 127.0.0.1:23119"), "http://127.0.0.1:23119", 27 * 60), "Zotero/Better BibTeX is not reachable at http://127.0.0.1:23119; using the saved index from 27 h ago.");
	assert.equal(describeRefreshFailure(new Error("connect ECONNREFUSED 127.0.0.1:23119"), "http://127.0.0.1:23119", null), "Zotero/Better BibTeX is not reachable at http://127.0.0.1:23119; no saved index is available yet. Start Zotero and refresh the index.");
	assert.equal(describeRefreshFailure(new IndexRefusalError("legacy-plugin-enabled", "The legacy plugin is enabled."), "http://127.0.0.1:23119", 5), "The legacy plugin is enabled; using the saved index from 5 min ago.");
	assert.match(describeRefreshFailure(new Error("Refusing to save invalid Zotero index"), "http://127.0.0.1:23119", 5), /^The index could not be refreshed \(Refusing to save invalid Zotero index\); using the saved index from 5 min ago\.$/);
});

test("duplicate current/history matches remain ambiguous", async () => {
	const index = fixtureIndex();
	const second = normalizeEntry(parent(9, "Other2026"));
	second.citekeyHistory = ["Example2026"]; second.contentHash = entryHash(second);
	index.entries.push(second); index.count++;
	const service = new IndexService({} as BbtService, { read: async () => JSON.stringify(index), writeValidated: async () => undefined }, () => 60);
	assert.equal((await resolveLoaded(service, "Example2026")).status, "ambiguous");
	assert.equal((await resolveLoaded(service, "Example2026", { libraryID: 1 })).status, "resolved");
});

test("missing-file sentinel retains attachment identity without fabricating a path", () => {
	const attachments = normalizeAttachments([{ open: "zotero://open-pdf/library/items/EFGH2345", path: false }], normalizeEntry(parent()));
	assert.equal(attachments[0].path, null);
	assert.equal(attachments[0].key, "EFGH2345");
	assert.equal(attachments[0].title, "Synthetic PDF");
	assert.throws(() => normalizeAttachments([{ open: "zotero://open-pdf/library/items/ZZZZ2345", path: null }], normalizeEntry(parent())), /parent/);
	assert.throws(() => normalizeAttachments([{ open: "zotero://open-pdf/library/items/EFGH2345", path: true }], normalizeEntry(parent())));
});

test("annotationImagePath is preserved and takes precedence over the legacy image field", () => {
	const annotation = { key: "JKLM2345", parentItem: "EFGH2345", annotationType: "image", annotationPosition: { pageIndex: 0 }, annotationImagePath: "/synthetic/current.png", image: "/synthetic/legacy.png" };
	const normalize = (value: Record<string, unknown>) => normalizeAttachments([{ open: "zotero://open-pdf/library/items/EFGH2345", path: "/synthetic/example.pdf", annotations: [value] }], normalizeEntry(parent()))[0].annotations[0];
	assert.equal(normalize(annotation).imagePath, "/synthetic/current.png");
	assert.equal(normalize({ ...annotation, annotationImagePath: undefined }).imagePath, "/synthetic/legacy.png");
	assert.equal(normalize({ ...annotation, annotationImagePath: null }).imagePath, "/synthetic/legacy.png");
	assert.equal(normalize({ ...annotation, annotationImagePath: undefined, image: undefined }).imagePath, undefined);
});

test("dispose aborts outstanding requests and does not issue later calls", async () => {
	let notify: (() => void) | undefined;
	const received = new Promise<void>(resolve => { notify = resolve; });
	let count = 0;
	const api = await serve(() => { count++; notify?.(); });
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	try {
		const pending = service.collect();
		const rejected = assert.rejects(pending, /abort/i);
		await received;
		service.dispose();
		await rejected;
		assert.equal(count, 1);
		await assert.rejects(service.capabilities(), /abort/i);
		assert.equal(count, 1);
	} finally { service.dispose(); await api.close(); }
});

test("transport throws HTTP/JSON/RPC failures and enforces a wall-clock timeout", async () => {
	const api = await serve((request, response) => {
		if (request.url === "/slow") return;
		response.end("{not-json");
	});
	try {
		await assert.rejects(rpc(api.endpoint, "api.ready", [], 1000));
		await assert.rejects(httpRequest(`${api.endpoint}/slow`, 20), /timed out/);
	} finally { await api.close(); }
});
