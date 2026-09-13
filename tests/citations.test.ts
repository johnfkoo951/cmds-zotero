import { test } from "node:test";
import assert from "node:assert/strict";
import { scanCitations, uniqueCitekeys } from "../src/citations/scan";
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
