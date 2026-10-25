// 0.6.2 WP5 citations editor: the pure modules behind the suggester, clusters, locators, formats, marks, renames, pastes
// and locator pages. Synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptEdit, bracketSpan, citationAt, citationsOnLine, clusterItems, composeCluster, decomposeCluster, isPageLocator, itemText, locatorEdit, mergeIntoCluster, parseClusters, parseLocator, UNICODE_KEY } from "../src/citations/cluster";
import { authorDateLabel, authorDateParts, authorSurnames, hangulParticle, isHangulName, joinAuthorNames, narrativeLabel, renderCluster } from "../src/citations/author-date";
import { CITATION_FORMATS, formatCitation, isCitationFormat } from "../src/citations/formats";
import { applyRenamePlan, citekeyProblem, problemText, renamePlan } from "../src/citations/problems";
import { parsePastedLinks, resolvePastedRef } from "../src/citations/paste";
import { firstPageLabel, locatorPageIn, pageSourceText } from "../src/citations/locator-page";
import { completionRows, matchScore, rankCompletions, searchFold } from "../src/citations/score";
import { maskIgnored } from "../src/citations/cited-keys";
import { referencesBlock, withoutReferencesBlock } from "../src/citations/references-block";
import { findStyle, type InstalledStyle } from "../src/bibliography/csl-styles";
import { indexDerived } from "../src/index-derived";
import { CITATION_FORMAT_SETTINGS, normalizeSettings } from "../src/settings-data";
import { DEFAULT_SETTINGS, type Annotation, type ZoteroIndexEntry } from "../src/types";

