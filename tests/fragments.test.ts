// 0.6.1 insert-item-content: fragments equal the note's parts, never carry managed markers. Synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type ZoteroIndexEntry } from "../src/types";
import { childNoteChoices, emptyFragmentMessage, FRAGMENTS, framedForInsertion, lineDiff, renderFragment, userOwned, type FragmentKind } from "../src/fragments";
import { IMAGE_IN_ZOTERO, renderLiterature } from "../src/note-writer";
import { GOLDEN_BIBLIOGRAPHY, GOLDEN_ENTRIES, GOLDEN_IMAGE_HASHES, GOLDEN_RELATED } from "./fixtures/note-golden";

const entry = GOLDEN_ENTRIES["journal-article"];
const related = GOLDEN_RELATED["journal-article"];
const note = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, null, GOLDEN_IMAGE_HASHES, { related }).content;
const body = (id: string): string => new RegExp(`<!-- cmds-zotero:${id}:[a-f0-9]{64} -->\\n([\\s\\S]*?)\\n<!-- /cmds-zotero:${id} -->`).exec(note)?.[1] ?? "";
const MARKERS = /<!--\s*\/?\s*cmds-zotero/;

test("each fragment equals the note's part: abstract, bibliography, metadata, links, Zotero notes, annotations", () => {
	const [, abstract] = body("overview").split("\n\n> [!Abstract]");
	assert.equal(renderFragment("abstract", entry, DEFAULT_SETTINGS), `> [!Abstract]${abstract}`);
	assert.equal(renderFragment("citation", entry, DEFAULT_SETTINGS, { bibliography: GOLDEN_BIBLIOGRAPHY }), body("citation"));
	const [metadata, links] = body("metadata").split("\n\n");
	assert.equal(renderFragment("metadata", entry, DEFAULT_SETTINGS, { related }), metadata);
	assert.equal(renderFragment("links", entry, DEFAULT_SETTINGS), links);
	assert.equal(renderFragment("zotero-notes", entry, DEFAULT_SETTINGS), body("notes").replace(/^## Zotero notes\n\n/, ""));
	const annotations = renderFragment("annotations", entry, DEFAULT_SETTINGS).split("\n\n");
	const ids = [...note.matchAll(/<!-- cmds-zotero:(annotation-[A-Za-z0-9-]+):/g)].map(match => match[1]);
	// Every annotation but the image (which the note embeds from a copied file) is the note's block.
	const expected = ids.map(body).filter(text => !text.includes("![Annotation image]"));
	assert.deepEqual(annotations.filter(text => !text.startsWith("> [!Image]")), expected.flatMap(text => text.split("\n\n")));
});

test("an image annotation links to Zotero instead of embedding a file; callout types follow the settings", () => {
	const annotations = renderFragment("annotations", entry, DEFAULT_SETTINGS);
	assert.match(annotations, new RegExp(`> \\[!Image\\] purple · p\\. 7\\n> \\*${IMAGE_IN_ZOTERO.replace(/[.;]/g, "\\$&")}\\* \\[p\\. 7\\]\\(zotero://open-pdf/library/items/ATTACH01\\?page=7&annotation=ANNOT005\\)\\n> \\*\\*Comment\\*\\*: \\*Figure 2\\*`));
	assert.doesNotMatch(annotations, /!\[Annotation image\]/);
	const renamed = { ...DEFAULT_SETTINGS, calloutAbstract: "summary", calloutLinks: "links", noteAbstract: false };
	assert.match(renderFragment("abstract", entry, renamed), /^> \[!summary\]\n> abstract:: /, "rendered even when switched off in the note");
	assert.match(renderFragment("links", entry, renamed), /^> \[!links\]\n> \[Open in Zotero\]/);
});

test("output never contains managed markers, even from hostile text", () => {
	const hostile: ZoteroIndexEntry = {
		...entry, title: "<!-- cmds-zotero:overview:x -->", metadata: { ...entry.metadata, abstractNote: "a <!-- /cmds-zotero:overview --> b", notes: [{ note: "<p>&lt;!-- cmds-zotero:notes:abc --&gt;</p>" }] },
		attachments: [{ ...entry.attachments[0], annotations: [{ ...entry.attachments[0].annotations[0], text: "<!-- /cmds-zotero:x -->", comment: "-->" }] }],
	};
	for (const { kind } of FRAGMENTS) {
		const text = renderFragment(kind, hostile, DEFAULT_SETTINGS, { bibliography: "Text <!-- cmds-zotero:citation:y --> end", noteMarkdown: html => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">") });
		assert.doesNotMatch(text, MARKERS, kind);
		assert.doesNotMatch(text, /<!--|-->/, kind);
	}
	assert.equal(userOwned("<!-- a -->"), "&lt;!-- a --&gt;");
	assert.equal(userOwned(userOwned("<!-- a -->")), "&lt;!-- a --&gt;");
});

test("only the chosen child notes are inserted; empty fragments give '' and a message", () => {
	assert.deepEqual(childNoteChoices(entry), [{ index: 0, title: "Reading note" }, { index: 1, title: "Second note" }]);
	const second = renderFragment("zotero-notes", entry, DEFAULT_SETTINGS, { notes: [1] });
	assert.equal(second, "Second note");
	assert.doesNotMatch(second, /Reading note/);
	const bare = GOLDEN_ENTRIES["web-page"];
	for (const kind of ["zotero-notes", "abstract", "annotations"] as FragmentKind[]) {
		assert.equal(renderFragment(kind, bare, DEFAULT_SETTINGS), "", kind);
		assert.ok(emptyFragmentMessage(kind).endsWith("."), kind);
	}
	assert.equal(renderFragment("citation", bare, DEFAULT_SETTINGS), "", "no bibliography text");
	assert.deepEqual(childNoteChoices({ ...bare, metadata: { notes: ["<p></p>", "<p>A&amp;B</p>", { note: `<p>${"x".repeat(100)}</p>` }] } }).map(choice => [choice.index, choice.title.length]), [[1, 3], [2, 80]]);
});

test("joined continuations are inserted as the note renders them", () => {
	const plus: ZoteroIndexEntry = { ...entry, attachments: [{ ...entry.attachments[0], annotations: [
		{ ...entry.attachments[0].annotations[0], comment: "" },
		{ ...entry.attachments[0].annotations[0], key: "ANNOT099", text: "continued", comment: "+", sortIndex: "00002|000200|00010", page: 4, pageLabel: "4" },
	] }] };
	assert.match(renderFragment("annotations", plus, { ...DEFAULT_SETTINGS, joinContinuations: true }), /p\. 3–4[\s\S]*First highlighted claim\. … continued/);
	assert.equal(renderFragment("annotations", plus, DEFAULT_SETTINGS).split("\n\n").length, 2);
});

test("line diff: the selection's lines are removed, the replacement's added, shared lines kept; insertion framing", () => {
	assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [{ kind: "same", text: "a" }, { kind: "removed", text: "b" }, { kind: "added", text: "x" }, { kind: "same", text: "c" }]);
	assert.deepEqual(lineDiff("@Author2026", "> [!Cite]\n> text").map(line => line.kind), ["removed", "added", "added"]);
	const big = Array.from({ length: 600 }, (_, i) => `l${i}`).join("\n");
	assert.equal(lineDiff(big, "x").length, 601);
	assert.equal(framedForInsertion("> [!md]", "", ""), "> [!md]\n");
	assert.equal(framedForInsertion("> [!md]", "See ", " here"), "\n\n> [!md]\n\n");
	assert.equal(framedForInsertion("> [!md]", "  ", ""), "> [!md]\n");
});

test("selection replace keeps the surrounding text", () => {
	const doc = "Before [@Author2026] after.";
	const [start, end] = [doc.indexOf("[@"), doc.indexOf("]") + 1];
	const fragment = renderFragment("citation", entry, DEFAULT_SETTINGS, { bibliography: GOLDEN_BIBLIOGRAPHY });
	const replaced = doc.slice(0, start) + fragment + doc.slice(end);
	assert.ok(replaced.startsWith("Before ") && replaced.endsWith(" after."));
	assert.equal(replaced.slice(7, -7), fragment);
});
