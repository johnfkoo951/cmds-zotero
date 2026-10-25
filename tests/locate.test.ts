import { test } from "node:test";
import assert from "node:assert/strict";
import { displayPageLabel, extractQuoteCallouts, joinTextItems, locateBatch, locateQuote, normalizeForMatch, normalizePageLabel, parsePageRange, type PageText } from "../src/pdf/locate";

// Synthetic look-alikes only: shapes reproduce real cases, none of the text, keys or titles are real.
const pages: PageText[] = [
	{ page: 1, pageLabel: "i", text: "Abstract. Large pre-trained language models have been shown to store factual knowl-\nedge in their parameters." },
	{ page: 2, pageLabel: "1", text: "We introduce retrieval-augmented generation (RAG) — models which combine pre-trained parametric and non-parametric memory for language generation. The ﬁne-tuned model" },
	{ page: 3, pageLabel: "2", text: "Unrelated page about training details and hyperparameters." },
];
const OPEN_URI = "zotero://open-pdf/library/items/ATTACH01";

test("quote location normalizes ligatures, hyphenation and quotes and falls back to token windows", () => {
	assert.equal(normalizeForMatch("knowl-\nedge ﬁne “quoted”"), 'knowledge fine "quoted"');
	assert.equal(normalizeForMatch("Æsop’s Œuvre"), "aesop's oeuvre");
	const exact = locateQuote(pages, "store factual knowledge in their parameters");
	assert.equal(exact.length, 1);
	assert.equal(exact[0].page, 1);
	assert.equal(exact[0].method, "exact");
	assert.equal(exact[0].span, undefined);
	const ligature = locateQuote(pages, "The fine-tuned model");
	assert.equal(ligature[0].page, 2);
	const fuzzy = locateQuote(pages, "models that combine parametric memory with non-parametric memory for generation");
	assert.equal(fuzzy[0].page, 2);
	assert.equal(fuzzy[0].method, "tokens");
	assert.ok(fuzzy[0].score >= 0.6);
	assert.deepEqual(locateQuote(pages, "completely absent sentence about elephants"), []);
	assert.throws(() => locateQuote(pages, "short"));
});

test("page ranges parse and validate", () => {
	assert.deepEqual(parsePageRange(undefined, 3), [1, 2, 3]);
	assert.deepEqual(parsePageRange("1-2,5", 6), [1, 2, 5]);
	assert.throws(() => parsePageRange("0-2", 6));
	assert.throws(() => parsePageRange("5-9", 6));
	assert.throws(() => parsePageRange("a", 6));
});

test("pdf text items join into lines with spaces only across visible gaps", () => {
	const items = [
		{ str: "Retrieval", transform: [1, 0, 0, 1, 10, 700], width: 40 },
		{ str: "-Augmented", transform: [1, 0, 0, 1, 50, 700], width: 45 },
		{ str: "Generation", transform: [1, 0, 0, 1, 100, 700], width: 44, hasEOL: true },
		{ str: "next line", transform: [1, 0, 0, 1, 10, 686], width: 30 },
		{ str: "far below", transform: [1, 0, 0, 1, 10, 600], width: 30 },
	];
	assert.equal(joinTextItems(items), "Retrieval-Augmented Generation\nnext line\nfar below");
});

test("page labels collapse to empty when absent, positional or placeholder, and display falls back to the position", () => {
	assert.equal(normalizePageLabel(undefined, 3), "");
	assert.equal(normalizePageLabel(null, 3), "");
	assert.equal(normalizePageLabel("3", 3), "");
	assert.equal(normalizePageLabel(" 3 ", 3), "");
	assert.equal(normalizePageLabel("-", 3), "");
	assert.equal(normalizePageLabel(" – — ", 3), "");
	assert.equal(normalizePageLabel("", 3), "");
	assert.equal(normalizePageLabel("iv", 3), "iv");
	assert.equal(normalizePageLabel("A-1", 3), "A-1");
	assert.equal(normalizePageLabel("12", 3), "12");
	assert.equal(displayPageLabel("-", 7), "7");
	assert.equal(displayPageLabel("", 7), "7");
	assert.equal(displayPageLabel("xii", 7), "xii");
});

