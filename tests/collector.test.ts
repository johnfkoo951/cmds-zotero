// 0.6 index-refresh-resilience, group-library-validation, collection-membership-index, retraction-flags-from-zotero,
// OPT-07: one bad item never aborts a refresh. Synthetic Better BibTeX stub only (tests/fixtures/bbt-mock.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { BbtService } from "../src/bbt";
import { IndexService } from "../src/index-service";
import { BbtTransportError, isBbtTransportError } from "../src/api/transport";
import { DEFAULT_SETTINGS, type ZoteroIndex } from "../src/types";
import { validateIndex } from "../src/identity";
import { collectionTerms, groupRowsByLibraryName, legacyParentTerms, parentTerms, parseGroups, planLibraryRows, skippedId } from "../src/index/collect-plan";
import { endsRefresh, zoteroGone } from "../src/index/collector";
import { collectionsOfEntry, indexLibraries, libraryName, membersOf } from "../src/library/collections";
import { isRetracted } from "../src/library/retraction";
import * as released from "./fixtures/identity-0.5.0";
import { RpcFault, pdfAttachment, startMockBbt, type MockCall, type MockLibrary } from "./fixtures/bbt-mock";

const user = (key: string) => `http://zotero.org/users/local/Example/items/${key}`;
const group = (id: number, key: string) => `http://zotero.org/groups/${id}/items/${key}`;

test("planLibraryRows skips duplicate and missing citekeys, foreign rows and bad URIs instead of throwing", () => {
	const rows = [
		{ id: user("AAAA0001"), citekey: "Alpha2026", library: "My Library" },
		{ id: user("AAAA0002"), citekey: "Dup2026", library: "My Library" },
		{ id: user("AAAA0003"), citekey: "Dup2026", library: "My Library" },
		{ id: user("AAAA0004"), citekey: "", library: "My Library" },
		{ id: user("AAAA0001"), citekey: "Alpha2026", library: "My Library" },
		{ id: group(77, "AAAA0006"), citekey: "Foreign2026", library: "My Library" },
		{ id: "not a uri", citekey: "Broken2026" },
		"malformed",
	];
	const planned = planLibraryRows({ libraryID: 1, name: "My Library" }, rows);
	assert.deepEqual(planned.accepted.map(item => item.citekey), ["Alpha2026"], "a repeated row counts once");
	assert.deepEqual(planned.scope, { libraryType: "user" });
	assert.equal(planned.rows, rows.length);
	assert.deepEqual(planned.skipped.map(item => [item.reason, item.itemKey ?? null, item.citekey ?? null]), [
		["invalid-uri", null, "Broken2026"],
		["invalid-item", null, null],
		["library-scope", "AAAA0006", "Foreign2026"],
		["missing-citekey", "AAAA0004", null],
		["duplicate-citekey", "AAAA0002", "Dup2026"],
		["duplicate-citekey", "AAAA0003", "Dup2026"],
	]);
	assert.equal(skippedId(planned.skipped[3]), "1:AAAA0004");
	assert.equal(skippedId(planned.skipped[0]), null);
	// A group library takes the scope most of its rows share.
	const shared = planLibraryRows({ libraryID: 3, name: "Shared" }, [{ id: group(22, "BBBB0001"), citekey: "One" }, { id: group(22, "BBBB0002"), citekey: "Two" }, { id: group(23, "BBBB0003"), citekey: "Three" }]);
	assert.deepEqual(shared.scope, { libraryType: "group", groupID: 22 });
	assert.deepEqual(shared.skipped.map(item => item.reason), ["library-scope"]);
});

test("the name-based fallback skips rows of same-named libraries and rows without a library name", () => {
	const { libraries, skipped } = groupRowsByLibraryName([
		{ id: user("AAAA0001"), citekey: "Mine2026", library: "My Library" },
		{ id: group(11, "BBBB0001"), citekey: "Same2026", library: "Shared" },
		{ id: group(22, "CCCC0001"), citekey: "Same2026", library: "Shared" },
		{ id: group(11, "BBBB0002"), citekey: "Nameless2026" },
	]);
	assert.deepEqual([...libraries.keys()], ["My Library"]);
	assert.deepEqual(skipped.map(item => [item.reason, item.library, item.itemKey ?? null]), [["library-name", "", null], ["library-name", "Shared", "BBBB0001"], ["library-name", "Shared", "CCCC0001"]]);
});

