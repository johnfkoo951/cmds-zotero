import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { BbtService } from "../src/bbt";
import { DEFAULT_SETTINGS, type ZoteroIndex } from "../src/types";
import { contentHash, entryHash, validateEntry, validateIndex } from "../src/identity";
import { normalizeAttachments, normalizeEntry } from "../src/api/normalize";
import { identityKey, markdownLink, noteDeepLink, parseZoteroURI, pdfURI, selectURI } from "../src/uris";
import { IndexService } from "../src/index-service";
import { httpRequest, rpc } from "../src/api/transport";

const parent = (libraryID = 1, citationKey = "Example2026", itemKey = "ABCD2345") => ({ libraryID, citationKey, itemKey, uri: libraryID === 1 ? `http://zotero.org/users/local/Example/items/${itemKey}` : `http://zotero.org/groups/12345/items/${itemKey}`, itemType: "journalArticle", title: "Synthetic example", date: "2026", creators: [{ firstName: "Example", lastName: "Author" }], tags: [{ tag: "synthetic" }], attachments: [{ select: libraryID === 1 ? "zotero://select/library/items/EFGH2345" : "zotero://select/groups/12345/items/EFGH2345", title: "Synthetic PDF" }], notes: [] });
const fixtureIndex = (): ZoteroIndex => ({ schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: 1, entries: [normalizeEntry(parent())], capabilities: { zotero: "8", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true });

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

test("index single-flight persists valid candidate only and refresh errors do not overwrite cache", async () => {
	let collections = 0;
	let writes = 0;
	let fail = false;
	const index = fixtureIndex();
	const bbt = { collect: async () => { collections++; await new Promise(resolve => setTimeout(resolve, 10)); if (fail) throw new Error("offline"); return index; } } as unknown as BbtService;
	const service = new IndexService(bbt, { read: async () => JSON.stringify({ entries: [], count: 0 }), writeValidated: async () => { writes++; } }, () => 60);
	await Promise.all([service.get(), service.get(true)]);
	assert.equal(collections, 1); assert.equal(writes, 1);
	fail = true;
	await assert.rejects(service.get(true), /offline/);
	assert.equal(await service.get(), index);
	assert.equal(writes, 1);
	assert.equal((await service.resolve("Example2026")).status, "resolved");
	assert.equal((await service.resolve("missing")).status, "not-found");
});

test("duplicate current/history matches remain ambiguous", async () => {
	const index = fixtureIndex();
	const second = normalizeEntry(parent(9, "Other2026"));
	second.citekeyHistory = ["Example2026"]; second.contentHash = entryHash(second);
	index.entries.push(second); index.count++;
	const service = new IndexService({} as BbtService, { read: async () => JSON.stringify(index), writeValidated: async () => undefined }, () => 60);
	assert.equal((await service.resolve("Example2026")).status, "ambiguous");
	assert.equal((await service.resolve("Example2026", { libraryID: 1 })).status, "resolved");
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
