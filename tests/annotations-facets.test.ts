// 0.6.1 annotation-sidebar-facets: colour, type, tag, attachment and comment facets, sort orders and groupings. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationQuery, annotationRows, facetCounts, facetsActive, filterAnnotations, groupAnnotations, noFacets, sectionVisibility, sortAnnotations, emptyListText, type AnnotationFacets } from "../src/annotations/filter";
import type { Annotation, Attachment } from "../src/types";

// Synthetic records only (AGENTS.md).
const note = (key: string, page: number, o: Partial<Annotation> = {}): Annotation => ({
	key, attachmentKey: "ATTA2345", type: "highlight", text: `Synthetic ${key}`, comment: "", color: "#ffd400", page, pageLabel: String(page), version: 1,
	uri: "", tags: [], dateModified: "2026-01-01T00:00:00Z", ...o,
});
const attachment = (key: string, title: string, annotations: Annotation[]): Attachment => ({ key, openURI: `zotero://open-pdf/library/items/${key}`, path: null, title, annotations });

const main = attachment("ATTA2345", "Main PDF", [
	note("A3", 3, { color: "#ff6666", tags: ["method"], sortIndex: "00002|000300|00100", dateModified: "2026-03-01T00:00:00Z" }),
	note("A1", 1, { comment: "기억 연구의 핵심", sortIndex: "00000|000100|00100", dateModified: "2026-01-05T00:00:00Z" }),
	note("A2", 2, { type: "note", text: "", comment: "Plain note", color: "#5fb236", sortIndex: "00001|000050|00100" }),
	note("A1b", 1, { text: "적응적 기억 Adaptive", tags: ["method", "중요"], sortIndex: "00000|000050|00100", dateModified: "2026-02-01T00:00:00Z" }),
	note("A9", 9, { type: "image", text: "", color: "", sortIndex: "00008|000000|00000" }),
]);
const supplement = attachment("SUPP2345", "", [note("S1", 1, { color: "#ff6666", tags: ["중요"] })]);
const entry = { attachments: [main, supplement] };
const rows = annotationRows(entry);
const keys = (list: { annotation: Annotation }[]): string[] => list.map(row => row.annotation.key);
const facets = (o: Partial<AnnotationFacets>): AnnotationFacets => ({ ...noFacets(), ...o });

test("no facets shows every annotation; each facet alone narrows", () => {
	assert.deepEqual(keys(filterAnnotations(rows, noFacets())), ["A3", "A1", "A2", "A1b", "A9", "S1"]);
	assert.equal(facetsActive(noFacets()), false);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ colors: ["red"] }))), ["A3", "S1"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ colors: ["none"] }))), ["A9"], "an unreadable colour is its own facet value");
	assert.deepEqual(keys(filterAnnotations(rows, facets({ types: ["note"] }))), ["A2"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ types: ["highlight"] }))), ["A3", "A1", "A1b", "S1"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ tags: ["중요"] }))), ["A1b", "S1"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ attachments: ["SUPP2345"] }))), ["S1"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ comment: "with" }))), ["A1", "A2"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ comment: "without" }))), ["A3", "A1b", "A9", "S1"]);
	for (const one of [{ colors: ["red"] }, { types: ["note"] }, { tags: ["x"] }, { attachments: ["X"] }, { comment: "with" as const }, { query: " a " }]) assert.equal(facetsActive(facets(one)), true);
	assert.equal(facetsActive(facets({ query: "   " })), false);
});

test("facets combine: values within a facet are alternatives, facets all apply", () => {
	assert.deepEqual(keys(filterAnnotations(rows, facets({ colors: ["red", "green"] }))), ["A3", "A2", "S1"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ colors: ["red"], tags: ["중요"] }))), ["S1"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ tags: ["method", "중요"], attachments: ["ATTA2345"] }))), ["A3", "A1b"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ colors: ["yellow"], comment: "with", query: "기억" }))), ["A1"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ colors: ["blue"] }))), []);
});

test("Korean and mixed queries match text, comments and tags; composed and decomposed forms match each other", () => {
	assert.deepEqual(keys(filterAnnotations(rows, facets({ query: "기억" }))), ["A1", "A1b"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ query: "중요" }))), ["A1b", "S1"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ query: "ADAPTIVE" }))), ["A1b"]);
	assert.deepEqual(keys(filterAnnotations(rows, facets({ query: "기억".normalize("NFD") }))), ["A1", "A1b"], "a decomposed query");
	const decomposed = annotationRows({ attachments: [attachment("DECO2345", "", [note("D1", 1, { text: "핵심 개념".normalize("NFD") })])] });
	assert.deepEqual(keys(filterAnnotations(decomposed, facets({ query: "핵심" }))), ["D1"], "decomposed annotation text");
	assert.equal(annotationQuery("  기억  "), "기억");
});

