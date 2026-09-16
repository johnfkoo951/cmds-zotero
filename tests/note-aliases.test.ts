// 0.5 R14: identity ladder (zoteroID → zoteroSelectURI → zotero-key → citekey) and the foreign-identity guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAliasIndex, citekeyEvidenceAllowed, hasForeignIdentity, noteIdentity, selectIdentity } from "../src/note-aliases";
import { classifyNotes } from "../src/agent/note-classify";
import { ZOTERO_NOTE_TYPES, type NoteRecord } from "../src/agent/types";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({
	id: "1:KOOAAAA1", libraryID: 1, libraryType: "user", itemKey: "KOOAAAA1", citekey: "koo2022", citekeyHistory: [],
	title: "Moderating effects", authors: ["Koo, Synthetic"], year: "2022", doi: "10.1000/koo.2022", url: "", collections: [], tags: [],
	attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/KOOAAAA1", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...o,
});
const koo = entry({});
const lee = entry({ id: "1:LEEAAAA1", itemKey: "LEEAAAA1", citekey: "lee2019", citekeyHistory: ["lee2019old"], zoteroSelectURI: "zotero://select/library/items/LEEAAAA1" });
const groupItem = entry({ id: "2:GRPAAAA1", libraryID: 2, libraryType: "group", groupID: 4242, itemKey: "GRPAAAA1", citekey: "grp2020", zoteroSelectURI: "zotero://select/groups/4242/items/GRPAAAA1" });
const single = buildAliasIndex([koo, lee]);
const two = buildAliasIndex([koo, lee, groupItem]);

test("explicit zoteroID and zoteroSelectURI resolve regardless of basename; unknown explicit identity refuses", () => {
	assert.equal(noteIdentity("anything", { zoteroID: koo.id }, single), koo.id);
	assert.equal(noteIdentity("anything", { zoteroID: "1:NOPEAAA1", citekey: "koo2022" }, single), null, "a zoteroID outside the index never falls through to citekey");
	assert.equal(noteIdentity("anything", { zoteroSelectURI: "zotero://select/library/items/LEEAAAA1" }, single), lee.id);
	assert.equal(noteIdentity("anything", { zoteroSelectURI: "zotero://select/groups/4242/items/GRPAAAA1" }, two), groupItem.id);
	assert.equal(noteIdentity("anything", { zoteroSelectURI: "zotero://select/library/items/GRPAAAA1" }, two), null, "library scope is part of the select identity");
	assert.equal(noteIdentity("anything", { zoteroSelectURI: "zotero://select/library/items/ZZZZZZZ9", citekey: "koo2022" }, single), null, "an unknown select URI never falls through to citekey");
	assert.equal(noteIdentity("@koo2022", { zoteroSelectURI: "zotero://open-pdf/library/items/KOOAAAA1?page=2" }, single), koo.id, "a non-select URI is not identity evidence; the @ basename still resolves");
	assert.equal(noteIdentity("@koo2022", { zoteroSelectURI: "not a uri" }, single), koo.id);
	assert.equal(selectIdentity("zotero://select/groups/4242/items/GRPAAAA1")?.groupID, 4242);
	assert.equal(selectIdentity(""), null);
	assert.equal(selectIdentity(42), null);
});

test("ZotLit zotero-key resolves only while the index holds exactly one library", () => {
	assert.equal(single.singleLibrary, true);
	assert.equal(two.singleLibrary, false);
	assert.equal(noteIdentity("zotlit-note", { "zotero-key": "LEEAAAA1" }, single), lee.id);
	assert.equal(noteIdentity("zotlit-note", { "zotero-key": " LEEAAAA1 " }, single), lee.id);
	assert.equal(noteIdentity("zotlit-note", { "zotero-key": "ZZZZZZZ9", citekey: "koo2022" }, single), null, "an unknown key in a single-library index never falls through to citekey");
	assert.equal(noteIdentity("zotlit-note", { "zotero-key": "LEEAAAA1" }, two), null, "two libraries: the bare key is ambiguous and the untyped note has no other evidence");
	assert.equal(noteIdentity("@lee2019", { "zotero-key": "LEEAAAA1" }, two), lee.id, "two libraries: the @ basename still resolves by citekey");
	assert.equal(noteIdentity("zotlit-note", { "zotero-key": "lowercase" }, single), null);
});

