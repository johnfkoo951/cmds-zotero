// 0.6.1: metadata fields per Zotero item type (opt-in). Synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type ZoteroIndexEntry } from "../src/types";
import { renderLiterature } from "../src/note-writer";
import { extraFields, fieldsFor, GENERIC_FIELDS, OPTIONAL_FIELDS } from "../src/item-fields";
import { GOLDEN_BIBLIOGRAPHY, GOLDEN_ENTRIES, GOLDEN_IMAGE_HASHES, GOLDEN_RELATED } from "./fixtures/note-golden";

const settings = { ...DEFAULT_SETTINGS, noteItemTypeFields: true };
const golden = (name: string): string => readFileSync(join(__dirname, "fixtures", "golden", `${name}.md`), "utf8");
const render = (name: string, previous: string | null = null, entry: ZoteroIndexEntry = GOLDEN_ENTRIES[name]) =>
	renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, settings, previous, GOLDEN_IMAGE_HASHES, { related: GOLDEN_RELATED[name] ?? [] });
/** The `**Label**:: value` lines of the metadata callout. */
const fieldLines = (content: string): string[] => content.split("\n").filter(line => /^> \*\*[^*]+\*\*::/.test(line)).map(line => line.slice(2)).filter(line => !/^\*\*(?:Contribution|Related)\*\*::$/.test(line));

test("field order per item type; an unknown type gets the generic set; DOI and ISBN are not listed twice", () => {
	const labels = (type: string): string[] => fieldsFor(type).map(spec => spec.label);
	const optional = OPTIONAL_FIELDS.map(spec => spec.label);
	assert.deepEqual(labels("thesis"), ["University", "Thesis type", "Location", "Number of pages", "DOI", "ISBN", ...optional]);
	assert.deepEqual(labels("report"), ["Institution", "Report number", "Report type", "Series", "Location", "Pages", "DOI", "ISBN", ...optional]);
	assert.deepEqual(labels("conferencePaper"), ["Proceedings", "Conference", "Publisher", "Location", "Volume", "Pages", "DOI", "ISBN", ...optional]);
	assert.deepEqual(labels("journalArticle"), ["Journal", "Volume", "Issue", "Pages", "DOI", "ISSN", "ISBN", ...optional]);
	assert.deepEqual(labels("webpage"), ["Website", "Website type", "DOI", "ISBN", ...optional]);
	assert.deepEqual(labels("preprint"), ["Repository", "Archive ID", "DOI", "ISBN", ...optional]);
	assert.deepEqual(labels("film"), [...GENERIC_FIELDS.map(spec => spec.label), "DOI", "ISBN", ...optional]);
	assert.deepEqual(labels("toString"), labels("film"), "prototype names are not item types");
	assert.deepEqual(labels(""), labels("film"));
});

test("a thesis lists its university and type, keeps the partial date raw and omits empty fields", () => {
	assert.deepEqual(fieldLines(render("thesis").content), [
		"**Author**:: Student, S.", "**Contributor**:: Advisor, A.", "**Title**:: A thesis about examples", "**Year**:: 2024", "**Citekey**:: @Student2024",
		"**Tags**:: dissertation", "**itemType**:: thesis", "**University**:: Example University", "**Thesis type**:: PhD dissertation", "**Location**:: Example City",
		"**Date**:: 2024-05", "**URL**:: https://example.org/thesis", "**Collections**:: Theses", "**Zotero related**::",
	]);
});