test("search terms: per-library parents without feeds, a feed probe without the filter, collection members with a libraryID", () => {
	const parents = [["itemType", "isNot", "attachment"], ["itemType", "isNot", "annotation"], ["itemType", "isNot", "note"]];
	assert.deepEqual(parentTerms(2), [["libraryID", "is", 2], ...parents, ["ignore_feeds"]]);
	assert.deepEqual(parentTerms(4, { feeds: true }), [["libraryID", "is", 4], ...parents]);
	assert.deepEqual(legacyParentTerms(), [...parents, ["ignore_feeds"]]);
	assert.deepEqual(collectionTerms(1, "COLL0001"), [["libraryID", "is", 1], ["collection", "is", "COLL0001"], ...parents, ["ignore_feeds"]]);
	assert.deepEqual(parseGroups([{ id: 1, name: "My Library", collections: null }, { id: 1, name: "Again" }, { id: 0, name: "Bad" }, "junk", { id: 2, name: "Group", collections: [{ key: "COLL0001", name: "A", parentCollection: false }] }]), [
		{ libraryID: 1, name: "My Library", collections: null },
		{ libraryID: 2, name: "Group", collections: [{ libraryID: 2, key: "COLL0001", name: "A", parentKey: null }] },
	]);
	assert.throws(() => parseGroups({}), /library list/);
});

test("only faults about Zotero itself end a refresh; optional steps stop only when Zotero is gone", () => {
	const live = new AbortController().signal;
	const fault = (reason: ConstructorParameters<typeof BbtTransportError>[0]) => new BbtTransportError(reason, "http://127.0.0.1:23119/better-bibtex/json-rpc", "synthetic");
	assert.deepEqual(["connection-refused", "timeout", "http-404", "http-other", "aborted", "rpc", "invalid-response"].map(reason => endsRefresh(fault(reason as never), live)), [true, true, true, true, true, false, false]);
	assert.deepEqual(["connection-refused", "timeout", "http-404", "http-other", "aborted", "rpc", "invalid-response"].map(reason => zoteroGone(fault(reason as never), live)), [true, false, true, false, true, false, false]);
	assert.equal(endsRefresh(new Error("plain"), live), false);
	const aborted = new AbortController();
	aborted.abort();
	assert.equal(endsRefresh(new Error("plain"), aborted.signal), true);
	assert.equal(zoteroGone(new Error("plain"), aborted.signal), true);
});

function synthetic(): MockLibrary[] {
	return [
		{ id: 1, name: "My Library", collections: [{ key: "COLL0001", name: "Thesis" }, { key: "COLL0002", name: "방법론", parent: "COLL0001" }, { key: "COLL0003", name: "Trashed", deleted: true }], items: [
			{ itemKey: "AAAA0001", citekey: "Alpha2026", attachments: [pdfAttachment("PDFA0001", ["ANNA0001"])], collections: ["COLL0001"] },
			{ itemKey: "AAAA0002", citekey: "Dup2026" },
			{ itemKey: "AAAA0004", citekey: "Old2025", collections: ["COLL0002"] },
			{ itemKey: "AAAA0005", citekey: "Retracted2026", collections: ["COLL0002"] },
		] },
		{ id: 2, name: "Shared", groupID: 1111, items: [{ itemKey: "BBBB0001", citekey: "Same2026" }] },
		{ id: 3, name: "Shared", groupID: 2222, items: [{ itemKey: "CCCC0001", citekey: "Same2026" }] },
		{ id: 4, name: "Science feed", feed: true, items: [{ itemKey: "FFFF0001", citekey: "" }] },
		{ id: 5, name: "Empty group", groupID: 3333, items: [] },
	];
}