test("sorts: page, Zotero reading order with ties, newest modified, colour", () => {
	assert.deepEqual(keys(sortAnnotations(rows, "page")), ["A1", "A1b", "A2", "A3", "A9", "S1"], "attachment, page, indexed order");
	assert.deepEqual(keys(sortAnnotations(rows, "reading")), ["A1b", "A1", "A2", "A3", "A9", "S1"], "sortIndex within an attachment; attachments as listed");
	assert.deepEqual(keys(sortAnnotations(rows, "modified")), ["A3", "A1b", "A1", "A2", "A9", "S1"], "newest first, reading order on ties");
	assert.deepEqual(keys(sortAnnotations(rows, "color")), ["A1", "A1b", "A3", "S1", "A2", "A9"], "palette order (yellow, red, green), uncoloured last");
	// Ties: equal sort indexes keep the indexed order; one annotation without a sort index keeps the whole attachment as indexed.
	const tie = annotationRows({ attachments: [attachment("TIES2345", "", [note("T2", 1, { sortIndex: "00000|000001|00001" }), note("T1", 1, { sortIndex: "00000|000001|00001" }), note("T0", 1, { sortIndex: "00000|000000|00000" })])] });
	assert.deepEqual(keys(sortAnnotations(tie, "reading")), ["T0", "T2", "T1"]);
	const partial = annotationRows({ attachments: [attachment("PART2345", "", [note("P2", 2, { sortIndex: "00001|000000|00000" }), note("P1", 1)])] });
	assert.deepEqual(keys(sortAnnotations(partial, "reading")), ["P2", "P1"]);
	assert.deepEqual(keys(rows), ["A3", "A1", "A2", "A1b", "A9", "S1"], "sorting copies");
});

test("groups: attachment (headings only with several attachments), page, colour", () => {
	const byAttachment = groupAnnotations(sortAnnotations(rows, "page"), "attachment", 2);
	assert.deepEqual(byAttachment.map(section => [section.heading, keys(section.rows)]), [["Main PDF", ["A1", "A1b", "A2", "A3", "A9"]], ["SUPP2345", ["S1"]]]);
	const single = annotationRows({ attachments: [main] });
	assert.deepEqual(groupAnnotations(single, "attachment", 1).map(section => section.heading), [null]);
	const byPage = groupAnnotations(sortAnnotations(rows, "modified"), "page", 2);
	assert.deepEqual(byPage.map(section => [section.heading, keys(section.rows)]), [
		["p. 1 · Main PDF", ["A1b", "A1"]], ["p. 2 · Main PDF", ["A2"]], ["p. 3 · Main PDF", ["A3"]], ["p. 9 · Main PDF", ["A9"]], ["p. 1 · SUPP2345", ["S1"]],
	], "sections by attachment and page; rows keep the sort");
	assert.deepEqual(groupAnnotations(single, "page", 1).map(section => section.heading), ["p. 1", "p. 2", "p. 3", "p. 9"], "page order whatever the row order");
	const byColor = groupAnnotations(sortAnnotations(rows, "page"), "color", 2);
	assert.deepEqual(byColor.map(section => [section.heading, keys(section.rows)]), [["Yellow", ["A1", "A1b"]], ["Red", ["A3", "S1"]], ["Green", ["A2"]], ["No color", ["A9"]]]);
});

test("section visibility, counts and the empty message follow the facets", () => {
	const sections = groupAnnotations(sortAnnotations(rows, "page"), "color", 2);
	assert.deepEqual(sectionVisibility(sections, facets({ tags: ["중요"] })), { cards: [[false, true], [false, true], [false], [false]], headings: [true, true, false, false], shown: 2 });
	assert.deepEqual(sectionVisibility(sections, noFacets()).shown, 6);
	const counts = facetCounts(rows);
	assert.deepEqual(counts.colors, [["yellow", 2], ["red", 2], ["green", 1], ["none", 1]]);
	assert.deepEqual(counts.types, [["highlight", 4], ["note", 1], ["image", 1]]);
	assert.deepEqual(counts.tags, [["method", 2], ["중요", 2]]);
	assert.deepEqual(counts.attachments, [["ATTA2345", 5], ["SUPP2345", 1]]);
	assert.equal(emptyListText(facets({ colors: ["blue"] }), "complete"), "No annotations match the filter.");
	assert.equal(emptyListText(noFacets(), "complete"), "No annotations are indexed for this item.");
	assert.equal(emptyListText(noFacets(), "unavailable"), "Attachment lookup failed at the last refresh. Refresh the index.");
});
