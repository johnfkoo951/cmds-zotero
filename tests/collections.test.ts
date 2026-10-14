// 0.6 collection-membership-index: the pure collection tree, paths and the forward-compatible index readers.
import test from "node:test";
import assert from "node:assert/strict";
import { collectionId, collectionPaths, collectionTree, collectionsOfEntry, entryCollectionPaths, indexCollections, indexLibraries, libraryName, membersOf, parseCollections, type CollectionNode } from "../src/library/collections";
import type { ZoteroIndex } from "../src/types";

/** A synthetic `user.groups(true)` collection list: flat, nested ones included, `parentCollection` false at the root. */
const RAW = [
	{ key: "THES0001", name: "Thesis", parentCollection: false, version: 3, relations: {} },
	{ key: "METH0001", name: "방법론", parentCollection: "THES0001", version: 4, relations: {} },
	{ key: "SURV0001", name: "Surveys", parentCollection: "METH0001", version: 4, relations: {} },
	{ key: "ORPH0001", name: "Orphan", parentCollection: "GONE0001", version: 1, relations: {} },
	{ key: "SELF0001", name: "Self", parentCollection: "SELF0001", version: 1, relations: {} },
	{ key: "LOOP000A", name: "Loop A", parentCollection: "LOOP000B", version: 1, relations: {} },
	{ key: "LOOP000B", name: "Loop B", parentCollection: "LOOP000A", version: 1, relations: {} },
	{ key: "TRSH0001", name: "Trashed", parentCollection: false, deleted: true },
	{ key: "bad key", name: "Malformed" },
	{ key: "THES0001", name: "Repeated key" },
	{ key: "NONA0001" },
	"junk",
];

test("parseCollections keeps the flat tree, drops trashed, malformed and repeated rows, and roots self-parents", () => {
	const nodes = parseCollections(7, RAW);
	assert.deepEqual(nodes.map(node => [node.key, node.name, node.parentKey]), [
		["THES0001", "Thesis", null], ["METH0001", "방법론", "THES0001"], ["SURV0001", "Surveys", "METH0001"], ["ORPH0001", "Orphan", "GONE0001"],
		["SELF0001", "Self", null], ["LOOP000A", "Loop A", "LOOP000B"], ["LOOP000B", "Loop B", "LOOP000A"],
	]);
	assert.ok(nodes.every(node => node.libraryID === 7));
	assert.deepEqual(parseCollections(7, null), []);
	assert.equal(collectionId(7, "THES0001"), "7:THES0001");
});

test("collection paths join names from the root, treat a missing parent as a root and stop at parent loops", () => {
	const nodes = parseCollections(7, RAW);
	const paths = collectionPaths(nodes);
	assert.equal(paths.get("7:THES0001"), "Thesis");
	assert.equal(paths.get("7:METH0001"), "Thesis/방법론");
	assert.equal(paths.get("7:SURV0001"), "Thesis/방법론/Surveys");
	assert.equal(paths.get("7:ORPH0001"), "Orphan", "a trashed or unlisted parent makes its child a root");
	assert.equal(paths.get("7:SELF0001"), "Self");
	assert.equal(paths.get("7:LOOP000A"), "Loop B/Loop A", "a loop ends at the first collection seen twice");
	assert.equal(paths.get("7:LOOP000B"), "Loop B");
	// Two libraries may reuse names and even keys; ids keep them apart.
	const other = parseCollections(8, [{ key: "THES0001", name: "Thesis", parentCollection: false }]);
	assert.equal(collectionPaths([...nodes, ...other]).get("8:THES0001"), "Thesis");
});

test("the display tree nests children under parents, sorts by name and shows loop members as roots", () => {
	const tree = collectionTree(parseCollections(7, RAW));
	const flat = (nodes: ReturnType<typeof collectionTree>, depth = 0): string[] => nodes.flatMap(node => [`${"  ".repeat(depth)}${node.collection.name} (${node.path})`, ...flat(node.children, depth + 1)]);
	assert.deepEqual(flat(tree), [
		"Loop A (Loop B/Loop A)",
		"Loop B (Loop B)",
		"Orphan (Orphan)",
		"Self (Self)",
		"Thesis (Thesis)",
		"  방법론 (Thesis/방법론)",
		"    Surveys (Thesis/방법론/Surveys)",
	]);
});

