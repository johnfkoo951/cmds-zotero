import { test } from "node:test";
import assert from "node:assert/strict";
import { queryEcho, resolveIndex, selectorKind } from "../src/agent/resolve";
import { buildNoteIndexes, classifyNotes, noteKind } from "../src/agent/note-classify";
import type { NoteRecord } from "../src/agent/types";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

/* Synthetic fixtures only: invented titles, authors, keys and DOIs shaped like the real cases. */
const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({ id: "1:AAAAAAA1", libraryID: 1, libraryType: "user", itemKey: "AAAAAAA1", citekey: "park2021adaptive", citekeyHistory: [], title: "Adaptive Memory Routing for Long-Horizon Agents", authors: ["Park, Minseo", "Choi, Daniel"], year: "2021", doi: "10.48550/arXiv.2103.04567", url: "http://arxiv.org/abs/2103.04567", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/AAAAAAA1", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: { extra: "arXiv:2103.04567 [cs.AI]" }, ...o });
const park = entry({});
const viaUrl = entry({ id: "1:AAAAAAA2", itemKey: "AAAAAAA2", citekey: "cho2022latent", title: "Latent planning with sparse rewards", doi: "", url: "https://arxiv.org/abs/2204.01234v2", metadata: {} });
const viaDoi = entry({ id: "1:AAAAAAA3", itemKey: "AAAAAAA3", citekey: "yoon2023graph", title: "Graph curricula for tool use", doi: "10.48550/arXiv.2301.09876", url: "", metadata: {} });
const dupA = entry({ id: "1:BBBBBBB1", itemKey: "BBBBBBB1", citekey: "song2020a", title: "F_Meaning fit at work: Daily consequences of fitting tasks", doi: "10.1000/synthetic.0001", url: "", authors: ["Song, Hana"], year: "2020", metadata: {} });
const dupB = entry({ id: "1:BBBBBBB2", itemKey: "BBBBBBB2", citekey: "song2020", title: "Meaning fit at work: Daily consequences of fitting tasks", doi: "10.1000/synthetic.0001", url: "", authors: ["Song, Hana"], year: "2020", metadata: {} });
const rituals = entry({ id: "1:CCCCCCC1", itemKey: "CCCCCCC1", citekey: "lim2024rituals", citekeyHistory: ["lim2024"], title: "Knowledge sharing rituals in distributed engineering teams", doi: "", url: "", year: "2024", authors: ["Lim, Jaeho"], metadata: {} });
const twin2019 = entry({ id: "1:DDDDDDD1", itemKey: "DDDDDDD1", citekey: "moon2019boundary", title: "Team boundary spanning and creativity", doi: "10.1000/synthetic.0019", url: "", year: "2019", authors: ["Moon, Sora"], metadata: {} });
const twin2023 = entry({ id: "1:DDDDDDD2", itemKey: "DDDDDDD2", citekey: "han2023boundary", title: "Team boundary spanning and creativity", doi: "10.1000/synthetic.0023", url: "", year: "2023", authors: ["Han, Yuri"], metadata: {} });
const korean = entry({ id: "1:FFFFFFF1", itemKey: "FFFFFFF1", citekey: "kang2022hybrid", title: "하이브리드 팀의 지식 공유와 협업 리듬".normalize("NFD"), doi: "", url: "", year: "2022", authors: ["Kang, Yuna"], metadata: {} });
const groupTwin = entry({ id: "2:AAAAAAA1", libraryID: 2, libraryType: "group", groupID: 77, itemKey: "AAAAAAA1", citekey: "park2021adaptiveGroup", zoteroSelectURI: "zotero://select/groups/77/items/AAAAAAA1", metadata: {} });

const index = (entries: ZoteroIndexEntry[]): ZoteroIndex => ({ schemaVersion: 2, generatedAt: "2026-09-14T00:00:00.000Z", source: "better-bibtex", count: entries.length, entries, capabilities: { zotero: "7.0", betterbibtex: "7.0", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true });
const single = index([park, viaUrl, viaDoi, dupA, dupB, rituals, twin2019, twin2023, korean]);
const twoLibraries = index([...single.entries, groupTwin]);

test("selector validation accepts exactly one family with usable modifiers", () => {
	assert.deepEqual(selectorKind({ citekey: "park2021adaptive" }), { kind: "citekey" });
	assert.deepEqual(selectorKind({ itemKey: "AAAAAAA1", libraryID: 1 }), { kind: "itemKey" });
	assert.deepEqual(selectorKind({ title: "x", year: "2021", author: "Park", libraryID: 1 }), { kind: "title" });
	assert.deepEqual(selectorKind({ query: "x", year: "2021" }), { kind: "query" });
	assert.equal(selectorKind({}).kind, null);
	assert.match(selectorKind({}).error ?? "", /Exactly one selector/);
	assert.match(selectorKind({ doi: "10.1/x", title: "y" }).error ?? "", /Only one selector/);
	assert.match(selectorKind({ itemKey: "AAAAAAA1" }).error ?? "", /--library/);
	assert.match(selectorKind({ itemKey: "AAAA", libraryID: 1 }).error ?? "", /8-character/);
	assert.match(selectorKind({ itemKey: "AAAAAAA1", libraryID: 1.5 }).error ?? "", /--library/);
	assert.match(selectorKind({ citekey: "   " }).error ?? "", /needs a value/);
	assert.match(selectorKind({ doi: "10.1/x", year: "2020" }).error ?? "", /--year and --author/);
	assert.match(selectorKind({ title: "x", year: "20" }).error ?? "", /four-digit/);
	assert.equal(selectorKind({ doi: "10.1/x", year: "" }).error, undefined);
});

test("query echo reports the family, raw and normalized forms and applicable modifiers", () => {
	assert.deepEqual(queryEcho({ doi: " https://doi.org/10.1000/Synthetic.0001. ", libraryID: 1 }), { kind: "doi", raw: " https://doi.org/10.1000/Synthetic.0001. ", normalized: "10.1000/synthetic.0001", libraryID: 1 });
	assert.deepEqual(queryEcho({ arxiv: "arXiv:2103.04567v3" }), { kind: "arxiv", raw: "arXiv:2103.04567v3", normalized: "2103.04567" });
	assert.deepEqual(queryEcho({ citekey: " @park2021adaptive " }), { kind: "citekey", raw: " @park2021adaptive ", normalized: "park2021adaptive" });
	assert.deepEqual(queryEcho({ itemKey: "AAAAAAA1", libraryID: 1 }), { kind: "itemKey", raw: "AAAAAAA1", normalized: "AAAAAAA1", libraryID: 1 });
	assert.deepEqual(queryEcho({ title: "Team “Boundary” Spanning!", year: " 2023 ", author: " Han " }), { kind: "title", raw: "Team “Boundary” Spanning!", normalized: "team boundary spanning", year: "2023", author: "Han" });
	assert.deepEqual(queryEcho({ query: "song fitting", year: "" }), { kind: "query", raw: "song fitting", normalized: "song fitting" });
});

test("v1 citekey family: citekey, history, id and item key behave as before", () => {
	const byKey = resolveIndex(single, { citekey: "@park2021adaptive" });
	assert.equal(byKey.status, "resolved");
	assert.equal(byKey.matchedBy, "citekey");
	assert.equal(byKey.entry?.id, "1:AAAAAAA1");
	assert.equal(byKey.matchedHistory, false);
	assert.deepEqual(byKey.candidates, []);
	assert.deepEqual(byKey.ranked, []);
	assert.deepEqual(byKey.query, { kind: "citekey", raw: "@park2021adaptive", normalized: "park2021adaptive" });
	const history = resolveIndex(single, { citekey: "lim2024" });
	assert.equal(history.status, "resolved");
	assert.equal(history.matchedBy, "citekeyHistory");
	assert.equal(history.matchedHistory, true);
	assert.equal(history.entry?.citekey, "lim2024rituals");
	const byId = resolveIndex(single, { citekey: "1:CCCCCCC1" });
	assert.equal(byId.status, "resolved");
	assert.equal(byId.matchedBy, "id");
	assert.equal(byId.matchedHistory, false);
	const byItemKey = resolveIndex(single, { citekey: "CCCCCCC1" });
	assert.equal(byItemKey.status, "resolved");
	assert.equal(byItemKey.matchedBy, "itemKey");
	const lowerItemKey = resolveIndex(single, { citekey: "ccccccc1" });
	assert.equal(lowerItemKey.status, "not-found");
	assert.equal(lowerItemKey.matchedBy, null);
	assert.deepEqual(lowerItemKey.ranked, []);
	const scopedOut = resolveIndex(single, { citekey: "park2021adaptive", libraryID: 9 });
	assert.equal(scopedOut.status, "not-found");
	assert.equal(resolveIndex(single, { citekey: "" }).status, "not-found");
});


test("citekey resolution unions current and history matches across distinct items", () => {
	const current = entry({ id: "1:UNION001", itemKey: "UNION001", citekey: "shared2024key", citekeyHistory: [] });
	const former = entry({ id: "1:UNION002", itemKey: "UNION002", citekey: "moved2024key", citekeyHistory: ["shared2024key"] });
	const result = resolveIndex(index([current, former]), { citekey: "shared2024key" });
	assert.equal(result.status, "ambiguous");
	assert.deepEqual(result.candidates.map(candidate => candidate.id), ["1:UNION001", "1:UNION002"]);
});

test("v1 item key family: duplicates across libraries are ambiguous until scoped", () => {
	const ambiguous = resolveIndex(twoLibraries, { citekey: "AAAAAAA1" });
	assert.equal(ambiguous.status, "ambiguous");
	assert.equal(ambiguous.matchedBy, "citekey");
	assert.deepEqual(ambiguous.candidates.map(c => c.id), ["1:AAAAAAA1", "2:AAAAAAA1"]);
	assert.equal(ambiguous.ranked.length, 2);
	assert.ok(ambiguous.ranked.every(r => r.matchedBy === "itemKey" && r.score === 100));
	const unscoped = resolveIndex(twoLibraries, { itemKey: "AAAAAAA1" });
	assert.equal(unscoped.status, "ambiguous");
	assert.equal(unscoped.matchedBy, "itemKey");
	const scoped = resolveIndex(twoLibraries, { itemKey: "AAAAAAA1", libraryID: 2 });
	assert.equal(scoped.status, "resolved");
	assert.equal(scoped.matchedBy, "itemKey");
	assert.equal(scoped.entry?.id, "2:AAAAAAA1");
	assert.equal(scoped.matchedHistory, false);
	assert.deepEqual(scoped.query, { kind: "itemKey", raw: "AAAAAAA1", normalized: "AAAAAAA1", libraryID: 2 });
	assert.equal(resolveIndex(twoLibraries, { itemKey: "ZZZZZZZ9", libraryID: 1 }).status, "not-found");
	assert.equal(resolveIndex(twoLibraries, { itemKey: "AAAAAAA1 ", libraryID: 1 }).status, "not-found");
	assert.throws(() => resolveIndex(single, {}), /Exactly one selector/);
	assert.throws(() => resolveIndex(single, { doi: "10.1/x", citekey: "y" }), /Only one selector/);
});

test("doi and arxiv selectors: exact hits resolve, duplicates are ambiguous, variants agree", () => {
	const dup = resolveIndex(single, { doi: "https://doi.org/10.1000/SYNTHETIC.0001" });
	assert.equal(dup.status, "ambiguous");
	assert.equal(dup.matchedBy, "doi");
	assert.equal(dup.entry, null);
	assert.deepEqual(dup.candidates.map(c => c.citekey), ["song2020", "song2020a"]);
	assert.deepEqual(dup.ranked.map(r => [r.citekey, r.matchedBy, r.doi]), [["song2020", "doi", "10.1000/synthetic.0001"], ["song2020a", "doi", "10.1000/synthetic.0001"]]);
	assert.equal(dup.query.normalized, "10.1000/synthetic.0001");
	const extra = resolveIndex(single, { arxiv: "arXiv:2103.04567v1" });
	assert.equal(extra.status, "resolved");
	assert.equal(extra.matchedBy, "arxiv");
	assert.equal(extra.entry?.citekey, "park2021adaptive");
	const url = resolveIndex(single, { arxiv: "https://arxiv.org/pdf/2204.01234.pdf" });
	assert.equal(url.status, "resolved");
	assert.equal(url.entry?.citekey, "cho2022latent");
	const doi = resolveIndex(single, { arxiv: "2301.09876" });
	assert.equal(doi.status, "resolved");
	assert.equal(doi.entry?.citekey, "yoon2023graph");
	const doiAsArxiv = resolveIndex(single, { doi: "10.48550/arXiv.2204.01234" });
	assert.equal(doiAsArxiv.status, "resolved");
	assert.equal(doiAsArxiv.matchedBy, "arxiv");
	assert.equal(doiAsArxiv.entry?.citekey, "cho2022latent");
	const missing = resolveIndex(single, { doi: "10.9999/none" });
	assert.equal(missing.status, "not-found");
	assert.deepEqual(missing.ranked, []);
	assert.equal(resolveIndex(single, { doi: "10.48550/arXiv.2103.04567", libraryID: 2 }).status, "not-found");
});

test("title selectors: exact normalized match narrowed by year and author; NFC Korean", () => {
	const nfc = resolveIndex(single, { title: "하이브리드 팀의 지식 공유와 협업 리듬" });
	assert.equal(nfc.status, "resolved");
	assert.equal(nfc.matchedBy, "title");
	assert.equal(nfc.entry?.citekey, "kang2022hybrid");
	assert.equal(nfc.query.normalized, "하이브리드 팀의 지식 공유와 협업 리듬");
	const twins = resolveIndex(single, { title: "team boundary spanning and creativity" });
	assert.equal(twins.status, "ambiguous");
	assert.equal(twins.matchedBy, "title");
	assert.deepEqual(twins.candidates.map(c => c.citekey), ["han2023boundary", "moon2019boundary"]);
	assert.deepEqual(twins.ranked.map(r => r.matchedBy), ["title", "title"]);
	const narrowed = resolveIndex(single, { title: "Team boundary spanning and creativity", year: "2019" });
	assert.equal(narrowed.status, "resolved");
	assert.equal(narrowed.entry?.citekey, "moon2019boundary");
	assert.deepEqual(narrowed.query, { kind: "title", raw: "Team boundary spanning and creativity", normalized: "team boundary spanning and creativity", year: "2019" });
	const byAuthor = resolveIndex(single, { title: "Team boundary spanning and creativity", author: "Han" });
	assert.equal(byAuthor.status, "resolved");
	assert.equal(byAuthor.entry?.citekey, "han2023boundary");
	const noSuchYear = resolveIndex(single, { title: "Team boundary spanning and creativity", year: "1999" });
	assert.equal(noSuchYear.status, "ambiguous");
	assert.equal(noSuchYear.entry, null);
});

test("prefix and free-text selectors never resolve; not-found carries at most ten suggestions", () => {
	const prefix = resolveIndex(single, { title: "Knowledge sharing rituals in" });
	assert.equal(prefix.status, "ambiguous");
	assert.equal(prefix.matchedBy, "title");
	assert.equal(prefix.entry, null);
	assert.deepEqual(prefix.ranked.map(r => [r.citekey, r.matchedBy]), [["lim2024rituals", "titlePrefix"]]);
	const query = resolveIndex(single, { query: "lim rituals distributed" });
	assert.equal(query.status, "ambiguous");
	assert.equal(query.matchedBy, null);
	assert.equal(query.entry, null);
	assert.equal(query.ranked[0].matchedBy, "query");
	const none = resolveIndex(single, { query: "quantum chromodynamics" });
	assert.equal(none.status, "not-found");
	assert.deepEqual(none.ranked, []);
	const crowd = index(Array.from({ length: 14 }, (_, i) => entry({ id: `1:EEEEEE${String(i).padStart(2, "0")}`, itemKey: `EEEEEE${String(i).padStart(2, "0")}`, citekey: `crowd${2000 + i}shared`, title: `Shared mental models study ${i}`, doi: "", url: "", year: String(2000 + i), authors: ["Crowd, Author"], metadata: {} })));
	const loose = resolveIndex(crowd, { title: "Shared mental models of climbing" });
	assert.equal(loose.status, "not-found");
	assert.equal(loose.ranked.length, 10);
	assert.ok(loose.ranked.every(r => r.matchedBy === "titleTokens" && r.reason.includes("title tokens")));
	const capped = resolveIndex(crowd, { title: "Shared mental models study" });
	assert.equal(capped.status, "ambiguous");
	assert.equal(capped.ranked.length, 10);
	assert.equal(capped.candidates.length, 10);
});

const note = (path: string, frontmatter: Record<string, unknown> | null, frontmatterParse: "ok" | "error" = "ok"): NoteRecord => ({ path, basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path, frontmatter, frontmatterParse });
const vault = "Research Vault";
const notes: NoteRecord[] = [
	note("40. Paper Analyses/park2021adaptive/park2021adaptive.md", { type: "paper-hub", citekey: "park2021adaptive", doi: "10.48550/arXiv.2103.04567", zoteroID: "1:AAAAAAA1" }),
	note("40. Paper Analyses/park2021adaptive/park2021adaptive-claim-1.md", { type: "paper-analysis", citekey: "park2021adaptive" }),
	note("40. Paper Analyses/park2021adaptive/park2021adaptive-claim-2.md", { type: "paper-analysis", citekey: "park2021adaptive" }),
	note("10. Raw Sources/2021-03-09-Adaptive-Memory-Routing.md", { type: "raw-source", citekey: "park2021adaptive", doi: "https://doi.org/10.48550/arXiv.2103.04567" }),
	note("References/Zotero/@park2021adaptive.md", { type: "zotero", citekey: "park2021adaptive", zoteroID: "1:AAAAAAA1", "zotero-key": "AAAAAAA1" }),
	note("20. Wiki/park-summary.md", { citekey: "park2021adaptive", tags: ["summary"] }), // 0.5 R14: untyped, no `@` — citekey alone no longer claims it
	note("20. Wiki/@park2021adaptive.md", { tags: ["summary"] }), // 0.5 R14: `@` basename still counts as citekey evidence
	note("20. Literature Notes/park2021.md", { type: "bookends", citekey: "park2021adaptive", bookendsID: "1234" }), // 0.5 R14: foreign identity, never claimed
	note("40. Paper Analyses/lim2024rituals/lim2024rituals.md", { type: "paper-hub", citekey: "lim2024", doi: "" }),
	note("40. Paper Analyses/unregistered/unregistered.md", { type: "paper-hub", citekey: "Ahn2025Provisional", doi: "10.1000/synthetic.9999", citekeyProvisional: true }),
	note("10. Raw Sources/2025-01-01-Unregistered.md", { type: "raw-source", citekey: "ahn2025provisional", doi: "10.1000/SYNTHETIC.9999." }),
	note("40. Paper Analyses/arxiv-only/arxiv-only.md", { type: "paper-hub", citekey: "bae2025arxivonly", doi: "", url: "https://arxiv.org/abs/2505.00001v2" }),
	note("30. Literature/zotlit-park.md", { title: "ZotLit note", "zotero-key": "AAAAAAA1" }),
	note("30. Literature/zotlit-broken.md", null, "error"),
	note("40. Paper Analyses/other-paper/other-paper.md", { type: "paper-hub", citekey: "kim2020other", doi: "10.1000/synthetic.0500" }),
];

test("note kinds follow frontmatter type", () => {
	assert.equal(noteKind(note("a.md", { type: "paper-hub" })), "hub");
	assert.equal(noteKind(note("a.md", { type: " raw-source " })), "raw");
	assert.equal(noteKind(note("a.md", { type: "paper-analysis" })), "atom");
	assert.equal(noteKind(note("a.md", { type: "zotero" })), "literature");
	assert.equal(noteKind(note("a.md", { type: "research-question" })), "other");
	assert.equal(noteKind(note("a.md", null)), "other");
});

test("classifyNotes buckets a resolved item by zoteroID and citekey", () => {
	const result = classifyNotes(vault, notes, park, {}, single);
	assert.equal(result.hub?.path, "40. Paper Analyses/park2021adaptive/park2021adaptive.md");
	assert.equal(result.hub?.basename, "park2021adaptive");
	assert.equal(result.hub?.uri, `obsidian://open?${new URLSearchParams({ vault, file: "40. Paper Analyses/park2021adaptive/park2021adaptive.md" }).toString()}`);
	assert.deepEqual(result.raw.map(r => r.path), ["10. Raw Sources/2021-03-09-Adaptive-Memory-Routing.md"]);
	assert.deepEqual(result.atoms.map(r => r.path), ["40. Paper Analyses/park2021adaptive/park2021adaptive-claim-1.md", "40. Paper Analyses/park2021adaptive/park2021adaptive-claim-2.md"]);
	assert.equal(result.literatureNote?.path, "References/Zotero/@park2021adaptive.md");
	assert.deepEqual(result.other.map(r => r.path), ["20. Wiki/@park2021adaptive.md", "30. Literature/zotlit-park.md"]);
	assert.deepEqual(result.warnings, ["Frontmatter could not be parsed for 30. Literature/zotlit-broken.md; it was not classified."]);
});

test("classifyNotes matches hubs through citekey history and ZotLit notes through a unique zotero-key", () => {
	const history = classifyNotes(vault, notes, rituals, {}, single);
	assert.equal(history.hub?.path, "40. Paper Analyses/lim2024rituals/lim2024rituals.md");
	assert.equal(history.literatureNote, null);
	const zotlitOnly = notes.filter(n => !n.path.startsWith("References/Zotero/"));
	const zotlit = classifyNotes(vault, zotlitOnly, park, {}, single);
	assert.equal(zotlit.literatureNote?.path, "30. Literature/zotlit-park.md");
	assert.deepEqual(zotlit.other.map(r => r.path), ["20. Wiki/@park2021adaptive.md"]);
	const ambiguousKey = classifyNotes(vault, zotlitOnly, park, {}, twoLibraries);
	assert.equal(ambiguousKey.literatureNote, null);
	assert.deepEqual(ambiguousKey.other.map(r => r.path), ["20. Wiki/@park2021adaptive.md"]);
	// 0.5 R14: inside the output folder an untyped, `@`-less citekey match is still the plugin's own note.
	const folder = classifyNotes(vault, zotlitOnly, park, {}, twoLibraries, { outputFolder: "/20. Wiki/" });
	assert.equal(folder.literatureNote?.path, "20. Wiki/@park2021adaptive.md");
	assert.deepEqual(folder.other.map(r => r.path), ["20. Wiki/park-summary.md"]);
	const twoOwned = [...notes, note("References/Zotero/@park2021adaptive (1).md", { type: "zotero", zoteroID: "1:AAAAAAA1" })];
	const owned = classifyNotes(vault, twoOwned, park, {}, single);
	assert.equal(owned.literatureNote?.path, "References/Zotero/@park2021adaptive (1).md");
	assert.deepEqual(owned.other.map(r => r.path), ["20. Wiki/@park2021adaptive.md", "30. Literature/zotlit-park.md", "References/Zotero/@park2021adaptive.md"]);
	assert.equal(owned.warnings.length, 2);
	assert.ok(owned.warnings.some(warning => /More than one literature note matches \(2\)/.test(warning)));
	assert.ok(owned.warnings.some(warning => /zotlit-broken/.test(warning)));
});

test("classifyNotes finds hubs and raw sources for not-found items by DOI, arXiv and case-insensitive citekey", () => {
	const byDoi = classifyNotes(vault, notes, null, { doi: "doi:10.1000/Synthetic.9999" }, single);
	assert.equal(byDoi.hub?.path, "40. Paper Analyses/unregistered/unregistered.md");
	assert.deepEqual(byDoi.raw.map(r => r.path), ["10. Raw Sources/2025-01-01-Unregistered.md"]);
	assert.deepEqual(byDoi.atoms, []);
	assert.equal(byDoi.literatureNote, null);
	const byCitekey = classifyNotes(vault, notes, null, { citekey: "AHN2025PROVISIONAL" }, single);
	assert.equal(byCitekey.hub?.path, "40. Paper Analyses/unregistered/unregistered.md");
	assert.equal(byCitekey.raw.length, 1);
	const byArxiv = classifyNotes(vault, notes, null, { arxiv: "arXiv:2505.00001" }, single);
	assert.equal(byArxiv.hub?.path, "40. Paper Analyses/arxiv-only/arxiv-only.md");
	const nothing = classifyNotes(vault, notes, null, { doi: "10.1000/absent" }, single);
	assert.deepEqual(nothing, { hub: null, raw: [], atoms: [], literatureNote: null, other: [], warnings: ["Frontmatter could not be parsed for 30. Literature/zotlit-broken.md; it was not classified."] });
	const resolvedWithHint = classifyNotes(vault, notes, twin2019, { citekey: "ahn2025provisional" }, single);
	assert.equal(resolvedWithHint.hub?.path, "40. Paper Analyses/unregistered/unregistered.md");
});

test("classifyNotes refuses to choose among multiple matching hubs and warns about every source", () => {
	const twoHubs = [
		...notes,
		note("00. Inbox/park2021adaptive-copy.md", { type: "paper-hub", citekey: "park2021adaptive" }),
	];
	const result = classifyNotes(vault, twoHubs, park, {}, single);
	assert.equal(result.hub, null);
	assert.equal(result.warnings.length, 2);
	const warning = result.warnings.find(item => item.includes("More than one hub note matches")) ?? "";
	assert.match(warning, /no hub selected/);
	assert.match(warning, /00\. Inbox\/park2021adaptive-copy\.md/);
	assert.match(warning, /40\. Paper Analyses\/park2021adaptive\/park2021adaptive\.md/);
});

test("buildNoteIndexes keys hubs and raw sources by exact (case-preserving) citekey, normalized DOI and arXiv id", () => {
	const indexes = buildNoteIndexes([...notes].reverse());
	assert.deepEqual(indexes.hubByCitekey.get("Ahn2025Provisional")?.map(n => n.path), ["40. Paper Analyses/unregistered/unregistered.md"]);
	assert.equal(indexes.hubByCitekey.has("ahn2025provisional"), false, "camelCase hub keys are not folded (pandoc matches exactly)");
	assert.deepEqual(indexes.rawByCitekey.get("ahn2025provisional")?.map(n => n.path), ["10. Raw Sources/2025-01-01-Unregistered.md"]);
	assert.equal(indexes.rawByCitekey.has("Ahn2025Provisional"), false);
	assert.deepEqual(indexes.hubByDoi.get("10.1000/synthetic.9999")?.map(n => n.path), ["40. Paper Analyses/unregistered/unregistered.md"]);
	assert.deepEqual(indexes.rawByDoi.get("10.1000/synthetic.9999")?.map(n => n.path), ["10. Raw Sources/2025-01-01-Unregistered.md"]);
	assert.deepEqual(indexes.hubByDoi.get("10.48550/arxiv.2103.04567")?.map(n => n.path), ["40. Paper Analyses/park2021adaptive/park2021adaptive.md"]);
	assert.deepEqual(indexes.hubByArxiv.get("2505.00001")?.map(n => n.path), ["40. Paper Analyses/arxiv-only/arxiv-only.md"]);
	assert.equal(indexes.hubByDoi.has(""), false);
	assert.equal(indexes.hubByCitekey.has("park2021adaptive"), true);
	assert.equal(indexes.hubByCitekey.has("kim2020other"), true);
	assert.equal(indexes.rawByCitekey.has("kim2020other"), false);
	assert.equal([...indexes.hubByCitekey.keys()].includes("zotlit-broken"), false);
	assert.deepEqual(indexes.skipped, ["30. Literature/zotlit-broken.md"]);
});