test("a refresh with feeds, duplicate and missing citekeys and same-named libraries yields a partial index plus diagnostics", async () => {
	const libraries = synthetic();
	const api = await startMockBbt(libraries);
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	try {
		const first = await service.collect();
		assert.equal(first.complete, true);
		assert.deepEqual(first.entries.map(entry => entry.id), ["1:AAAA0001", "1:AAAA0002", "1:AAAA0004", "1:AAAA0005", "2:BBBB0001", "3:CCCC0001"], "two libraries named Shared no longer abort the refresh");
		assert.ok(!api.calls.some(call => call.method === "item.export" && call.params[2] === "Shared"), "exports address libraries by local ID, never by an ambiguous name");
		const unfiltered = api.calls.filter(call => call.method === "item.search" && !(call.params[0] as unknown[][]).some(term => term[0] === "ignore_feeds"));
		assert.deepEqual(unfiltered.map(call => (call.params[0] as unknown[][])[0]).sort((left, right) => Number(left[2]) - Number(right[2])), [["libraryID", "is", 4], ["libraryID", "is", 5]], "every search keeps feeds out except the probe that tells an empty library from a feed");

		// Zotero changes: a second item takes Dup2026, Old2025 loses its key, AAAA0005 is retracted.
		libraries[0].items.push({ itemKey: "AAAA0003", citekey: "Dup2026" });
		libraries[0].items[2].citekey = "";
		libraries[0].items[3].retracted = true;
		const second = await service.collect(first);
		assert.equal(second.complete, false, "skipped items make the index incomplete");
		assert.deepEqual(second.entries.map(entry => entry.id), ["1:AAAA0001", "1:AAAA0002", "1:AAAA0004", "1:AAAA0005", "2:BBBB0001", "3:CCCC0001"], "skipped items keep their previous entries; the new duplicate has none");
		assert.equal(second.entries.find(entry => entry.id === "1:AAAA0002"), first.entries.find(entry => entry.id === "1:AAAA0002"), "a kept entry is the previous sealed object");
		assert.equal(second.entries.find(entry => entry.id === "1:AAAA0004")?.citekey, "Old2025");
		const codes = second.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.itemID ?? diagnostic.citekey ?? null]);
		assert.deepEqual(codes, [
			["duplicate-citekey", "Same2026"],
			["duplicate-citekey", "1:AAAA0002"],
			["duplicate-citekey", "1:AAAA0003"],
			["missing-citekey", "1:AAAA0004"],
			["feed-library", null],
			["library-empty", null],
			["retracted-source", "1:AAAA0005"],
		]);
		const messages = second.diagnostics.map(diagnostic => diagnostic.message).join("\n");
		assert.match(messages, /Item AAAA0002 in library "My Library" was left out of this refresh because Better BibTeX gives @Dup2026 to 2 items in that library; its previous index entry was kept/);
		assert.match(messages, /Item AAAA0004 in library "My Library" has no Better BibTeX citation key yet and was left out of this refresh; its previous index entry was kept\./);
		assert.match(messages, /Library "Science feed" is a Zotero feed; feed items are not indexed\./);
		assert.match(messages, /Zotero marks @Retracted2026 as retracted/);
		assert.deepEqual(second.diagnostics.find(diagnostic => diagnostic.code === "retracted-source")?.severity, "warning");

		assert.deepEqual(indexLibraries(second), [
			{ libraryID: 1, name: "My Library", kind: "user", items: 5, indexed: 4 },
			{ libraryID: 2, name: "Shared", kind: "group", groupID: 1111, items: 1, indexed: 1 },
			{ libraryID: 3, name: "Shared", kind: "group", groupID: 2222, items: 1, indexed: 1 },
			{ libraryID: 4, name: "Science feed", kind: "feed", items: 0, indexed: 0 },
			{ libraryID: 5, name: "Empty group", kind: "unknown", items: 0, indexed: 0 },
		]);
		assert.equal(libraryName(second, 3), "Shared");
		assert.deepEqual(second.collections, [
			{ libraryID: 1, key: "COLL0001", name: "Thesis", parentKey: null, items: ["1:AAAA0001"] },
			{ libraryID: 1, key: "COLL0002", name: "방법론", parentKey: "COLL0001", items: ["1:AAAA0004", "1:AAAA0005"] },
		], "trashed collections are left out; kept entries stay members");
		assert.deepEqual(second.entries.find(entry => entry.id === "1:AAAA0005")?.collections, ["Thesis/방법론"]);
		assert.deepEqual(second.entries.find(entry => entry.id === "1:AAAA0001")?.collections, ["Thesis"]);
		assert.deepEqual(collectionsOfEntry(second, "1:AAAA0005").map(collection => collection.path), ["Thesis/방법론"]);
		assert.deepEqual(membersOf(second, 1, "COLL0001", { recursive: true })?.sort(), ["1:AAAA0001", "1:AAAA0004", "1:AAAA0005"]);
		assert.deepEqual(second.retracted, ["1:AAAA0005"]);
		assert.equal(isRetracted(second, "1:AAAA0005"), true);
		assert.equal(isRetracted(first, "1:AAAA0005"), false);

		const bytes = JSON.parse(JSON.stringify(second)) as unknown;
		assert.ok(validateIndex(bytes), "the current validator accepts the additive fields");
		assert.ok(released.validateIndex(bytes), "the released 0.5.0 validator still accepts the index");
	} finally { service.dispose(); await api.close(); }
});

