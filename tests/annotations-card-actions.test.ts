// 0.6.1 annotation-card-actions: citations, scoped keys, identity links and the annotation data view. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANNOTATION_CARD_ACTIONS, CARD_ACTIONS, annotationData, annotationDataText, citationFor, citationPage, identityLinkFor, pagePosition, scopedKey } from "../src/annotations/card-actions";
import { parseProtocolRequest } from "../src/protocol";
import type { Annotation, ZoteroIndexEntry } from "../src/types";

// Synthetic records only (AGENTS.md).
const note = (o: Partial<Annotation> = {}): Annotation => ({
	key: "ANNO2345", attachmentKey: "ATTA2345", type: "highlight", text: "Synthetic", comment: "", color: "#ffd400", page: 12, pageLabel: "12", version: 3, uri: "", tags: [], dateModified: "2026-01-01T00:00:00Z", ...o,
});
const user = { id: "1:ITEM2345", libraryID: 1, libraryType: "user", itemKey: "ITEM2345", citekey: "synthetic2026memory", citekeyHistory: [], title: "Synthetic memory", attachments: [] } as unknown as ZoteroIndexEntry;
const group = { ...user, id: "4:ITEM2345", libraryID: 4, libraryType: "group", groupID: 6001 } as ZoteroIndexEntry;

test("citation page: the printed label when it has a letter or digit, else the page position", () => {
	assert.equal(citationPage(note()), "12");
	assert.equal(citationPage(note({ pageLabel: "xii" })), "xii");
	assert.equal(citationPage(note({ pageLabel: "가" })), "가", "Korean label");
	assert.equal(citationPage(note({ pageLabel: "부록 3" })), "부록 3");
	assert.equal(citationPage(note({ pageLabel: "-" })), "12", "placeholder label");
	assert.equal(citationPage(note({ pageLabel: "" })), "12");
	assert.equal(citationPage(note({ pageLabel: "", page: 0 })), "1", "no usable position");
	assert.equal(citationPage(note({ pageLabel: "S[2];\n3" })), "S2 3", "brackets, semicolons and line breaks cannot end the citation");
	assert.equal(pagePosition(note({ page: -2 })), 1);
});

test("citation: [@key, p. label], optionally with the Zotero link", () => {
	assert.equal(citationFor(note(), user), "[@synthetic2026memory, p. 12]");
	assert.equal(citationFor(note({ pageLabel: "ⅳ" }), user), "[@synthetic2026memory, p. ⅳ]");
	assert.equal(citationFor(note({ pageLabel: "가" }), user, { link: true }), "[@synthetic2026memory, p. 가] [Zotero](<zotero://open-pdf/library/items/ATTA2345?page=12&annotation=ANNO2345>)");
	assert.equal(citationFor(note(), group, { link: true }), "[@synthetic2026memory, p. 12] [Zotero](<zotero://open-pdf/groups/6001/items/ATTA2345?page=12&annotation=ANNO2345>)");
});

test("keys: bare in the personal library, <libraryID>:<key> in a group", () => {
	assert.equal(scopedKey("ANNO2345", user), "ANNO2345");
	assert.equal(scopedKey("ANNO2345", group), "4:ANNO2345");
	assert.equal(scopedKey(group.itemKey, group), "4:ITEM2345");
});

test("identity link opens the annotation's PDF page and parses back", () => {
	const link = identityLinkFor("Research vault", note(), group);
	assert.equal(link, "obsidian://cmds-zotero?vault=Research+vault&libraryID=4&itemKey=ITEM2345&target=pdf&page=12&annotation=ANNO2345");
	const params = Object.fromEntries(new URL(link).searchParams);
	assert.deepEqual(parseProtocolRequest(params, "Research vault"), { vault: "Research vault", libraryID: 4, itemKey: "ITEM2345", target: "pdf", page: 12, annotation: "ANNO2345" });
	assert.match(identityLinkFor("V", note({ page: 0 }), user), /page=1&/);
	assert.throws(() => identityLinkFor("V", note({ key: "bad" }), user), /Invalid annotation key/);
});

test("annotation data: the normalized annotation with its item and attachment, no local path", () => {
	const data = annotationData(note({ tags: ["중요"] }), { key: "ATTA2345", title: "Main PDF" }, group);
	assert.deepEqual(data.item, { id: "4:ITEM2345", libraryID: 4, libraryType: "group", groupID: 6001, itemKey: "ITEM2345", citekey: "synthetic2026memory", title: "Synthetic memory" });
	assert.deepEqual(data.attachment, { key: "ATTA2345", title: "Main PDF" });
	assert.deepEqual(data.annotation, note({ tags: ["중요"] }));
	const text = annotationDataText(note(), { key: "ATTA2345", title: "Main PDF", contentType: "application/pdf" }, user);
	assert.deepEqual(JSON.parse(text).attachment, { key: "ATTA2345", title: "Main PDF", contentType: "application/pdf" });
	assert.ok(!/"path"/.test(text));
	assert.equal(ANNOTATION_CARD_ACTIONS, CARD_ACTIONS);
	assert.deepEqual(CARD_ACTIONS.map(action => action.id), ["copy-citation", "copy-citation-link", "copy-quote", "copy-callout", "copy-bibliography", "copy-annotation-key", "copy-item-key", "copy-identity-link", "show-data"]);
});
