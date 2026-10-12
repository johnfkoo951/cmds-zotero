// 0.6 PERF-15: the Annotations sidebar builds its cards once and the filter only changes what is shown. What is shown must
// stay what 0.5.0 rebuilt on every keystroke: the same cards in the same order, the same headings and the same message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationHaystack, annotationMatches, annotationQuery, annotationsByPage, annotationVisibility, emptyAnnotationsText } from "../src/annotations/filter";
import type { Annotation, Attachment, ZoteroIndexEntry } from "../src/types";

// Synthetic records only (AGENTS.md).
const note = (key: string, page: number, o: Partial<Annotation> = {}): Annotation => ({
	key, attachmentKey: "ATTA2345", type: "highlight", text: `Synthetic text ${key}`, comment: "", color: "#ffd400", page, pageLabel: String(page), version: 1,
	uri: `zotero://open-pdf/library/items/ATTA2345?page=${page}&annotation=${key}`, tags: [], dateModified: "2026-01-01T00:00:00Z", ...o,
});
const attachment = (key: string, title: string, annotations: Annotation[]): Attachment => ({ key, openURI: `zotero://open-pdf/library/items/${key}`, path: null, title, annotations });

/** What 0.5.0 `renderList` put in the list for `filter`: headings, cards and the message, in DOM order. */
function shown050(entry: Pick<ZoteroIndexEntry, "attachments" | "attachmentStatus">, filter: string): string[] {
	const out: string[] = [];
	const query = filter.trim().toLowerCase();
	let shown = 0;
	for (const item of entry.attachments) {
		const annotations = [...item.annotations].sort((a, b) => a.page - b.page).filter(a => !query || `${a.text} ${a.comment} ${a.tags.join(" ")} ${a.pageLabel} ${a.page}`.toLowerCase().includes(query));
		if (!annotations.length) continue;
		if (entry.attachments.length > 1) out.push(`h6 ${item.title || item.key}`);
		for (const annotation of annotations) { out.push(`card ${annotation.key}`); shown++; }
	}
	if (!shown) out.push(`p ${query ? "No annotations match the filter." : entry.attachmentStatus === "unavailable" ? "Attachment lookup failed at the last refresh. Refresh the index." : "No annotations are indexed for this item."}`);
	return out;
}

/** The 0.6 sidebar: every card built once per render, then only the visible ones count. */
function shown06(entry: Pick<ZoteroIndexEntry, "attachments" | "attachmentStatus">, filter: string): string[] {
	const groups = entry.attachments.map(item => ({ item, annotations: annotationsByPage(item) })).filter(group => group.annotations.length);
	const query = annotationQuery(filter);
	const visibility = annotationVisibility(groups.map(group => group.annotations.map(annotationHaystack)), query);
	const out: string[] = [];
	groups.forEach((group, index) => {
		if (entry.attachments.length > 1 && visibility.headings[index]) out.push(`h6 ${group.item.title || group.item.key}`);
		group.annotations.forEach((annotation, position) => { if (visibility.cards[index][position]) out.push(`card ${annotation.key}`); });
	});
	if (!visibility.shown) out.push(`p ${emptyAnnotationsText(query, entry.attachmentStatus)}`);
	return out;
}

const pdf = attachment("ATTA2345", "Main PDF", [
	note("K5", 5, { text: "Memory consolidation", tags: ["Important"] }), note("K1", 1, { text: "Adaptive Memory", comment: "Check the METHOD" }),
	note("K3a", 3, { pageLabel: "iii" }), note("K3b", 3, { text: "", comment: "Comment only" }), note("K2", 2, { tags: ["method", "draft"] }),
	note("K10", 10, { text: "Ten", pageLabel: "x" }), note("K3c", 3, { text: "Third on page three" }),
]);
const supplement = attachment("SUPP2345", "", [note("S2", 2, { text: "Supplement memory" }), note("S1", 1, { text: "Supplement table" })]);
const empty = attachment("EMPT2345", "No annotations", []);
const queries = ["", "   ", "memory", "MEMORY", "  Memory  ", "method", "important", "iii", "x", "3", "10", "1", "page three", "comment only", "supplement", "zzz", "synthetic text", "k2", "draft method"];

test("0.6 PERF-15: the filter shows the same cards, headings and message as the 0.5.0 per-keystroke rebuild", () => {
	const entries: Pick<ZoteroIndexEntry, "attachments" | "attachmentStatus">[] = [
		{ attachments: [pdf], attachmentStatus: "complete" },
		{ attachments: [pdf, empty, supplement], attachmentStatus: "complete" },
		{ attachments: [empty], attachmentStatus: "complete" },
		{ attachments: [], attachmentStatus: "unavailable" },
		{ attachments: [empty, supplement], attachmentStatus: "unavailable" },
	];
	for (const entry of entries) for (const filter of queries) assert.deepEqual(shown06(entry, filter), shown050(entry, filter), `${entry.attachments.map(item => item.key).join(",")} / ${JSON.stringify(filter)}`);
	assert.deepEqual(shown06(entries[1], "memory"), ["h6 Main PDF", "card K1", "card K5", "h6 SUPP2345", "card S2"]);
	assert.deepEqual(shown06(entries[1], "table"), ["h6 SUPP2345", "card S1"], "a heading shows only while one of its cards does");
});

test("0.6 PERF-15: the pure pieces keep the 0.5.0 rules", () => {
	assert.deepEqual(annotationsByPage(pdf).map(item => item.key), ["K1", "K2", "K3a", "K3b", "K3c", "K5", "K10"], "page order, indexed order within a page");
	assert.equal(annotationHaystack(note("K", 7, { text: "A", comment: "B", tags: ["C", "D"], pageLabel: "vii" })), "a b c d vii 7");
	assert.equal(annotationQuery("  MiXed  "), "mixed");
	assert.equal(annotationMatches("anything", ""), true);
	assert.equal(annotationMatches("abc", "bc"), true);
	assert.equal(annotationMatches("abc", "cd"), false);
	assert.deepEqual(annotationVisibility([], "x"), { cards: [], headings: [], shown: 0 });
	assert.equal(emptyAnnotationsText("q", "unavailable"), "No annotations match the filter.");
	assert.equal(emptyAnnotationsText("", "unavailable"), "Attachment lookup failed at the last refresh. Refresh the index.");
	assert.equal(emptyAnnotationsText("", "complete"), "No annotations are indexed for this item.");
});
