// 0.6 PERF-05: lookups derived once per index generation (one entries array), shared by every edit-time reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexDerived } from "../src/index-derived";
import { buildAliasIndex } from "../src/note-aliases";
import { completionRows } from "../src/citations/score";
import type { ZoteroIndexEntry } from "../src/types";

// Synthetic records only (AGENTS.md).
const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({
	id: "1:AAAA2345", libraryID: 1, libraryType: "user", itemKey: "AAAA2345", citekey: "alpha2020", citekeyHistory: [], title: "Alpha", authors: ["Example, Ann"], year: "2020",
	doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/AAAA2345", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...o,
});
const alpha = entry({});
const beta = entry({ id: "1:BBBB2345", itemKey: "BBBB2345", citekey: "beta2021", citekeyHistory: ["beta2021", "betaOld", "betaOld"], zoteroSelectURI: "zotero://select/library/items/BBBB2345" });
const groupAlpha = entry({ id: "2:AAAA2345", libraryID: 2, libraryType: "group", groupID: 4242, citekey: "alpha2020", zoteroSelectURI: "zotero://select/groups/4242/items/AAAA2345" });
const renamed = entry({ id: "1:CCCC2345", itemKey: "CCCC2345", citekey: "gamma2022", citekeyHistory: ["alpha2020"], zoteroSelectURI: "zotero://select/library/items/CCCC2345" });
const entries = [alpha, beta, groupAlpha, renamed];

test("one derived cache per entries array: the same array shares it, a new generation (new array) never sees the old one", () => {
	const derived = indexDerived(entries);
	assert.equal(indexDerived(entries), derived);
	assert.equal(derived.entries, entries);
	const next = [...entries];
	assert.notEqual(indexDerived(next), derived, "an equal but new array is a new generation");
	assert.equal(derived.aliasIndex, indexDerived(entries).aliasIndex, "the alias index is built once per generation");
	assert.notEqual(indexDerived(next).aliasIndex, derived.aliasIndex);
});

test("the shared alias index is exactly buildAliasIndex(entries)", () => {
	const derived = indexDerived(entries);
	assert.deepEqual(derived.aliasIndex, buildAliasIndex(entries));
	assert.equal(derived.aliasIndex.aliases.get("alpha2020"), null, "three items claim alpha2020 (two libraries and a history key)");
	assert.equal(derived.aliasIndex.singleLibrary, false);
});

test("citekey lookup covers current keys and history in index order, each entry once per key, like the 0.5.0 per-render map", () => {
	const derived = indexDerived(entries);
	const byKey050 = new Map<string, ZoteroIndexEntry[]>();
	for (const item of entries) for (const alias of new Set([item.citekey, ...item.citekeyHistory])) (byKey050.get(alias) ?? byKey050.set(alias, []).get(alias))?.push(item);
	for (const [key, list] of byKey050) assert.deepEqual(derived.entriesWithCitekey(key), list, key);
	assert.deepEqual(derived.entriesWithCitekey("alpha2020").map(item => item.id), ["1:AAAA2345", "2:AAAA2345", "1:CCCC2345"]);
	assert.deepEqual(derived.entriesWithCitekey("beta2021"), [beta], "a history key equal to the current key is not listed twice");
	assert.deepEqual(derived.entriesWithCitekey("betaOld"), [beta]);
	assert.deepEqual(derived.entriesWithCitekey("missing"), []);
	assert.ok(Object.isFrozen(derived.entriesWithCitekey("missing")), "the shared empty result cannot be mutated");
});

test("id and item-key lookups return what a scan of the entries would, in index order", () => {
	const derived = indexDerived(entries);
	for (const item of entries) {
		assert.deepEqual(derived.entriesWithId(item.id), entries.filter(candidate => candidate.id === item.id));
		assert.equal(derived.entryById(item.id), entries.find(candidate => candidate.id === item.id));
	}
	assert.equal(derived.entryById("9:ZZZZ2345"), null);
	assert.deepEqual(derived.entriesWithId("9:ZZZZ2345"), []);
	assert.deepEqual(derived.entriesWithItemKey("AAAA2345"), [alpha, groupAlpha], "the same item key in two libraries");
	assert.deepEqual(derived.entriesWithItemKey("ZZZZ2345"), []);
});

test("completion rows are the shared completionRows(entries), built on first use", () => {
	const derived = indexDerived(entries);
	assert.deepEqual(derived.completionRows, completionRows(entries));
	assert.equal(derived.completionRows, derived.completionRows);
});

test("lookups are built lazily: a partial record set serves the lookups whose fields it has", () => {
	const partial = [{ id: "1:A", citekey: "known2020", citekeyHistory: ["old2019"] }] as ZoteroIndexEntry[];
	const derived = indexDerived(partial);
	assert.deepEqual(derived.entriesWithCitekey("old2019"), partial);
	assert.equal(derived.entryById("1:A"), partial[0]);
	assert.throws(() => derived.completionRows, TypeError, "completion rows need titles and authors");
	assert.deepEqual(derived.entriesWithCitekey("known2020"), partial, "a failed lookup does not poison the others");
});
