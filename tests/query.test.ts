// 0.6.1 R18: the fielded picker query (pure parser and predicates over synthetic index entries).
import test from "node:test";
import assert from "node:assert/strict";
import { filterEntries, matchesQuery, needsNotes, parseQuery, queryContext, rankingQuery } from "../src/search/query";
import { completionRows, rankCompletions } from "../src/citations/score";
import { entry } from "./agent-fixtures";
import type { ZoteroIndex } from "../src/types";

const PDF = { key: "PDFAAAA1", openURI: "zotero://open-pdf/library/items/PDFAAAA1", path: "/synthetic/a.pdf", title: "Full text", annotations: [] };
const KIM = entry({ itemKey: "KIMA2345", citekey: "kim2019", title: "질적 연구 방법론", authors: ["김민수", "Lee, Ji"], year: "2019", tags: ["Method", "survey"], collections: ["Thesis/방법론", "Thesis/방법론/Surveys"], metadata: { itemType: "journalArticle" }, attachments: [PDF] });
const DOE = entry({ itemKey: "DOEB2345", citekey: "doe2021", title: "Deep reading at scale", authors: ["Doe, Jane"], year: "2021", tags: ["draft"], collections: ["Teaching"], metadata: { itemType: "book" } });
const OLD = entry({ itemKey: "OLDC2345", citekey: "old1998", title: "An older study", authors: ["Roe, Ray"], year: "", libraryID: 2, libraryType: "group", groupID: 7, collections: [], metadata: { itemType: "bookSection" }, attachments: [{ ...PDF, key: "EPUBAAA1", path: "/synthetic/a.epub", contentType: "application/epub+zip", annotations: [], readerAnnotations: [{ key: "RANN0001", attachmentKey: "EPUBAAA1", type: "highlight", text: "x", comment: "", color: "#ffd400", pageLabel: "", version: 1, uri: "zotero://select/groups/7/items/EPUBAAA1", tags: [], dateModified: "", position: { type: "FragmentSelector" } }] }] });
const ALL = [KIM, DOE, OLD];
const INDEX = { libraries: [{ libraryID: 1, name: "My Library", kind: "user", items: 2, indexed: 2 }, { libraryID: 2, name: "Lab Group", kind: "group", groupID: 7, items: 1, indexed: 1 }] } as Pick<ZoteroIndex, "libraries">;
const CONTEXT = queryContext(INDEX, candidate => candidate.id === DOE.id);
const ids = (query: string): string[] => filterEntries(ALL, parseQuery(query).terms, CONTEXT).map(candidate => candidate.citekey);

test("parseQuery separates fielded terms from free text; quotes, negation and aliases", () => {
	assert.deepEqual(parseQuery("deep reading"), { text: "deep reading", terms: [] });
	const parsed = parseQuery(`neural col:"Thesis/Related work" -tag:draft au:kim year:2019-2021 "exact phrase"`);
	assert.equal(parsed.text, "neural exact phrase");
	assert.deepEqual(parsed.terms.map(term => [term.field, term.value, term.negate]), [["col", "Thesis/Related work", false], ["tag", "draft", true], ["author", "kim", false], ["year", "2019-2021", false]]);
	const year = parsed.terms[3];
	assert.ok(year.field === "year" && year.from === 2019 && year.to === 2021);
	assert.deepEqual(parseQuery("year:2021-2019").terms.map(term => term.field === "year" ? [term.from, term.to] : null), [[2019, 2021]]);
	assert.deepEqual(parseQuery("year:2019-").terms.map(term => term.field === "year" ? [term.from, term.to] : null), [[2019, null]]);
	assert.deepEqual(parseQuery("year:..2000").terms.map(term => term.field === "year" ? [term.from, term.to] : null), [[null, 2000]]);
});

test("unknown fields and unreadable values stay text; an empty known field is dropped while typing", () => {
	assert.deepEqual(parseQuery("foo:bar https://example.org"), { text: "foo:bar https://example.org", terms: [] });
	assert.deepEqual(parseQuery("year:soon has:video"), { text: "year:soon has:video", terms: [] });
	assert.deepEqual(parseQuery("tag: smith"), { text: "smith", terms: [] });
	assert.deepEqual(parseQuery("-word"), { text: "-word", terms: [] });
	assert.equal(parseQuery("TAG:Method").terms[0].field, "tag");
});

