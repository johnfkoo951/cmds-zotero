import { test } from "node:test";
import assert from "node:assert/strict";
import { arxivFromDoi, normalizeArxiv, normalizeDoi, normalizeTitle, searchIndex } from "../src/agent/search";
import { joinTextItems, locateQuote, normalizeForMatch, parsePageRange } from "../src/pdf/locate";
import type { ZoteroIndexEntry } from "../src/types";

const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({ id: "1:AAAAAAA1", libraryID: 1, libraryType: "user", itemKey: "AAAAAAA1", citekey: "lewis2020retrieval", citekeyHistory: [], title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", authors: ["Lewis, Patrick", "Perez, Ethan"], year: "2020", doi: "10.48550/arXiv.2005.11401", url: "http://arxiv.org/abs/2005.11401", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/AAAAAAA1", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: { extra: "arXiv:2005.11401 [cs.CL]" }, ...o });
const lewis = entry({});
const vogelA = entry({ id: "1:BBBBBBB1", itemKey: "BBBBBBB1", citekey: "vogel2020a", title: "F_Meaningfulness misfit: Consequences of daily meaningful work", doi: "10.1037/apl0000464", url: "", authors: ["Vogel, Ryan"], metadata: {} });
const vogelB = entry({ id: "1:BBBBBBB2", itemKey: "BBBBBBB2", citekey: "vogel2020", title: "Meaningfulness misfit: Consequences of daily meaningful work", doi: "10.1037/apl0000464", url: "", authors: ["Vogel, Ryan"], metadata: {} });
const kim = entry({ id: "1:CCCCCCC1", itemKey: "CCCCCCC1", citekey: "kim2024", title: "Knowledge sharing in hybrid teams", doi: "", url: "", year: "2024", authors: ["Kim, Jisoo"], metadata: {} });
const all = [lewis, vogelA, vogelB, kim];

test("identifier normalization", () => {
	assert.equal(normalizeDoi("https://doi.org/10.1037/APL0000464."), "10.1037/apl0000464");
	assert.equal(normalizeDoi("doi: 10.48550/arXiv.2005.11401"), "10.48550/arxiv.2005.11401");
	assert.equal(normalizeDoi("not a doi"), "");
	assert.equal(normalizeArxiv("arXiv:2005.11401v3"), "2005.11401");
	assert.equal(normalizeArxiv("https://arxiv.org/pdf/2005.11401.pdf"), "2005.11401");
	assert.equal(normalizeArxiv("hep-th/9901001"), "hep-th/9901001");
	assert.equal(arxivFromDoi("10.48550/arxiv.2005.11401"), "2005.11401");
	assert.equal(normalizeTitle("Retrieval‑Augmented “Generation”!"), "retrieval augmented generation");
});

test("doi and arxiv lookups resolve exactly and report duplicates as ambiguous", () => {
	const byDoi = searchIndex(all, { doi: "https://doi.org/10.48550/arXiv.2005.11401" });
	assert.equal(byDoi.status, "resolved");
	if (byDoi.status === "resolved") { assert.equal(byDoi.entry.citekey, "lewis2020retrieval"); assert.equal(byDoi.matchedBy, "doi"); }
	const byArxiv = searchIndex(all, { arxiv: "2005.11401v2" });
	assert.equal(byArxiv.status, "resolved");
	if (byArxiv.status === "resolved") assert.equal(byArxiv.matchedBy, "arxiv");
	const dup = searchIndex(all, { doi: "10.1037/apl0000464" });
	assert.equal(dup.status, "ambiguous");
	assert.deepEqual(dup.candidates.map(c => c.entry.citekey), ["vogel2020", "vogel2020a"]);
	assert.equal(searchIndex(all, { doi: "10.9999/nothing" }).status, "not-found");
});

test("title and free-text lookups rank and refuse to guess", () => {
	const exact = searchIndex(all, { title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" });
	assert.equal(exact.status, "resolved");
	const fuzzy = searchIndex(all, { title: "Knowledge sharing in hybrid teams", year: "2024", author: "Kim" });
	assert.equal(fuzzy.status, "resolved");
	if (fuzzy.status === "resolved") assert.equal(fuzzy.entry.citekey, "kim2024");
	const exactOverFuzzy = searchIndex(all, { title: "Meaningfulness misfit: Consequences of daily meaningful work" });
	assert.equal(exactOverFuzzy.status, "resolved");
	if (exactOverFuzzy.status === "resolved") assert.equal(exactOverFuzzy.entry.citekey, "vogel2020");
	assert.equal(exactOverFuzzy.candidates.length, 2);
	const query = searchIndex(all, { query: "vogel meaningful" });
	assert.equal(query.status, "ambiguous");
	assert.equal(query.candidates.length, 2);
	assert.equal(searchIndex(all, { query: "quantum chromodynamics" }).status, "not-found");
	assert.equal(searchIndex(all, {}).status, "not-found");
});

test("quote location normalizes ligatures, hyphenation and quotes and falls back to token windows", () => {
	const pages = [
		{ page: 1, pageLabel: "i", text: "Abstract. Large pre-trained language models have been shown to store factual knowl-\nedge in their parameters." },
		{ page: 2, pageLabel: "1", text: "We introduce retrieval-augmented generation (RAG) — models which combine pre-trained parametric and non-parametric memory for language generation. The ﬁne-tuned model" },
		{ page: 3, pageLabel: "2", text: "Unrelated page about training details and hyperparameters." },
	];
	assert.equal(normalizeForMatch("knowl-\nedge ﬁne “quoted”"), 'knowledge fine "quoted"');
	const exact = locateQuote(pages, "store factual knowledge in their parameters");
	assert.equal(exact.length, 1);
	assert.equal(exact[0].page, 1);
	assert.equal(exact[0].method, "exact");
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
