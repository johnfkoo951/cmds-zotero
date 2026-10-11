import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Annotation, type ZoteroIndexEntry } from "../src/types";
import { annotationBody, noteBody, readingOrder, renderLiterature, safeNoteMarkdown } from "../src/note-writer";
import { normalizeAttachments, normalizeEntry } from "../src/api/normalize";

// Synthetic records only.
const annotation = (key: string, page: number, sortIndex: string | undefined, extra: Partial<Annotation> = {}): Annotation => ({
	key, attachmentKey: "ATTACH01", type: "highlight", text: `Text ${key}`, comment: "", color: "#ffd400", page, pageLabel: String(page), version: 1,
	uri: `zotero://open-pdf/library/items/ATTACH01?page=${page}&annotation=${key}`, tags: [], dateModified: "2026-03-01T10:00:00Z", ...(sortIndex ? { sortIndex } : {}), ...extra,
});
function entryWith(annotations: Annotation[], notes: unknown[] = []): ZoteroIndexEntry {
	return {
		id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "Example2026", citekeyHistory: [], title: "Synthetic example", authors: ["Test Author"],
		year: "2026", doi: "", url: "", collections: [], tags: [], attachmentPath: "/synthetic/a.pdf", zoteroSelectURI: "zotero://select/library/items/ITEM0001",
		attachments: [{ key: "ATTACH01", openURI: "zotero://open-pdf/library/items/ATTACH01", path: "/synthetic/a.pdf", title: "PDF", annotations }],
		attachmentStatus: "complete", contentHash: "", metadata: { itemType: "journalArticle", notes },
	};
}
const render = (item: ZoteroIndexEntry, previous: string | null, convert?: (html: string) => string) => renderLiterature(item, "Author (2026). Example.", DEFAULT_SETTINGS, previous, new Map(), convert ? { noteMarkdown: convert } : {});
const positions = (content: string, keys: string[]) => keys.map(key => content.indexOf(`cmds-zotero:annotation-ATTACH01-${key}:`));

test("annotation blocks follow Zotero's reading order, not the order BBT listed them", () => {
	const listed = [annotation("PAGE0005", 5, "00004|000100|00010"), annotation("PAGE0001", 1, "00000|000010|00010"), annotation("PAGE0003", 3, "00002|000050|00010")];
	assert.deepEqual(readingOrder(entryWith(listed)).map(item => item.annotation.key), ["PAGE0001", "PAGE0003", "PAGE0005"]);
	const [first, third, fifth] = positions(render(entryWith(listed), null).content, ["PAGE0001", "PAGE0003", "PAGE0005"]);
	assert(first > 0 && first < third && third < fifth);
	// Without sort indexes the listed order stands.
	assert.deepEqual(readingOrder(entryWith([annotation("BBBB0001", 2, undefined), annotation("AAAA0001", 1, undefined)])).map(item => item.annotation.key), ["BBBB0001", "AAAA0001"]);
});

test("a new annotation on an earlier page lands before later blocks; user prose below the list stays last", () => {
	const initial = render(entryWith([annotation("PAGE0002", 2, "00001|000010|00010"), annotation("PAGE0009", 9, "00008|000010|00010")]), null).content;
	const withProse = `${initial.trimEnd()}\n\nMy own closing thoughts.\n`;
	const updated = render(entryWith([annotation("PAGE0002", 2, "00001|000010|00010"), annotation("PAGE0005", 5, "00004|000010|00010"), annotation("PAGE0009", 9, "00008|000010|00010"), annotation("PAGE0012", 12, "00011|000010|00010")]), withProse);
	assert.deepEqual(updated.conflicts, []);
	const [two, five, nine, twelve] = positions(updated.content, ["PAGE0002", "PAGE0005", "PAGE0009", "PAGE0012"]);
	assert(two < five && five < nine && nine < twelve, "page 5 goes between 2 and 9; page 12 after 9");
	assert(updated.content.indexOf("My own closing thoughts.") > twelve, "prose written below the annotation list stays below it");
	assert.equal(render(entryWith([annotation("PAGE0002", 2, "00001|000010|00010"), annotation("PAGE0005", 5, "00004|000010|00010"), annotation("PAGE0009", 9, "00008|000010|00010"), annotation("PAGE0012", 12, "00011|000010|00010")]), updated.content).content, updated.content, "idempotent");
});

