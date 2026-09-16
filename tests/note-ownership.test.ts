// 0.5 R14: owned-only "Update all" partition — owner marker inside the output folder; linked notes counted once, never read outside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownershipSummary, partitionOwnedNotes, type OwnershipNote } from "../src/note-ownership";
import { ownerMarker } from "../src/note-writer";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({
	id: "1:KOOAAAA1", libraryID: 1, libraryType: "user", itemKey: "KOOAAAA1", citekey: "koo2022", citekeyHistory: [],
	title: "Moderating effects", authors: [], year: "2022", doi: "", url: "", collections: [], tags: [],
	attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/KOOAAAA1", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...o,
});
const koo = entry({});
const lee = entry({ id: "1:LEEAAAA1", itemKey: "LEEAAAA1", citekey: "lee2019", zoteroSelectURI: "zotero://select/library/items/LEEAAAA1" });
const park = entry({ id: "1:PARKAAA1", itemKey: "PARKAAA1", citekey: "park2021", zoteroSelectURI: "zotero://select/library/items/PARKAAA1" });
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: "2026-09-16T00:00:00.000Z", source: "better-bibtex", count: 3, entries: [koo, lee, park], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const note = (path: string, frontmatter: Record<string, unknown> | undefined): OwnershipNote => ({ path, basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path, frontmatter });

test("partitionOwnedNotes owns only marker-carrying notes inside the output folder and counts the rest once", async () => {
	const texts: Record<string, string> = {
		"References/Zotero/@lee2019.md": `---\ntype: zotero\n---\n\n${ownerMarker(lee.id)}\n\n# Lee`,
		"References/Zotero/@koo2022.md": `---\ntype: zotero\n---\n\n${ownerMarker(koo.id)}\n\n# Koo`,
		"References/Zotero/@koo2022 (copy).md": "---\ntype: zotero\n---\n\n# Hand-written copy without a marker",
		"References/Zotero/@park2021.md": `---\ntype: zotero\n---\n\n${ownerMarker(lee.id)}\n\n# Marker of another item`,
		"References/Zotero/unreadable.md": "",
	};
	const reads: string[] = [];
	const read = (path: string): Promise<string> => {
		reads.push(path);
		if (path.endsWith("unreadable.md")) return Promise.reject(new Error("boom"));
		return Promise.resolve(texts[path] ?? "");
	};
	const notes = [
		note("References/Zotero/@lee2019.md", { type: "zotero", zoteroID: lee.id }),
		note("References/Zotero/@koo2022.md", { type: "zotero", zoteroID: koo.id }),
		note("References/Zotero/@koo2022 (copy).md", { type: "zotero", zoteroID: koo.id }),
		note("References/Zotero/@park2021.md", { type: "zotero", zoteroID: park.id }),
		note("References/Zotero/unreadable.md", { zoteroID: park.id }),
		note("40. Paper Analyses/koo2022/koo2022.md", { type: "paper-hub", citekey: "koo2022" }),
		note("40. Paper Analyses/koo2022/koo2022-claim-1.md", { type: "paper-analysis", citekey: "koo2022" }),
		note("10. Raw Sources/2022-koo.md", { type: "raw-source", citekey: "koo2022" }),
		note("20. Literature Notes/koo2022.md", { citekey: "koo2022", bookendsID: "9" }),
		note("20. Wiki/unrelated.md", { tags: ["x"] }),
		note("20. Wiki/no-frontmatter.md", undefined),
	];
	const partition = await partitionOwnedNotes(index, notes, "/References/Zotero/", read);
	assert.deepEqual(partition.owned.map(e => e.id), [koo.id, lee.id], "index order, one entry per owned item");
	assert.deepEqual([...partition.ownedPaths], [[koo.id, ["References/Zotero/@koo2022.md"]], [lee.id, ["References/Zotero/@lee2019.md"]]]);
	assert.deepEqual(partition.linkedNotOwned, [
		"10. Raw Sources/2022-koo.md",
		"40. Paper Analyses/koo2022/koo2022-claim-1.md",
		"40. Paper Analyses/koo2022/koo2022.md",
		"References/Zotero/@koo2022 (copy).md",
		"References/Zotero/@park2021.md",
		"References/Zotero/unreadable.md",
	]);
	assert.deepEqual(reads.sort(), ["References/Zotero/@koo2022 (copy).md", "References/Zotero/@koo2022.md", "References/Zotero/@lee2019.md", "References/Zotero/@park2021.md", "References/Zotero/unreadable.md"], "only resolved notes inside the output folder are read");
	assert.equal(ownershipSummary(partition), "Owned: 2 · Linked but not owned: 6 (not updated)");
});

test("partitionOwnedNotes with an empty output folder owns nothing and reads nothing", async () => {
	let reads = 0;
	const partition = await partitionOwnedNotes(index, [note("References/Zotero/@koo2022.md", { zoteroID: koo.id })], "", () => { reads += 1; return Promise.resolve(ownerMarker(koo.id)); });
	assert.deepEqual(partition.owned, []);
	assert.deepEqual(partition.linkedNotOwned, ["References/Zotero/@koo2022.md"]);
	assert.equal(reads, 0);
	const none = await partitionOwnedNotes(index, [note("20. Wiki/x.md", { tags: [] })], "References/Zotero", () => Promise.resolve(""));
	assert.deepEqual(none, { owned: [], ownedPaths: new Map(), linkedNotOwned: [] });
});
