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

// 0.5 R12: provenance tags and the copy Notice.
import { bibliographySourceTag, copyBibliographyNotice, countBibliographySources, fallbackCitation } from "../src/citations/reference-rows";

test("row tags name cached and fallback text; live text carries none", () => {
	assert.equal(bibliographySourceTag({ source: "live" }), null);
	assert.equal(bibliographySourceTag({ source: "cached", renderedAt: "2026-09-14T10:30:00.000Z" }), "cached 2026-09-14");
	assert.equal(bibliographySourceTag({ source: "cached" }), "cached");
	assert.equal(bibliographySourceTag({ source: "cached", renderedAt: "not a date" }), "cached");
	assert.equal(bibliographySourceTag({ source: "fallback" }), "offline: author-year fallback");
});

test("the copy Notice counts cache and fallback entries only when Zotero was offline for some of them", () => {
	assert.equal(copyBibliographyNotice(countBibliographySources([{ source: "live" }, { source: "live" }])), "Copied 2 entries.");
	assert.equal(copyBibliographyNotice(countBibliographySources([{ source: "live" }])), "Copied 1 entry.");
	assert.equal(copyBibliographyNotice(countBibliographySources([{ source: "live" }, { source: "cached" }, { source: "cached" }, { source: "fallback" }])), "Copied 4 entries (2 from cache, 1 fallback; Zotero offline).");
	assert.equal(copyBibliographyNotice(countBibliographySources([{ source: "cached" }])), "Copied 1 entry (1 from cache; Zotero offline).");
	assert.equal(copyBibliographyNotice(countBibliographySources([{ source: "fallback" }, { source: "fallback" }])), "Copied 2 entries (2 fallback; Zotero offline).");
});

test("the author-year fallback line truncates after three authors and marks a missing year", () => {
	assert.equal(fallbackCitation({ authors: ["A", "B", "C", "D"], year: "2020", title: "T" }), "A, B, C et al. (2020). T");
	assert.equal(fallbackCitation({ authors: ["A"], year: "", title: "T" }), "A (n.d.). T");
});

// 0.6 PERF-05: the citekey map comes from the per-generation cache; rows stay exactly what 0.5.0 built per render.
import { scanCitations } from "../src/citations/scan";
import type { ReferenceRow } from "../src/citations/reference-rows";

/** 0.5.0 `resolveReferenceRows`: the citekey map rebuilt from every entry on each call. */
function resolve050(source: string, entries: ZoteroIndexEntry[], loaded: boolean): ReferenceRow[] {
	const byKey = new Map<string, ZoteroIndexEntry[]>();
	for (const item of entries) for (const alias of new Set([item.citekey, ...item.citekeyHistory])) (byKey.get(alias) ?? byKey.set(alias, []).get(alias))?.push(item);
	const rows: ReferenceRow[] = [];
	const seen = new Set<string>();
	for (const occurrence of scanCitations(source)) {
		if (seen.has(occurrence.citekey)) continue;
		seen.add(occurrence.citekey);
		const matches = byKey.get(occurrence.citekey) ?? [];
		if (matches.length === 1) rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: "resolved", entry: matches[0] });
		else if (matches.length > 1) rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: "ambiguous", candidates: matches });
		else rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: loaded ? "not-found" : "unchecked" });
	}
	return rows;
}

test("0.6 PERF-05: rows from the cached citekey map equal the 0.5.0 per-render rows, across renders and generations", () => {
	const entries = Array.from({ length: 60 }, (_, i) => entry(`${i % 5 === 0 ? 2 : 1}:K${String(i).padStart(7, "0")}`, `key${i % 45}`, i % 7 === 0 ? [`old${i}`, `key${(i + 1) % 45}`] : []));
	const note = Array.from({ length: 80 }, (_, i) => `Line ${i} cites [@key${i % 50}; @old${i % 63}] and [[@key${(i * 7) % 50}]] and @missing${i % 4}.`).join("\n");
	for (const loaded of [true, false]) {
		assert.deepEqual(resolveReferenceRows(note, entries, loaded), resolve050(note, entries, loaded));
		assert.deepEqual(resolveReferenceRows(note, entries, loaded), resolve050(note, entries, loaded), "a second render on the same generation");
	}
	const next = entries.map(item => item.citekey === "key3" ? { ...item, citekey: "key3renamed", citekeyHistory: ["key3"] } : item);
	assert.deepEqual(resolveReferenceRows(note, next, true), resolve050(note, next, true), "a new generation is resolved against its own entries");
	assert.ok(resolveReferenceRows(note, entries, true).some(row => row.status === "ambiguous"));
});

test("0.6 PERF-05: ambiguous candidates are a fresh array per call, so a caller cannot alter the shared map", () => {
	const entries = [entry("1:B", "dup2021"), entry("2:C", "dup2021")];
	const first = resolveReferenceRows(text, entries, true).find(row => row.status === "ambiguous");
	first?.candidates?.push(entry("3:D", "dup2021"));
	const second = resolveReferenceRows(text, entries, true).find(row => row.status === "ambiguous");
	assert.equal(second?.candidates?.length, 2);
	assert.notEqual(first?.candidates, second?.candidates);
});
