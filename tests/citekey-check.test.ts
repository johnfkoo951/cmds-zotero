import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNoteLookup, checkCitekey, citekeyShape, isP7Valid, pinInstruction, recommend } from "../src/agent/citekey-check";
import type { NoteRecord } from "../src/agent/types";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

// Synthetic fixtures only: the shapes mirror real conventions, the values do not.
const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({ id: "1:PARENT01", libraryID: 1, libraryType: "user", itemKey: "PARENT01", citekey: "doe2021widget", citekeyHistory: [], title: "Widget retrieval for synthetic tasks", authors: ["Doe, Jane"], year: "2021", doi: "10.48550/arXiv.2101.00001", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/PARENT01", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: { extra: "arXiv:2101.00001 [cs.CL]" }, ...o });

const doe = entry({});
const roe = entry({ id: "1:PARENT02", itemKey: "PARENT02", citekey: "roeKnowledgeSharing2019", citekeyHistory: ["roe2019knowledge"], title: "Knowledge sharing in synthetic teams", authors: ["Roe, Richard"], year: "2019", doi: "10.1000/synthetic.2019.1", zoteroSelectURI: "zotero://select/library/items/PARENT02", metadata: {} });
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: "2026-09-14T02:00:00.000Z", source: "better-bibtex", count: 2, entries: [doe, roe], capabilities: { zotero: "9", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };

const note = (path: string, frontmatter: Record<string, unknown> | null): NoteRecord => ({ path, basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path, frontmatter, frontmatterParse: frontmatter ? "ok" : "error" });
const notes = buildNoteLookup("Vault", [
	note("40. Paper Analyses/doe2021widget/Doe 2021 - S00 Hub.md", { type: "paper-hub", citekey: "doe2021widget", doi: "10.48550/arXiv.2101.00001" }),
	note("40. Paper Analyses/poe2022local/Poe 2022 - S00 Hub.md", { type: "paper-hub", citekey: "poe2022local", doi: "https://doi.org/10.1000/SYN.2022.7" }),
	note("40. Paper Analyses/bloggs2020arxiv/Bloggs 2020 - S00 Hub.md", { type: "paper-hub", citekey: "bloggs2020arxiv", doi: "", arxiv: "2001.00002" }),
	note("10. Raw Sources/12. Papers/2026-09-01-Widget Retrieval.md", { type: "raw-source", citekey: "doe2021widget", doi: "10.48550/arxiv.2101.00001" }),
	note("10. Raw Sources/12. Papers/2026-09-02-Local Models.md", { type: "raw-source", citekey: "Poe2022Local", doi: "doi:10.1000/syn.2022.7" }),
	note("20. Wiki/Some Concept.md", { type: "concept", citekey: "doe2021widget" }),
	note("20. Wiki/Broken.md", null),
]);

test("shape table follows the vocabulary regexes", () => {
	assert.equal(citekeyShape("doe2021widget"), "vault");
	assert.equal(citekeyShape("doe2021widgetRetrieval2"), "vault");
	assert.equal(citekeyShape("van-berg2019mental"), "vault");
	assert.equal(citekeyShape("roeKnowledgeSharing2019"), "bbt-default");
	assert.equal(citekeyShape("roeKnowledgeSharing2019a"), "bbt-default");
	// `^[a-z]+[A-Z][A-Za-z]*\d{4}[a-z]?$` accepts camel-cased particles; the vocabulary regex, not the prose example, wins.
	assert.equal(citekeyShape("vanBerg2019"), "bbt-default");
	assert.equal(citekeyShape("roe2020a"), "bbt-disambiguated");
	assert.equal(citekeyShape("roe2020"), "bbt-disambiguated");
	assert.equal(citekeyShape("Roe2020"), "other");
	assert.equal(citekeyShape("roe_2020_widget"), "other");
	assert.equal(citekeyShape("roe2020w"), "bbt-disambiguated");
	assert.equal(citekeyShape("roe20widget"), "other");
	assert.equal(citekeyShape(""), "other");
	assert.equal(isP7Valid("roe_2020_widget"), true);
	assert.equal(isP7Valid("roe2020:a.b-c"), true);
	assert.equal(isP7Valid("2020roe"), false);
	assert.equal(isP7Valid("roe 2020"), false);
	assert.equal(isP7Valid(""), false);
});

test("pinInstruction is the exact paste string", () => {
	assert.equal(pinInstruction("doe2021widget"), "Zotero → item → Extra field → add line `Citation Key: doe2021widget` (Better BibTeX pins it on save; the plugin cannot write it)");
});

test("pinned key: own entry, own notes excluded, no pin instruction", () => {
	const check = checkCitekey("doe2021widget", index, notes, { ownId: "1:PARENT01", ownPaths: ["40. Paper Analyses/doe2021widget/Doe 2021 - S00 Hub.md", "10. Raw Sources/12. Papers/2026-09-01-Widget Retrieval.md"] });
	assert.deepEqual(check, { citekey: "doe2021widget", shape: "vault", conventionOk: true, p7Valid: true, existsInIndex: true, collisions: [], pinInstruction: null });
	assert.equal(recommend(check, "doe2021widget"), "pinned");
	// Without identity hints, an existing key is a collision rather than being assumed to be this paper.
	const unknownOwner = checkCitekey("doe2021widget", index, buildNoteLookup("Vault", []));
	assert.deepEqual(unknownOwner.collisions, [{ kind: "index", ref: "1:PARENT01" }]);
	assert.equal(unknownOwner.pinInstruction, pinInstruction("doe2021widget"));
	// DOI hints identify the own entry when no ownId is given.
	assert.equal(checkCitekey("doe2021widget", index, buildNoteLookup("Vault", []), { doi: "10.48550/ARXIV.2101.00001" }).pinInstruction, null);
	assert.equal(checkCitekey("doe2021widget", index, buildNoteLookup("Vault", []), { arxiv: "arXiv:2101.00001v2" }).pinInstruction, null);
});

test("ambiguous DOI or arXiv hints do not exempt a colliding index entry", () => {
	const duplicateDoi = entry({ id: "1:PARENT03", itemKey: "PARENT03", citekey: "smith2021widget", zoteroSelectURI: "zotero://select/library/items/PARENT03" });
	const ambiguousIndex: ZoteroIndex = { ...index, count: 3, entries: [...index.entries, duplicateDoi] };
	const byDoi = checkCitekey("doe2021widget", ambiguousIndex, buildNoteLookup("Vault", []), { doi: "10.48550/ARXIV.2101.00001" });
	assert.deepEqual(byDoi.collisions, [{ kind: "index", ref: "1:PARENT01" }]);
	assert.equal(byDoi.pinInstruction, pinInstruction("doe2021widget"));
	assert.equal(recommend(byDoi, "doe2021widget"), "collision");
	const byArxiv = checkCitekey("doe2021widget", ambiguousIndex, buildNoteLookup("Vault", []), { arxiv: "2101.00001v3" });
	assert.deepEqual(byArxiv.collisions, [{ kind: "index", ref: "1:PARENT01" }]);
});

test("existing hub and raw source for the same paper collide by key and by DOI", () => {
	const check = checkCitekey("doe2021widget", index, notes, { ownId: "1:PARENT01", doi: "10.48550/arXiv.2101.00001" });
	assert.equal(check.existsInIndex, true);
	assert.deepEqual(check.collisions, [
		{ kind: "hub", ref: "40. Paper Analyses/doe2021widget/Doe 2021 - S00 Hub.md" },
		{ kind: "raw-source", ref: "10. Raw Sources/12. Papers/2026-09-01-Widget Retrieval.md" },
		{ kind: "hub-doi", ref: "40. Paper Analyses/doe2021widget/Doe 2021 - S00 Hub.md" },
		{ kind: "raw-doi", ref: "10. Raw Sources/12. Papers/2026-09-01-Widget Retrieval.md" },
	]);
	assert.equal(recommend(check, "doe2021widget"), "collision");
});

test("minting a provisional key: index, history, case-insensitive and arXiv collisions", () => {
	const taken = checkCitekey("doe2021widget", index, buildNoteLookup("Vault", []), { doi: "10.1000/other.2021.9" });
	assert.deepEqual(taken.collisions, [{ kind: "index", ref: "1:PARENT01" }]);
	assert.equal(taken.existsInIndex, true);
	assert.equal(taken.pinInstruction, pinInstruction("doe2021widget"));
	assert.equal(recommend(taken, null), "collision");
	const history = checkCitekey("roe2019knowledge", index, notes, { doi: "10.1000/other.2019.9" });
	assert.deepEqual(history.collisions, [{ kind: "history", ref: "1:PARENT02" }]);
	assert.equal(history.existsInIndex, false);
	const ci = checkCitekey("poe2022local", index, notes, { doi: "10.1000/syn.2022.7" });
	assert.deepEqual(ci.collisions, [
		{ kind: "hub", ref: "40. Paper Analyses/poe2022local/Poe 2022 - S00 Hub.md" },
		{ kind: "hub-doi", ref: "40. Paper Analyses/poe2022local/Poe 2022 - S00 Hub.md" },
		{ kind: "raw-doi", ref: "10. Raw Sources/12. Papers/2026-09-02-Local Models.md" },
		{ kind: "raw-citekey-ci", ref: "10. Raw Sources/12. Papers/2026-09-02-Local Models.md" },
	]);
	const hubCi = checkCitekey("POE2022local", index, notes);
	assert.deepEqual(hubCi.collisions, [
		{ kind: "hub-citekey-ci", ref: "40. Paper Analyses/poe2022local/Poe 2022 - S00 Hub.md" },
		{ kind: "raw-citekey-ci", ref: "10. Raw Sources/12. Papers/2026-09-02-Local Models.md" },
	]);
	const arxiv = checkCitekey("bloggs2020local", index, notes, { arxiv: "https://arxiv.org/abs/2001.00002v1" });
	assert.deepEqual(arxiv.collisions, [{ kind: "hub-doi", ref: "40. Paper Analyses/bloggs2020arxiv/Bloggs 2020 - S00 Hub.md" }]);
});

test("fresh provisional key and recommendation precedence", () => {
	const fresh = checkCitekey("  snow2024ledger ", index, notes, { doi: "10.1000/fresh.2024.1" });
	assert.deepEqual(fresh, { citekey: "snow2024ledger", shape: "vault", conventionOk: true, p7Valid: true, existsInIndex: false, collisions: [], pinInstruction: pinInstruction("snow2024ledger") });
	assert.equal(recommend(fresh, null), "ok");
	assert.equal(recommend(fresh, "snowLedger2024"), "pin-pending");
	const nonconforming = checkCitekey("snowLedger2024", index, notes, { doi: "10.1000/fresh.2024.1" });
	assert.equal(nonconforming.shape, "bbt-default");
	assert.equal(nonconforming.conventionOk, false);
	assert.equal(recommend(nonconforming, null), "nonconforming");
	assert.equal(recommend(nonconforming, "snow2024ledger"), "nonconforming");
	const pinnedNonconforming = checkCitekey("roeKnowledgeSharing2019", index, notes, { ownId: "1:PARENT02" });
	assert.equal(recommend(pinnedNonconforming, "roeKnowledgeSharing2019"), "pinned");
});