test("citekey evidence needs an @ basename or a Zotero note type", () => {
	assert.equal(noteIdentity("@koo2022", {}, single), koo.id);
	assert.equal(noteIdentity("@koo2022", undefined, single), koo.id);
	assert.equal(noteIdentity("koo2022", { citekey: "koo2022" }, single), null, "Bookends-style <citekey>.md without a type is not claimed");
	assert.equal(noteIdentity("koo2022", {}, single), null);
	for (const type of ZOTERO_NOTE_TYPES) assert.equal(noteIdentity("koo-hub", { type, citekey: "koo2022" }, single), koo.id, type);
	assert.equal(noteIdentity("lee-hub", { type: "paper-hub", citekey: "lee2019old" }, single), lee.id, "history counts for typed notes");
	assert.equal(noteIdentity("@lee2019old", { citekey: "lee2019" }, single), lee.id, "basename and frontmatter naming the same item agree");
	assert.equal(noteIdentity("@lee2019", { citekey: "koo2022" }, single), null, "basename and frontmatter naming different items are ambiguous");
	assert.equal(citekeyEvidenceAllowed("@x", undefined), true);
	assert.equal(citekeyEvidenceAllowed("x", { type: "raw-source" }), true);
	assert.equal(citekeyEvidenceAllowed("x", { type: "note" }), false);
	assert.equal(citekeyEvidenceAllowed("x", undefined), false);
});

test("notes carrying a foreign identity are never claimed by citekey or ZotLit key", () => {
	const foreign: Record<string, unknown>[] = [
		{ citekey: "koo2022", bookendsID: "1234" },
		{ citekey: "koo2022", bookendsID: 1234 },
		{ citekey: "koo2022", source: "bookends://sonnysoftware.com/1234" },
		{ citekey: "koo2022", links: ["x-devonthink-item://0A1B2C3D-0000-4000-8000-000000000000"] },
		{ citekey: "koo2022", type: "bookends" },
		{ citekey: "koo2022", type: "note" },
		{ "zotero-key": "KOOAAAA1", type: "bookends" },
		{ zoteroSelectURI: "zotero://select/library/items/KOOAAAA1", type: "bookends" },
	];
	for (const fm of foreign) {
		assert.equal(hasForeignIdentity(fm), true, JSON.stringify(fm));
		assert.equal(noteIdentity("@koo2022", fm, single), null, JSON.stringify(fm));
		assert.equal(noteIdentity("koo2022", fm, single), null, JSON.stringify(fm));
	}
	assert.equal(hasForeignIdentity({ citekey: "koo2022", bookendsID: "" }), false, "an empty bookendsID is not an identity");
	assert.equal(hasForeignIdentity({ type: "zotero" }), false);
	assert.equal(hasForeignIdentity(undefined), false);
	assert.equal(noteIdentity("@koo2022", { zoteroID: koo.id, type: "bookends" }, single), koo.id, "an explicit zoteroID is the strongest evidence and still wins");
});

test("reassigned aliases stay refused across the new ladder", () => {
	const moved = entry({ id: "1:NEWAAAA1", itemKey: "NEWAAAA1", citekey: "new2024", citekeyHistory: ["koo2022"] });
	const lookup = buildAliasIndex([koo, moved]);
	assert.equal(lookup.aliases.get("koo2022"), null);
	assert.equal(noteIdentity("@koo2022", {}, lookup), null);
	assert.equal(noteIdentity("hub", { type: "paper-hub", citekey: "koo2022" }, lookup), null);
	assert.equal(noteIdentity("@koo2022", { zoteroID: koo.id }, lookup), koo.id);
	const twinKey = buildAliasIndex([koo, entry({ id: "1:TWINAAA1", citekey: "twin", itemKey: "KOOAAAA1" })]);
	assert.equal(twinKey.itemKeys.get("KOOAAAA1"), null, "a colliding item key is not evidence");
	assert.equal(noteIdentity("zotlit", { "zotero-key": "KOOAAAA1" }, twinKey), null);
});

test("classifyNotes follows the same ladder: select URI matches, foreign notes and @-less untyped citekeys do not", () => {
	const index: ZoteroIndex = { schemaVersion: 2, generatedAt: "2026-09-16T00:00:00.000Z", source: "better-bibtex", count: 2, entries: [koo, lee], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
	const note = (path: string, frontmatter: Record<string, unknown> | null): NoteRecord => ({ path, basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path, frontmatter, frontmatterParse: "ok" });
	const notes = [
		note("40. Paper Analyses/koo2022/koo2022.md", { type: "paper-hub", citekey: "koo2022" }),
		note("30. Literature/by-uri.md", { zoteroSelectURI: "zotero://select/library/items/KOOAAAA1" }),
		note("30. Literature/other-uri.md", { zoteroSelectURI: "zotero://select/library/items/LEEAAAA1" }),
		note("20. Literature Notes/koo2022.md", { citekey: "koo2022", bookendsID: "77" }),
		note("20. Literature Notes/koo2022-devon.md", { type: "zotero", citekey: "koo2022", link: "x-devonthink-item://0A1B2C3D-0000-4000-8000-000000000000" }),
		note("20. Wiki/summary.md", { citekey: "koo2022" }),
		note("20. Wiki/@koo2022.md", {}),
	];
	const result = classifyNotes("Vault", notes, koo, {}, index);
	assert.equal(result.hub?.path, "40. Paper Analyses/koo2022/koo2022.md");
	assert.deepEqual(result.other.map(r => r.path), ["20. Wiki/@koo2022.md", "30. Literature/by-uri.md"]);
	assert.equal(result.literatureNote, null);
	assert.deepEqual(result.warnings, []);
});