test("entry collection paths come from direct membership, sorted and de-duplicated", () => {
	const nodes: CollectionNode[] = parseCollections(1, RAW.slice(0, 3));
	const members = new Map([["1:THES0001", ["1:AAAA0001"]], ["1:METH0001", ["1:AAAA0001", "1:AAAA0002"]], ["1:SURV0001", ["1:AAAA0002", "1:AAAA0002"]], ["1:GONE0001", ["1:AAAA0003"]]]);
	const paths = entryCollectionPaths(nodes, members);
	assert.deepEqual(paths.get("1:AAAA0001"), ["Thesis", "Thesis/방법론"]);
	assert.deepEqual(paths.get("1:AAAA0002"), ["Thesis/방법론", "Thesis/방법론/Surveys"]);
	assert.equal(paths.has("1:AAAA0003"), false, "membership of an unknown collection is ignored");
});

function index(extra: Partial<ZoteroIndex> & Record<string, unknown>): ZoteroIndex {
	return { schemaVersion: 2, generatedAt: "2026-10-13T00:00:00.000Z", source: "better-bibtex", count: 0, entries: [], capabilities: { zotero: "10.0.6", betterbibtex: "9.0.71", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true, ...extra } as ZoteroIndex;
}

test("index readers accept older indexes, skip malformed elements and ignore unknown fields", () => {
	assert.deepEqual(indexLibraries(index({})), [], "a 0.5 index has no library list");
	assert.deepEqual(indexLibraries(null), []);
	const libraries = indexLibraries(index({ libraries: [
		{ libraryID: 1, name: "My Library", kind: "user", items: 3, indexed: 3, futureField: true },
		{ libraryID: 2, name: "Lab", kind: "satellite", groupID: 4321, items: -1, indexed: "2" },
		{ libraryID: 0, name: "Broken" }, { name: "No id" }, "junk",
	] as never }));
	assert.deepEqual(libraries, [
		{ libraryID: 1, name: "My Library", kind: "user", items: 3, indexed: 3 },
		{ libraryID: 2, name: "Lab", kind: "unknown", groupID: 4321, items: 0, indexed: 0 },
	]);
	assert.equal(libraryName(index({ libraries: libraries }), 2), "Lab");
	assert.equal(libraryName(index({}), 1), null);
	const collections = indexCollections(index({ collections: [
		{ libraryID: 1, key: "THES0001", name: "Thesis", parentKey: null, items: ["1:AAAA0001", 7], extra: "ignored" },
		{ libraryID: 1, key: "METH0001", name: "방법론", parentKey: "THES0001" },
		{ libraryID: 1, key: "bad", name: "Bad" }, { libraryID: 1, key: "NOPA0001", name: "No parent", parentKey: "not a key", items: [] },
	] as never }));
	assert.deepEqual(collections, [
		{ libraryID: 1, key: "THES0001", name: "Thesis", parentKey: null, items: ["1:AAAA0001"] },
		{ libraryID: 1, key: "METH0001", name: "방법론", parentKey: "THES0001" },
		{ libraryID: 1, key: "NOPA0001", name: "No parent", parentKey: null, items: [] },
	]);
});

test("member lookups: direct and recursive members, unknown or unread membership is null, entry collections by path", () => {
	const value = index({ collections: [
		{ libraryID: 1, key: "THES0001", name: "Thesis", parentKey: null, items: ["1:AAAA0001"] },
		{ libraryID: 1, key: "METH0001", name: "방법론", parentKey: "THES0001", items: ["1:AAAA0002", "1:AAAA0001"] },
		{ libraryID: 1, key: "SURV0001", name: "Surveys", parentKey: "METH0001", items: ["1:AAAA0003"] },
		{ libraryID: 1, key: "UNRD0001", name: "Unread", parentKey: null },
		{ libraryID: 1, key: "KIDS0001", name: "Child of unread", parentKey: "UNRD0001", items: [] },
		{ libraryID: 2, key: "THES0001", name: "Thesis", parentKey: null, items: ["2:BBBB0001"] },
	] });
	assert.deepEqual(membersOf(value, 1, "THES0001"), ["1:AAAA0001"]);
	assert.deepEqual(membersOf(value, 1, "THES0001", { recursive: true }), ["1:AAAA0001", "1:AAAA0002", "1:AAAA0003"]);
	assert.deepEqual(membersOf(value, 2, "THES0001", { recursive: true }), ["2:BBBB0001"], "libraries stay apart");
	assert.equal(membersOf(value, 1, "MISS0001"), null);
	assert.equal(membersOf(value, 1, "UNRD0001"), null, "membership that was not read is unknown, not empty");
	assert.deepEqual(membersOf(value, 1, "KIDS0001"), []);
	assert.deepEqual(collectionsOfEntry(value, "1:AAAA0001").map(collection => [collection.key, collection.path]), [["THES0001", "Thesis"], ["METH0001", "Thesis/방법론"]]);
	assert.deepEqual(collectionsOfEntry(index({}), "1:AAAA0001"), []);
});
