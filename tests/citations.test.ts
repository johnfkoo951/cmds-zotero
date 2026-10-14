import { test } from "node:test";
import assert from "node:assert/strict";
import { scanCitations, scanFrontmatterCitations, uniqueCitekeys } from "../src/citations/scan";
import { colorName, parseHexColor } from "../src/annotations/colors";
import { matchScore } from "../src/citations/score";
import { relatedCitekeys } from "../src/related";
import { normalizeSettings } from "../src/settings-data";
import { DEFAULT_SETTINGS, ZoteroIndex, ZoteroIndexEntry } from "../src/types";

test("scan finds pandoc, bare and wikilink citations and skips code, frontmatter and emails", () => {
	const text = [
		"---", "citekey: front2020", "---",
		"See [@smith2020, p. 3; -@doe2019] and @lee2021 or [[@kim2022|Kim]].",
		"Mail me at someone@example.com; not a citation.",
		"```", "@code2000", "```",
		"Repeat [@smith2020].",
	].join("\n");
	const found = scanCitations(text);
	assert.deepEqual(found.map(item => [item.citekey, item.form]), [["smith2020", "pandoc"], ["doe2019", "pandoc"], ["lee2021", "bare"], ["kim2022", "wikilink"], ["smith2020", "pandoc"]]);
	assert.deepEqual(uniqueCitekeys(text), ["smith2020", "doe2019", "lee2021", "kim2022"]);
	assert.equal(found[0].line, 3);
});

test("colors map to the Zotero palette by nearest match and reject junk", () => {
	assert.equal(colorName("#ffd400"), "yellow");
	assert.equal(colorName("#FFD500"), "yellow");
	assert.equal(colorName("#aaaaaa"), "gray");
	assert.equal(colorName("#2ea8e5"), "blue");
	assert.equal(colorName("#fd6"), "yellow");
	assert.equal(colorName(""), null);
	assert.equal(colorName("javascript:alert(1)"), null);
	assert.deepEqual(parseHexColor("#abc"), [0xaa, 0xbb, 0xcc]);
});