test("web page, preprint (with Extra) and book section", () => {
	assert.deepEqual(fieldLines(render("web-page").content).slice(4), [
		"**itemType**:: webpage", "**Website**:: Example Site", "**Accessed**:: 2023-01-02T03:04:05Z", "**URL**:: https://example.org/page?x=1&y=2", "**Zotero related**::",
	]);
	assert.deepEqual(fieldLines(render("preprint").content).slice(4), [
		"**itemType**:: preprint", "**Repository**:: arXiv", "**Archive ID**:: arXiv:2601.00001", "**DOI**:: 10.48550/arXiv.2601.00001", "**Original Date**:: 2025", "**Zotero related**::",
	]);
	assert.deepEqual(fieldLines(render("book-section").content).slice(5), [
		"**itemType**:: bookSection", "**Book**:: *Handbook of Examples*", "**Publisher**:: Example Press", "**Location**:: Seoul", "**Pages**:: 101-130", "**ISBN**:: 978-0-00-000000-0", "**Zotero related**::",
	]);
});

test("a journal article keeps the 0.6.0 values, escaping and DOI path; record dates come last", () => {
	const entry: ZoteroIndexEntry = { ...GOLDEN_ENTRIES["journal-article"], metadata: { ...GOLDEN_ENTRIES["journal-article"].metadata, dateAdded: "2026-01-02T03:04:05Z", dateModified: "2026-02-03T04:05:06Z", language: "en", shortTitle: "Synthetic_evidence" } };
	const lines = fieldLines(render("journal-article", null, entry).content);
	const classic = fieldLines(golden("journal-article"));
	for (const line of classic) assert.ok(lines.includes(line), line);
	assert.deepEqual(lines.slice(lines.indexOf("**Journal**:: *Journal of Examples*"), lines.indexOf("**URL**:: https://doi.org/10.1234/example_%282026%29")), [
		"**Journal**:: *Journal of Examples*", "**Volume**:: 4", "**Issue**:: 2", "**Pages**:: 10-20", "**DOI**:: 10.1234/example_(2026)", "**Short title**:: Synthetic\\_evidence", "**Language**:: en",
	]);
	assert.deepEqual(lines.slice(-3), ["**Date added**:: 2026-01-02T03:04:05Z", "**Date modified**:: 2026-02-03T04:05:06Z", "**Zotero related**:: [[@Chapter2025]], [[@Student2024]]"]);
});

test("Extra: key: value lines in order; citation key, repeats, URLs and other lines are left out", () => {
	assert.deepEqual(extraFields("Citation Key: Draft2026\nOriginal Date: 2025\nA plain sentence.\nhttps://example.org/x\ntex.howpublished: online\noriginal date: 1999\nPMID:  123 "), [
		["Original Date", "2025"], ["tex.howpublished", "online"], ["PMID", "123"],
	]);
	assert.deepEqual(extraFields(undefined), []);
	assert.deepEqual(extraFields("Key:"), []);
	// Extra values are escaped like any other field; a key that repeats a field label is not written twice.
	const entry: ZoteroIndexEntry = { ...GOLDEN_ENTRIES.preprint, metadata: { ...GOLDEN_ENTRIES.preprint.metadata, extra: "DOI: 10.1/other\nNote: *bold* [x](y)" } };
	const lines = fieldLines(render("preprint", null, entry).content);
	assert.equal(lines.filter(line => line.startsWith("**DOI**::")).length, 1);
	assert.ok(lines.includes("**Note**:: \\*bold\\* \\[x\\]\\(y\\)"));
});

test("switching the option on refreshes an unedited metadata block; an edited one stays as a soft conflict", () => {
	const refreshed = render("thesis", golden("thesis"));
	assert.deepEqual([refreshed.conflicts, refreshed.softConflicts], [[], []]);
	assert.match(refreshed.content, /\*\*University\*\*:: Example University/);
	assert.equal(refreshed.sections.find(section => section.id === "metadata")?.reason, "not edited: refreshed from Zotero");
	const edited = golden("thesis").replace("**Location**:: Example City", "**Location**:: My city");
	const kept = render("thesis", edited);
	assert.deepEqual(kept.softConflicts, ["Edited generated section preserved: metadata"]);
	assert.match(kept.content, /My city/);
	assert.doesNotMatch(kept.content, /University/);
});