test("locateBatch reports found with locator, uri and callout title from the printed label", () => {
	const { results, summary, warnings } = locateBatch(pages, [{ line: 12, quote: "store factual knowledge in their parameters" }], { openURI: OPEN_URI });
	assert.deepEqual(warnings, []);
	assert.deepEqual(summary, { total: 1, found: 1, multiple: 0, fuzzy: 0, notFound: 0 });
	const [result] = results;
	assert.equal(result.line, 12);
	assert.equal(result.matchStatus, "found");
	assert.equal(result.quote.raw, "store factual knowledge in their parameters");
	assert.equal(result.quote.chars, result.quote.normalized.length);
	assert.equal(result.calloutTitle, "원문 (p.i)");
	assert.equal(result.matches.length, 1);
	const [match] = result.matches;
	assert.equal(match.page, 1);
	assert.equal(match.pageLabel, "i");
	assert.equal(match.locator, "p.i");
	assert.equal(match.spansPages, false);
	assert.equal(match.uri, `${OPEN_URI}?page=1`);
	assert.equal(match.method, "exact");
	assert.equal(match.score, 1);
	assert.ok(match.snippet.includes("factual knowledge"));
});

test("locateBatch reports a phrase printed on two pages as multiple with no callout title", () => {
	const duplicated: PageText[] = [
		{ page: 1, pageLabel: "", text: "Running header: knowledge-intensive tasks need retrieval. Body of the first page." },
		{ page: 2, pageLabel: "", text: "Running header: knowledge-intensive tasks need retrieval. Body of the second page." },
		{ page: 3, pageLabel: "", text: "Nothing of note here." },
	];
	const { results, summary } = locateBatch(duplicated, [{ quote: "knowledge-intensive tasks need retrieval" }], { openURI: OPEN_URI });
	assert.equal(summary.multiple, 1);
	assert.equal(results[0].matchStatus, "multiple");
	assert.equal(results[0].calloutTitle, null);
	assert.equal(results[0].line, undefined);
	assert.deepEqual(results[0].matches.map(m => m.locator), ["p.1", "p.2"]);
	assert.deepEqual(results[0].matches.map(m => m.uri), [`${OPEN_URI}?page=1`, `${OPEN_URI}?page=2`]);
});

test("locateBatch marks a quote straddling a page break as spansPages with a two-page locator", () => {
	const straddling: PageText[] = [
		{ page: 4, pageLabel: "3", text: "The final sentence of the page argues that parametric memory alone cannot" },
		{ page: 5, pageLabel: "4", text: "keep pace with a changing world, so retrieval is added. More text follows." },
	];
	const { results, summary } = locateBatch(straddling, [{ quote: "parametric memory alone cannot keep pace with a changing world" }], { openURI: OPEN_URI });
	assert.equal(summary.found, 1);
	const [match] = results[0].matches;
	assert.equal(match.spansPages, true);
	assert.equal(match.page, 4);
	assert.equal(match.locator, "p.3-4");
	assert.equal(match.uri, `${OPEN_URI}?page=4`);
	assert.equal(results[0].calloutTitle, "원문 (p.3-4)");

	const hyphenatedAcrossPages: PageText[] = [
		{ page: 4, pageLabel: "3", text: "The final sentence of the page argues that parametric mem-" },
		{ page: 5, pageLabel: "4", text: "ory alone cannot keep pace with a changing world." },
	];
	const dehyphenated = locateBatch(hyphenatedAcrossPages, [{ quote: "parametric memory alone cannot keep pace" }], { openURI: OPEN_URI });
	assert.equal(dehyphenated.summary.found, 1);
	assert.equal(dehyphenated.results[0].matches[0].spansPages, true);
	assert.equal(dehyphenated.results[0].matches[0].locator, "p.3-4");
});

test("locateBatch classifies token-window hits as fuzzy without a callout title", () => {
	const { results, summary } = locateBatch(pages, [{ quote: "models that combine parametric memory with non-parametric memory for generation" }], { openURI: OPEN_URI });
	assert.equal(summary.fuzzy, 1);
	assert.equal(results[0].matchStatus, "fuzzy");
	assert.equal(results[0].calloutTitle, null);
	assert.equal(results[0].matches[0].method, "tokens");
	assert.ok(results[0].matches[0].score >= 0.6);
	assert.equal(results[0].matches[0].locator, "p.1");
});

