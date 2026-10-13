// 0.6 retraction-flags-from-zotero: Zotero's own retraction flag (item.search `retracted`) mapped to index ids.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEntry } from "../src/api/normalize";
import { retractedDiagnostics, retractionUnavailableDiagnostic } from "../src/diagnostics";
import { isRetracted, retractedIds, retractedIdsFromRows, retractedTerms } from "../src/library/retraction";
import type { ZoteroIndex } from "../src/types";

function entry(libraryID: number, itemKey: string, citekey: string, groupID?: number) {
	const uri = groupID ? `http://zotero.org/groups/${groupID}/items/${itemKey}` : `http://zotero.org/users/local/Example/items/${itemKey}`;
	return normalizeEntry({ libraryID, itemKey, uri, citationKey: citekey, itemType: "journalArticle", title: `Synthetic ${citekey}`, date: "2026", creators: [], tags: [], attachments: [], notes: [] });
}

test("retraction terms use resultLevel only on Zotero 10 and keep feeds out", () => {
	assert.deepEqual(retractedTerms(10), [["retracted", "true"], ["resultLevel", "item"], ["ignore_feeds"]]);
	assert.deepEqual(retractedTerms(11), [["retracted", "true"], ["resultLevel", "item"], ["ignore_feeds"]]);
	assert.deepEqual(retractedTerms(9), [["retracted", "true"], ["ignore_feeds"]]);
	assert.deepEqual(retractedTerms(null), [["retracted", "true"], ["ignore_feeds"]]);
});

test("search rows map to index ids by item key and library scope; rows that are not indexed parents are ignored", () => {
	const entries = [entry(1, "AAAA0001", "Mine2026"), entry(4, "BBBB0001", "Lab2026", 1234), entry(5, "AAAA0001", "Other2026", 5678)];
	const rows = [
		{ id: "http://zotero.org/groups/1234/items/BBBB0001", citekey: "Lab2026", library: "Lab" },
		{ id: "http://zotero.org/users/local/Example/items/AAAA0001", citekey: "Mine2026", library: "My Library" },
		{ id: "http://zotero.org/users/local/Example/items/AAAA0001", citekey: "Mine2026", library: "My Library" },
		{ id: "http://zotero.org/users/local/Example/items/ANNO0001", library: "My Library" },
		{ id: "http://zotero.org/groups/9999/items/AAAA0001", citekey: "Elsewhere", library: "Unknown" },
		{ id: "not a uri" }, null, "junk",
	];
	assert.deepEqual(retractedIdsFromRows(rows, entries), ["1:AAAA0001", "4:BBBB0001"], "the same item key in another group is not flagged");
	assert.deepEqual(retractedIdsFromRows([], entries), []);
});

test("the index flag reads older indexes as unflagged and skips malformed ids; diagnostics name each flagged entry", () => {
	const older = { entries: [] } as unknown as ZoteroIndex;
	assert.equal(retractedIds(older).size, 0);
	assert.equal(isRetracted(null, "1:AAAA0001"), false);
	const flagged = { retracted: ["1:AAAA0001", 42, "4:BBBB0001"] } as unknown as ZoteroIndex;
	assert.deepEqual([...retractedIds(flagged)], ["1:AAAA0001", "4:BBBB0001"]);
	assert.equal(retractedIds(flagged), retractedIds(flagged), "one set per published array");
	assert.equal(isRetracted(flagged, "4:BBBB0001"), true);
	const entries = [entry(1, "AAAA0001", "Mine2026")];
	assert.deepEqual(retractedDiagnostics(["1:AAAA0001", "9:ZZZZ0001"], entries), [{ code: "retracted-source", severity: "warning", message: "Zotero marks @Mine2026 as retracted (Retraction Watch data in Zotero); check the source before citing it.", itemID: "1:AAAA0001", citekey: "Mine2026" }]);
	assert.deepEqual(retractionUnavailableDiagnostic("synthetic"), { code: "retraction-check-unavailable", severity: "info", message: "Zotero's retraction flags could not be read (synthetic); retracted sources are not marked in this index." });
});
