import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceHeader, referenceRowText, resolveReferenceRows } from "../src/citations/reference-rows";
import type { ZoteroIndexEntry } from "../src/types";

const entry = (id: string, citekey: string, citekeyHistory: string[] = []) => ({ id, citekey, citekeyHistory }) as ZoteroIndexEntry;
const text = "See [@known2020] and @gone2019, plus [[@dup2021]] and @known2020 again.";

test("without a loaded snapshot every row is unchecked and no negative is claimed", () => {
	const rows = resolveReferenceRows(text, [], false);
	assert.deepEqual(rows.map(row => [row.citekey, row.status]), [["known2020", "unchecked"], ["gone2019", "unchecked"], ["dup2021", "unchecked"]]);
	assert.equal(rows.some(row => row.status === "not-found"), false);
	const state = { loaded: false, stale: false, ageMinutes: null };
	assert.equal(referenceRowText(rows[1], state), "@gone2019 — index not loaded; refresh to check");
	assert.equal(referenceHeader(rows.length, state), "3 references · index not loaded");
	assert.equal(referenceHeader(1, state), "1 reference · index not loaded");
});

test("a loaded snapshot with zero entries is loaded, so its negatives are real", () => {
	const rows = resolveReferenceRows(text, [], true);
	assert.ok(rows.every(row => row.status === "not-found"));
	const state = { loaded: true, stale: false, ageMinutes: 2 };
	assert.equal(referenceHeader(rows.length, state), "3 references");
	assert.equal(referenceRowText(rows[0], state), "@known2020 is not in the literature index. Refresh the index or check the key.");
});

test("resolution uses citekey history, reports ambiguity, and labels stale negatives with the snapshot age", () => {
	const entries = [entry("1:A", "known2020", ["gone2019"]), entry("1:B", "dup2021"), entry("2:C", "dup2021")];
	const rows = resolveReferenceRows(text, entries, true);
	assert.deepEqual(rows.map(row => [row.citekey, row.status]), [["known2020", "resolved"], ["gone2019", "resolved"], ["dup2021", "ambiguous"]]);
	assert.equal(rows[1].entry?.id, "1:A", "a previous citekey resolves to the renamed entry");
	assert.equal(rows[2].candidates?.length, 2);
	const stale = { loaded: true, stale: true, ageMinutes: 27 * 60 };
	assert.equal(referenceHeader(rows.length, stale), "3 references · index 27 h old");
	assert.equal(referenceRowText(rows[2], stale), "@dup2021 matches 2 items across libraries. Change the citekey in Zotero or narrow the library.");
	assert.equal(referenceRowText({ citekey: "gone2019", line: 0, status: "not-found" }, stale), "@gone2019 is not in the saved index (27 h old); refresh to confirm.");
});