const entry = (overrides: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({ id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "smith2020", citekeyHistory: [], title: "Knowledge sharing", authors: ["Smith, Ann"], year: "2020", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...overrides });

test("suggest scoring prefers exact and prefix citekeys, then multi-term title matches", () => {
	const a = entry({});
	assert.equal(matchScore(a, "smith2020"), 100);
	assert.ok(matchScore(a, "smi") > matchScore(a, "knowledge_sharing"));
	assert.ok(matchScore(a, "knowledge_sharing") > 0);
	assert.equal(matchScore(a, "unrelated"), 0);
	assert.equal(matchScore(a, ""), 1);
});

test("related citekeys resolve dc:relation URIs within the index and skip ambiguity", () => {
	const source = entry({ metadata: { relations: { "dc:relation": ["http://zotero.org/users/local/abc/items/ITEM0002", "http://zotero.org/users/local/abc/items/ITEM0003", "not a uri"] } } });
	const target = entry({ id: "1:ITEM0002", itemKey: "ITEM0002", citekey: "doe2019" });
	const dupA = entry({ id: "1:ITEM0003", itemKey: "ITEM0003", citekey: "dupA" });
	const dupB = entry({ id: "2:ITEM0003", libraryID: 2, itemKey: "ITEM0003", citekey: "dupB" });
	const index = { entries: [source, target, dupA, dupB] } as unknown as ZoteroIndex;
	assert.deepEqual(relatedCitekeys(source, index), ["doe2019"]);
	assert.deepEqual(relatedCitekeys(entry({ metadata: {} }), index), []);
});

test("new settings normalize with defaults and reject invalid values", () => {
	const settings = normalizeSettings({ citationTrigger: "at", excludedTags: ["Obscite", " ", "draft"], headingHighlightColor: "pink", referencesFollowActiveNote: false });
	assert.equal(settings.citationTrigger, "at");
	assert.deepEqual(settings.excludedTags, ["obscite", "draft"]);
	assert.equal(settings.headingHighlightColor, DEFAULT_SETTINGS.headingHighlightColor);
	assert.equal(settings.referencesFollowActiveNote, false);
	assert.equal(normalizeSettings({ citationTrigger: "bogus" }).citationTrigger, "bracket");
	assert.equal(normalizeSettings({ headingHighlightColor: "none" }).headingHighlightColor, "none");
});

test("frontmatter scan reads bare-key arrays and [@key] tokens, ignoring wikilinks, bare @keys and the note's own citekey", () => {
	const found = scanFrontmatterCitations({
		citekey: "self2020own",
		cites: ["alpha2020memory", " beta2021old ", "@atsign2019no", "[[wiki2018no]]", 42, "", "self2020own"],
		supports: "gamma2019single",
		counters: [{ nested: "object2017no" }],
		evidenceFor: ["[[Some note]] backs [@delta2018tok, p. 4] but bare @epsilon2017no and [[@zeta2016wiki]] do not count", "[@self2020own; @eta2015tok]"],
		evidenceAgainst: "None [@theta2014tok]",
		sourceCallout: ["[@iota2013tok]"],
		hypotheses: "H1 [@kappa2012tok]",
		title: "[@lambda2011no] not a scanned field",
	});
	assert.deepEqual(found, [
		{ citekey: "alpha2020memory", field: "cites", form: "bare" },
		{ citekey: "beta2021old", field: "cites", form: "bare" },
		{ citekey: "gamma2019single", field: "supports", form: "bare" },
		{ citekey: "delta2018tok", field: "evidenceFor", form: "pandoc" },
		{ citekey: "eta2015tok", field: "evidenceFor", form: "pandoc" },
		{ citekey: "theta2014tok", field: "evidenceAgainst", form: "pandoc" },
		{ citekey: "iota2013tok", field: "sourceCallout", form: "pandoc" },
		{ citekey: "kappa2012tok", field: "hypotheses", form: "pandoc" },
	]);
	assert.deepEqual(scanFrontmatterCitations({}), []);
	assert.deepEqual(scanFrontmatterCitations({ cites: ["dup2010twice", "dup2010twice"] }).length, 2);
});

// 0.6 PERF-04 / PERF-13: faster ranking and scanning, pinned against the 0.5.0 algorithms (copied verbatim below).
import { COMPLETION_LIMIT, completionRows, rankCompletions, searchFold } from "../src/citations/score";
import { indexDerived } from "../src/index-derived";

/** Seeded PRNG so the generated fixtures are deterministic. */
function prng(seed: number): () => number {
	let state = seed;
	return () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
}

/** 0.5.0 `CitekeySuggest.getSuggestions` body. */
function rank050(entries: ZoteroIndexEntry[], query: string): ZoteroIndexEntry[] {
	return entries.map(item => ({ entry: item, score: matchScore(item, query) })).filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.citekey.localeCompare(b.entry.citekey)).slice(0, 30).map(item => item.entry);
}

function completionCorpus(): ZoteroIndexEntry[] {
	const random = prng(7);
	const tricky = [
		"smith2020", "smith2020", "Smith2020", "SMITH2020a", "smith2020b", "smith_2020", "smith-2020", "smith:2020", "smith.2020",
		"müller2019", "muller2019", "müller2019", "Müller2019x", "ışık2020", "İnci2021", "inci2021", "straße2018", "strasse2018",
		"café2020", "café2020", "a10", "a9", "a1", "A1", "a", "doe2019", "doe-2019", "doe2019doe", "kim", "kim", "Kim", "kim2001",
		"o'brien2015", "zeta​2010", "zeta2010", "σοφία2012", "ΣΟΦΊΑ2012",
	];
	const words = ["memory", "knowledge", "sharing", "kim", "smith", "adaptive", "lorem", "2020", "Müller", "Straße", "İnci", "café"];
	const entries: ZoteroIndexEntry[] = [];
	let n = 0;
	const add = (citekey: string, title: string, authors: string[], year: string): void => {
		n++;
		const group = n % 7 === 0;
		entries.push(entry({ id: `${group ? 2 : 1}:K${String(n).padStart(7, "0")}`, libraryID: group ? 2 : 1, libraryType: group ? "group" : "user", ...(group ? { groupID: 4242 } : {}), itemKey: `K${String(n).padStart(7, "0")}`, citekey, title, authors, year }));
	};
	for (const key of tricky) add(key, `${words[n % words.length]} title ${n}`, [`Author ${n}`], String(2000 + (n % 25)));
	// Enough entries per bucket to cross the 30-row limit for each query shape, in shuffled index order.
	for (let i = 0; i < 260; i++) {
		const pick = (list: string[]) => list[Math.floor(random() * list.length)];
		add(`${pick(["kim", "smith", "lee", "Kim", "SMITH", "müller"])}${2000 + Math.floor(random() * 30)}${pick(["", "memory", "a", "b"])}${i % 3 ? "" : i}`,
			`${pick(words)} ${pick(words)} ${pick(words)}`, [`${pick(words)} ${pick(["Ann", "Bo", "Cy"])}`, ...(i % 4 ? [] : ["Second Author"])], String(1990 + Math.floor(random() * 35)));
	}
	return entries;
}

