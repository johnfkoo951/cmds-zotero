// 0.6.1 annotation-sidebar-modes: the sidebar's stored state and how each source resolves to an index entry. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorTarget, defaultViewState, emptySourceText, entryForRef, parseViewState, selectionTarget, serializeViewState, type AnnotationsViewState } from "../src/annotations/view-state";
import { noFacets } from "../src/annotations/filter";
import type { ZoteroIndexEntry } from "../src/types";

// Synthetic records only (AGENTS.md).
const item = (libraryID: number, itemKey: string, citekey: string, history: string[] = []): ZoteroIndexEntry => ({
	id: `${libraryID}:${itemKey}`, libraryID, libraryType: libraryID === 1 ? "user" : "group", ...(libraryID === 1 ? {} : { groupID: 900 + libraryID }), itemKey, citekey, citekeyHistory: history,
	title: `Synthetic ${itemKey}`, authors: [], year: "2026", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {},
}) as ZoteroIndexEntry;
const entries = [item(1, "AAAA1111", "synthetic2026a", ["old2020a"]), item(2, "AAAA1111", "synthetic2026group"), item(1, "BBBB2222", "shared2026"), item(2, "CCCC3333", "shared2026"), item(1, "DDDD4444", "synthetic2026d", ["shared2026"])];

test("parse/serialize round trip keeps every field", () => {
	const state: AnnotationsViewState = {
		mode: "pinned", pinned: { libraryID: 2, itemKey: "AAAA1111" }, selected: { libraryID: 1, itemKey: "BBBB2222" },
		facets: { colors: ["red", "none"], types: ["note"], tags: ["중요", "method"], attachments: ["ATTA2345"], comment: "with", query: "기억" }, sort: "reading", group: "color",
	};
	const stored = JSON.parse(JSON.stringify(serializeViewState(state))) as unknown;
	assert.deepEqual(parseViewState(stored), state);
	for (const mode of ["note", "selection", "cursor"] as const) assert.deepEqual(parseViewState(serializeViewState({ ...state, mode })), { ...state, mode });
	assert.deepEqual(parseViewState(serializeViewState(defaultViewState())), defaultViewState());
});

test("malformed or unknown state falls back field by field; pinned mode needs a valid identity", () => {
	for (const raw of [undefined, null, 7, "pinned", [], {}]) assert.deepEqual(parseViewState(raw), defaultViewState());
	assert.equal(parseViewState({ mode: "reader" }).mode, "note", "unknown mode");
	assert.equal(parseViewState({ mode: "pinned" }).mode, "note", "pinned without an item");
	for (const pinned of [{ libraryID: 0, itemKey: "AAAA1111" }, { libraryID: 1, itemKey: "aaaa1111" }, { libraryID: "1", itemKey: "AAAA1111" }, { libraryID: 1.5, itemKey: "AAAA1111" }, { itemKey: "AAAA1111" }, { libraryID: 1, itemKey: "AAAA11112" }]) {
		const state = parseViewState({ mode: "pinned", pinned });
		assert.equal(state.mode, "note", JSON.stringify(pinned));
		assert.equal(state.pinned, null);
	}
	const mixed = parseViewState({ mode: "cursor", sort: "random", group: 3, selected: { libraryID: 1 }, facets: { colors: ["red", "teal", 4], types: ["NOTE"], tags: "x", attachments: ["ATTA2345", "bad"], comment: "maybe", query: 12 } });
	assert.deepEqual(mixed, { ...defaultViewState(), mode: "cursor", facets: { ...noFacets(), colors: ["red"], types: ["note"], attachments: ["ATTA2345"] } });
	assert.equal(parseViewState({ facets: { query: "x".repeat(2000) } }).facets.query.length, 500, "bounded filter text");
	assert.equal(parseViewState({ facets: { tags: Array.from({ length: 300 }, (_, n) => `t${n}`) } }).facets.tags.length, 64, "bounded lists");
});

test("a pinned or selected item resolves by identity only", () => {
	assert.equal(entryForRef(entries, { libraryID: 2, itemKey: "AAAA1111" })?.citekey, "synthetic2026group", "same item key in another library is another item");
	assert.equal(entryForRef(entries, { libraryID: 1, itemKey: "AAAA1111" })?.citekey, "synthetic2026a");
	assert.equal(entryForRef(entries, { libraryID: 3, itemKey: "AAAA1111" }), null);
	assert.equal(entryForRef(entries, null), null);
	assert.equal(entryForRef([], { libraryID: 1, itemKey: "AAAA1111" }), null);
});

test("cursor citekeys: current key first, then history; several candidates are ambiguous, never the first", () => {
	assert.deepEqual(cursorTarget(entries, ""), { kind: "none" });
	const resolved = cursorTarget(entries, "synthetic2026a");
	assert.equal(resolved.kind === "resolved" && resolved.entry.id, "1:AAAA1111");
	const old = cursorTarget(entries, "old2020a");
	assert.equal(old.kind === "resolved" && old.entry.id, "1:AAAA1111", "a previous citekey of one item");
	assert.deepEqual(cursorTarget(entries, "shared2026"), { kind: "ambiguous", citekey: "shared2026", count: 2 }, "two current holders; the history holder is not counted");
	assert.deepEqual(cursorTarget(entries, "nobody2026"), { kind: "not-found", citekey: "nobody2026" });
});

test("a Zotero selection resolves by identity; several indexed items are a choice", () => {
	assert.deepEqual(selectionTarget(entries, []), { kind: "empty" });
	const one = selectionTarget(entries, [{ libraryID: 2, itemKey: "CCCC3333" }]);
	assert.equal(one.kind === "resolved" && one.entry.id, "2:CCCC3333");
	const mixed = selectionTarget(entries, [{ libraryID: 9, itemKey: "ZZZZ9999" }, { libraryID: 1, itemKey: "BBBB2222" }]);
	assert.equal(mixed.kind === "resolved" && mixed.entry.id, "1:BBBB2222", "unindexed items are skipped");
	const several = selectionTarget(entries, [{ libraryID: 1, itemKey: "BBBB2222" }, { libraryID: 2, itemKey: "CCCC3333" }]);
	assert.deepEqual(several.kind === "several" && several.entries.map(entry => entry.id), ["1:BBBB2222", "2:CCCC3333"]);
	assert.deepEqual(selectionTarget(entries, [{ libraryID: 9, itemKey: "ZZZZ9999" }]), { kind: "not-indexed", count: 1 });
});

test("an empty source is explained per mode", () => {
	assert.match(emptySourceText("note"), /Open a literature note/);
	assert.match(emptySourceText("pinned"), /not in the index/);
	assert.match(emptySourceText("selection"), /Select an item in Zotero/);
	assert.match(emptySourceText("selection", { selected: true }), /not in the index/);
	assert.match(emptySourceText("cursor"), /Put the cursor on a @citekey/);
	assert.match(emptySourceText("cursor", { cursor: { kind: "ambiguous", citekey: "k", count: 2 } }), /@k names 2 items/);
	assert.match(emptySourceText("cursor", { cursor: { kind: "not-found", citekey: "k" } }), /@k is not in the index/);
});
