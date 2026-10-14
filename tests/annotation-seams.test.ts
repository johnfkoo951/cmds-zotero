// 0.6.1 merge seams: the annotations sidebar and search follow the note layout settings. Synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationInsertText, annotationSearchRow } from "../src/annotations/search";
import { annotationBody, renderLiterature } from "../src/note-writer";
import { annotationRows, facetCounts } from "../src/annotations/filter";
import { DEFAULT_SETTINGS, type Annotation, type Attachment, type ZoteroIndexEntry } from "../src/types";

const note = (o: Partial<Annotation> = {}): Annotation => ({
	key: "ANNO2345", attachmentKey: "ATTA2345", type: "highlight", text: "Synthetic", comment: "", color: "#ffd400", page: 12, pageLabel: "12", version: 3, uri: "", tags: [], dateModified: "2026-01-01T00:00:00Z", ...o,
});
const attachment = (annotations: Annotation[], key = "ATTA2345"): Attachment => ({ key, title: "Synthetic.pdf", path: "/synthetic/a.pdf", openURI: `zotero://open-pdf/library/items/${key}`, annotations } as unknown as Attachment);
const entry = (annotations: Annotation[]): ZoteroIndexEntry => ({
	id: "1:ITEM2345", libraryID: 1, libraryType: "user", itemKey: "ITEM2345", citekey: "synthetic2026memory", citekeyHistory: [], title: "Synthetic memory", authors: [], year: "2026", doi: "", url: "",
	collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM2345", attachments: [attachment(annotations)], attachmentStatus: "complete", contentHash: "", metadata: {},
} as unknown as ZoteroIndexEntry);

test("joined: note block vs sidebar callout of the head and the continuation", () => {
	const settings = { ...DEFAULT_SETTINGS, joinContinuations: true };
	const head = note({ key: "HEAD2345", text: "First half", sortIndex: "00001|000001|00010" });
	const cont = note({ key: "CONT2345", text: "second half", comment: "+ go on", sortIndex: "00001|000002|00010", page: 13, pageLabel: "13" });
	const e = entry([head, cont]);
	const rendered = renderLiterature(e, "Bib.", settings, null);
	const noteBlock = rendered.sections.find(s => s.id === "annotation-ATTA2345-HEAD2345")?.body ?? "";
	const sidebarHead = annotationInsertText("callout", head, e, settings); // Insert at cursor / drag / Copy callout
	const sidebarCont = annotationInsertText("callout", cont, e, settings);
	assert.ok(!rendered.sections.some(s => s.id === "annotation-ATTA2345-CONT2345"), "note has no block for the continuation");
	assert.equal(sidebarHead, noteBlock, "head card inserts what the note shows");
	assert.equal(sidebarCont, noteBlock, "the continuation card inserts the joined block too, never a block the note does not have");
	assert.doesNotMatch(sidebarCont, /\+ go on/);
});

test("quote insert is escaped like the note, reads rich text only when the layout does, and can never forge a managed marker", () => {
	const settings = { ...DEFAULT_SETTINGS, noteRichText: true };
	const a = note({ text: "An <i>italic</i> word <!-- cmds-zotero:overview" });
	const e = entry([a]);
	const quote = annotationInsertText("quote", a, e, settings);
	assert.match(quote, /\*italic\*/);
	assert.doesNotMatch(quote, /<!--/);
	assert.doesNotMatch(annotationInsertText("quote", a, e, DEFAULT_SETTINGS), /<i>italic<\/i>/, "rich text off: the tags are escaped as in the note");
	const fresh = renderLiterature(e, "Bib.", settings, null).content;
	const edited = fresh.replace("## Notes\n", `## Notes\n\n${quote}\n`);
	const again = renderLiterature(e, "Bib.", settings, edited);
	const callout = annotationInsertText("callout", a, e, settings);
	const edited2 = fresh.replace("## Notes\n", `## Notes\n\n${callout}\n`);
	assert.deepEqual(renderLiterature(e, "Bib.", settings, edited2).conflicts, []);
	assert.deepEqual(again.conflicts, []);
});

test("search row and facets ignore excluded tags and rich text", () => {
	const a = note({ text: "<b>Bold</b> claim", tags: ["obscite", "method"] });
	const e = entry([a]);
	const row = annotationSearchRow(e, e.attachments[0], a, DEFAULT_SETTINGS.excludedTags);
	assert.equal(row.snippet, "Bold claim");
	assert.doesNotMatch(row.primary, /obscite|<b>/);
	assert.deepEqual(facetCounts(annotationRows(e, DEFAULT_SETTINGS.excludedTags)).tags, [["method", 1]]);
	assert.doesNotMatch(annotationBody(a, undefined, e, DEFAULT_SETTINGS), /obscite/);
});