test("an export batch that answers with other items is retried item by item; an item that still fails is skipped", async () => {
	const libraries: MockLibrary[] = [{ id: 1, name: "My Library", items: [
		{ itemKey: "AAAA0001", citekey: "One2026" }, { itemKey: "AAAA0002", citekey: "Broken2026" }, { itemKey: "AAAA0003", citekey: "Three2026" },
	] }];
	const exports: string[][] = [];
	const api = await startMockBbt(libraries, { override: (call: MockCall) => {
		if (call.method !== "item.export") return undefined;
		const keys = call.params[0] as string[];
		exports.push(keys);
		if (keys.includes("Broken2026") && keys.length === 1) throw new RpcFault(-32603, "synthetic translator failure");
		if (keys.length > 1) return JSON.stringify({ items: [] });
		return undefined;
	} });
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	try {
		const index = await service.collect();
		assert.deepEqual(exports, [["One2026", "Broken2026", "Three2026"], ["One2026"], ["Broken2026"], ["Three2026"]]);
		assert.deepEqual(index.entries.map(entry => entry.citekey), ["One2026", "Three2026"]);
		assert.equal(index.complete, false);
		const skipped = index.diagnostics.find(diagnostic => diagnostic.code === "item-skipped");
		assert.equal(skipped?.itemID, "1:AAAA0002");
		assert.match(skipped?.message ?? "", /the Better BibTeX export failed \(synthetic translator failure\)\.$/);
	} finally { service.dispose(); await api.close(); }
});

