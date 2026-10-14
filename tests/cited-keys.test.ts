// 0.6.2 cited-key-set-pandoc-semantics: synthetic notes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adjacentOccurrence, citedKeyAt, citedKeySet, ignoredRegions, maskIgnored } from "../src/citations/cited-keys";

const note = [
	"---",
	"title: Draft",
	"citekey: own2020",
	"nocite: |",
	"  @extra2001, @extra2002",
	"  @*",
	"tags: [a]",
	"---",
	"See [@smith2020, p. 3; -@doe2019] and @lee2021 or [[@kim2022|Kim]].",
	"Mail someone@example.com, escaped \\@notakey and `@inline2000` code.",
	"<!-- @htmlcomment2000",
	"still comment @htmlcomment2001 -->",
	"%% @obsidian2000 %% after [@after2020]",
	"```",
	"@fenced2000",
	"```",
	"> [!note]",
	"> ```",
	"> @calloutfence2000",
	"> ```",
	"Braced @{weird key 1} and repeat [@smith2020].",
].join("\n");

test("the cited set follows pandoc: code, comments, escapes and e-mails are not citations; -@key counts", () => {
	const set = citedKeySet(note);
	assert.deepEqual(set.occurrences.map(item => [item.citekey, item.form, item.suppressAuthor]), [
		["smith2020", "pandoc", false], ["doe2019", "pandoc", true], ["lee2021", "bare", false], ["kim2022", "wikilink", false],
		["after2020", "pandoc", false], ["weird key 1", "bare", false], ["smith2020", "pandoc", false],
	]);
	assert.deepEqual(set.keys, ["smith2020", "doe2019", "lee2021", "kim2022", "after2020", "weird key 1", "extra2001", "extra2002"]);
	assert.deepEqual(set.nocite.map(item => [item.citekey, item.line]), [["extra2001", 4], ["extra2002", 4]]);
	assert.equal(set.nociteAll, true);
	assert.equal(set.occurrences[0].line, 8);
	assert.equal(set.occurrences[0].column, note.split("\n")[8].indexOf("@smith2020"));
});

test("nocite as a quoted string or a list; a later key ends it; no frontmatter means no nocite", () => {
	assert.deepEqual(citedKeySet("---\nnocite: \"@a1 @b2\"\nlang: ko-KR\n---\nBody @c3").keys, ["c3", "a1", "b2"]);
	assert.deepEqual(citedKeySet("---\nnocite:\n  - \"@a1\"\n  - '@b2'\nother: \"@notnocite\"\n---\n").nocite.map(item => item.citekey), ["a1", "b2"]);
	const plain = citedKeySet("nocite: @x1\nText");
	assert.deepEqual(plain.nocite, []);
	assert.equal(plain.nociteAll, false);
});

test("masking keeps offsets and line breaks; regions are typed", () => {
	const masked = maskIgnored(note);
	assert.equal(masked.length, note.length);
	assert.equal(masked.split("\n").length, note.split("\n").length);
	const kinds = new Set(ignoredRegions(note).map(region => region.kind));
	for (const kind of ["frontmatter", "fence", "code", "html-comment", "obsidian-comment", "escape"]) assert.ok(kinds.has(kind as never), kind);
	// An unclosed fence or comment runs to the end of the note.
	assert.deepEqual(citedKeySet("Before @a1\n```\n@b2").keys, ["a1"]);
	assert.deepEqual(citedKeySet("Before @a1 <!-- @b2\n@c3").keys, ["a1"]);
	// A longer closing fence closes; a different fence character does not.
	assert.deepEqual(citedKeySet("````\n```\n@in1\n````\n@out1").keys, ["out1"]);
	assert.deepEqual(citedKeySet("~~~\n```\n@in1\n~~~\n@out1").keys, ["out1"]);
	// Double-backtick code may contain a single backtick.
	assert.deepEqual(citedKeySet("``a ` @in1`` @out1").keys, ["out1"]);
	// Trailing punctuation is not part of a key; Korean keys are kept.
	assert.deepEqual(citedKeySet("As @doe2019. And @김2020, then (@x.y-z).").keys, ["doe2019", "김2020", "x.y-z"]);
});

test("occurrence navigation wraps around and skips the occurrence under the cursor", () => {
	const text = "A @k1 and @k2.\nB [@k1].\nC [-@k1].";
	const set = citedKeySet(text);
	assert.equal(citedKeyAt(set, { line: 1, ch: 4 }), "k1");
	assert.equal(citedKeyAt(set, { line: 0, ch: 0 }), null);
	const next = adjacentOccurrence(set, "k1", { line: 0, ch: 3 }, "next");
	assert.deepEqual([next?.line, next?.column], [1, 3]);
	const wrap = adjacentOccurrence(set, "k1", { line: 2, ch: 5 }, "next");
	assert.deepEqual([wrap?.line, wrap?.column], [0, 2]);
	const previous = adjacentOccurrence(set, "k1", { line: 0, ch: 3 }, "previous");
	assert.deepEqual([previous?.line, previous?.suppressAuthor], [2, true]);
	assert.equal(adjacentOccurrence(set, "missing", { line: 0, ch: 0 }, "next"), null);
});
