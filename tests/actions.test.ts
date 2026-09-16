import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_API_VERSION, AGENT_ACTIONS, runAction, validateActionRequest, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";
import type { NoteRecord } from "../src/agent/types";

const now = new Date("2026-09-14T10:00:00.000Z");
const entry: ZoteroIndexEntry = { id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "smith2020", citekeyHistory: [], title: "Knowledge sharing", authors: ["Smith, Ann"], year: "2020", doi: "10.1000/Example", url: "", collections: [], tags: [], attachmentPath: "/synthetic/paper.pdf", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [{ key: "PDF00001", openURI: "zotero://open-pdf/library/items/PDF00001", path: "/synthetic/paper.pdf", title: "PDF", annotations: [] }], attachmentStatus: "complete", contentHash: "", metadata: {} };
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: now.toISOString(), source: "better-bibtex", count: 1, entries: [entry], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const notes: NoteRecord[] = [{ path: "Questions/Q.md", basename: "Q", frontmatter: { type: "research-question" }, frontmatterParse: "ok" }, { path: "Hubs/smith2020/Hub.md", basename: "Hub", frontmatter: { type: "paper-hub", citekey: "smith2020", doi: "10.1000/Example", citekeyProvisional: false, zoteroID: entry.id, zoteroSelectURI: entry.zoteroSelectURI, zoteroStatus: "resolved", zoteroCheckedAt: now.toISOString() }, frontmatterParse: "ok" }];
const bodies = new Map([["Questions/Q.md", "[@smith2020]"], ["Hubs/smith2020/Hub.md", "---\ntype: paper-hub\ncitekey: smith2020\n---\n"]]);