const entry = (overrides: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({
	id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "kim2020", citekeyHistory: [], title: "Knowledge sharing in teams",
	authors: ["Minji Kim", "Jae Lee"], year: "2020", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001",
	attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...overrides,
});

// Clusters, locators and affixes.

test("clusters parse prefixes, locators, suppressed authors and suffixes with exact columns", () => {
	const line = "As shown [see @kim2020, pp. 33–35, 38 and *passim*; also -@park2019, ch. 1] and [@lee2021].";
	const clusters = parseClusters(line);
	assert.equal(clusters.length, 2);
	const [first, second] = clusters[0].items;
	assert.equal(line.slice(clusters[0].start, clusters[0].end), "[see @kim2020, pp. 33–35, 38 and *passim*; also -@park2019, ch. 1]");
	assert.deepEqual([first.prefix, first.citekey, first.suppressAuthor, first.locator, first.rest], ["see", "kim2020", false, { label: "pp.", value: "33–35, 38" }, " and *passim*"]);
	assert.equal(line.slice(first.keyStart, first.keyEnd), "kim2020");
	assert.equal(line.slice(first.start, first.end), "see @kim2020, pp. 33–35, 38 and *passim*");
	assert.deepEqual([second.prefix, second.citekey, second.suppressAuthor, second.locator], ["also", "park2019", true, { label: "ch.", value: "1" }]);
	assert.equal(line.slice(second.start, second.end), "also -@park2019, ch. 1");
	assert.deepEqual(clusters[1].items.map(item => item.citekey), ["lee2021"]);
});

test("UNICODE_KEY parses Unicode citekeys in clusters, bare citations, wikilinks, paste and rename", () => {
	assert.ok(new RegExp(`^${UNICODE_KEY}$`, "u").test("müller2020"));
	assert.ok(new RegExp(`^${UNICODE_KEY}$`, "u").test("김2020"));
	const line = "See [cf. @müller2020, p. 4; -@김2020], @müller2020 [p. 9] and [[@김2020|김]].";
	const clusters = parseClusters(line);
	assert.equal(clusters.length, 1);
	assert.deepEqual(clusters[0].items.map(item => [item.citekey, item.suppressAuthor, item.locator]), [
		["müller2020", false, { label: "p.", value: "4" }],
		["김2020", true, null],
	]);
	const all = citationsOnLine(line);
	assert.deepEqual(all.map(item => [item.form, item.citekey]), [
		["pandoc", "müller2020"],
		["pandoc", "김2020"],
		["bare", "müller2020"],
		["wikilink", "김2020"],
	]);
	const pasted = parsePastedLinks("zotero://select/items/@müller2020 zotero://select/items/@김2020");
	assert.deepEqual(pasted?.map(ref => ref.kind === "citekey" ? ref.citekey : ""), ["müller2020", "김2020"]);
	const note = "Body [@müller2019old, p. 2] and @müller2019old and [[@müller2019old|M]] vs @müller2019older.";
	const plan = renamePlan(note, "müller2019old", "müller2020");
	assert.equal(plan.count, 3);
	assert.equal(applyRenamePlan(note, plan), "Body [@müller2020, p. 2] and @müller2020 and [[@müller2020|M]] vs @müller2019older.");
});

test("brackets that are not citations are skipped: wikilinks, links, images, emails and items without a key", () => {
	assert.deepEqual(parseClusters("[[@kim2020]] [@kim2020](https://example.org) ![@kim2020] [mail me@example.org] [@kim2020; no key]"), []);
	assert.equal(parseClusters("[@a; @b]").length, 1);
});

test("locators: labels, bare page numbers, roman numerals, s.vv., and abbreviations that are not locators", () => {
	assert.deepEqual(parseLocator(", p. 3"), { locator: { label: "p.", value: "3" }, rest: "" });
	assert.deepEqual(parseLocator(", p.3"), { locator: { label: "p.", value: "3" }, rest: "" });
	assert.deepEqual(parseLocator(", §2"), { locator: { label: "§", value: "2" }, rest: "" });
	assert.deepEqual(parseLocator(", 33-35, emphasis added"), { locator: { label: "", value: "33-35" }, rest: ", emphasis added" });
	assert.deepEqual(parseLocator(", chap. xii"), { locator: { label: "chap.", value: "xii" }, rest: "" });
	assert.deepEqual(parseLocator(", pp. iii, v–vi"), { locator: { label: "pp.", value: "iii, v–vi" }, rest: "" });
	assert.deepEqual(parseLocator(", s.vv. iii, iv"), { locator: { label: "s.vv.", value: "iii, iv" }, rest: "" });
	assert.deepEqual(parseLocator(" sec. 2"), { locator: { label: "sec.", value: "2" }, rest: "" });
	assert.deepEqual(parseLocator(", emphasis added"), { locator: null, rest: ", emphasis added" });
	assert.deepEqual(parseLocator(", page2x"), { locator: null, rest: ", page2x" });
	assert.deepEqual(parseLocator(", n.d."), { locator: null, rest: ", n.d." });
	assert.deepEqual(parseLocator(", l.c."), { locator: null, rest: ", l.c." });
	assert.deepEqual(parseLocator(", s.vv."), { locator: null, rest: ", s.vv." });
	assert.ok(isPageLocator({ label: "", value: "3" }));
	assert.ok(isPageLocator({ label: "pp.", value: "3-4" }));
	assert.ok(!isPageLocator({ label: "fig.", value: "3" }));
});

test("decomposeCluster and composeCluster round-trip multi-item clusters with prefixes, locators, suffixes and author suppression", () => {
	const text = "[see @kim2020, p. 3, emphasis added; also -@park2019, ch. 1; @김2021]";
	const [cluster] = parseClusters(text);
	const items = decomposeCluster(cluster);
	assert.deepEqual(items, [
		{ citekey: "kim2020", prefix: "see", locator: "p. 3", suffix: "emphasis added", suppressAuthor: false },
		{ citekey: "park2019", prefix: "also", locator: "ch. 1", suffix: "", suppressAuthor: true },
		{ citekey: "김2021", prefix: "", locator: "", suffix: "", suppressAuthor: false },
	]);
	assert.equal(composeCluster(items), text);
	assert.equal(composeCluster([]), "");
});

test("citations on a line: bracket items, bare keys with a bracket locator, and wikilinks, by column", () => {
	const line = "@kim2020 [p. 4] argues, unlike [[@lee2021|Lee]] and [@park2019], that @choi2018 holds.";
	const items = citationsOnLine(line);
	assert.deepEqual(items.map(item => [item.form, item.citekey]), [["bare", "kim2020"], ["wikilink", "lee2021"], ["pandoc", "park2019"], ["bare", "choi2018"]]);
	assert.deepEqual(items[0].locator, { label: "p.", value: "4" });
	assert.equal(line.slice(items[0].start, items[0].end), "@kim2020 [p. 4]");
	assert.equal(citationAt(line, line.indexOf("park"))?.item.citekey, "park2019");
	assert.equal(citationAt(line, line.indexOf("Lee]"))?.item.form, "wikilink");
	assert.equal(citationAt(line, line.indexOf("argues")), null);
	// The cursor right after a cluster's `]` still belongs to it.
	assert.equal(citationAt(line, line.indexOf("park2019]") + 9)?.item.citekey, "park2019");
});

test("maskIgnored + withoutReferencesBlock masks frontmatter, fenced/inline code, HTML/Obsidian comments and the managed references block while keeping columns", () => {
	const doc = [
		"---",
		"citekey: @front2020",
		"---",
		"Prose [@kim2020] with `[@inline2020]` and <!-- [@html2020] --> and %% [@obs2020] %%.",
		"```",
		"[@fence2020]",
		"```",
		referencesBlock("[@refblock2020]"),
	].join("\n");
	const masked = maskIgnored(withoutReferencesBlock(doc));
	assert.equal(masked.length, doc.length);
	const lines = masked.split("\n");
	assert.deepEqual(citationsOnLine(lines[1]), []);
	assert.deepEqual(citationsOnLine(lines[3]).map(item => item.citekey), ["kim2020"]);
	assert.equal(citationAt(lines[3], doc.split("\n")[3].indexOf("@kim2020"))?.item.citekey, "kim2020");
	assert.equal(citationAt(lines[3], doc.split("\n")[3].indexOf("@inline2020")), null);
	assert.equal(citationAt(lines[3], doc.split("\n")[3].indexOf("@html2020")), null);
	assert.equal(citationAt(lines[5], 2), null);
	assert.equal(citationAt(lines[8], 2), null);
});

test("locator edits keep prefixes and suffixes; bare citations take a bracket locator; wikilinks have none", () => {
	const line = "[see @kim2020, emphasis added]";
	const item = parseClusters(line)[0].items[0];
	const add = locatorEdit(item, { label: "p.", value: "33" });
	assert.ok(add);
	assert.equal(line.slice(0, add.from) + add.text + line.slice(add.to), "[see @kim2020, p. 33, emphasis added]");
	const withLocator = "[@kim2020, pp. 3-4]";
	const remove = locatorEdit(parseClusters(withLocator)[0].items[0], null);
	assert.ok(remove);
	assert.equal(withLocator.slice(0, remove.from) + remove.text + withLocator.slice(remove.to), "[@kim2020]");
	const bare = "As -@kim2020 shows";
	const bareEdit = locatorEdit(citationsOnLine(bare)[0], { label: "chap.", value: "2" });
	assert.ok(bareEdit);
	assert.equal(bare.slice(0, bareEdit.from) + bareEdit.text + bare.slice(bareEdit.to), "As -@kim2020 [chap. 2] shows");
	const bareWith = "@kim2020 [p. 4] shows";
	const cleared = locatorEdit(citationsOnLine(bareWith)[0], null);
	assert.ok(cleared);
	assert.equal(bareWith.slice(0, cleared.from) + cleared.text + bareWith.slice(cleared.to), "@kim2020 shows");
	assert.equal(locatorEdit(citationsOnLine("[[@kim2020]]")[0], { label: "p.", value: "1" }), null);
	assert.equal(itemText({ citekey: "a", prefix: "", suppressAuthor: true, rest: "" }, { label: "", value: "7" }), "-@a, 7");
});

// Clusters at the cursor (multi-source-citation-cluster) and suggester accepts (suggester-alternate-insert).

test("merging into the cluster at the cursor adds new keys only and leaves the rest of the line alone", () => {
	const line = "Text [@a, p. 2] more";
	const inside = mergeIntoCluster(line, line.indexOf("a,"), ["@b", "@a", "@c, p. 9"]);
	assert.deepEqual(inside, { from: 14, to: 14, text: "; @b; @c, p. 9", cursor: 29 });
	assert.equal(line.slice(0, 14) + inside.text + line.slice(14), "Text [@a, p. 2; @b; @c, p. 9] more");
	const after = mergeIntoCluster(line, line.indexOf("]") + 1, ["@b"]);
	assert.equal(after?.text, "; @b");
	assert.equal(mergeIntoCluster(line, line.indexOf("]") + 1, ["@a"])?.text, "");
	assert.equal(mergeIntoCluster(line, 2, ["@b"]), null);
	assert.deepEqual(clusterItems(" [@b; @c, p. 9] "), ["@b", "@c, p. 9"]);
	assert.equal(clusterItems("[@b] and [@c]"), null);
	assert.equal(clusterItems("@b"), null);
});

const applyEdit = (line: string, edit: { from: number; to: number; text: string }): string => `${line.slice(0, edit.from)}${edit.text}${line.slice(edit.to)}`;

test("suggester accept keeps the 0.6.1 insertions by default", () => {
	assert.equal(applyEdit("See [@ki", acceptEdit("See [@ki", 5, 8, "kim2020", "default")), "See [@kim2020]");
	assert.equal(applyEdit("See [@ki]", acceptEdit("See [@ki]", 5, 8, "kim2020", "default")), "See [@kim2020]");
	assert.equal(applyEdit("See [[@ki", acceptEdit("See [[@ki", 6, 9, "kim2020", "default")), "See [[@kim2020]]");
	assert.equal(applyEdit("[@a; @ki", acceptEdit("[@a; @ki", 5, 8, "kim2020", "default")), "[@a; @kim2020");
	assert.equal(applyEdit("See @ki", acceptEdit("See @ki", 4, 7, "kim2020", "default")), "See [@kim2020]");
	const edit = acceptEdit("See [@ki", 5, 8, "kim2020", "default");
	assert.equal(edit.cursor, "See [@kim2020]".length);
});

test("suggester accept: [@ typed right after a cluster joins it; Shift inserts a narrative key", () => {
	assert.equal(applyEdit("[@a][@ki]", acceptEdit("[@a][@ki]", 5, 8, "kim2020", "default")), "[@a; @kim2020]");
	assert.equal(applyEdit("[@a][@ki", acceptEdit("[@a][@ki", 5, 8, "kim2020", "default")), "[@a; @kim2020]");
	assert.equal(applyEdit("[@kim2020][@ki", acceptEdit("[@kim2020][@ki", 11, 14, "kim2020", "default")), "[@kim2020]");
	assert.equal(applyEdit("See [@ki]", acceptEdit("See [@ki]", 5, 8, "kim2020", "narrative")), "See @kim2020");
	assert.equal(applyEdit("See @ki", acceptEdit("See @ki", 4, 7, "kim2020", "narrative")), "See @kim2020");
	assert.equal(applyEdit("[@a; @ki", acceptEdit("[@a; @ki", 5, 8, "kim2020", "narrative")), "[@a; @kim2020");
});

test("Mod accept replaces the typed brackets with the note link, but not inside a cluster", () => {
	assert.deepEqual(bracketSpan("See [@ki]", 5, 8), { from: 4, to: 9 });
	assert.deepEqual(bracketSpan("See [[@ki", 6, 9), { from: 4, to: 9 });
	assert.deepEqual(bracketSpan("See @ki", 4, 7), { from: 4, to: 7 });
	assert.equal(bracketSpan("[@a; @ki", 5, 8), null);
	assert.equal(bracketSpan("[@a][@ki", 5, 8), null);
});

// Unicode suggester queries.

test("suggester folding: Korean NFC and NFD compare equal, diacritics drop, ASCII only changes case", () => {
	assert.equal(searchFold("Kim2020 Knowledge"), "kim2020 knowledge");
	assert.equal(searchFold("Müller É"), "muller e");
	assert.equal(searchFold("김민지".normalize("NFD")), "김민지".normalize("NFC"));
	const korean = entry({ id: "1:ITEM0002", itemKey: "ITEM0002", citekey: "kim2021", title: "지식 공유", authors: ["김민지"] });
	const accented = entry({ id: "1:ITEM0003", itemKey: "ITEM0003", citekey: "muller2019", title: "Éducation et société", authors: ["Anna Müller"] });
	const rows = completionRows([entry({}), korean, accented]);
	assert.deepEqual(rankCompletions(rows, "김민지").map(row => row.citekey), ["kim2021"]);
	assert.deepEqual(rankCompletions(rows, "김민지".normalize("NFD")).map(row => row.citekey), ["kim2021"]);
	assert.deepEqual(rankCompletions(rows, "지식").map(row => row.citekey), ["kim2021"]);
	assert.deepEqual(rankCompletions(rows, "education").map(row => row.citekey), ["muller2019"]);
	assert.deepEqual(rankCompletions(rows, "Müller").map(row => row.citekey), ["muller2019"]);
	assert.ok(matchScore(accented, "societe") > 0);
	// ASCII ranking unchanged: exact, prefix, then term matches.
	assert.deepEqual(rankCompletions(rows, "kim").map(row => row.citekey), ["kim2020", "kim2021"]);
	assert.equal(matchScore(entry({}), "kim2020"), 100);
});

// Author-date approximations and locale-aware Hangul rules.

test("joinAuthorNames default rule and locale-aware Hangul/narrative rules", () => {
	assert.equal(joinAuthorNames(["Kim"]), "Kim");
	assert.equal(joinAuthorNames(["Kim", "Lee"]), "Kim & Lee");
	assert.equal(joinAuthorNames(["Kim", "Lee"], { narrative: true }), "Kim and Lee");
	assert.equal(joinAuthorNames(["Kim", "Lee", "Park"]), "Kim et al.");
	assert.ok(isHangulName("김민지") && !isHangulName("Kim"));
	assert.equal(hangulParticle("김"), "과");
	assert.equal(hangulParticle("이"), "와");
	assert.equal(hangulParticle("김민지"), "와");
	assert.equal(hangulParticle("박서준"), "과");
	assert.equal(joinAuthorNames(["김", "이"]), "김·이");
	assert.equal(joinAuthorNames(["김", "이"], { narrative: true }), "김과 이");
	assert.equal(joinAuthorNames(["이", "김"], { narrative: true }), "이와 김");
	assert.equal(joinAuthorNames(["김", "이", "박"]), "김 외");
	assert.equal(joinAuthorNames(["Kim", "Lee", "Park"], { locale: "ko-KR" }), "Kim 외");
	assert.equal(joinAuthorNames(["Kim", "Lee"], { locale: "ko" }), "Kim·Lee");
	const krEntry = entry({ authors: ["김민지", "박서준"], year: "2021" });
	assert.deepEqual(authorDateParts(krEntry), { authors: "김민지·박서준", year: "2021" });
	assert.equal(authorDateLabel(krEntry), "김민지·박서준, 2021");
	assert.equal(narrativeLabel(krEntry), "김민지와 박서준 (2021)");
});

test("surnames come from Zotero creators (authors first), else from the indexed names", () => {
	const creators = [{ firstName: "Minji", lastName: "Kim", creatorType: "author" }, { name: "김지현", creatorType: "author" }, { firstName: "Ed", lastName: "Itor", creatorType: "editor" }];
	assert.deepEqual(authorSurnames(entry({ metadata: { creators } })), ["Kim", "김지현"]);
	assert.deepEqual(authorSurnames(entry({ metadata: { creators: [{ lastName: "Itor", creatorType: "editor" }] } })), ["Itor"]);
	assert.deepEqual(authorSurnames(entry({ authors: ["Smith, Ann", "Jae Lee", "박서준"] })), ["Smith", "Lee", "박서준"]);
	assert.equal(authorDateLabel(entry({})), "Kim & Lee, 2020");
	assert.equal(narrativeLabel(entry({ year: "" })), "Kim and Lee (n.d.)");
	assert.equal(authorDateLabel(entry({ authors: [], title: "A study of many things here" })), "“A study of many”, 2020");
});

test("clusters render as author-date text with prefixes, suppressed authors, locators and suffixes; an unknown key keeps the source", () => {
	const kim = entry({});
	const park = entry({ id: "1:ITEM0004", itemKey: "ITEM0004", citekey: "park2019", authors: ["Seo Park"], year: "2019" });
	const lookup = (key: string): ZoteroIndexEntry | null => key === "kim2020" ? kim : key === "park2019" ? park : null;
	const [cluster] = parseClusters("[see @kim2020, p. 3, emphasis added; -@park2019]");
	assert.equal(renderCluster(cluster.items, lookup), "(see Kim & Lee, 2020, p. 3, emphasis added; 2019)");
	assert.equal(renderCluster(cluster.items, lookup, { locale: "ko-KR" }), "(see Kim·Lee, 2020, p. 3, emphasis added; 2019)");
	assert.equal(renderCluster(parseClusters("[@kim2020; @nobody2000]")[0].items, lookup), null);
});

test("findStyle strips trailing .csl from the query before matching installed styles", () => {
	const styles: InstalledStyle[] = [
		{ id: "http://www.zotero.org/styles/apa", key: "apa", title: "APA", path: "/Zotero/styles/apa.csl", file: "apa.csl" },
	];
	assert.equal(findStyle(styles, "apa")?.key, "apa");
	assert.equal(findStyle(styles, "apa.csl")?.key, "apa");
	assert.equal(findStyle(styles, "http://www.zotero.org/styles/apa.csl")?.key, "apa");
});

// Named formats (a fixed list, no templates).

test("named formats are a fixed list and render each form", () => {
	assert.deepEqual(CITATION_FORMATS.map(format => format.id), [...CITATION_FORMAT_SETTINGS]);
	assert.ok(isCitationFormat("pandoc") && !isCitationFormat("{{title}}"));
	const kim = entry({});
	const park = entry({ id: "1:ITEM0004", itemKey: "ITEM0004", citekey: "park2019", authors: ["Seo Park"], year: "2019", zoteroSelectURI: "zotero://select/library/items/ITEM0004" });
	assert.equal(formatCitation("pandoc", [kim, park]), "[@kim2020; @park2019]");
	assert.equal(formatCitation("narrative", [kim]), "@kim2020");
	assert.equal(formatCitation("wikilink", [kim]), "[[@kim2020]]");
	assert.equal(formatCitation("author-date", [kim, park]), "(Kim & Lee, 2020; Park, 2019)");
	assert.equal(formatCitation("zotero-link", [kim]), "[Kim & Lee, 2020](<zotero://select/library/items/ITEM0001>)");
	assert.equal(formatCitation("note-link", [kim], (_entry, alias) => `[[Kim 2020|${alias}]]`), "[[Kim 2020|Kim & Lee, 2020]]");
	assert.throws(() => formatCitation("note-link", [kim, park], item => item.citekey === "kim2020" ? "[[x]]" : null), /@park2019/);
	assert.throws(() => formatCitation("pandoc", []), /Nothing to cite/);
});

// Problem marks, the chooser's inputs and the renamed-key fix.

test("citekey problems: unknown, ambiguous and former keys, and nothing without a loaded snapshot", () => {
	const current = entry({ citekeyHistory: ["kim2019old"] });
	const other = entry({ id: "2:ITEM0009", libraryID: 2, libraryType: "group", groupID: 7, itemKey: "ITEM0009", citekey: "shared2020" });
	const another = entry({ id: "1:ITEM0010", itemKey: "ITEM0010", citekey: "other2021", citekeyHistory: ["shared2020"] });
	const derived = indexDerived([current, other, another]);
	assert.equal(citekeyProblem("kim2020", derived, true), null);
	assert.equal(citekeyProblem("kim2019old", derived, true), "former");
	assert.equal(citekeyProblem("shared2020", derived, true), "ambiguous");
	assert.equal(citekeyProblem("nobody", derived, true), "unknown");
	assert.equal(citekeyProblem("nobody", derived, false), null);
	// An incomplete snapshot cannot prove absence: no unknown mark, but ambiguous and former keys are still evidence.
	assert.equal(citekeyProblem("nobody", derived, true, false), null);
	assert.equal(citekeyProblem("kim2019old", derived, true, false), "former");
	assert.match(problemText("former", "kim2019old", [current]), /former citekey of @kim2020/);
	assert.match(problemText("ambiguous", "shared2020", [other, another]), /2 items/);
});

test("the renamed-key plan touches only body citations of the old key, and applying checks the lines", () => {
	const text = ["---", "cites: [kim2019old]", "---", "See [@kim2019old, p. 3; @kim2019older] and @kim2019old.", "```", "@kim2019old", "```", "Also [[@kim2019old|Kim]] and mail@kim2019old.org."].join("\n");
	const plan = renamePlan(text, "kim2019old", "kim2020");
	assert.equal(plan.count, 3);
	assert.deepEqual(plan.lines.map(row => row.line), [3, 7]);
	assert.equal(plan.lines[0].after, "See [@kim2020, p. 3; @kim2019older] and @kim2020.");
	assert.equal(plan.lines[1].after, "Also [[@kim2020|Kim]] and mail@kim2019old.org.");
	const applied = applyRenamePlan(text, plan);
	assert.ok(applied.includes("cites: [kim2019old]") && applied.includes("```\n@kim2019old\n```"));
	assert.throws(() => applyRenamePlan(text.replace("See [", "Seen ["), plan), /changed since the preview/);
	assert.equal(applyRenamePlan(text.replace(/\n/g, "\r\n"), renamePlan(text.replace(/\n/g, "\r\n"), "kim2019old", "kim2020")).includes("\r\n"), true);
});

// Pasted and dropped Zotero links.

test("pasted text is taken only when it is made of Zotero item links", () => {
	assert.deepEqual(parsePastedLinks("zotero://select/library/items/ITEM0001"), [{ kind: "item", libraryType: "user", itemKey: "ITEM0001", text: "zotero://select/library/items/ITEM0001" }]);
	assert.deepEqual(parsePastedLinks("<zotero://select/groups/7/items/ITEM0009>\nzotero://select/items/1_ITEM0001; zotero://select/items/@kim2020")?.map(ref => ref.kind), ["item", "library-item", "citekey"]);
	assert.equal(parsePastedLinks("See zotero://select/library/items/ITEM0001"), null);
	assert.equal(parsePastedLinks("zotero://open-pdf/library/items/ITEM0001"), null);
	assert.equal(parsePastedLinks("zotero://select/library/items/item0001"), null);
	assert.equal(parsePastedLinks(""), null);
});

test("pasted links resolve by library and item key, never by a first match", () => {
	const user = entry({});
	const group = entry({ id: "2:ITEM0001", libraryID: 2, libraryType: "group", groupID: 7, itemKey: "ITEM0001", citekey: "kim2020", zoteroSelectURI: "zotero://select/groups/7/items/ITEM0001" });
	const entries = [user, group];
	const [userRef, groupRef, libraryRef, keyRef] = parsePastedLinks("zotero://select/library/items/ITEM0001 zotero://select/groups/7/items/ITEM0001 zotero://select/items/2_ITEM0001 zotero://select/items/@kim2020") ?? [];
	assert.deepEqual(resolvePastedRef(userRef, entries), { status: "resolved", entry: user });
	assert.deepEqual(resolvePastedRef(groupRef, entries), { status: "resolved", entry: group });
	assert.deepEqual(resolvePastedRef(libraryRef, entries), { status: "resolved", entry: group });
	assert.deepEqual(resolvePastedRef(keyRef, entries), { status: "ambiguous", candidates: [user, group] });
	assert.deepEqual(resolvePastedRef(groupRef, [user]), { status: "not-found" });
});

// PDF pages from locators.

const annotation = (page: number, pageLabel: string): Annotation => ({ key: `ANNO000${page}`, attachmentKey: "ATTACH01", type: "highlight", text: "", comment: "", color: "#ffd400", page, pageLabel, version: 1, uri: "", tags: [], dateModified: "" });

test("locator pages: an annotated label, a consistent label offset, else the number as a 1-based page", () => {
	const labelled = { key: "ATTACH01", annotations: [annotation(15, "1"), annotation(20, "6"), annotation(3, "iii")] };
	assert.deepEqual(locatorPageIn(labelled, { label: "p.", value: "6" }), { attachmentKey: "ATTACH01", page: 20, source: "label" });
	assert.deepEqual(locatorPageIn(labelled, { label: "pp.", value: "33–35" }), { attachmentKey: "ATTACH01", page: 47, source: "offset" });
	assert.deepEqual(locatorPageIn(labelled, { label: "", value: "iii" }), { attachmentKey: "ATTACH01", page: 3, source: "label" });
	assert.equal(locatorPageIn(labelled, { label: "p.", value: "xii" }), null);
	const conflicting = { key: "ATTACH02", annotations: [annotation(5, "1"), annotation(9, "2")] };
	assert.deepEqual(locatorPageIn(conflicting, { label: "p.", value: "7" }), { attachmentKey: "ATTACH02", page: 7, source: "number" });
	assert.deepEqual(locatorPageIn({ key: "ATTACH03", annotations: [] }, { label: "p.", value: "12" }), { attachmentKey: "ATTACH03", page: 12, source: "number" });
	assert.equal(locatorPageIn({ key: "ATTACH03", annotations: [] }, { label: "fig.", value: "2" }), null);
	assert.equal(firstPageLabel("33–35, 38"), "33");
	assert.match(pageSourceText({ attachmentKey: "A", page: 12, source: "number" }, "12"), /counting from 1/);
});

// Settings.

test("citations editor settings: defaults keep 0.6.1 behaviour (marks on), invalid values fall back", () => {
	assert.deepEqual([DEFAULT_SETTINGS.citationFormat, DEFAULT_SETTINGS.citekeyProblemMarks, DEFAULT_SETTINGS.citationHover, DEFAULT_SETTINGS.authorDateRendering, DEFAULT_SETTINGS.citationClickAction, DEFAULT_SETTINGS.pasteZoteroLinks], ["pandoc", true, false, false, "nothing", false]);
	const settings = normalizeSettings({ citationFormat: "author-date", citekeyProblemMarks: false, citationHover: true, authorDateRendering: true, citationClickAction: "pdf", pasteZoteroLinks: true });
	assert.deepEqual([settings.citationFormat, settings.citekeyProblemMarks, settings.citationHover, settings.authorDateRendering, settings.citationClickAction, settings.pasteZoteroLinks], ["author-date", false, true, true, "pdf", true]);
	const junk = normalizeSettings({ citationFormat: "{{author}}", citekeyProblemMarks: "yes", citationClickAction: "open" });
	assert.deepEqual([junk.citationFormat, junk.citekeyProblemMarks, junk.citationClickAction], ["pandoc", true, "nothing"]);
});

test("editor extension, CitationEditorController, BibliographyController and CitekeySuggest IME/masking/fallback behaviour", async () => {
	const { build } = await import("esbuild");
	const mockObsidian = `
export const editorInfoField = "editorInfoField";
export const editorLivePreviewField = "editorLivePreviewField";
export function normalizePath(p) { return p; }
export class App {}
export class MarkdownView {}
export class TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class FileSystemAdapter {}
export class Modal {
	constructor(app) { this.app = app; this.contentEl = { empty() {}, createDiv() { return this; } }; }
	open() {}
	close() {}
}
export class Setting {
	constructor() { this.controlEl = { createEl() { return { setText() {} }; } }; }
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	addText(cb) { cb({ setPlaceholder() { return this; }, setValue() { return this; }, onChange() { return this; }, inputEl: { value: "", addEventListener() {}, focus() {} } }); return this; }
	addToggle(cb) { cb({ setTooltip() { return this; }, setValue() { return this; }, onChange() { return this; } }); return this; }
	addExtraButton(cb) { cb({ setIcon() { return this; }, setTooltip() { return this; }, setDisabled() { return this; }, onClick() { return this; } }); return this; }
	addButton(cb) { cb({ setButtonText() { return this; }, setCta() { return this; }, setDisabled() { return this; }, onClick() { return this; } }); return this; }
}
export class Notice { constructor(msg) { Notice.messages.push(String(msg)); } hide() {} static messages = []; }
export class TFile { constructor(path = "Draft.md") { this.path = path; this.extension = "md"; } }
export class EditorSuggest {
	constructor(app) {
		this.app = app;
		this.registered = [];
		this.scope = { register: (mods, key, fn) => { this.registered.push({ mods, key, fn }); } };
	}
	setInstructions() {}
}
export class Keymap { static isModifier(event, mod) { return mod === "Mod" && Boolean(event.metaKey || event.ctrlKey); } }
export class FuzzySuggestModal { constructor(app) { this.app = app; } setPlaceholder() {} }
`;
	const mockCmState = `
export const StateEffect = { define: () => ({ of: val => ({ value: val }) }) };
`;
	const mockCmView = `
export class WidgetType { eq() { return false; } ignoreEvent() { return false; } }
export const Decoration = {
	none: [],
	replace: spec => ({ spec, range: (from, to) => ({ kind: "replace", from, to, spec }) }),
	mark: spec => ({ spec, range: (from, to) => ({ kind: "mark", from, to, spec }) }),
	set: items => items,
};
export const ViewPlugin = { fromClass: (cls, spec) => ({ cls, spec }) };
export const hoverTooltip = (fn, opts) => ({ fn, opts });
export const EditorView = { domEventHandlers: handlers => handlers };
`;
	const contents = [
		'export { buildDecorations, citationAtOffset, citationEditorExtension } from "./src/citations/editor-extension";',
		'export { CitationEditorController } from "./src/plugin/citation-editor";',
		'export { BibliographyController } from "./src/plugin/bibliography-controller";',
		'export { CitekeySuggest } from "./src/citations/suggest";',
		'export { TFile } from "obsidian";',
	].join("\n");
	const bundled = await build({
		stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
		bundle: true,
		platform: "node",
		format: "esm",
		write: false,
		logLevel: "silent",
		plugins: [{
			name: "mocks",
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
				b.onResolve({ filter: /^@codemirror\/state$/ }, () => ({ path: "cm-state", namespace: "mock" }));
				b.onResolve({ filter: /^@codemirror\/view$/ }, () => ({ path: "cm-view", namespace: "mock" }));
				b.onLoad({ filter: /^obsidian$/, namespace: "mock" }, () => ({ contents: mockObsidian, loader: "js" }));
				b.onLoad({ filter: /^cm-state$/, namespace: "mock" }, () => ({ contents: mockCmState, loader: "js" }));
				b.onLoad({ filter: /^cm-view$/, namespace: "mock" }, () => ({ contents: mockCmView, loader: "js" }));
			},
		}],
	});
	const mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

	// 1. citationAtOffset & buildDecorations (with IME composing and masked regions)
	const docText = "See [@kim2020; @park2019] and `@inline2020` and @unknown2020.";
	const makeDoc = (text: string) => {
		const lines = text.split("\n");
		return {
			length: text.length,
			lines: lines.length,
			toString: () => text,
			line: (n: number) => {
				let from = 0;
				for (let i = 0; i < n - 1; i++) from += lines[i].length + 1;
				return { number: n, from, to: from + lines[n - 1].length, text: lines[n - 1] };
			},
			lineAt: (offset: number) => {
				let from = 0;
				for (let i = 0; i < lines.length; i++) {
					const to = from + lines[i].length;
					if (offset <= to || i === lines.length - 1) return { number: i + 1, from, to, text: lines[i] };
					from = to + 1;
				}
				return { number: 1, from: 0, to: lines[0].length, text: lines[0] };
			},
		};
	};
	const view = {
		composing: true,
		visibleRanges: [{ from: 0, to: docText.length }],
		state: {
			doc: makeDoc(docText),
			field: (f: string) => f === "editorLivePreviewField",
			selection: { ranges: [{ from: docText.indexOf("@unknown2020"), to: docText.indexOf("@unknown2020") + 5 }] },
		},
	};
	// At '[' of the cluster (column 4), citationAtOffset falls back to cluster.items[0] ("kim2020")
	assert.equal(mod.citationAtOffset(view, docText.indexOf("["))?.item.citekey, "kim2020");
	// At ']' of the cluster, citationAtOffset falls back to cluster.items[0] ("kim2020")
	assert.equal(mod.citationAtOffset(view, docText.indexOf("]") + 1)?.item.citekey, "kim2020");
	// Inside inline code, citationAtOffset returns null
	assert.equal(mod.citationAtOffset(view, docText.indexOf("@inline2020") + 2), null);

	const host = {
		views: new Set(),
		marksEnabled: () => true,
		hoverEnabled: () => true,
		authorDateEnabled: () => false,
		problem: (key: string) => key === "unknown2020" ? { problem: "unknown", text: "unknown" } : null,
		renderCluster: () => null,
		fillHover: () => true,
		modClick: () => true,
		rememberContextMenu: () => {},
		drop: () => false,
	};
	// While view.composing is true and cursor overlaps @unknown2020, Decoration.mark is skipped
	assert.equal(mod.buildDecorations(view, host).length, 0);
	view.composing = false;
	assert.equal(mod.buildDecorations(view, host).length, 1);

	// 2. CitekeySuggest IME guard
	let selected = 0;
	const suggest = new mod.CitekeySuggest({ app: {}, settings: { citationTrigger: "bracket" } });
	suggest.suggestions = { useSelectedItem: () => { selected++; return true; } };
	suggest.context = {
		editor: { getLine: () => "[@ki", replaceRange: () => { selected++; }, setCursor: () => {} },
		start: { line: 0, ch: 1 },
		end: { line: 0, ch: 4 },
		file: null,
	};
	for (const reg of suggest.registered) {
		assert.equal(reg.fn({ isComposing: true }), true);
		assert.equal(reg.fn({ keyCode: 229 }), true);
	}
	suggest.selectSuggestion(entry({}), { isComposing: true });
	suggest.selectSuggestion(entry({}), { keyCode: 229 });
	assert.equal(selected, 0);
	suggest.selectSuggestion(entry({}), { shiftKey: false });
	assert.equal(selected, 1);

	// 3. CitationEditorController.copyBibliography fallback & noteFormat
	let copied = "";
	Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t: string) => { copied = t; } } }, configurable: true });
	const kim = entry({});
	const plugin = {
		app: { workspace: { getActiveFile: () => null } },
		settings: { ...DEFAULT_SETTINGS, bibliographyLocale: "ko-KR" },
		indexLoaded: () => true,
		indexComplete: () => true,
		cachedEntries: () => [kim],
		lastMarkdownView: () => null,
		bibliography: {
			noteFormat: async () => ({ style: "chicago-author-date", locale: "ko-KR", styleFrom: "note", localeFrom: "note", problems: [] }),
			bibliographyDetail: async (_e: unknown, style: string, opts: { locale?: string }) => {
				assert.equal(style, "chicago-author-date");
				assert.equal(opts.locale, "ko-KR");
				return { text: "", source: "fallback" };
			},
		},
	};
	const controller = new mod.CitationEditorController(plugin);
	await controller.copyBibliography(kim);
	assert.match(copied, /Minji Kim, Jae Lee \(2020\)\. Knowledge sharing in teams/);
	assert.equal(controller.renderCluster(parseClusters("[@kim2020]")[0].items), "(Kim·Lee, 2020)");
});

