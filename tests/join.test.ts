// 0.6.1 zi-annot-concat: highlights continued with a leading "+". Synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Annotation, type ZoteroIndexEntry } from "../src/types";
import { displayPageLabel, isContinuation, joinContinuations } from "../src/annotations/join";
import { continuationHeads, ownerMarker, readingOrder, renderedAnnotation, renderLiterature } from "../src/note-writer";
import { describeNoteStatus, literatureNoteStatus, needsSending } from "../src/recent/recent-reads";
import { normalizeSettings } from "../src/settings-data";
import { GOLDEN_BIBLIOGRAPHY, GOLDEN_ENTRIES, GOLDEN_IMAGE_HASHES, GOLDEN_RELATED } from "./fixtures/note-golden";

const a = (key: string, extra: Partial<Annotation> = {}): Annotation => ({
	key, attachmentKey: "ATTACH01", type: "highlight", text: `Text ${key}`, comment: "", color: "#ffd400", page: 3, pageLabel: "3", version: 1,
	uri: "", tags: [], dateModified: "", ...extra,
});
const items = (list: Annotation[], attachment = "ATTACH01") => list.map(annotation => ({ attachment: { key: attachment }, annotation }));
const ON = { ...DEFAULT_SETTINGS, joinContinuations: true };
const base = GOLDEN_ENTRIES["journal-article"];
const entryWith = (annotations: Annotation[]): ZoteroIndexEntry => ({ ...base, attachments: [{ ...base.attachments[0], annotations }] });
const ids = (content: string): string[] => [...content.matchAll(/<!-- cmds-zotero:(annotation-[A-Za-z0-9-]+):[a-f0-9]{64} -->/g)].map(match => match[1]);

test("a chain of three joins into the first: texts with ' … ', comments without '+', merged tags, page span", () => {
	const joined = joinContinuations(items([
		a("AAA1", { comment: "first thought", tags: ["method"] }),
		a("AAA2", { comment: "+ second thought", page: 4, pageLabel: "4", tags: ["Method", "질문"] }),
		a("AAA3", { comment: "+", page: 4, pageLabel: "4" }),
	]));
	assert.equal(joined.length, 1);
	assert.deepEqual(joined[0].continuations, ["AAA2", "AAA3"]);
	const merged = joined[0].annotation;
	assert.deepEqual([merged.key, merged.text, merged.comment, merged.tags, merged.pageLabel], ["AAA1", "Text AAA1 … Text AAA2 … Text AAA3", "first thought · second thought", ["method", "질문"], "3–4"]);
});

test("'+' on the first annotation stays alone with its comment; images never join and are skipped; notes end the chain", () => {
	const lone = joinContinuations(items([a("BBB1", { comment: "+ orphan" })]));
	assert.deepEqual([lone.length, lone[0].annotation.comment, lone[0].continuations], [1, "+ orphan", []]);
	const skipped = joinContinuations(items([a("CCC1"), a("CCC2", { type: "image", text: "", imagePath: "/x.png" }), a("CCC3", { comment: "+" })]));
	assert.deepEqual(skipped.map(joined => [joined.annotation.key, joined.continuations]), [["CCC1", ["CCC3"]], ["CCC2", []]]);
	const imagePlus = joinContinuations(items([a("DDD1"), a("DDD2", { type: "image", text: "", comment: "+ figure" })]));
	assert.deepEqual(imagePlus.map(joined => joined.continuations.length), [0, 0], "an image with '+' never joins");
	const afterNote = joinContinuations(items([a("EEE1"), a("EEE2", { type: "note", text: "", comment: "note" }), a("EEE3", { comment: "+ after note" })]));
	assert.deepEqual(afterNote.map(joined => joined.annotation.key), ["EEE1", "EEE2", "EEE3"]);
});

test("no join across attachments; the page label spans only when pages differ and falls back for placeholder labels", () => {
	const across = joinContinuations([...items([a("FFF1")], "ATTACH01"), ...items([a("FFF2", { attachmentKey: "ATTACH02", comment: "+" })], "ATTACH02")]);
	assert.equal(across.length, 2);
	assert.equal(joinContinuations(items([a("GGG1"), a("GGG2", { comment: "+" })]))[0].annotation.pageLabel, "3");
	assert.equal(joinContinuations(items([a("HHH1", { pageLabel: "-", page: 7 }), a("HHH2", { comment: "+", page: 8, pageLabel: "-" })]))[0].annotation.pageLabel, "7–8");
	assert.equal(displayPageLabel({ page: 0, pageLabel: "" }), "1");
	assert.equal(isContinuation({ comment: "  +x" }), true);
	assert.equal(isContinuation({ comment: "x+" }), false);
	// Bug 34: whitespace-only text is not joinable, and renderedAnnotation checks attachmentKey.
	const blankText = joinContinuations(items([a("WSL1"), a("WSL2", { text: "   ", comment: "+ blank" })]));
	assert.equal(blankText.length, 2);
	const twoAttachments: ZoteroIndexEntry = {
		...base,
		attachments: [
			{ ...base.attachments[0], key: "ATTACH01", annotations: [a("SAMEKEY1", { attachmentKey: "ATTACH01" }), a("CONTKEY1", { attachmentKey: "ATTACH01", comment: "+" })] },
			{ ...base.attachments[0], key: "ATTACH02", annotations: [a("SAMEKEY1", { attachmentKey: "ATTACH02", text: "Other attachment text" })] },
		],
	};
	const otherAnnot = twoAttachments.attachments[1].annotations[0];
	assert.equal(renderedAnnotation(twoAttachments, otherAnnot, ON).text, "Other attachment text");
	assert.equal(renderedAnnotation(twoAttachments, twoAttachments.attachments[0].annotations[0], ON).text, "Text SAMEKEY1 … Text CONTKEY1");
});

