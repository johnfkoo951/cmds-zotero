import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_SCHEMA, cacheFileName, cachePrefix, evictionSet, evictionSetByPath, parseCacheName, PDF_TEXT_CACHE_DIR, pickNewest, validateCache, verifyCache, type PdfTextCache } from "../src/pdf/cache";

const SHA = "0123456789abcdef".repeat(4);
const OTHER_SHA = "fedcba9876543210".repeat(4);
const attachment = { kind: "attachment", libraryType: "user", libraryID: 1, attachmentKey: "ATTACH01" } as const;
const group = { kind: "attachment", libraryType: "group", libraryID: 42, attachmentKey: "GRPATT01" } as const;

test("cache names encode scope and the first 16 hex chars of the content hash", () => {
	assert.equal(PDF_TEXT_CACHE_DIR, ".cmds-zotero/pdf-text");
	assert.equal(cachePrefix(attachment), "user-1-ATTACH01");
	assert.equal(cachePrefix(group), "group-42-GRPATT01");
	assert.equal(cachePrefix({ kind: "file" }), "file");
	assert.equal(cacheFileName(attachment, SHA), "user-1-ATTACH01-0123456789abcdef.json");
	assert.equal(cacheFileName(group, SHA), "group-42-GRPATT01-0123456789abcdef.json");
	assert.equal(cacheFileName({ kind: "file" }, SHA), "file-0123456789abcdef.json");
	assert.throws(() => cacheFileName(attachment, "abc"), /SHA-256/);
	assert.throws(() => cacheFileName({ ...attachment, attachmentKey: "short" }, SHA), /attachment key/);
	assert.throws(() => cacheFileName({ ...attachment, libraryID: 0 }, SHA), /library ID/);
	assert.throws(() => cacheFileName({ ...attachment, libraryType: "shared" as "user" }, SHA), /library type/);
});

test("cache names parse back into their scope and ignore foreign files", () => {
	assert.deepEqual(parseCacheName("user-1-ATTACH01-0123456789abcdef.json"), { scope: attachment, prefix: "user-1-ATTACH01", sha16: "0123456789abcdef" });
	assert.deepEqual(parseCacheName("group-42-GRPATT01-0123456789abcdef.json"), { scope: group, prefix: "group-42-GRPATT01", sha16: "0123456789abcdef" });
	assert.deepEqual(parseCacheName("file-0123456789abcdef.json"), { scope: { kind: "file" }, prefix: "file", sha16: "0123456789abcdef" });
	assert.equal(parseCacheName("user-0-ATTACH01-0123456789abcdef.json"), null);
	assert.equal(parseCacheName("user-1-attach01-0123456789abcdef.json"), null);
	assert.equal(parseCacheName("user-1-ATTACH01-0123456789ABCDEF.json"), null);
	assert.equal(parseCacheName("user-1-ATTACH01-0123456789abcdef.json.tmp"), null);
	assert.equal(parseCacheName("notes.md"), null);
	assert.equal(parseCacheName(""), null);
});

test("the newest cache for a prefix wins by extractedAt with a deterministic tie-break", () => {
	const entries = [
		{ name: "user-1-ATTACH01-aaaaaaaaaaaaaaaa.json", extractedAt: "2026-09-01T10:00:00.000Z" },
		{ name: "user-1-ATTACH01-bbbbbbbbbbbbbbbb.json", extractedAt: "2026-09-03T10:00:00.000Z" },
		{ name: "user-1-ATTACH01-cccccccccccccccc.json", extractedAt: "2026-09-02T10:00:00.000Z" },
		{ name: "user-1-OTHERATT-dddddddddddddddd.json", extractedAt: "2026-09-09T10:00:00.000Z" },
		{ name: "file-eeeeeeeeeeeeeeee.json", extractedAt: "2026-09-04T10:00:00.000Z" },
		{ name: "file-ffffffffffffffff.json", extractedAt: "2026-09-04T10:00:00.000Z" },
		{ name: "README.md", extractedAt: "2099-01-01T00:00:00.000Z" },
	];
	assert.equal(pickNewest(entries, "user-1-ATTACH01")?.name, "user-1-ATTACH01-bbbbbbbbbbbbbbbb.json");
	assert.equal(pickNewest(entries, "file")?.name, "file-ffffffffffffffff.json");
	assert.equal(pickNewest(entries, "user-1-MISSING1"), null);
	assert.equal(pickNewest([], "file"), null);
	assert.equal(pickNewest([{ name: "file-0000000000000000.json", extractedAt: "garbage" }, { name: "file-1111111111111111.json", extractedAt: "2026-01-01T00:00:00Z" }], "file")?.name, "file-1111111111111111.json");
});

test("eviction keeps the current cache and leaves other prefixes and foreign files alone", () => {
	const names = [
		"user-1-ATTACH01-aaaaaaaaaaaaaaaa.json",
		"user-1-ATTACH01-bbbbbbbbbbbbbbbb.json",
		"user-1-ATTACH01-cccccccccccccccc.json",
		"user-1-ATTACH01-cccccccccccccccc.json",
		"user-1-OTHERATT-dddddddddddddddd.json",
		"group-42-GRPATT01-aaaaaaaaaaaaaaaa.json",
		"file-eeeeeeeeeeeeeeee.json",
		".DS_Store",
	];
	assert.deepEqual(evictionSet(names, "user-1-ATTACH01-bbbbbbbbbbbbbbbb.json"), ["user-1-ATTACH01-aaaaaaaaaaaaaaaa.json", "user-1-ATTACH01-cccccccccccccccc.json"]);
	// file- names carry no identity: never evict another vault PDF's cache by name.
	assert.deepEqual(evictionSet(names, "file-0000000000000000.json"), []);
	assert.deepEqual(evictionSet(names, "group-42-GRPATT01-aaaaaaaaaaaaaaaa.json"), []);
	assert.throws(() => evictionSet(names, "not-a-cache.json"), /cache name/);
});

