import { test } from "node:test";
import assert from "node:assert/strict";
import { arxivFromDoi, citekeyShape, emitDoi, normalizeArxiv, normalizeDoi, normalizeTitle, rankedItem, searchIndex } from "../src/agent/search";
import type { ZoteroIndexEntry } from "../src/types";

/* Synthetic fixtures only: invented titles, authors, keys and DOIs shaped like the real cases. */
const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({ id: "1:AAAAAAA1", libraryID: 1, libraryType: "user", itemKey: "AAAAAAA1", citekey: "park2021adaptive", citekeyHistory: [], title: "Adaptive Memory Routing for Long-Horizon Agents", authors: ["Park, Minseo", "Choi, Daniel"], year: "2021", doi: "10.48550/arXiv.2103.04567", url: "http://arxiv.org/abs/2103.04567", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/AAAAAAA1", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: { extra: "arXiv:2103.04567 [cs.AI]" }, ...o });
const park = entry({});
const dupA = entry({ id: "1:BBBBBBB1", itemKey: "BBBBBBB1", citekey: "song2020a", title: "F_Meaning fit at work: Daily consequences of fitting tasks", doi: "10.1000/synthetic.0001", url: "", authors: ["Song, Hana"], year: "2020", metadata: {} });
const dupB = entry({ id: "1:BBBBBBB2", itemKey: "BBBBBBB2", citekey: "song2020", title: "Meaning fit at work: Daily consequences of fitting tasks", doi: "10.1000/synthetic.0001", url: "", authors: ["Song, Hana"], year: "2020", metadata: {} });
const rituals = entry({ id: "1:CCCCCCC1", itemKey: "CCCCCCC1", citekey: "lim2024rituals", title: "Knowledge sharing rituals in distributed engineering teams", doi: "", url: "", year: "2024", authors: ["Lim, Jaeho"], metadata: {} });
const twin2019 = entry({ id: "1:DDDDDDD1", itemKey: "DDDDDDD1", citekey: "moon2019boundary", title: "Team boundary spanning and creativity", doi: "10.1000/synthetic.0019", url: "", year: "2019", authors: ["Moon, Sora"], metadata: {} });
const twin2023 = entry({ id: "1:DDDDDDD2", itemKey: "DDDDDDD2", citekey: "han2023boundary", title: "Team boundary spanning and creativity", doi: "10.1000/synthetic.0023", url: "", year: "2023", authors: ["Han, Yuri"], metadata: {} });
const all = [park, dupA, dupB, rituals, twin2019, twin2023];

test("identifier normalization", () => {
	assert.equal(normalizeDoi("https://doi.org/10.1000/SYNTHETIC.0001."), "10.1000/synthetic.0001");
	assert.equal(normalizeDoi("doi: 10.48550/arXiv.2103.04567"), "10.48550/arxiv.2103.04567");
	assert.equal(normalizeDoi("dx.doi.org/10.1000/synthetic.0001)"), "10.1000/synthetic.0001");
	assert.equal(normalizeDoi("10.1000%2Fsynthetic.0001"), "10.1000/synthetic.0001");
	assert.equal(normalizeDoi("not a doi"), "");
	assert.equal(emitDoi(" https://doi.org/10.48550/arXiv.2103.04567. "), "10.48550/arXiv.2103.04567");
	assert.equal(emitDoi("doi:10.1000/Synthetic.0001;"), "10.1000/Synthetic.0001");
	assert.equal(emitDoi("doi: https://doi.org/10.1000/Stacked.Prefix"), "10.1000/Stacked.Prefix");
	assert.equal(emitDoi("https://doi.org/10.1000/Case%2FPart"), "10.1000/Case/Part");
	assert.equal(emitDoi("see the publisher page"), "");
	assert.equal(normalizeArxiv("arXiv:2103.04567v3"), "2103.04567");
	assert.equal(normalizeArxiv("https://arxiv.org/pdf/2103.04567.pdf"), "2103.04567");
	assert.equal(normalizeArxiv("hep-th/9901001"), "hep-th/9901001");
	assert.equal(normalizeArxiv("https://example.test/abs/2103.04567"), "");
	assert.equal(normalizeArxiv("prefix-2103.04567"), "");
	assert.equal(arxivFromDoi("10.48550/arxiv.2103.04567"), "2103.04567");
	assert.equal(normalizeTitle("Adaptive‑Memory “Routing”!"), "adaptive memory routing");
	assert.equal(normalizeTitle("지식 공유".normalize("NFD")), "지식 공유");
});

test("citekey shapes follow the vocabulary regexes", () => {
	assert.equal(citekeyShape("park2021adaptive"), "vault");
	assert.equal(citekeyShape("van-der-berg2019memory"), "vault");
	assert.equal(citekeyShape("park2021ab"), "vault");
	assert.equal(citekeyShape("park2021ab2"), "vault");
	assert.equal(citekeyShape("parkAdaptiveMemoryRouting2021"), "bbt-default");
	assert.equal(citekeyShape("parkAdaptiveMemoryRouting2021a"), "bbt-default");
	assert.equal(citekeyShape("song2020a"), "bbt-disambiguated");
	assert.equal(citekeyShape("song2020"), "bbt-disambiguated");
	assert.equal(citekeyShape("Park2021adaptive"), "other");
	assert.equal(citekeyShape("park21adaptive"), "other");
	assert.equal(citekeyShape("park2021_adaptive"), "other");
	assert.equal(citekeyShape(""), "other");
});

test("ranked items project the entry with an emitted, case-preserved DOI", () => {
	const item = rankedItem(park, "doi", 100, "DOI 10.48550/arxiv.2103.04567");
	assert.deepEqual(item, { id: "1:AAAAAAA1", citekey: "park2021adaptive", title: park.title, year: "2021", authors: ["Park, Minseo", "Choi, Daniel"], doi: "10.48550/arXiv.2103.04567", libraryID: 1, zoteroSelectURI: "zotero://select/library/items/AAAAAAA1", matchedBy: "doi", score: 100, reason: "DOI 10.48550/arxiv.2103.04567" });
	assert.notEqual(item.authors, park.authors);
});

test("doi and arxiv lookups resolve exactly and report duplicates as ambiguous", () => {
	const byDoi = searchIndex(all, { doi: "https://doi.org/10.48550/arXiv.2103.04567" });
	assert.equal(byDoi.status, "resolved");
	if (byDoi.status === "resolved") { assert.equal(byDoi.entry.citekey, "park2021adaptive"); assert.equal(byDoi.matchedBy, "doi"); }
	const byArxiv = searchIndex(all, { arxiv: "2103.04567v2" });
	assert.equal(byArxiv.status, "resolved");
	if (byArxiv.status === "resolved") assert.equal(byArxiv.matchedBy, "arxiv");
	const dup = searchIndex(all, { doi: "10.1000/synthetic.0001" });
	assert.equal(dup.status, "ambiguous");
	if (dup.status === "ambiguous") assert.equal(dup.matchedBy, "doi");
	assert.deepEqual(dup.candidates.map(c => c.entry.citekey), ["song2020", "song2020a"]);
	const missing = searchIndex(all, { doi: "10.9999/nothing" });
	assert.equal(missing.status, "not-found");
	if (missing.status === "not-found") assert.deepEqual(missing.suggestions, []);
});

test("exact titles resolve; year and author narrow twins", () => {
	const exact = searchIndex(all, { title: "Adaptive memory routing for long-horizon agents" });
	assert.equal(exact.status, "resolved");
	if (exact.status === "resolved") assert.equal(exact.matchedBy, "title");
	const exactOverFuzzy = searchIndex(all, { title: "Meaning fit at work: Daily consequences of fitting tasks" });
	assert.equal(exactOverFuzzy.status, "resolved");
	if (exactOverFuzzy.status === "resolved") assert.equal(exactOverFuzzy.entry.citekey, "song2020");
	assert.equal(exactOverFuzzy.candidates.length, 2);
	assert.equal(exactOverFuzzy.candidates[1].matchedBy, "titleTokens");
	const twins = searchIndex(all, { title: "Team boundary spanning and creativity" });
	assert.equal(twins.status, "ambiguous");
	assert.equal(twins.candidates.length, 2);
	const byYear = searchIndex(all, { title: "Team boundary spanning and creativity", year: "2023" });
	assert.equal(byYear.status, "resolved");
	if (byYear.status === "resolved") assert.equal(byYear.entry.citekey, "han2023boundary");
	const byAuthor = searchIndex(all, { title: "Team boundary spanning and creativity", author: "Moon" });
	assert.equal(byAuthor.status, "resolved");
	if (byAuthor.status === "resolved") assert.equal(byAuthor.entry.citekey, "moon2019boundary");
	const byBoth = searchIndex(all, { title: "Team boundary spanning and creativity", year: "2019", author: "Moon" });
	assert.equal(byBoth.status, "resolved");
	const wrongYear = searchIndex(all, { title: "Team boundary spanning and creativity", year: "2001" });
	assert.equal(wrongYear.status, "ambiguous");
	const wrongAuthor = searchIndex(all, { title: "Knowledge sharing rituals in distributed engineering teams", author: "Nobody" });
	assert.equal(wrongAuthor.status, "ambiguous");
	assert.equal(wrongAuthor.candidates[0].matchedBy, "title");
	assert.match(wrongAuthor.candidates[0].reason, /author mismatch/);
	const substring = searchIndex([entry({ authors: ["Hannah, Min"] })], { title: park.title, author: "Han" });
	assert.equal(substring.status, "ambiguous");
	assert.match(substring.candidates[0].reason, /author mismatch/);
});

test("prefix, token and free-text hits are candidates only and never resolve", () => {
	const prefix = searchIndex(all, { title: "Knowledge sharing rituals in" });
	assert.equal(prefix.status, "ambiguous");
	assert.equal(prefix.candidates.length, 1);
	assert.equal(prefix.candidates[0].matchedBy, "titlePrefix");
	const shortPrefix = searchIndex(all, { title: "Knowledge sharin" });
	assert.equal(shortPrefix.status, "not-found");
	if (shortPrefix.status === "not-found") assert.deepEqual(shortPrefix.suggestions.map(s => [s.entry.citekey, s.matchedBy]), [["lim2024rituals", "titleTokens"]]);
	const twoTokens = searchIndex(all, { title: "Knowledge sharing" });
	assert.equal(twoTokens.status, "ambiguous");
	assert.equal(twoTokens.candidates[0].matchedBy, "titleTokens");
	const tokensOnly = searchIndex(all, { title: "Knowledge sharing rituals in remote engineering teams" });
	assert.equal(tokensOnly.status, "ambiguous");
	assert.equal(tokensOnly.candidates[0].matchedBy, "titleTokens");
	const single = searchIndex(all, { query: "lim rituals distributed" });
	assert.equal(single.status, "ambiguous");
	assert.equal(single.candidates.length, 1);
	assert.equal(single.candidates[0].matchedBy, "query");
	if (single.status === "ambiguous") assert.equal(single.matchedBy, null);
	const query = searchIndex(all, { query: "song fitting" });
	assert.equal(query.status, "ambiguous");
	assert.equal(query.candidates.length, 2);
	const none = searchIndex(all, { query: "quantum chromodynamics" });
	assert.equal(none.status, "not-found");
	if (none.status === "not-found") assert.deepEqual(none.suggestions, []);
	assert.equal(searchIndex(all, {}).status, "not-found");
});

test("not-found title lookups carry looser suggestions capped at the limit", () => {
	const crowd = Array.from({ length: 14 }, (_, i) => entry({ id: `1:EEEEEE${String(i).padStart(2, "0")}`, itemKey: `EEEEEE${String(i).padStart(2, "0")}`, citekey: `crowd${2000 + i}shared`, title: `Shared mental models study ${i}`, doi: "", url: "", year: String(2000 + i), authors: ["Crowd, Author"], metadata: {} }));
	const loose = searchIndex(crowd, { title: "Shared mental models of climbing" });
	assert.equal(loose.status, "not-found");
	if (loose.status === "not-found") {
		assert.equal(loose.suggestions.length, 10);
		assert.ok(loose.suggestions.every(s => s.matchedBy === "titleTokens"));
	}
	const capped = searchIndex(crowd, { title: "Shared mental models study" });
	assert.equal(capped.status, "ambiguous");
	assert.equal(capped.candidates.length, 10);
});