test("0.6 PERF-04: prepared completion ranking returns exactly the 0.5.0 top 30 for every query shape", () => {
	const entries = completionCorpus();
	const rows = completionRows(entries);
	const queries = ["", " ", "_", "__", "s", "S", "smith", "SMITH", "smith2020", "Smith2020", "smith_2020", "smith-2020", "smith2020_memory", "kim", "kim20", "kim_memory", "memory",
		"memory_kim_lee_smith_ann_bo", "a", "a1", "A1", "2020", "doe", "doe-", "müller", "müller", "muller", "ışık", "i̇nci", "inci", "İnci", "straße", "strasse",
		"café", "café", "σοφία", "ςοφία", "zeta", "zeta2010", "o'brien", "zzzzqq", "title", "title_1", "author_2", "second_author", "lorem_ipsum"];
	const random = prng(11);
	for (let i = 0; i < 60; i++) { const sample = entries[Math.floor(random() * entries.length)]; const source = i % 2 ? sample.citekey : sample.title; const start = Math.floor(random() * source.length); queries.push(source.slice(start, start + 1 + Math.floor(random() * 6)).replace(/ /g, "_")); }
	for (const query of queries) {
		const expected = rank050(entries, query);
		const actual = rankCompletions(rows, query);
		assert.equal(actual.length, expected.length, `length for ${JSON.stringify(query)}`);
		actual.forEach((item, index) => assert.equal(item, expected[index], `${JSON.stringify(query)} #${index}: ${item.citekey} vs ${expected[index].citekey}`));
	}
	assert.equal(COMPLETION_LIMIT, 30);
	assert.equal(rankCompletions(rows, "").length, 30, "the empty query lists the first 30 rows");
	assert.deepEqual(rankCompletions([], "smith"), []);
});

test("0.6 PERF-04: bucket boundaries — late term matches still fill the list after 28 prefix matches, exact matches always lead", () => {
	let n = 0;
	const make = (citekey: string, title = "untitled"): ZoteroIndexEntry => { n++; return entry({ id: `1:B${String(n).padStart(7, "0")}`, itemKey: `B${String(n).padStart(7, "0")}`, citekey, title, authors: ["Synthetic Author"], year: "2020" }); };
	const entries = [
		...Array.from({ length: 28 }, (_, i) => make(`zq${String(i).padStart(2, "0")}`)),
		make("zz1", "a zq title"), make("zz2", "another zq title"), make("zz3", "third zq title"),
		...Array.from({ length: 35 }, () => make("dup")), make("dupe"), make("aaa", "dup in a title"),
	];
	const rows = completionRows(entries);
	for (const query of ["zq", "dup", "zz", "zq_title", "title"]) assert.deepEqual(rankCompletions(rows, query).map(item => item.id), rank050(entries, query).map(item => item.id), query);
	assert.deepEqual(rankCompletions(rows, "zq").map(item => item.citekey).slice(26), ["zq26", "zq27", "zz1", "zz2"]);
	assert.ok(rankCompletions(rows, "dup").every(item => item.citekey === "dup"), "35 exact matches fill the list before the prefix match");
});

