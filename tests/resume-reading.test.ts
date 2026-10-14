// 0.6.1 resume-reading-position: an "open PDF" without a page leaves the page out of the open-pdf link, so Zotero's
// reader restores where the person stopped reading; explicit pages and annotation keys are kept. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfURI } from "../src/uris";
import { parseProtocolRequest, pdfTargets } from "../src/protocol";
import type { Annotation, Attachment, ZoteroIndexEntry } from "../src/types";

// Synthetic records only (AGENTS.md).
const note = (o: Partial<Annotation> = {}): Annotation => ({
	key: "ANNO2345", attachmentKey: "ATTA2345", type: "highlight", text: "Synthetic", comment: "", color: "#ffd400", page: 12, pageLabel: "12", version: 3, uri: "", tags: [], dateModified: "2026-01-01T00:00:00Z", ...o,
});
const pdf = (key: string, annotations: Annotation[] = [], path: string | null = `/synthetic/${key}.pdf`): Attachment => ({
	key, title: `${key}.pdf`, path, openURI: `zotero://open-pdf/library/items/${key}`, annotations,
} as unknown as Attachment);
const entry = (attachments: Attachment[]): ZoteroIndexEntry => ({ id: "1:ITEM2345", libraryID: 1, libraryType: "user", itemKey: "ITEM2345", citekey: "synthetic2026", title: "Synthetic", attachments } as unknown as ZoteroIndexEntry);

test("pdfURI without a page has no page parameter; explicit pages and annotation keys stay", () => {
	assert.equal(pdfURI("zotero://open-pdf/library/items/ATTA2345"), "zotero://open-pdf/library/items/ATTA2345");
	assert.equal(pdfURI("zotero://open-pdf/groups/6001/items/ATTA2345"), "zotero://open-pdf/groups/6001/items/ATTA2345");
	assert.equal(pdfURI("zotero://open-pdf/library/items/ATTA2345", 7), "zotero://open-pdf/library/items/ATTA2345?page=7");
	assert.equal(pdfURI("zotero://open-pdf/library/items/ATTA2345", undefined, "ANNO2345"), "zotero://open-pdf/library/items/ATTA2345?annotation=ANNO2345");
	assert.equal(pdfURI("zotero://open-pdf/library/items/ATTA2345", 3, "ANNO2345"), "zotero://open-pdf/library/items/ATTA2345?page=3&annotation=ANNO2345");
});

test("pdf targets: no page resumes; an explicit page and an annotation are kept and narrow the attachments", () => {
	const item = entry([pdf("ATTA2345", [note()]), pdf("ATTB2345"), pdf("WEBL2345", [], null)]);
	assert.deepEqual(pdfTargets(item).map(target => target.uri), ["zotero://open-pdf/library/items/ATTA2345", "zotero://open-pdf/library/items/ATTB2345"], "a web link is not a PDF");
	assert.deepEqual(pdfTargets(item, 4).map(target => target.uri), ["zotero://open-pdf/library/items/ATTA2345?page=4", "zotero://open-pdf/library/items/ATTB2345?page=4"]);
	assert.deepEqual(pdfTargets(item, 12, "ANNO2345").map(target => target.uri), ["zotero://open-pdf/library/items/ATTA2345?page=12&annotation=ANNO2345"]);
	assert.deepEqual(pdfTargets(item, undefined, undefined, "ATTB2345").map(target => target.uri), ["zotero://open-pdf/library/items/ATTB2345"]);
	assert.deepEqual(pdfTargets(item, undefined, "MISS2345"), []);
});

test("an identity link to a PDF without a page carries no page, so the protocol handler resumes", () => {
	const request = parseProtocolRequest({ vault: "Research", libraryID: "1", itemKey: "ITEM2345", target: "pdf" });
	assert.equal(request.page, undefined);
	assert.deepEqual(pdfTargets(entry([pdf("ATTA2345")]), request.page, request.annotation).map(target => target.uri), ["zotero://open-pdf/library/items/ATTA2345"]);
});