test("locateBatch reports absent and too-short quotes as not-found, warning on the short one", () => {
	const { results, summary, warnings } = locateBatch(pages, [{ line: 3, quote: "short" }, { quote: "completely absent sentence about elephants" }], { openURI: OPEN_URI });
	assert.deepEqual(summary, { total: 2, found: 0, multiple: 0, fuzzy: 0, notFound: 2 });
	assert.equal(results[0].matchStatus, "not-found");
	assert.equal(results[0].quote.chars, 5);
	assert.deepEqual(results[0].matches, []);
	assert.equal(results[1].matchStatus, "not-found");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /line 3/);
	assert.match(warnings[0], /8 characters/);
});

test("placeholder and empty page labels never leak into locator, uri or callout title", () => {
	const dashes: PageText[] = [
		{ page: 1, pageLabel: "-", text: "A page whose printed label is a bare dash in the PDF label tree." },
		{ page: 2, pageLabel: "", text: "A page without any printed label at all in the PDF label tree." },
	];
	const { results } = locateBatch(dashes, [{ quote: "printed label is a bare dash" }, { quote: "without any printed label at all" }], { openURI: OPEN_URI });
	assert.equal(results[0].matches[0].pageLabel, "1");
	assert.equal(results[0].matches[0].locator, "p.1");
	assert.equal(results[0].calloutTitle, "원문 (p.1)");
	assert.equal(results[0].matches[0].uri, `${OPEN_URI}?page=1`);
	assert.equal(results[1].matches[0].locator, "p.2");
	assert.equal(results[1].calloutTitle, "원문 (p.2)");
});

test("a --file target yields null uris while keeping locators and titles", () => {
	const { results } = locateBatch(pages, [{ quote: "store factual knowledge in their parameters" }], { openURI: null });
	assert.equal(results[0].matchStatus, "found");
	assert.equal(results[0].matches[0].uri, null);
	assert.equal(results[0].matches[0].locator, "p.i");
	assert.equal(results[0].calloutTitle, "원문 (p.i)");
});

test("quote callouts are extracted with 1-based head lines, payload lines and stripped wrapping quotes", () => {
	const atom = [
		"---",
		"type: paper-analysis",
		"citekey: synth2024example",
		"---",
		"# Claim",
		"",
		"> [!quote] 원문 (p.3)",
		'> "Large pre-trained language models have been shown',
		'> to store factual knowledge in their parameters."',
		"",
		"Some analysis in between.",
		"",
		"> [!QUOTE] §2.1",
		"> “The ﬁne-tuned model outperforms the baseline.”",
		"> — trailing attribution line",
		"Not part of the callout.",
		"   > [!quote]",
		">Indented head, no title, no space after the marker",
		"> [!note] a different callout",
		"> ignored",
	].join("\n");
	const callouts = extractQuoteCallouts(atom);
	assert.deepEqual(callouts.map(c => c.line), [7, 13, 17]);
	assert.equal(callouts[0].quote, "Large pre-trained language models have been shown\nto store factual knowledge in their parameters.");
	// Only a matched wrapping pair is stripped; a closing quote mid-payload leaves the text untouched.
	assert.equal(callouts[1].quote, "“The ﬁne-tuned model outperforms the baseline.”\n— trailing attribution line");
	assert.deepEqual(extractQuoteCallouts("> [!quote]\n> “Fully wrapped curly quote.”"), [{ line: 1, quote: "Fully wrapped curly quote." }]);
	assert.deepEqual(extractQuoteCallouts("> [!quote]\n> 「괄호형 인용」"), [{ line: 1, quote: "괄호형 인용" }]);
	assert.equal(callouts[2].quote, "Indented head, no title, no space after the marker");
	assert.deepEqual(extractQuoteCallouts("no callouts here\n> plain blockquote"), []);
	assert.deepEqual(extractQuoteCallouts("> [!quote] empty payload\nplain"), [{ line: 1, quote: "" }]);
});

test("extracted callouts feed locateBatch end to end", () => {
	const atom = "> [!quote] 원문\n> 'store factual knowledge in their parameters'\n\n> [!quote]\n> nope\n";
	const { results, summary, warnings } = locateBatch(pages, extractQuoteCallouts(atom), { openURI: OPEN_URI });
	assert.deepEqual(summary, { total: 2, found: 1, multiple: 0, fuzzy: 0, notFound: 1 });
	assert.equal(results[0].line, 1);
	assert.equal(results[0].calloutTitle, "원문 (p.i)");
	assert.equal(results[1].line, 4);
	assert.equal(warnings.length, 1);
});