test("0.6 PERF-04: completion rows keep citekey collation with index order on ties, and are built once per index generation", () => {
	const entries = completionCorpus();
	const rows = completionRows(entries);
	assert.deepEqual(rows.map(row => row.entry), [...entries].sort((a, b) => a.citekey.localeCompare(b.citekey)), "stable localeCompare order");
	const twins = rows.filter(row => row.entry.citekey === "kim").map(row => row.entry.id);
	assert.deepEqual(twins, entries.filter(item => item.citekey === "kim").map(item => item.id), "equal citekeys keep index order");
	// 0.6.2 suggester-unicode-query: the haystack is folded (`searchFold`); ASCII text is only lower-cased, as before.
	for (const row of rows) assert.equal(row.haystack, searchFold(`${row.entry.citekey.toLowerCase()} ${row.entry.title} ${row.entry.authors.join(" ")} ${row.entry.year}`));
	const derived = indexDerived(entries);
	assert.equal(derived.completionRows, indexDerived(entries).completionRows, "one row list per entries array");
	assert.notEqual(indexDerived([...entries]).completionRows, derived.completionRows, "a new index generation (new array) gets its own rows");
});

const KEY050 = "[A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*[A-Za-z0-9_]|[A-Za-z0-9_]";
/** 0.5.0 `scanCitations`: bracket depth recounted from column 0 and the line prefix sliced for every match. */
function scan050(text: string): { citekey: string; line: number; column: number; form: string }[] {
	const citation = new RegExp(`\\[\\[@(${KEY050})(?:[|#][^\\]]*)?\\]\\]|(^|[\\s\\[;(,\\-])-?@(${KEY050})`, "g");
	const lines = text.split(/\r?\n/);
	const occurrences: { citekey: string; line: number; column: number; form: string }[] = [];
	let fenced = false;
	let frontmatter = lines[0]?.trim() === "---";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (frontmatter) { if (index > 0 && line.trim() === "---") frontmatter = false; continue; }
		if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		const bracketDepth = (offset: number): number => {
			let depth = 0;
			for (let i = 0; i < offset; i++) { if (line[i] === "[") depth++; else if (line[i] === "]" && depth > 0) depth--; }
			return depth;
		};
		citation.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = citation.exec(line)) !== null) {
			if (match[1]) { occurrences.push({ citekey: match[1], line: index, column: match.index, form: "wikilink" }); continue; }
			const prefix = match[2] ?? "";
			const column = match.index + prefix.length;
			if (line.slice(0, column).endsWith("[[")) continue;
			const form = bracketDepth(column) > 0 ? "pandoc" : "bare";
			occurrences.push({ citekey: match[3], line: index, column, form });
		}
	}
	return occurrences;
}

test("0.6 PERF-13: the linear citation scan matches the 0.5.0 scan on generated Markdown", () => {
	const random = prng(3);
	const tokens = ["[", "]", "[[", "]]", "@", "-", ";", " ", "  ", "(", ")", ",", "a", "b9", "_", ":", "|", "#", ".", "x@y", "-@k1", "[@", "[[@", "@k2", "@-k", "e",
		"\n", "\r\n", "```", "~~~", "---", "\n---\n", "[@smith2020, p. 3; -@doe2019]", "[[@kim2022|Kim]]", "[[@kim2022#h]]", "see @lee2021", "mail@example.com", "[-@x]", "]]@y", "[[ @z"];
	for (let doc = 0; doc < 4000; doc++) {
		const length = 1 + Math.floor(random() * 50);
		let text = doc % 5 === 0 ? "---\n" : "";
		for (let i = 0; i < length; i++) text += tokens[Math.floor(random() * tokens.length)];
		assert.deepEqual(scanCitations(text), scan050(text), JSON.stringify(text));
	}
});

test("0.6 PERF-13: one long line with thousands of citations scans every occurrence with the right bracket form", () => {
	const line = Array.from({ length: 1200 }, (_, i) => i % 3 === 0 ? `text [see @key${i}; -@alt${i}] more` : i % 3 === 1 ? `text @bare${i} and [[@wiki${i}|W]]` : `nested [a [b @deep${i}] ] after @out${i}`).join(" ");
	const found = scanCitations(line);
	assert.deepEqual(found, scan050(line));
	assert.equal(found.length, 2400);
	assert.deepEqual(found.slice(0, 6).map(item => [item.citekey, item.form]), [["key0", "pandoc"], ["alt0", "pandoc"], ["bare1", "bare"], ["wiki1", "wikilink"], ["deep2", "pandoc"], ["out2", "bare"]]);
	assert.equal(uniqueCitekeys(`${line}\n${line}`).length, 2400);
});
