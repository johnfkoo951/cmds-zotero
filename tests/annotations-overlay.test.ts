// 0.6.1 annotation-sidebar-live-read: the in-memory overlay of fresh reads beside the saved index. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveOverlay, sameIdentity, sourceLabel } from "../src/annotations/overlay";
import type { ZoteroIndexEntry } from "../src/types";

// Synthetic records only (AGENTS.md).
const entry = (libraryID: number, itemKey: string, o: Partial<ZoteroIndexEntry> = {}): ZoteroIndexEntry => ({
	id: `${libraryID}:${itemKey}`, libraryID, libraryType: libraryID === 1 ? "user" : "group", ...(libraryID === 1 ? {} : { groupID: 77 }), itemKey, citekey: "synthetic2026", citekeyHistory: [], title: "Synthetic",
	authors: [], year: "", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...o,
}) as ZoteroIndexEntry;

test("the overlay wins for the same id and generation", () => {
	const overlay = new LiveOverlay();
	const saved = entry(1, "AAAA1111");
	const fresh = entry(1, "AAAA1111", { title: "Fresh" });
	assert.equal(overlay.get("G1", saved.id), null);
	assert.equal(overlay.put("G1", saved, fresh, 1000), true);
	assert.deepEqual(overlay.get("G1", saved.id), { entry: fresh, at: 1000 });
	assert.equal(overlay.get("G1", "1:BBBB2222"), null, "other ids are not affected");
	assert.equal(overlay.put("G1", saved, entry(1, "AAAA1111", { title: "Fresher" }), 2000), true);
	assert.equal(overlay.get("G1", saved.id)?.entry.title, "Fresher", "a later read replaces an earlier one");
});

test("a new index generation drops every live entry", () => {
	const overlay = new LiveOverlay();
	const saved = entry(1, "AAAA1111");
	overlay.put("G1", saved, entry(1, "AAAA1111"), 1);
	overlay.put("G1", entry(1, "BBBB2222"), entry(1, "BBBB2222"), 1);
	assert.equal(overlay.get("G2", saved.id), null);
	assert.equal(overlay.get("G1", saved.id), null, "going back does not bring dropped entries back");
	assert.equal(overlay.get("G1", "1:BBBB2222"), null);
});

test("an answer for another item is refused and stores nothing", () => {
	const overlay = new LiveOverlay();
	const saved = entry(1, "AAAA1111");
	for (const other of [entry(1, "BBBB2222"), entry(2, "AAAA1111"), { ...entry(1, "AAAA1111"), libraryType: "group" as const, groupID: 5 }, { ...entry(1, "AAAA1111"), id: "1:CCCC3333" }]) {
		assert.equal(overlay.put("G1", saved, other, 1), false, JSON.stringify([other.id, other.libraryID, other.libraryType]));
		assert.equal(overlay.get("G1", saved.id), null);
	}
	assert.equal(sameIdentity(entry(2, "AAAA1111"), { ...entry(2, "AAAA1111"), groupID: 78 }), false, "another group");
	assert.equal(sameIdentity(entry(2, "AAAA1111"), entry(2, "AAAA1111", { citekey: "renamed" })), true, "a renamed citekey is the same item");
});

test("the source line names a live read's time or the snapshot's age", () => {
	const at = new Date(2026, 0, 2, 9, 5).getTime();
	assert.equal(sourceLabel(at, 30), "Live from Zotero · 09:05");
	assert.equal(sourceLabel(null, null), "Saved snapshot");
	assert.equal(sourceLabel(null, 0.4), "Saved snapshot · just now");
	assert.equal(sourceLabel(null, 12), "Saved snapshot · 12 min old");
	assert.equal(sourceLabel(null, 125), "Saved snapshot · 2 h old");
	assert.equal(sourceLabel(null, 3 * 1440 + 5), "Saved snapshot · 3 d old");
	assert.equal(sourceLabel(null, -1), "Saved snapshot");
});
