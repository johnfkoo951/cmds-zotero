// 0.5 R15 fix pass: "Open link under cursor" edge cases and open-pdf resolution against the index.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyLink, resolveOpenPdfTarget } from "../src/protocol";
import { noteRef } from "../src/agent/types";
import type { ZoteroIndexEntry } from "../src/types";

test("classifyLink accepts a bare Zotero link followed by sentence punctuation", () => {
	const period = "Source: zotero://select/library/items/ABCD2345.";
	const hit = classifyLink(period, 20);
	assert.equal(hit.kind, "select");
	if (hit.kind === "select") assert.equal(hit.uri, "zotero://select/library/items/ABCD2345", "the period is not part of the link");
	assert.equal(classifyLink(period, period.length - 1).kind, "select", "caret right after the key still counts");
	assert.equal(classifyLink(period, period.length).kind, "none", "caret after the period is outside the link");

	const comma = "zotero://select/library/items/ABCD2345, and zotero://open-pdf/library/items/EFGH2345?page=4; then";
	assert.equal(classifyLink(comma, 5).kind, "select");
	const pdf = classifyLink(comma, 60);
	assert.equal(pdf.kind, "open-pdf");
	if (pdf.kind === "open-pdf") assert.equal(pdf.parsed.page, 4, "the query survives the trim; only the trailing ';' goes");

	assert.equal(classifyLink("zotero://select/library/items/ABCD23456.", 5).kind, "none", "a nine-character key is still malformed, not truncated to a match");
});

test("classifyLink drops wikilink alias and heading suffixes in line mode and as a selection", () => {
	assert.deepEqual(classifyLink("see [[@smith2020|Smith]] here", 8), { kind: "citekey", citekey: "smith2020" });
	assert.deepEqual(classifyLink("see [[@smith2020#Findings]] here", 12), { kind: "citekey", citekey: "smith2020" });
	assert.deepEqual(classifyLink("see [[@smith2020|Smith]] here", 22), { kind: "citekey", citekey: "smith2020" }, "caret on the closing brackets");
	assert.equal(classifyLink("see [[@smith2020|Smith]] here", 26).kind, "none", "caret outside the wikilink");
	assert.deepEqual(classifyLink("", 0, "[[@smith2020|Smith]]"), { kind: "citekey", citekey: "smith2020" });
	assert.deepEqual(classifyLink("", 0, "[[@smith2020#Findings]]"), { kind: "citekey", citekey: "smith2020" });
	assert.deepEqual(classifyLink("[[@a2020]] and [[@b2021|B]]", 20), { kind: "citekey", citekey: "b2021" }, "the wikilink under the caret wins, not the first one");
	assert.deepEqual(classifyLink("plain [@smith2020] cite", 10), { kind: "citekey", citekey: "smith2020" }, "bracketed citations are unchanged");
});

test("classifyLink treats a selected malformed Zotero URI as nothing, never as a citekey", () => {
	assert.deepEqual(classifyLink("", 0, "zotero://select/library/items/citekey"), { kind: "none" });
	assert.deepEqual(classifyLink("", 0, "<zotero://open-pdf/library/items/EFGH2345?page=0>"), { kind: "none" });
	assert.deepEqual(classifyLink("", 0, "ZOTERO://select/library/items/ABCD2345"), { kind: "none" }, "scheme is case-sensitive in parseZoteroURI; no guess");
	assert.equal(classifyLink("", 0, "zotero://select/library/items/ABCD2345").kind, "select", "a well-formed selection still resolves");
	assert.deepEqual(classifyLink("", 0, "smith2020"), { kind: "citekey", citekey: "smith2020" }, "plain selected citekeys are unchanged");
});

function entry(partial: Partial<ZoteroIndexEntry> & Pick<ZoteroIndexEntry, "itemKey" | "libraryType">): ZoteroIndexEntry {
	return {
		id: `${partial.libraryID ?? 1}:${partial.itemKey}`, libraryID: 1, groupID: undefined, citekey: partial.itemKey.toLowerCase(), citekeyHistory: [], title: partial.itemKey,
		authors: [], year: "", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {},
		...partial,
	};
}
const attachment = (key: string) => ({ key, openURI: `zotero://open-pdf/library/items/${key}`, path: `/x/${key}.pdf`, title: key, annotations: [] });

test("resolveOpenPdfTarget matches attachment keys first, then parent keys, within the link's library only", () => {
	const user = entry({ itemKey: "PARENT01", libraryType: "user", attachments: [attachment("ATTACH01"), attachment("ATTACH02")] });
	const group = entry({ itemKey: "PARENT02", libraryType: "group", groupID: 12345, libraryID: 2, attachments: [attachment("ATTACH03")] });
	const index = { entries: [user, group] };

	assert.deepEqual(resolveOpenPdfTarget(index, { action: "open-pdf", libraryType: "user", itemKey: "ATTACH02" }), { kind: "attachment", entry: user, attachmentKey: "ATTACH02" });
	assert.deepEqual(resolveOpenPdfTarget(index, { action: "open-pdf", libraryType: "user", itemKey: "PARENT01" }), { kind: "parent", entry: user }, "a parent key opens through the entry without pinning an attachment");
	assert.deepEqual(resolveOpenPdfTarget(index, { action: "open-pdf", libraryType: "group", groupID: 12345, itemKey: "ATTACH03" }), { kind: "attachment", entry: group, attachmentKey: "ATTACH03" });
	assert.deepEqual(resolveOpenPdfTarget(index, { action: "open-pdf", libraryType: "group", groupID: 12345, itemKey: "PARENT02" }), { kind: "parent", entry: group });
	assert.deepEqual(resolveOpenPdfTarget(index, { action: "open-pdf", libraryType: "user", itemKey: "ATTACH03" }), { kind: "not-found" }, "a group attachment is not found through the user library");
	assert.deepEqual(resolveOpenPdfTarget(index, { action: "open-pdf", libraryType: "group", groupID: 99999, itemKey: "PARENT02" }), { kind: "not-found" }, "another group never matches");
	assert.deepEqual(resolveOpenPdfTarget(index, { action: "open-pdf", libraryType: "user", itemKey: "NOPE0000" }), { kind: "not-found" });

	const duplicate = entry({ itemKey: "PARENT03", libraryType: "user", attachments: [attachment("ATTACH01")] });
	assert.deepEqual(resolveOpenPdfTarget({ entries: [user, duplicate] }, { action: "open-pdf", libraryType: "user", itemKey: "ATTACH01" }), { kind: "ambiguous" }, "two owners of one attachment key are ambiguous");
	const twin = entry({ itemKey: "PARENT01", libraryType: "user", libraryID: 3 });
	assert.deepEqual(resolveOpenPdfTarget({ entries: [entry({ itemKey: "PARENT01", libraryType: "user" }), twin] }, { action: "open-pdf", libraryType: "user", itemKey: "PARENT01" }), { kind: "ambiguous" }, "two parents with one key are ambiguous");
});

test("noteRef strips the extension case-insensitively, like obsidianOpenURI", () => {
	const ref = noteRef("Main Vault", "Folder/Note.MD");
	assert.equal(ref.basename, "Note");
	assert.equal(ref.uri, "obsidian://open?vault=Main%20Vault&file=Folder%2FNote");
	assert.equal(noteRef("V", "a/b.md").basename, "b");
});
