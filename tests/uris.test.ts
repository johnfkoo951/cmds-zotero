// 0.5 R15 — canonical Obsidian addresses, Hookmark-bare Markdown links, row ordering and link classification.
import test from "node:test";
import assert from "node:assert/strict";
import { advancedURI, compareNoteRows, listsAdvancedUri, markdownLink, noteRowRank, obsidianOpenURI, peerNoteURI } from "../src/uris";
import { classifyLink } from "../src/protocol";

/** The shape Hookmark-style clients parse from the clipboard: `[title](url)` with no whitespace inside the URL. */
const HOOKMARK_LINK = /^\[(.+)\]\((\S+)\)$/;

test("obsidianOpenURI matches Obsidian's own copied address: percent-encoded, .md stripped, never '+'", () => {
	assert.equal(obsidianOpenURI("Research", "Notes/@smith2020.md"), "obsidian://open?vault=Research&file=Notes%2F%40smith2020");
	const spaced = obsidianOpenURI("My Vault", "80. References/84. References (Zotero)/@smith2020.md");
	assert.equal(spaced, "obsidian://open?vault=My%20Vault&file=80.%20References%2F84.%20References%20(Zotero)%2F%40smith2020");
	assert.ok(!spaced.includes("+"), "spaces are %20, not +");
	const korean = obsidianOpenURI("연구 볼트", "20. 문헌노트/한글 제목.md");
	assert.equal(new URL(korean).searchParams.get("vault"), "연구 볼트");
	assert.equal(new URL(korean).searchParams.get("file"), "20. 문헌노트/한글 제목");
	const special = obsidianOpenURI("V", "a/b#c?d&e.md");
	assert.equal(special, "obsidian://open?vault=V&file=a%2Fb%23c%3Fd%26e");
	assert.equal(new URL(special).searchParams.get("file"), "a/b#c?d&e");
	assert.equal(obsidianOpenURI("V", "deep/nested/folder/note.MD"), "obsidian://open?vault=V&file=deep%2Fnested%2Ffolder%2Fnote");
	assert.equal(obsidianOpenURI("V", "readme.md.md"), "obsidian://open?vault=V&file=readme.md", "only the final extension is stripped");
	assert.throws(() => obsidianOpenURI(" ", "a.md"));
	assert.throws(() => obsidianOpenURI("V", ".md"));
});

test("peer URI uses Advanced URI only when the peer's community-plugins.json lists it", () => {
	assert.equal(advancedURI("Wiki", "40. Paper Analyses/park2021adaptive/park2021adaptive.md"), "obsidian://advanced-uri?vault=Wiki&filepath=40.%20Paper%20Analyses%2Fpark2021adaptive%2Fpark2021adaptive.md");
	assert.equal(peerNoteURI("Wiki", "a/b.md", { advancedUri: true }), advancedURI("Wiki", "a/b.md"));
	assert.equal(peerNoteURI("Wiki", "a/b.md", { advancedUri: false }), obsidianOpenURI("Wiki", "a/b.md"));
	assert.equal(listsAdvancedUri(["dataview", "obsidian-advanced-uri"]), true);
	assert.equal(listsAdvancedUri(["dataview"]), false);
	assert.equal(listsAdvancedUri({ "obsidian-advanced-uri": true }), false, "only the array form Obsidian writes counts");
	assert.equal(listsAdvancedUri(null), false);
});

test("note rows put paper hubs and @citekey notes before atoms and raw sources, then sort by path", () => {
	const rows = [
		{ path: "40. Paper Analyses/vaswani2017attention/vaswani2017attention-claim-2.md" },
		{ path: "10. Raw Sources/12. Papers/2017-06-12-Attention Is All You Need.md" },
		{ path: "40. Paper Analyses/vaswani2017attention/vaswani2017attention.md" },
		{ path: "40. Paper Analyses/vaswani2017attention/vaswani2017attention-claim-1.md" },
		{ path: "80. References/Zotero/@vaswani2017attention.md" },
		{ path: "40. Paper Analyses/ahn2026prompts/Ahn 2026 - S00 Hub.md" },
	];
	const sorted = [...rows].sort((a, b) => compareNoteRows(a, b, ["vaswani2017attention"]));
	assert.deepEqual(sorted.map(row => row.path), [
		"40. Paper Analyses/ahn2026prompts/Ahn 2026 - S00 Hub.md",
		"40. Paper Analyses/vaswani2017attention/vaswani2017attention.md",
		"80. References/Zotero/@vaswani2017attention.md",
		"10. Raw Sources/12. Papers/2017-06-12-Attention Is All You Need.md",
		"40. Paper Analyses/vaswani2017attention/vaswani2017attention-claim-1.md",
		"40. Paper Analyses/vaswani2017attention/vaswani2017attention-claim-2.md",
	]);
	assert.equal(noteRowRank("x/Vaswani2017Attention.md", ["vaswani2017attention"]), 0, "a note named after the citekey counts as a hub");
	assert.equal(noteRowRank("x/hub-of-something-else.md"), 0);
	assert.equal(noteRowRank("x/subhub.md"), 1, "'hub' must be a whole word");
	assert.equal(noteRowRank("x/summary.md"), 1);
});