function host(): ActionHost {
	const connection = buildConnection({ mode: "live", obsidian: "ok", pluginVersion: "0.4.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: true, zotero: "7", betterbibtex: "7" }, index: { source: "plugin", path: "80. References/zotero-index.json", generatedAt: index.generatedAt, count: 1, complete: true, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now });
	const value: ActionHost = {
		vault: "Research", now, connection, settings: DEFAULT_SETTINGS, indexView: { index, stale: false, ageMinutes: 0 }, indexFailure: null,
		reader: { vaultName: () => "Research", scanWarnings: () => ({ skipped: [], truncated: false }), listNotes: async () => notes, readNote: async path => bodies.get(path) ?? "", exists: async path => bodies.has(path) },
		bibliography: async () => "Smith (2020). Knowledge sharing.", bibliographyReason: null, vaultLinks: async () => ({ links: [], warnings: [] }),
		pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
	};
	value.refresh = async () => ({ host: value, refreshed: false, reason: "fresh", ageMinutesBefore: 0 });
	value.extractPdf = async () => ({ cache: { path: ".cmds-zotero/pdf-text/x.json", hit: false, evicted: [] }, extracted: { version: 1, sha256: "a".repeat(64), bytes: 8, mtimeMs: 1, pageCount: 1, extractedAt: now.toISOString(), pages: [{ page: 1, pageLabel: "1", text: "synthetic" }], id: entry.id, attachmentKey: "PDF00001", path: "/synthetic/paper.pdf", tool: "pdfjs/test" }, truncatedPages: [], warnings: [] });
	value.applyReconcile = async () => ({ mode: "applied", attempted: 0, applied: 0, unchanged: 0, failed: 0, integrityFailure: false, notes: [] });
	return value;
}

const requests: Record<string, object> = { connection: {}, info: {}, refresh: {}, resolve: { citekey: "smith2020" }, identity: { doi: "10.1000/Example", noBibliography: true }, cites: { path: "Questions/Q.md" }, reconcile: {}, diagnostics: {}, "pdf-text": { citekey: "smith2020", pages: "1" }, locate: { citekey: "smith2020", quote: "synthetic" } };

test("one exhaustive dispatcher serves all ten actions with the declared payload version", async () => {
	for (const action of AGENT_ACTIONS) {
		const result = await runAction(host(), action, requests[action]);
		assert.equal(result.action, action);
		assert.equal(result.apiVersion, ACTION_API_VERSION[action]);
		assert.equal(result.contract, 2);
		assert.deepEqual(result.apiVersions, [1, 2]);
		assert.equal(result.connection.mode, "live");
	}
});

test("direct API validation rejects unknown fields and malformed selector combinations", () => {
	assert.throws(() => validateActionRequest("info", { refresh: true }), /Unsupported/);
	assert.throws(() => validateActionRequest("resolve", { citekey: "a", doi: "10.1/x" }), /exactly one/);
	assert.throws(() => validateActionRequest("reconcile", { apply: "yes" }), /boolean/);
	assert.throws(() => validateActionRequest("pdf-text", { file: "a.pdf", citekey: "x" }), /exactly one/);
});

test("DOI-only identity omits a vault citekey rather than falling back to the index key", async () => {
	const result = await runAction(host(), "identity", { doi: "10.1000/example", noBibliography: true });
	assert.equal((result.frontmatter as Record<string, unknown>).citekey, undefined);
	assert.equal(result.citekeyCurrent, "smith2020");
});

test("allow-stale never authorizes reconcile proposals or apply", async () => {
	const staleHost = host();
	staleHost.connection.index.stale = true;
	staleHost.connection.index.ageMinutes = 120;
	staleHost.indexView = { index, stale: true, ageMinutes: 120 };
	const result = await runAction(staleHost, "reconcile", { allowStale: true });
	const hub = (result.notes as { proposed: unknown; proposalEligible: boolean }[]).find(note => note.proposalEligible || note.proposed !== undefined);
	assert.equal(hub?.proposalEligible ?? false, false);
	assert.equal(hub?.proposed ?? null, null);
});

test("locate distinguishes corrupt cache and changed source from no-cache", async () => {
	const name = `user-1-PDF00001-${"a".repeat(16)}.json`;
	const corrupt = host();
	corrupt.pdfCache = { ...corrupt.pdfCache, list: async () => [name], read: async () => "{broken" };
	const invalid = await runAction(corrupt, "locate", { citekey: "smith2020", quote: "synthetic" });
	assert.equal(invalid.reason, "cache-invalid");
	const cache = { version: 1 as const, sha256: "a".repeat(64), bytes: 8, mtimeMs: 1, pageCount: 1, extractedAt: now.toISOString(), pages: [{ page: 1, pageLabel: "1", text: "synthetic" }], id: entry.id, attachmentKey: "PDF00001", path: "/synthetic/paper.pdf", tool: "pdfjs/test" };
	const changed = host();
	changed.pdfCache = { ...changed.pdfCache, list: async () => [name], read: async () => JSON.stringify(cache), statLocal: async () => ({ size: 9, mtimeMs: 1 }) };
	const mismatch = await runAction(changed, "locate", { citekey: "smith2020", quote: "synthetic" });
	assert.equal(mismatch.reason, "source-changed");
	assert.equal(mismatch.results, undefined);
});

test("apply response reflects actual per-note writer outcomes and rejects malformed host replies", async () => {
	const value = host();
	value.applyReconcile = async () => ({ mode: "applied", notes: [{ path: "Hubs/smith2020/Hub.md", status: "applied" }] });
	const result = await runAction(value, "reconcile", { apply: true });
	assert.equal((result.notes as {path:string;applied:boolean}[]).find(note => note.path.endsWith("Hub.md"))?.applied, true);
	value.applyReconcile = async () => undefined;
	const invalid = await runAction(value, "reconcile", { apply: true });
	assert.equal(invalid.ok, false);
	assert.equal(invalid.reason, "apply-failed");
});

test("allow-stale cannot turn incomplete index citation misses into dangling verdicts", async () => {
	const value = host();
	value.indexView = { index: { ...index, complete: false }, stale: false, ageMinutes: 0 };
	value.connection.index.complete = false;
	value.reader = { ...value.reader, readNote: async path => path === "Questions/Q.md" ? "[@missing2020]" : bodies.get(path) ?? "" };
	const result = await runAction(value, "cites", { path: "Questions/Q.md", allowStale: true });
	const files = result.files as {citations:{citeStatus:string}[]}[];
	assert.equal(files[0].citations[0].citeStatus, "unchecked");
});