test("an unreadable library keeps its previous entries; unreadable collections and retraction flags are reported, not fatal", async () => {
	const libraries = synthetic().slice(0, 3);
	let failLibrary = false;
	let failCollections = false;
	let failRetraction = false;
	const api = await startMockBbt(libraries, { override: (call: MockCall) => {
		if (call.method !== "item.search") return undefined;
		const terms = call.params[0] as unknown[][];
		if (failLibrary && terms.some(term => term[0] === "libraryID" && term[2] === 2) && !terms.some(term => term[0] === "collection")) throw new RpcFault(-32603, "synthetic search failure");
		if (failCollections && terms.some(term => term[0] === "collection")) throw new RpcFault(-32603, "synthetic collection failure");
		if (failRetraction && terms.some(term => term[0] === "retracted")) throw new RpcFault(-32603, "Error: Invalid condition 'retracted' in hasOperator()");
		return undefined;
	} });
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	try {
		const first = await service.collect();
		failLibrary = failCollections = failRetraction = true;
		libraries[1].items.push({ itemKey: "BBBB0002", citekey: "Unseen2026" });
		const second = await service.collect(first);
		assert.equal(second.complete, false);
		assert.deepEqual(second.entries.map(entry => entry.id), first.entries.map(entry => entry.id), "library 2 keeps its previous entry; its new item is not invented");
		assert.equal(second.entries.find(entry => entry.id === "2:BBBB0001"), first.entries.find(entry => entry.id === "2:BBBB0001"));
		assert.deepEqual(second.diagnostics.filter(diagnostic => !["duplicate-citekey"].includes(diagnostic.code)).map(diagnostic => [diagnostic.code, diagnostic.severity]), [
			["library-not-indexed", "warning"], ["collections-unavailable", "info"], ["retraction-check-unavailable", "info"],
		]);
		assert.match(second.diagnostics.find(diagnostic => diagnostic.code === "library-not-indexed")?.message ?? "", /Library "Shared" could not be read \(synthetic search failure\); its 1 previous entry was kept\./);
		assert.equal(second.retracted, undefined, "an unread flag is absent, not empty");
		assert.deepEqual(second.entries.find(entry => entry.id === "1:AAAA0001")?.collections, ["Thesis"], "entries keep the previous refresh's collections");
		assert.equal(second.collections?.find(collection => collection.key === "COLL0001")?.items, undefined, "membership that could not be read is absent");
		assert.equal(membersOf(second, 1, "COLL0001"), null);
		assert.ok(validateIndex(JSON.parse(JSON.stringify(second))));
	} finally { service.dispose(); await api.close(); }
});

test("without user.groups the 0.5 name-based search is used and same-named libraries are skipped, not fatal", async () => {
	const libraries = synthetic().slice(0, 3);
	const api = await startMockBbt(libraries, { override: (call: MockCall) => { if (call.method === "user.groups") throw new RpcFault(-32601, "Method not found: user.groups"); return undefined; } });
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	try {
		const index = await service.collect();
		assert.deepEqual(index.entries.map(entry => entry.id), ["1:AAAA0001", "1:AAAA0002", "1:AAAA0004", "1:AAAA0005"]);
		assert.deepEqual(index.diagnostics.filter(diagnostic => diagnostic.code === "item-skipped").map(diagnostic => diagnostic.citekey), ["Same2026", "Same2026"]);
		assert.equal(index.complete, false);
		assert.equal(index.libraries, undefined);
		assert.equal(index.collections, undefined);
		assert.ok(validateIndex(JSON.parse(JSON.stringify(index))));
	} finally { service.dispose(); await api.close(); }
});

test("a transport fault still ends the refresh and the index service falls back to the saved snapshot", async () => {
	const libraries = synthetic().slice(0, 1);
	let status: number | undefined;
	let failOn = "";
	const api = await startMockBbt(libraries, { httpStatus: (call: MockCall) => {
		if (!status) return undefined;
		const terms = call.method === "item.search" ? call.params[0] as unknown[][] : [];
		return failOn === "parents" && call.method === "item.search" && !terms.some(term => term[0] === "collection") ? status : failOn === "collections" && terms.some(term => term[0] === "collection") ? status : undefined;
	} });
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	let saved: string | null = null;
	const storage = { read: async () => saved, writeValidated: async (text: string) => { saved = text; } };
	const index = new IndexService(service, storage, () => 0);
	try {
		const first = await index.refresh({ force: true });
		assert.equal(first.refreshed, true);
		for (const [code, step] of [[500, "parents"], [404, "collections"]] as const) {
			status = code;
			failOn = step;
			const fallback = await index.refresh();
			assert.equal(fallback.reason, "stale-fallback", `HTTP ${code} during the ${step} step`);
			assert.equal(fallback.index.generatedAt, first.index.generatedAt);
			assert.ok(isBbtTransportError(fallback.cause), "the typed fault is carried");
			await assert.rejects(index.refresh({ force: true }), (error: unknown) => error instanceof Error && /HTTP/.test(error.message));
		}
		status = undefined;
		const recovered: ZoteroIndex = (await index.refresh({ force: true })).index;
		assert.equal(recovered.complete, true);
	} finally { service.dispose(); await api.close(); }
});
