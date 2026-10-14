import test from "node:test";
import assert from "node:assert/strict";
import { runAction, validateActionRequest, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { BbtTransportError, ZoteroVersionError } from "../src/api/transport";
import { IngestAPI } from "../src/ingest-api";
import { DEFAULT_SETTINGS, type ZoteroIndex } from "../src/types";
import type { ImportNoteResult, RecentReport } from "../src/recent/recent-reads";

// Synthetic records only.
const now = new Date(2026, 9, 12, 9);
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: now.toISOString(), source: "better-bibtex", count: 0, entries: [], capabilities: { zotero: "10", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };

function host(extra: Partial<ActionHost> = {}): ActionHost {
	const connection = buildConnection({ mode: "live", obsidian: "ok", pluginVersion: "0.5.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: true, zotero: "10", betterbibtex: "9" }, index: { source: "plugin", path: "80. References/zotero-index.json", generatedAt: index.generatedAt, count: 0, complete: true, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now });
	return {
		vault: "Research", now, connection, settings: DEFAULT_SETTINGS, indexView: { index, stale: false, ageMinutes: 0 }, indexFailure: null,
		reader: { vaultName: () => "Research", scanWarnings: () => ({ skipped: [], truncated: false }), listNotes: async () => [], readNote: async () => "", exists: async () => false },
		bibliography: null, bibliographyReason: null, vaultLinks: async () => ({ links: [], warnings: [] }),
		pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
		...extra,
	};
}

const report = (citekey: string, readOn: string | null, note: RecentReport["note"], extra: Partial<RecentReport> = {}): RecentReport => ({
	read: { itemKey: "ABCD2345", libraryType: "user", library: "My Library", citekey, title: `Title ${citekey}`, year: "2026", authors: ["Author, Example"], readOn },
	id: "1:ABCD2345", inIndex: true, fresh: true, note, ...extra,
});

test("recent and import need the live host and answer with contract-2 envelopes", async () => {
	for (const action of ["recent", "import"] as const) {
		const result = await runAction(host(), action, action === "import" ? { citekey: "Example2026" } : {});
		assert.equal(result.ok, false);
		assert.equal(result.reason, "requires-obsidian");
		assert.equal(result.apiVersion, 2);
		assert.equal(result.contract, 2);
	}
});

test("request validation bounds the window and requires exactly one import selector", () => {
	assert.throws(() => validateActionRequest("recent", { days: 0 }), /between 1 and 365/);
	assert.throws(() => validateActionRequest("recent", { days: 400 }), /between 1 and 365/);
	assert.throws(() => validateActionRequest("recent", { days: 2.5 }), /between 1 and 365/);
	assert.throws(() => validateActionRequest("recent", { citekey: "x" }), /Unsupported recent request field/);
	assert.throws(() => validateActionRequest("import", {}), /exactly one selector/);
	assert.throws(() => validateActionRequest("import", { citekey: "a", itemKey: "ABCD2345", libraryID: 1 }), /exactly one selector/);
	assert.throws(() => validateActionRequest("import", { itemKey: "ABCD2345" }), /libraryID/);
	assert.throws(() => validateActionRequest("import", { citekey: "a", apply: "yes" }), /boolean/);
	assert.throws(() => validateActionRequest("import", { citekey: "a", pages: "1" }), /Unsupported import request field/);
	validateActionRequest("import", { itemKey: "ABCD2345", libraryID: 1, apply: true, allowStale: true });
	validateActionRequest("recent", { days: 365 });
});

test("recent lists papers with read days, note states and what needs importing", async () => {
	let asked = 0;
	const reports = [
		report("New2026", "2026-10-12", { state: "none", path: null, missing: 2, orphaned: 0, annotations: 2 }),
		report("Behind2026", "2026-10-10", { state: "behind", path: "Refs/@Behind2026.md", missing: 3, orphaned: 0, annotations: 8 }),
		report("Current2026", "2026-09-22", { state: "current", path: "Refs/@Current2026.md", missing: 0, orphaned: 0, annotations: 41 }),
		report("Unknown2026", null, null, { id: null, inIndex: false, fresh: false, problem: "Not readable" }),
	];
	const result = await runAction(host({ recentReads: async days => { asked = days; return reports; } }), "recent", {});
	assert.equal(asked, 30, "the default window is the plugin setting");
	assert.equal(result.ok, true);
	assert.equal(result.count, 4);
	assert.equal(result.today, "2026-10-12");
	const items = result.items as { citekey: string; readLabel: string; note: { needsImport: boolean; summary: string } | null; problem?: string }[];
	assert.deepEqual(items.map(item => item.readLabel), ["read today", "read 2 days ago", "read on 2026-09-22", "read recently"]);
	assert.deepEqual(items.map(item => item.note?.needsImport ?? null), [true, true, false, null]);
	assert.equal(items[1].note?.summary, "3 new annotations not in the note");
	assert.equal(items[3].problem, "Not readable");
});

test("recent reports an unreachable Zotero with the typed transport fault", async () => {
	const fault = new BbtTransportError("connection-refused", "http://127.0.0.1:23119/better-bibtex/json-rpc", "connect ECONNREFUSED 127.0.0.1:23119", { code: "ECONNREFUSED" });
	const result = await runAction(host({ recentReads: async () => { throw fault; } }), "recent", { days: 7 });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bbt-unreachable");
	assert.deepEqual(result.bbtError, { reason: "connection-refused", endpoint: "http://127.0.0.1:23119/better-bibtex/json-rpc" });
});

test("recent on a Zotero older than 10 is zotero-too-old, never bbt-unreachable (0.6)", async () => {
	const refusal = new BbtTransportError("rpc", "http://127.0.0.1:23119/better-bibtex/json-rpc", "Invalid condition 'resultLevel' in hasOperator()");
	const result = await runAction(host({ recentReads: async () => { throw new ZoteroVersionError("Zotero's reading history", 10, "9.0.4", refusal); } }), "recent", {});
	assert.equal(result.ok, false);
	assert.equal(result.reason, "zotero-too-old");
	assert.match(String(result.message), /needs Zotero 10 or later; this Zotero is 9\.0\.4/);
	assert.equal(result.bbtError, undefined);
});

const item = { id: "1:ABCD2345", citekey: "Example2026", title: "Synthetic example", year: "2026", libraryID: 1, itemKey: "ABCD2345" };
const before = { state: "behind" as const, path: "Refs/@Example2026.md", missing: 3, orphaned: 0, annotations: 8 };
const preview = { path: "Refs/@Example2026.md", exists: true, conflicts: [], softConflicts: [], sections: [{ id: "overview", state: "unchanged" }, { id: "annotation-EFGH2345-JKLM2345", state: "fresh" }], changes: true };

test("import is a dry run unless apply, and reports what the note would get", async () => {
	let seen: unknown = null;
	const result = await runAction(host({ importNote: async request => { seen = request; return { item, fresh: true, before, preview, outcome: null, warnings: [] }; } }), "import", { citekey: "Example2026" });
	assert.deepEqual(seen, { citekey: "Example2026" });
	assert.equal(result.ok, true);
	assert.equal(result.dryRun, true);
	assert.equal(result.outcome, null);
	assert.deepEqual(result.preview, { conflicts: [], softConflicts: [], sections: { unchanged: 1, fresh: 1 }, changes: true });
	assert.deepEqual((result.note as { before: unknown }).before, before);
});

test("an applied import reports the outcome and the note state after the write", async () => {
	const after = { ...before, state: "current" as const, missing: 0 };
	const applied: ImportNoteResult = { item, fresh: true, before, after, preview, outcome: { status: "updated", path: preview.path, preserved: ["annotation-EFGH2345-AAAA2345"] }, warnings: [] };
	const result = await runAction(host({ importNote: async () => applied }), "import", { citekey: "Example2026", apply: true });
	assert.equal(result.ok, true);
	assert.equal(result.dryRun, false);
	assert.equal((result.outcome as { summary: string }).summary, "Updated Refs/@Example2026.md; your edits kept in 1 section");
	assert.deepEqual((result.note as { after: unknown }).after, after);
});

test("hard conflicts refuse with note-conflict, in a dry run and on apply", async () => {
	const conflicted = { ...preview, conflicts: ["Existing note is not owned by this Zotero item"] };
	const dry = await runAction(host({ importNote: async () => ({ item, fresh: true, before, preview: conflicted, outcome: null }) }), "import", { citekey: "Example2026" });
	assert.equal(dry.ok, false);
	assert.equal(dry.reason, "note-conflict");
	assert.match(String(dry.message), /not owned/);
	const refused = await runAction(host({ importNote: async () => ({ item, fresh: true, before, preview, outcome: { status: "refused", path: preview.path, preserved: [], message: "Note changed after preview; preview again" } }) }), "import", { citekey: "Example2026", apply: true });
	assert.equal(refused.reason, "note-conflict");
	assert.equal(refused.message, "Note changed after preview; preview again");
});

test("host failures (not found, unreachable Zotero) pass through with their reason", async () => {
	const result = await runAction(host({ importNote: async () => ({ failure: { reason: "bbt-unreachable", message: "Zotero is closed", bbtError: { reason: "connection-refused", endpoint: "http://x" } } }) }), "import", { citekey: "Example2026" });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bbt-unreachable");
	assert.deepEqual(result.bbtError, { reason: "connection-refused", endpoint: "http://x" });
});

test("the host advertises its actions and counts an applied import as a write", () => {
	const api = new IngestAPI({ vault: { getName: () => "Research" } } as never, {} as never, { collecting: false } as never, {} as never, async () => {}, async () => host());
	assert(api.actions.includes("recent") && api.actions.includes("import"));
	const writes = (IngestAPI as unknown as { writes(action: string, request: unknown): boolean }).writes;
	assert.equal(writes("import", { citekey: "x", apply: true }), true);
	assert.equal(writes("import", { citekey: "x" }), false);
	assert.equal(writes("recent", {}), false);
	api.dispose();
});