test("predicates: Korean names, tag case-folding, collection closure, library, type, year and has", () => {
	assert.deepEqual(ids("author:김민수"), ["kim2019"]);
	assert.deepEqual(ids("au:lee"), ["kim2019"]);
	assert.deepEqual(ids("title:방법론"), ["kim2019"]);
	assert.deepEqual(ids("tag:method"), ["kim2019"]);
	assert.deepEqual(ids("tag:meth"), [], "tags compare whole, not by substring");
	assert.deepEqual(ids("-tag:DRAFT"), ["kim2019", "old1998"]);
	// A parent collection matches entries filed in its subcollections; a segment run matches at any depth.
	assert.deepEqual(ids("col:thesis"), ["kim2019"]);
	assert.deepEqual(ids("col:방법론/surveys"), ["kim2019"]);
	assert.deepEqual(ids("col:Thes"), [], "collection segments compare whole");
	assert.deepEqual(ids("lib:2"), ["old1998"]);
	assert.deepEqual(ids("lib:lab"), ["old1998"]);
	assert.deepEqual(ids("-lib:group"), ["kim2019", "doe2021"]);
	assert.deepEqual(ids(`type:"journal article"`), ["kim2019"]);
	assert.deepEqual(ids("type:book-section"), ["old1998"]);
	assert.deepEqual(ids("year:2019-2020"), ["kim2019"]);
	assert.deepEqual(ids("year:2020-"), ["doe2021"]);
	assert.deepEqual(ids("-year:2021"), ["kim2019", "old1998"], "an entry without a year never matches a year");
	assert.deepEqual(ids("has:pdf"), ["kim2019"], "an EPUB is not a PDF");
	assert.deepEqual(ids("has:annotations"), ["old1998"], "reader annotations count");
	assert.deepEqual(ids("has:note"), ["doe2021"]);
	assert.deepEqual(ids("-has:pdf tag:draft"), ["doe2021"]);
	assert.deepEqual(filterEntries(ALL, parseQuery("has:note").terms, queryContext(INDEX)).map(candidate => candidate.citekey), [], "without a note lookup has:note matches nothing");
	assert.equal(needsNotes(parseQuery("has:note").terms), true);
	assert.equal(needsNotes(parseQuery("has:pdf tag:x").terms), false);
	assert.equal(matchesQuery(KIM, [], CONTEXT), true);
});

test("plain-text completion ranking is unchanged; a field prefix narrows rows before ranking", () => {
	const rows = completionRows(ALL);
	assert.deepEqual(rankCompletions(rows, "doe").map(candidate => candidate.citekey), ["doe2021"]);
	const parsed = parseQuery("col:Teaching");
	assert.deepEqual(rankCompletions(rows.filter(row => matchesQuery(row.entry, parsed.terms, CONTEXT)), parsed.text).map(candidate => candidate.citekey), ["doe2021"]);
	assert.deepEqual(filterEntries(ALL, [], CONTEXT), ALL);
});

test("rankingQuery: an empty field still being typed ranks like the query without it; plain queries keep the raw text", () => {
	assert.deepEqual(rankingQuery("tag:"), { terms: [], text: "", fielded: true });
	assert.deepEqual(rankingQuery("smith tag:"), { terms: [], text: "smith", fielded: true });
	assert.deepEqual(rankingQuery("-col: smith"), { terms: [], text: "smith", fielded: true });
	assert.deepEqual(rankingQuery("smith  jones"), { terms: [], text: "smith  jones", fielded: false }, "no field syntax: the raw query, unchanged");
	assert.deepEqual(rankingQuery("foo:bar"), { terms: [], text: "foo:bar", fielded: false }, "an unknown field is plain text");
	assert.deepEqual(rankingQuery("year:soon"), { terms: [], text: "year:soon", fielded: false }, "an unreadable value stays text");
	assert.equal(rankingQuery("tag:draft deep").fielded, true);
	assert.equal(rankingQuery("tag:draft deep").text, "deep");
	const rows = completionRows(ALL);
	const ranked = (query: string): string[] => { const plan = rankingQuery(query); const filtered = plan.terms.length ? rows.filter(row => matchesQuery(row.entry, plan.terms, CONTEXT)) : rows; return rankCompletions(filtered, plan.fielded ? plan.text : query).map(candidate => candidate.citekey); };
	assert.deepEqual(ranked("tag:"), ranked(""));
	assert.deepEqual(ranked("doe tag:"), ranked("doe"));
	assert.deepEqual(ranked("doe tag:"), ["doe2021"]);
});

test("IMP-KOREAN-QUERY-IME: Korean field aliases, Korean has values, and typographic quotes", () => {
	assert.deepEqual(ids("저자:김민수"), ["kim2019"]);
	assert.deepEqual(ids("제목:방법론"), ["kim2019"]);
	assert.deepEqual(ids("연도:2019"), ["kim2019"]);
	assert.deepEqual(ids("년도:2021"), ["doe2021"]);
	assert.deepEqual(ids("태그:method"), ["kim2019"]);
	assert.deepEqual(ids("-태그:draft"), ["kim2019", "old1998"]);
	assert.deepEqual(ids("컬렉션:방법론/surveys"), ["kim2019"]);
	assert.deepEqual(ids("폴더:Teaching"), ["doe2021"]);
	assert.deepEqual(ids("라이브러리:lab"), ["old1998"]);
	assert.deepEqual(ids("유형:book"), ["doe2021"]);
	assert.deepEqual(ids("종류:“journal article”"), ["kim2019"]);
	assert.deepEqual(ids("포함:첨부"), ["kim2019"]);
	assert.deepEqual(ids("포함:노트"), ["doe2021"]);
	assert.deepEqual(ids("포함:주석"), ["old1998"]);
	assert.deepEqual(ids("포함:하이라이트"), ["old1998"]);
	assert.deepEqual(ids(`${"저자".normalize("NFD")}:김민수`), ["kim2019"]);
	const parsed = parseQuery("제목:“질적 연구” “exact phrase”");
	assert.equal(parsed.text, "exact phrase");
	assert.deepEqual(parsed.terms, [{ field: "title", value: "질적 연구", negate: false }]);
});

