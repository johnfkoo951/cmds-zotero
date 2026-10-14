// 0.6.1 RICH-TEXT: Zotero's rich-text tags in titles and annotations as Markdown. Synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type Annotation, type ZoteroIndexEntry } from "../src/types";
import { richTextMarkdown, richTextPlain } from "../src/annotations/rich-text";
import { annotationBody, plainText, renderLiterature, richInline } from "../src/note-writer";
import { GOLDEN_BIBLIOGRAPHY, GOLDEN_ENTRIES } from "./fixtures/note-golden";

const escape = (text: string): string => text.replace(/[\\`*_{}[\]()#!|<>~]/g, "\\$&");
const md = (text: string): string => richTextMarkdown(text, escape);

test("whitelisted tags become Markdown: italics, bold, sup/sub kept, spans and line breaks", () => {
	assert.equal(md("<i>E. coli</i> growth"), "*E. coli* growth");
	assert.equal(md("<em>a</em> and <strong>b</strong> and <b>c</b>"), "*a* and **b** and **c**");
	assert.equal(md("H<sub>2</sub>O and x<sup>2</sup>"), "H<sub>2</sub>O and x<sup>2</sup>");
	assert.equal(md('The <span class="nocase">iPhone</span> and <span style="font-variant:small-caps;">Small Caps</span>'), "The iPhone and Small Caps");
	assert.equal(md("one<br>two<br/>three<br />four"), "one\ntwo\nthree\nfour");
	assert.equal(md('<i class="x" data-y="(z)">attrs ignored</i>'), "*attrs ignored*");
	assert.equal(md("<i> padded </i>"), " *padded* ");
	assert.equal(md("<i></i>empty"), "empty");
});

test("nesting: emphasis inside emphasis adds no second marker pair; bold inside italics combines", () => {
	assert.equal(md("<i>outer <i>inner</i> text</i>"), "*outer inner text*");
	assert.equal(md("<b>bold <i>both</i></b>"), "**bold *both***");
	assert.equal(md("<i>a <sup>b</sup></i>"), "*a <sup>b</sup>*");
	assert.equal(richTextMarkdown("<i>x</i> y", escape, { italic: true }), "x y", "already inside *…*");
});

test("unclosed, mismatched, unknown, upper-case and self-closing tags stay escaped text", () => {
	assert.equal(md("<i>unclosed"), "\\<i\\>unclosed");
	assert.equal(md("closing</i> only"), "closing\\</i\\> only");
	// The inner pair closes; the stray </i> is text and the unclosed <i> is written literally.
	assert.equal(md("<i><b>crossed</i></b>"), "\\<i\\>**crossed\\</i\\>**");
	assert.equal(md("<u>under</u> <B>Upper</B> <script>x</script> <i/>"), escape("<u>under</u> <B>Upper</B> <script>x</script> <i/>"));
	assert.equal(md("a < b > c and <273::AID-X>"), escape("a < b > c and <273::AID-X>"));
	for (const text of ["", "plain *stars* _under_ [link](x) #tag", "<<i>>", "x <i", "<!-- cmds-zotero:overview:abc -->"]) assert.equal(md(text), escape(text), text);
});

test("output never forms a marker, a comment or a link, whatever the tags hold", () => {
	for (const text of ["<i><!-- cmds-zotero:overview:" + "a".repeat(64) + " --></i>", "<b>[x](javascript:bad)</b>", "<sup><img src=x></sup>", "<span><!--</span>-->", "<i>`code`</i>"]) {
		const out = md(text);
		assert.doesNotMatch(out, /<!--|-->|\]\(|(?<!\\)<img|(?<!\\)`/, out);
		assert.equal(md(text), out, "deterministic");
	}
	assert.equal(md("<i>".repeat(100) + "deep" + "</i>".repeat(100)).includes("deep"), true);
});

test("plain form for sidebar cards drops the tags and keeps the text", () => {
	assert.equal(richTextPlain('<i>E. coli</i> in H<sub>2</sub>O, <span class="nocase">DNA</span><br>next'), "E. coli in H2O, DNA\nnext");
	assert.equal(richTextPlain("<u>kept</u> <i>open"), "<u>kept</u> <i>open");
});

test("note titles, annotation text and comments render rich text; text without tags is unchanged", () => {
	assert.equal(richInline("A *starred* (title) with #hash"), plainText("A *starred* (title) with #hash"));
	assert.equal(richInline("Line<br>break"), "Line break");
	const entry: ZoteroIndexEntry = { ...GOLDEN_ENTRIES.thesis, title: "Growth of <i>E. coli</i> in H<sub>2</sub>O" };
	const note = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, null).content;
	assert.match(note, /^# Growth of \*E\. coli\* in H<sub>2<\/sub>O$/m);
	assert.match(note, /^> \*\*Title\*\*:: Growth of \*E\. coli\* in H<sub>2<\/sub>O$/m);
	// The frontmatter keeps Zotero's value verbatim (identity keys mirror Zotero).
	assert.match(note, /^title: "Growth of <i>E\. coli<\/i> in H<sub>2<\/sub>O"$/m);
	assert.equal(renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, DEFAULT_SETTINGS, note).content, note, "idempotent");
	const annotation: Annotation = { key: "ANNOT001", attachmentKey: "ATTACH01", type: "highlight", text: "Uses <i>in vivo</i> data", comment: "<b>Key</b> point, <i>see</i> fig.", color: "#ffd400", page: 2, pageLabel: "2", version: 1, uri: "", tags: [], dateModified: "" };
	const body = annotationBody(annotation, undefined, GOLDEN_ENTRIES["journal-article"], DEFAULT_SETTINGS);
	assert.match(body, /<mark class="cmds-zotero-hl-yellow">Uses \*in vivo\* data<\/mark>/);
	assert.match(body, /> \*\*Comment\*\*: \*\*\*Key\*\* point, see fig\.\*/);
	const heading = annotationBody({ ...annotation, color: "#aaaaaa" }, undefined, GOLDEN_ENTRIES["journal-article"], DEFAULT_SETTINGS);
	assert.match(heading, /^##### Uses \*in vivo\* data \[p\. 2\]/);
	const sticky = annotationBody({ ...annotation, type: "note", text: "", comment: "A <i>note</i>" }, undefined, GOLDEN_ENTRIES["journal-article"], DEFAULT_SETTINGS);
	assert.match(sticky, /> A \*note\* \[p\. 2\]/);
});

test("DOIs, URLs, citekeys and tags bypass rich text", () => {
	const entry: ZoteroIndexEntry = { ...GOLDEN_ENTRIES.thesis, doi: "10.1002/(SICI)1097-4571<273::AID>3.0.CO;2-0", url: "https://example.org/<i>x</i>", tags: ["<i>tag</i>"], metadata: { ...GOLDEN_ENTRIES.thesis.metadata, DOI: "10.1002/(SICI)1097-4571<273::AID>3.0.CO;2-0" } };
	const note = renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, { ...DEFAULT_SETTINGS, noteItemTypeFields: true }, null).content;
	assert.match(note, /^> \*\*DOI\*\*:: 10\.1002\/\(SICI\)1097-4571<273::AID>3\.0\.CO;2-0$/m);
	assert.match(note, /^> \*\*URL\*\*:: https:\/\/example\.org\/\\<i\\>x\\<\/i\\>$/m);
	assert.match(note, /^> \*\*Tags\*\*:: \\<i\\>tag\\<\/i\\>$/m);
});
