import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_FEATURES, runAction, validateActionRequest, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { BbtTransportError, ZoteroVersionError } from "../src/api/transport";
import { IndexRefusalError } from "../src/index-service";
import { IngestAPI } from "../src/ingest-api";
import { DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";
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
	assert.throws(() => validateActionRequest("import", { citekey: "a", adopt: "Notes/x.md", rebuild: true }), /cannot be combined/);
	assert.throws(() => validateActionRequest("import", { citekey: "a", scope: [] }), /non-empty array/);
	assert.throws(() => validateActionRequest("import", { citekey: "a", scope: ["invalid"] }), /scope must be/);
	validateActionRequest("import", { itemKey: "ABCD2345", libraryID: 1, apply: true, allowStale: true });
	validateActionRequest("import", { adopt: "Notes/existing.md", apply: true });
	validateActionRequest("import", { citekey: "a", rebuild: true, scope: ["overview", "annotations"] });
	validateActionRequest("recent", { days: 365 });
	assert.ok(AGENT_FEATURES.includes("import-modes"));
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

test("import modes (adopt, rebuild, scope) report mode, repairs, backup and unverified", async () => {
	const rebuilt = await runAction(host({
		importNote: async req => ({
			mode: req.rebuild ? "rebuild" : "import",
			item, fresh: true, before, preview,
			repairs: ["Line 14: added missing closing marker for overview"],
			backup: ".cmds-zotero/backups/notes/@Example2026-1.md",
			unverified: "Post-write check warning",
			outcome: { status: "updated", path: preview.path, preserved: [] },
			warnings: [],
		}),
	}), "import", { citekey: "Example2026", rebuild: true, scope: ["overview"], apply: true });
	assert.equal(rebuilt.ok, true);
	assert.equal(rebuilt.mode, "rebuild");
	assert.deepEqual(rebuilt.repairs, ["Line 14: added missing closing marker for overview"]);
	assert.equal(rebuilt.backup, ".cmds-zotero/backups/notes/@Example2026-1.md");
	assert.equal(rebuilt.unverified, "Post-write check warning");
});

test("Bug 39 & Priority 10: resolve/identity --refresh catches IndexRefusalError, locateTarget catches bad attachment, cites/identity pass locale and locate warns on partial textLayer", async () => {
	const bbtCause = new BbtTransportError("connection-refused", "http://127.0.0.1:23119/better-bibtex/json-rpc", "ECONNREFUSED");
	const refusingHost = host({
		refresh: async () => { throw new IndexRefusalError("bbt-unreachable", "Better BibTeX is unreachable.", bbtCause); },
	});
	const resRefused = await runAction(refusingHost, "resolve", { citekey: "Example2026", refresh: true });
	assert.equal(resRefused.ok, false);
	assert.equal(resRefused.status, "unavailable");
	assert.equal(resRefused.reason, "bbt-unreachable");
	assert.deepEqual(resRefused.bbtError, { reason: "connection-refused", endpoint: "http://127.0.0.1:23119/better-bibtex/json-rpc" });

	const idRefused = await runAction(refusingHost, "identity", { citekey: "Example2026", refresh: true });
	assert.equal(idRefused.ok, false);
	assert.equal(idRefused.reason, "bbt-unreachable");
	assert.deepEqual(idRefused.bbtError, { reason: "connection-refused", endpoint: "http://127.0.0.1:23119/better-bibtex/json-rpc" });

	const entry: ZoteroIndexEntry = {
		id: "1:ABCD2345", libraryID: 1, libraryType: "user", itemKey: "ABCD2345", citekey: "Example2026", citekeyHistory: [],
		title: "Synthetic", authors: ["Author, A"], year: "2026", doi: "", url: "", collections: [], tags: [],
		attachmentPath: "/tmp/a.pdf", zoteroSelectURI: "zotero://select/library/items/ABCD2345",
		attachments: [{ key: "PDF12345", openURI: "zotero://open-pdf/library/items/PDF12345", path: "/tmp/a.pdf", title: "Paper.pdf", annotations: [] }],
		attachmentStatus: "complete", contentHash: "", metadata: {},
	};
	const withItem = host({ indexView: { index: { ...index, count: 1, entries: [entry] }, stale: false, ageMinutes: 0 } });
	const badAttach = await runAction(withItem, "locate", { citekey: "Example2026", attachment: "NOTTHERE", quote: "some quote that is long enough" });
	assert.equal(badAttach.ok, false);
	assert.equal(badAttach.reason, "invalid-request");
	assert.match(String(badAttach.message), /not attached/);

	const seenBib: { style: string; locale?: string }[] = [];
	const noteHost = host({
		indexView: { index: { ...index, count: 1, entries: [entry] }, stale: false, ageMinutes: 0 },
		bibliography: async (_e, style, locale) => { seenBib.push({ style, locale }); return "Rendered (2026)."; },
		reader: {
			vaultName: () => "Research",
			scanWarnings: () => ({ skipped: [], truncated: false }),
			listNotes: async () => [{ path: "Notes/test.md", basename: "test", frontmatter: { csl: "chicago-author-date", lang: "ko_kr" }, frontmatterParse: "ok" }],
			readNote: async () => "[@Example2026]",
			exists: async () => true,
		},
		pdfCache: {
			list: async () => ["user-1-PDF12345-aaaaaaaaaaaaaaaa.json"],
			read: async () => JSON.stringify({
				version: 1, sha256: "a".repeat(64), bytes: 100, mtimeMs: 1, pageCount: 2, extractedAt: now.toISOString(),
				pages: [{ page: 1, pageLabel: "1", text: "Page one has sufficient body text to count as non-empty here." }, { page: 2, pageLabel: "2", text: "" }],
				id: "1:ABCD2345", attachmentKey: "PDF12345", path: "/tmp/a.pdf", tool: "pdfjs/test",
			}),
			statLocal: async () => ({ size: 100, mtimeMs: 1 }),
			fileHash: async () => null,
		},
	});
	const citesRes = await runAction(noteHost, "cites", { path: "Notes/test.md", bibliography: true });
	assert.equal(citesRes.ok, true);
	assert.deepEqual(seenBib[0], { style: "chicago-author-date", locale: "ko-KR" });
	assert.equal((citesRes.references as { locale?: string }).locale, "ko-KR");

	const idRes = await runAction(noteHost, "identity", { citekey: "Example2026", locale: "de-DE" });
	assert.equal(idRes.ok, true);
	assert.deepEqual(seenBib[1], { style: DEFAULT_SETTINGS.bibliographyStyle, locale: "de-DE" });

	const locateRes = await runAction(noteHost, "locate", { citekey: "Example2026", quote: "missing quote from the scanned page two" });
	assert.equal(locateRes.ok, true);
	assert.ok((locateRes.warnings as string[]).some(w => /Partial text layer: 1 of 2 pages/.test(w)));
});