test("file-scope eviction follows the recorded vault path, never the prefix alone", () => {
	const entries = [
		{ name: "file-aaaaaaaaaaaaaaaa.json", path: "80. References/Attachments/synthetic-a.pdf" },
		{ name: "file-bbbbbbbbbbbbbbbb.json", path: "80. References/Attachments/synthetic-a.pdf" },
		{ name: "file-cccccccccccccccc.json", path: "80. References/Attachments/synthetic-b.pdf" },
		{ name: "user-1-ATTACH01-dddddddddddddddd.json", path: "80. References/Attachments/synthetic-a.pdf" },
	];
	assert.deepEqual(evictionSetByPath(entries, "file-bbbbbbbbbbbbbbbb.json", "80. References/Attachments/synthetic-a.pdf"), ["file-aaaaaaaaaaaaaaaa.json"]);
	assert.deepEqual(evictionSetByPath(entries, "file-eeeeeeeeeeeeeeee.json", "80. References/Attachments/synthetic-c.pdf"), []);
	assert.throws(() => evictionSetByPath(entries, "user-1-ATTACH01-dddddddddddddddd.json", "x.pdf"), /file scope/);
});

const cache: PdfTextCache = {
	version: 1, sha256: SHA, bytes: 1234, mtimeMs: 1725000000000.5, pageCount: 2, extractedAt: "2026-09-10T00:00:00.000Z",
	pages: [{ page: 1, pageLabel: "", text: "first" }, { page: 2, pageLabel: "ii", text: "second" }],
	id: "1:ITEMKEY1", attachmentKey: "ATTACH01", path: "/synthetic/storage/ATTACH01/paper.pdf", tool: "pdfjs/4.0.0",
};

test("validateCache accepts the schema and rejects damaged, foreign or pre-0.4 shapes", () => {
	assert.equal(CACHE_SCHEMA.version, 1);
	assert.ok(validateCache(cache));
	assert.ok(validateCache({ ...cache, id: null, attachmentKey: null, path: "80. References/Attachments/synthetic.pdf" }));
	assert.ok(validateCache(JSON.parse(JSON.stringify(cache))));
	for (const key of CACHE_SCHEMA.keys) {
		const copy: Record<string, unknown> = { ...cache };
		delete copy[key];
		assert.equal(validateCache(copy), false, `missing ${key}`);
	}
	assert.equal(validateCache(null), false);
	assert.equal(validateCache([]), false);
	assert.equal(validateCache({ ...cache, version: 2 }), false);
	assert.equal(validateCache({ ...cache, sha256: OTHER_SHA.slice(0, 63) }), false);
	assert.equal(validateCache({ ...cache, pageCount: 3 }), false);
	assert.equal(validateCache({ ...cache, pages: [{ page: 0, pageLabel: "", text: "" }, cache.pages[1]] }), false);
	assert.equal(validateCache({ ...cache, pages: [{ page: 1, pageLabel: null, text: "" }, cache.pages[1]] }), false);
	assert.equal(validateCache({ ...cache, attachmentKey: "bad" }), false);
	assert.equal(validateCache({ ...cache, extractedAt: "yesterday" }), false);
	assert.equal(validateCache({ ...cache, mtimeMs: "1725000000000" }), false);
	assert.equal(validateCache({ ...cache, tool: "" }), false);
});

test("verifyCache compares the lstat size and mtime and reports unchecked without a stat", () => {
	assert.equal(verifyCache(cache, { size: 1234, mtimeMs: 1725000000000.5 }), true);
	assert.equal(verifyCache(cache, { size: 1234, mtimeMs: 1725000000001 }), false);
	assert.equal(verifyCache(cache, { size: 1235, mtimeMs: 1725000000000.5 }), false);
	assert.equal(verifyCache(cache, null), "unchecked");
});

test("unsafe names and out-of-order or oversized cache records fail closed", () => {
	assert.equal(parseCacheName("user-9007199254740993-ATTACH01-0123456789abcdef.json"), null);
	assert.equal(validateCache({ ...cache, bytes: 0 }), false);
	assert.equal(validateCache({ ...cache, bytes: 64 * 1024 * 1024 + 1 }), false);
	assert.equal(validateCache({ ...cache, pages: [...cache.pages].reverse() }), false);
	assert.equal(validateCache({ ...cache, pages: [cache.pages[0], cache.pages[0]] }), false);
	assert.equal(validateCache({ ...cache, pages: [{...cache.pages[0],text:"x".repeat(200001)},cache.pages[1]] }), false);
	assert.equal(validateCache({ ...cache, id: null }), false);
	assert.equal(verifyCache(cache, { size: cache.bytes, mtimeMs: Math.trunc(cache.mtimeMs) }), true);
});