test("in a note: off by default (0.6.0 output), on renders one block under the first annotation's ID", () => {
	const annotations = [a("JJJ1", { sortIndex: "00002|000100|00010" }), a("JJJ2", { comment: "+ more", page: 4, pageLabel: "4", sortIndex: "00002|000200|00010" })];
	const entry = entryWith(annotations);
	const off = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, null).content;
	assert.deepEqual(ids(off), ["annotation-ATTACH01-JJJ1", "annotation-ATTACH01-JJJ2"]);
	const on = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, ON, null).content;
	assert.deepEqual(ids(on), ["annotation-ATTACH01-JJJ1"]);
	assert.match(on, /> \[!Highlight\] yellow · p\. 3–4\n> <mark class="cmds-zotero-hl-yellow">Text JJJ1 … Text JJJ2<\/mark> \(\[p\. 3–4\]\(zotero:\/\/open-pdf\/library\/items\/ATTACH01\?page=3&annotation=JJJ1\)\)\n> \*\*Comment\*\*: \*more\*/);
	assert.equal(normalizeSettings({}).joinContinuations, false);
	assert.equal(normalizeSettings({ joinContinuations: "yes" }).joinContinuations, false);
	assert.equal(normalizeSettings({ joinContinuations: true }).joinContinuations, true);
});

test("switching it on: the unedited first block refreshes, the continuation's old block is kept as an orphan; edited blocks stay", () => {
	const entry = entryWith([a("KKK1", { sortIndex: "00002|000100|00010" }), a("KKK2", { comment: "+", sortIndex: "00002|000200|00010" })]);
	const before = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, null).content;
	const after = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, ON, before);
	assert.deepEqual([after.conflicts, after.softConflicts], [[], []]);
	assert.deepEqual(ids(after.content), ["annotation-ATTACH01-KKK1", "annotation-ATTACH01-KKK2"]);
	assert.match(after.content, /Text KKK1 … Text KKK2/);
	assert.equal(after.sections.find(section => section.id === "annotation-ATTACH01-KKK2")?.reason, "joined into the previous highlight: kept", "still in Zotero, only joined");
	const deleted = renderLiterature(entryWith([a("KKK1", { sortIndex: "00002|000100|00010" })]), GOLDEN_BIBLIOGRAPHY, ON, before);
	assert.equal(deleted.sections.find(section => section.id === "annotation-ATTACH01-KKK2")?.reason, "no longer in Zotero: kept", "deleted in Zotero");
	const edited = before.replace("Text KKK1</mark>", "Text KKK1 (mine)</mark>");
	const kept = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, ON, edited);
	assert.deepEqual(kept.softConflicts, ["Edited generated section preserved: annotation-ATTACH01-KKK1"]);
	assert.match(kept.content, /Text KKK1 \(mine\)/);
	// Switching back off: the continuation's kept block refreshes again and the first block returns to its own text.
	const back = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, after.content).content;
	assert.equal(back, before);
});

test("golden notes: joining changes nothing when no comment starts with '+'", () => {
	for (const name of Object.keys(GOLDEN_ENTRIES)) {
		const expected = readFileSync(join(__dirname, "fixtures", "golden", `${name}.md`), "utf8");
		assert.equal(renderLiterature(GOLDEN_ENTRIES[name], GOLDEN_BIBLIOGRAPHY, ON, null, GOLDEN_IMAGE_HASHES, { related: GOLDEN_RELATED[name] ?? [] }).content, expected, name);
	}
	assert.deepEqual(readingOrder(base).length, 7);
});

test("note status: a joined note is current, and a continuation never reads as a new annotation", () => {
	const golden = GOLDEN_ENTRIES["journal-article"];
	const entry: ZoteroIndexEntry = { ...golden, attachments: [{ ...golden.attachments[0], annotations: golden.attachments[0].annotations.map(x => x.key === "ANNOT002" ? { ...x, comment: "+ continues" } : x) }] };
	assert.deepEqual([...continuationHeads(entry)], [["annotation-ATTACH01-ANNOT002", "annotation-ATTACH01-ANNOT001"]]);
	const render = (previous: string | null, settings = ON) => renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, settings, previous, GOLDEN_IMAGE_HASHES, { related: GOLDEN_RELATED["journal-article"] }).content;
	const joined = render(null);
	assert.equal(render(joined), joined, "stable");
	const status = literatureNoteStatus(entry, [{ path: "n.md", text: joined }], ON);
	assert.deepEqual(status, { state: "current", path: "n.md", missing: 0, orphaned: 0, annotations: 7 });
	assert(!needsSending(status));
	assert.equal(describeNoteStatus(status), "Note is up to date");
	assert.equal(literatureNoteStatus(entry, [{ path: "n.md", text: joined }]).state, "behind", "without the setting the continuation needs its own block");
	// A note written before joining keeps the continuation's own block: present, and not counted as deleted in Zotero.
	const older = render(null, DEFAULT_SETTINGS);
	assert.deepEqual(literatureNoteStatus(entry, [{ path: "n.md", text: render(older) }], ON), { state: "current", path: "n.md", missing: 0, orphaned: 0, annotations: 7 });
	// The chain head missing: the head and its continuation both count as missing.
	const headless = joined.replace(/<!-- cmds-zotero:annotation-ATTACH01-ANNOT001:[a-f0-9]{64} -->[\s\S]*?<!-- \/cmds-zotero:annotation-ATTACH01-ANNOT001 -->\n\n/, "");
	assert.ok(headless.includes(ownerMarker(entry.id)) && headless.length < joined.length);
	assert.deepEqual(literatureNoteStatus(entry, [{ path: "n.md", text: headless }], ON).missing, 2);
});
