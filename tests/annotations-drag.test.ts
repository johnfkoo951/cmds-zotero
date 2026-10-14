// 0.6.1 annotation-drag-insert: the drag payload, resolving it by identity, drop placement and the shared image path. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANNOTATION_DRAG_TYPE, dragPayload, dropText, encodeDragPayload, parseDragPayload, resolveDragPayload } from "../src/annotations/drag-payload";
import { annotationImagePath, renderLiterature } from "../src/note-writer";
import { DEFAULT_SETTINGS, type Annotation, type Attachment, type ZoteroIndexEntry } from "../src/types";

// Synthetic records only (AGENTS.md).
const note = (o: Partial<Annotation> = {}): Annotation => ({
	key: "ANNO2345", attachmentKey: "ATTA2345", type: "highlight", text: "Synthetic", comment: "", color: "#ffd400", page: 12, pageLabel: "12", version: 3, uri: "", tags: [], dateModified: "2026-01-01T00:00:00Z", ...o,
});
const attachment = (annotations: Annotation[], key = "ATTA2345"): Attachment => ({ key, title: "Synthetic.pdf", path: null, openURI: `zotero://open-pdf/library/items/${key}`, annotations });
const entry = (o: Partial<ZoteroIndexEntry> = {}, annotations: Annotation[] = [note()]): ZoteroIndexEntry => ({
	id: "1:ITEM2345", libraryID: 1, libraryType: "user", itemKey: "ITEM2345", citekey: "synthetic2026", citekeyHistory: [], title: "Synthetic", authors: [], year: "2026", doi: "", url: "", collections: [], tags: [],
	attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM2345", attachments: [attachment(annotations)], attachmentStatus: "complete", contentHash: "", metadata: {}, ...o,
}) as ZoteroIndexEntry;

test("payload round trip by identity, under its own type", () => {
	assert.equal(ANNOTATION_DRAG_TYPE, "application/x-cmds-zotero-annotation");
	const payload = dragPayload(entry({ libraryID: 4, itemKey: "ITEM6789" }), "ATTA2345", "ANNO2345");
	const raw = encodeDragPayload(payload);
	assert.deepEqual(JSON.parse(raw), { v: 1, id: "4:ITEM6789", attachmentKey: "ATTA2345", key: "ANNO2345" });
	assert.deepEqual(parseDragPayload(raw), { libraryID: 4, itemKey: "ITEM6789", attachmentKey: "ATTA2345", key: "ANNO2345" });
});

test("foreign or malformed payloads are ignored", () => {
	const good = { v: 1, id: "1:ITEM2345", attachmentKey: "ATTA2345", key: "ANNO2345" };
	for (const raw of [undefined, null, "", "text", "[]", "null", "42", JSON.stringify({ ...good, v: 2 }), JSON.stringify({ ...good, id: "0:ITEM2345" }),
		JSON.stringify({ ...good, id: "ITEM2345" }), JSON.stringify({ ...good, id: "1:item2345" }), JSON.stringify({ ...good, key: "../x" }), JSON.stringify({ ...good, attachmentKey: 5 }),
		JSON.stringify({ ...good, pad: "x".repeat(600) })]) {
		assert.equal(parseDragPayload(raw), null, String(raw));
	}
	assert.ok(parseDragPayload(JSON.stringify(good)));
});

test("a payload resolves by identity, the shown (live) entry first; nothing else is guessed", () => {
	const indexed = entry();
	const live = entry({}, [note(), note({ key: "NEWW2345", text: "Fresh" })]);
	const payload = dragPayload(indexed, "ATTA2345", "NEWW2345");
	assert.equal(resolveDragPayload([indexed], payload), null, "not in the index");
	assert.equal(resolveDragPayload([null, live, indexed], payload)?.annotation.text, "Fresh");
	assert.equal(resolveDragPayload([entry({ libraryID: 2 }, [note({ key: "NEWW2345" })])], payload), null, "another library");
	assert.equal(resolveDragPayload([indexed], dragPayload(indexed, "ATTB2345", "ANNO2345")), null, "another attachment");
	assert.equal(resolveDragPayload([indexed], dragPayload(indexed, "ATTA2345", "ANNO2345"))?.entry, indexed);
});

test("a drop inside a line starts the callout on its own line and ends it with a line break", () => {
	assert.equal(dropText("> [!Highlight] p. 1\n> text\n", 0), "> [!Highlight] p. 1\n> text\n");
	assert.equal(dropText("> [!Highlight] p. 1", 7), "\n> [!Highlight] p. 1\n");
});

test("the drag and insert image path is the import's image path", () => {
	const digest = "b".repeat(64);
	const image = note({ imagePath: "/synthetic/cache/ANNO2345.png", type: "image", text: "" });
	for (const item of [entry({}, [image]), entry({ id: "4:ITEM2345", libraryID: 4, libraryType: "group", groupID: 6001 }, [image])]) {
		const rendered = renderLiterature(item, "APA", { ...DEFAULT_SETTINGS, imageFolder: "Reference images" }, null, new Map([[image.imagePath ?? "", digest]]));
		assert.deepEqual(rendered.images.map(plan => plan.path), [annotationImagePath("Reference images", item, "ATTA2345", image, digest)]);
	}
	assert.equal(annotationImagePath("References/Zotero/images", entry(), "ATTA2345", image, digest), `References/Zotero/images/user-1-ATTA2345-ANNO2345-${digest}.png`);
	assert.throws(() => annotationImagePath("img", entry(), "ATTA2345", { ...image, imagePath: "/synthetic/x.svg" }, digest), /extension/);
	assert.throws(() => annotationImagePath("img", entry(), "ATTA2345", image, "nothex"), /hash/);
	assert.throws(() => annotationImagePath("../img", entry(), "ATTA2345", image, digest));
});
