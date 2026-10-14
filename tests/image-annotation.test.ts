// 0.6.1 G21: an image annotation without a cached image. Synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Annotation, type ZoteroIndexEntry } from "../src/types";
import { annotationBody, hashText, IMAGE_NOT_CACHED, renderLiterature } from "../src/note-writer";
import { GOLDEN_BIBLIOGRAPHY, GOLDEN_ENTRIES } from "./fixtures/note-golden";

const entry = GOLDEN_ENTRIES["journal-article"];
const image: Annotation = { key: "IMAGE009", attachmentKey: "ATTACH01", type: "image", text: "", comment: "", color: "#a28ae5", page: 7, pageLabel: "7", version: 1, uri: "", tags: [], dateModified: "" };

test("an image annotation without an image is a named [!Image] block with its Zotero link, never an empty <mark>", () => {
	const body = annotationBody(image, undefined, entry, DEFAULT_SETTINGS);
	assert.equal(body, `> [!Image] purple · p. 7\n> *${IMAGE_NOT_CACHED}* [p. 7](zotero://open-pdf/library/items/ATTACH01?page=7&annotation=IMAGE009)`);
	assert.doesNotMatch(body, /<mark|\[!Highlight\]|\[!Note\]/);
	assert.equal(IMAGE_NOT_CACHED, "Image not available in Zotero's cache; open it in Zotero.");
});

test("its comment and tags are kept, and an uncoloured or upper-case typed image still gets the placeholder", () => {
	const body = annotationBody({ ...image, comment: "Figure <i>3</i>", tags: ["figure", "결과"] }, undefined, entry, { ...DEFAULT_SETTINGS, noteRichText: true });
	assert.equal(body.split("\n").slice(2).join("\n"), "> **Comment**: *Figure 3*\n> Tags: figure, 결과");
	const plain = annotationBody({ ...image, comment: "Figure <i>3</i>" }, undefined, entry, DEFAULT_SETTINGS);
	assert.equal(plain.split("\n").slice(2).join("\n"), "> **Comment**: *Figure \\<i\\>3\\</i\\>*", "rich text is opt-in");
	assert.match(annotationBody({ ...image, color: "", type: "Image" }, undefined, entry, DEFAULT_SETTINGS), /^> \[!Image\] p\. 7\n> \*Image not available/);
});

test("in a note: an image without imagePath renders the placeholder; one with a cached image keeps the embed", () => {
	const item: ZoteroIndexEntry = { ...entry, attachments: [{ ...entry.attachments[0], annotations: [image] }] };
	const note = renderLiterature(item, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, null).content;
	assert.match(note, /<!-- cmds-zotero:annotation-ATTACH01-IMAGE009:[a-f0-9]{64} -->\n> \[!Image\] purple · p\. 7\n> \*Image not available/);
	assert.equal(renderLiterature(item, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, null).images.length, 0);
	// A 0.6.0 note held an empty highlight for it: unedited, it refreshes to the placeholder on the next update.
	const old = note.replace(/(<!-- cmds-zotero:annotation-ATTACH01-IMAGE009:)[a-f0-9]{64}( -->\n)[\s\S]*?(\n<!-- \/cmds-zotero:annotation-ATTACH01-IMAGE009 -->)/, (_, open: string, close: string, end: string) => {
		const body = "> [!Highlight] purple · p. 7\n> <mark class=\"cmds-zotero-hl-purple\"></mark> ([p. 7](zotero://open-pdf/library/items/ATTACH01?page=7&annotation=IMAGE009))";
		return `${open}${hashText(body)}${close}${body}${end}`;
	});
	assert.match(old, /<mark class="cmds-zotero-hl-purple"><\/mark>/);
	const updated = renderLiterature(item, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, old);
	assert.deepEqual([updated.conflicts, updated.softConflicts], [[], []]);
	assert.equal(updated.content, note);
});