test("markdownLink keeps the bracketed form by default and produces a Hookmark-parsable bare form on request", () => {
	const url = "obsidian://open?vault=My%20Vault&file=Notes%2F%40smith2020";
	assert.equal(markdownLink("Smith [2020]", url), `[Smith \\[2020\\]](<${url}>)`);
	const bare = markdownLink("Smith [2020]", url, { bare: true });
	assert.equal(bare, `[Smith \\[2020\\]](${url})`);
	assert.match(bare, HOOKMARK_LINK);
	assert.equal(HOOKMARK_LINK.exec(bare)?.[2], url);
	// Destinations that would otherwise need brackets are percent-encoded instead.
	const risky = markdownLink("T", "zotero://select/library/items/ABCD2345 (copy)\n<x>", { bare: true });
	assert.equal(risky, "[T](zotero://select/library/items/ABCD2345%20%28copy%29%3Cx%3E)");
	assert.match(risky, HOOKMARK_LINK);
	assert.match(markdownLink("A", "zotero://select/library/items/ABCD2345", { bare: true }), HOOKMARK_LINK);
	assert.match(markdownLink("A", "obsidian://cmds-zotero?vault=V&libraryID=1&itemKey=ABCD2345&target=note", { bare: true }), HOOKMARK_LINK);
	// Bracketed form is unchanged for notes and sidebars.
	assert.equal(markdownLink("A", "zotero://x (y)"), "[A](<zotero://x (y)>)");
	assert.doesNotMatch(markdownLink("A", "zotero://x (y)"), HOOKMARK_LINK);
});

test("classifyLink recognises Zotero select/open-pdf URIs under the cursor and falls back to citekeys", () => {
	const select = "See <zotero://select/library/items/ABCD2345> for the item.";
	const hit = classifyLink(select, 10);
	assert.equal(hit.kind, "select");
	if (hit.kind === "select") { assert.equal(hit.uri, "zotero://select/library/items/ABCD2345"); assert.equal(hit.parsed.itemKey, "ABCD2345"); }
	assert.equal(classifyLink(select, 2).kind, "none", "cursor before the link");
	assert.equal(classifyLink(select, 55).kind, "none", "cursor after the link");

	const pdf = "[Paper p. 3](zotero://open-pdf/groups/12345/items/EFGH2345?page=3&annotation=JKLM2345) and [@smith2020]";
	const open = classifyLink(pdf, 30);
	assert.equal(open.kind, "open-pdf");
	if (open.kind === "open-pdf") {
		assert.equal(open.uri, "zotero://open-pdf/groups/12345/items/EFGH2345?page=3&annotation=JKLM2345");
		assert.deepEqual(open.parsed, { action: "open-pdf", libraryType: "group", groupID: 12345, itemKey: "EFGH2345", page: 3, annotationKey: "JKLM2345" });
	}
	assert.deepEqual(classifyLink(pdf, pdf.length - 4), { kind: "citekey", citekey: "smith2020" });
	assert.deepEqual(classifyLink("", 0, "[[@wiki2021]]"), { kind: "citekey", citekey: "wiki2021" });
	assert.equal(classifyLink("", 0, "zotero://select/library/items/ABCD2345").kind, "select", "a selection is classified as a whole");
	assert.equal(classifyLink("zotero://open-pdf/library/items/EFGH2345?page=0", 5).kind, "none", "malformed URIs are never guessed");
	assert.equal(classifyLink("zotero://select/library/items/citekey", 5).kind, "none");
	assert.equal(classifyLink("plain prose", 3).kind, "none");
	assert.equal(classifyLink("user@example.com", 8).kind, "citekey", "citekeyAtCursor semantics are unchanged");
});