test("a detached block still anchors reading order", () => {
	const initial = render(entryWith([annotation("PAGE0009", 9, "00008|000010|00010")]), null).content;
	const detached = initial.replace(/<!-- cmds-zotero:(annotation-ATTACH01-PAGE0009):[a-f0-9]{64} -->/, "<!-- cmds-zotero:$1:detached -->");
	const updated = render(entryWith([annotation("PAGE0001", 1, "00000|000010|00010"), annotation("PAGE0009", 9, "00008|000010|00010")]), detached);
	assert.deepEqual(updated.conflicts, []);
	const [one, nine] = positions(updated.content, ["PAGE0001", "PAGE0009"]);
	assert(one > 0 && one < nine);
});

test("Zotero child notes keep their structure as marker-safe Markdown", () => {
	const html = '<div data-schema-version="9"><h1>Reading notes</h1><p>See <a href="https://example.org/x">the site</a> and <a href="javascript:alert(1)">this</a>.</p><p><img data-attachment-key="IMAGE001" src="x.png"></p><p>Ends --&gt; here <!-- cmds-zotero:overview:abc --></p><script>alert(1)</script></div>';
	const fake = (input: string): string => input
		.replace(/<script[\s\S]*?<\/script>/g, "SCRIPT-NOT-REMOVED")
		.replace(/<h1>(.*?)<\/h1>/g, "# $1\n\n").replace(/<a href="(.*?)">(.*?)<\/a>/g, "[$2]($1)").replace(/<img[^>]*src="(.*?)"[^>]*>/g, "![]($1)")
		.replace(/<!--(.*?)-->/g, "<!--$1-->").replace(/<\/?(div|p)[^>]*>/g, "\n").replace(/&gt;/g, ">");
	const body = noteBody(html, fake);
	assert.match(body, /^### Reading notes$/m, "an h1 nests under ## Zotero notes");
	assert.match(body, /\[the site\]\(https:\/\/example\.org\/x\)/);
	assert.doesNotMatch(body, /javascript:/);
	assert.match(body, /\*\(image in the Zotero note\)\*/);
	assert.doesNotMatch(body, /<!--|-->|SCRIPT-NOT-REMOVED/);
	assert.equal(noteBody(html, () => { throw new Error("converter failed"); }), noteBody(html), "a failing converter falls back to plain text");
	assert.equal(safeNoteMarkdown("###### Deep\n\n\n\nx"), "###### Deep\n\nx");
	const rendered = render(entryWith([], [{ note: html }]), null, fake).content;
	assert.equal((rendered.match(/<!-- cmds-zotero:notes:/g) ?? []).length, 1, "the note section is one intact managed block");
	assert.match(rendered, /## Zotero notes\n\n### Reading notes/);
});

test("ink annotations render as a named drawing with a link, not an empty highlight", () => {
	const ink = annotation("INK00001", 4, undefined, { type: "ink", text: "" });
	const body = annotationBody(ink, undefined, entryWith([ink]), DEFAULT_SETTINGS);
	assert.match(body, /^> \[!Note\] ink · yellow · p\. 4\n> \*Drawing; open it in Zotero\.\* \[p\. 4\]\(zotero:\/\/open-pdf\/library\/items\/ATTACH01\?page=4&annotation=INK00001\)$/);
	assert.doesNotMatch(body, /<mark/);
});

test("the annotation sort index is kept from Better BibTeX when well formed", () => {
	const raw = { libraryID: 1, citationKey: "Example2026", itemKey: "ABCD2345", uri: "http://zotero.org/users/local/Example/items/ABCD2345", itemType: "journalArticle", title: "T", date: "2026", creators: [], tags: [], attachments: [{ select: "zotero://select/library/items/EFGH2345", title: "PDF" }], notes: [] };
	const entry = normalizeEntry(raw);
	const attachments = normalizeAttachments([{ open: "zotero://open-pdf/library/items/EFGH2345", path: "/synthetic/a.pdf", annotations: [
		{ key: "JKLM2345", parentItem: "EFGH2345", annotationType: "highlight", annotationText: "x", annotationPosition: { pageIndex: 0 }, annotationSortIndex: "00000|000034|00125" },
		{ key: "NPQR2345", parentItem: "EFGH2345", annotationType: "highlight", annotationText: "y", annotationPosition: { pageIndex: 0 }, annotationSortIndex: "<script>" },
	] }], entry);
	assert.equal(attachments[0].annotations[0].sortIndex, "00000|000034|00125");
	assert.equal(attachments[0].annotations[1].sortIndex, undefined, "a malformed sort index is dropped, not trusted");
});
