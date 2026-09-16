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

const brokenNote: NoteRecord = { path: "70. Outputs/graphify/broken-description.md", basename: "broken-description", frontmatter: null, frontmatterParse: "error" };
const camelHub: NoteRecord = { path: "40. Paper Analyses/ahn2026promptsContracts/Ahn 2026 - S00 Hub.md", basename: "Ahn 2026 - S00 Hub", frontmatter: { type: "paper-hub", citekey: "ahn2026promptsContracts", citekeyProvisional: true, zoteroStatus: "not-found" }, frontmatterParse: "ok" };

function withScan(value: ActionHost, extra: NoteRecord[], scan: { skipped: string[]; truncated: boolean }, questionBody = "[@smith2020]"): ActionHost {
	const all = [...notes, ...extra];
	value.reader = { ...value.reader, scanWarnings: () => scan, listNotes: async () => all, readNote: async path => path === "Questions/Q.md" ? questionBody : bodies.get(path) ?? "" };
	return value;
}

function staleHost(): ActionHost {
	const value = host();
	value.connection.index.stale = true;
	value.connection.index.ageMinutes = 1950;
	value.indexView = { index, stale: true, ageMinutes: 1950 };
	return value;
}

test("fresh index plus one unparseable note: resolve/identity still return not-found instead of a withheld stale-index", async () => {
	const value = withScan(host(), [brokenNote], { skipped: [brokenNote.path], truncated: false });
	const resolved = await runAction(value, "resolve", { citekey: "doesNotExist9999" });
	assert.equal(resolved.ok, true);
	assert.equal(resolved.reason, undefined);
	assert.equal(resolved.status, "not-found");
	assert.equal(resolved.indexAnswer, undefined);
	assert.deepEqual(resolved.scan, { skipped: [brokenNote.path], truncated: false });
	assert.ok((resolved.vaultNotes as { warnings: string[] }).warnings.some(warning => warning.includes(brokenNote.path)));
	assert.ok((resolved.vaultNotes as { warnings: string[] }).warnings.some(warning => warning.startsWith("Vault discovery incomplete")));
	const identity = await runAction(value, "identity", { citekey: "new2026paper", doi: "10.1000/never.registered", noBibliography: true });
	assert.equal(identity.ok, true);
	assert.equal(identity.status, "not-found");
	const frontmatter = identity.frontmatter as Record<string, unknown>;
	assert.equal(frontmatter.zoteroStatus, "not-found");
	assert.equal(frontmatter.citekeyProvisional, true);
	assert.equal(frontmatter.citekey, "new2026paper");
	assert.match(identity.callout as string, /Provisional citekey/);
	assert.deepEqual(identity.scan, { skipped: [brokenNote.path], truncated: false });
	assert.equal(identity.reason, undefined);
});

test("cites attaches hub-only evidence for a camelCase paper hub, fresh or stale, even beside skipped notes", async () => {
	for (const build of [host, staleHost]) {
		const value = withScan(build(), [camelHub, brokenNote], { skipped: [brokenNote.path], truncated: false }, "[@ahn2026promptsContracts] and [@smith2020]");
		const result = await runAction(value, "cites", { path: "Questions/Q.md", bibliography: true });
		const citations = (result.files as { citations: { citekey: string; citeStatus: string; hub?: { path: string } }[] }[])[0].citations;
		assert.equal(citations[0].citeStatus, "hub-only");
		assert.equal(citations[0].hub?.path, camelHub.path);
		assert.equal(citations[1].citeStatus, "resolved");
		assert.equal((result.summary as { hubOnly: number }).hubOnly, 1);
		assert.equal((result.summary as { unchecked: number }).unchecked, 0);
		assert.match((result.references as { markdown: string }).markdown, /- \[@ahn2026promptsContracts\] \[\[Ahn 2026 - S00 Hub\]\] \(provisional\)/);
	}
});

test("stale index without allow-stale still withholds not-found as stale-index; allow-stale lifts it even beside skipped notes", async () => {
	const withheld = await runAction(withScan(staleHost(), [brokenNote], { skipped: [brokenNote.path], truncated: false }), "resolve", { citekey: "doesNotExist9999" });
	assert.equal(withheld.ok, false);
	assert.equal(withheld.reason, "stale-index");
	assert.equal(withheld.status, "unavailable");
	assert.equal(withheld.indexAnswer, "not-found");
	assert.match(withheld.message as string, /--allow-stale/);
	const identityWithheld = await runAction(withScan(staleHost(), [], { skipped: [], truncated: false }), "identity", { citekey: "new2026paper", doi: "10.1000/never.registered", noBibliography: true });
	assert.equal(identityWithheld.reason, "stale-index");
	assert.equal((identityWithheld.frontmatter as Record<string, unknown>).zoteroStatus, "unavailable");
	const allowed = await runAction(withScan(staleHost(), [brokenNote], { skipped: [brokenNote.path], truncated: false }), "resolve", { citekey: "doesNotExist9999", allowStale: true });
	assert.equal(allowed.ok, true);
	assert.equal(allowed.status, "not-found");
	assert.equal(allowed.reason, undefined);
	const resolvedStale = await runAction(staleHost(), "resolve", { citekey: "smith2020" });
	assert.equal(resolvedStale.ok, true);
	assert.equal(resolvedStale.status, "resolved");
});

test("truncated discovery is reported as discovery-incomplete without touching the index verdict or offering allow-stale", async () => {
	const scan = { skipped: [brokenNote.path, "70. Outputs/other-broken.md"], truncated: true };
	const resolved = await runAction(withScan(host(), [brokenNote], scan), "resolve", { citekey: "doesNotExist9999" });
	assert.equal(resolved.ok, false);
	assert.equal(resolved.reason, "discovery-incomplete");
	assert.equal(resolved.status, "not-found");
	assert.equal(resolved.indexAnswer, undefined);
	assert.deepEqual(resolved.scan, scan);
	assert.match(resolved.message as string, /2 notes were skipped/);
	assert.match(resolved.message as string, new RegExp(brokenNote.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(resolved.message as string, /allow-stale/);
	const identity = await runAction(withScan(host(), [brokenNote], scan), "identity", { citekey: "new2026paper", doi: "10.1000/never.registered", noBibliography: true });
	assert.equal(identity.reason, "discovery-incomplete");
	assert.equal((identity.frontmatter as Record<string, unknown>).zoteroStatus, "not-found");
	assert.equal((identity.frontmatter as Record<string, unknown>).citekeyProvisional, true);
	const many = { skipped: Array.from({ length: 12 }, (_, i) => `70. Outputs/broken-${i}.md`), truncated: true };
	const capped = await runAction(withScan(host(), [], many), "resolve", { citekey: "doesNotExist9999" });
	assert.match(capped.message as string, /first 10 of 12/);
	assert.doesNotMatch(capped.message as string, /broken-11\.md/);
	const staleAndTruncated = await runAction(withScan(staleHost(), [], many), "resolve", { citekey: "doesNotExist9999" });
	assert.equal(staleAndTruncated.reason, "stale-index");
	const resolvedTruncated = await runAction(withScan(host(), [], many), "resolve", { citekey: "smith2020" });
	assert.equal(resolvedTruncated.reason, "discovery-incomplete");
	assert.equal(resolvedTruncated.status, "resolved");
});

test("cites names discovery-incomplete for vault-absence verdicts beside skipped notes and allow-stale does not lift it", async () => {
	const value = withScan(host(), [brokenNote], { skipped: [brokenNote.path], truncated: false }, "[@nowhere2025gone]");
	const result = await runAction(value, "cites", { path: "Questions/Q.md", bibliography: true, allowStale: true });
	const citation = (result.files as { citations: { citeStatus: string; uncheckedReason?: string }[] }[])[0].citations[0];
	assert.equal(citation.citeStatus, "unchecked");
	assert.equal(citation.uncheckedReason, "discovery-incomplete");
	assert.deepEqual(result.scan, { skipped: [brokenNote.path], truncated: false });
	const unresolved = (result.references as { unresolved: { uncheckedReason?: string; hint: string }[]; markdown: string }).unresolved[0];
	assert.equal(unresolved.uncheckedReason, "discovery-incomplete");
	assert.match(unresolved.hint, /--allow-stale does not apply/);
	assert.match((result.references as { markdown: string }).markdown, /\(unchecked: vault discovery incomplete\)/);
	const diagnostic = (result.diagnostics as { code: string; message: string }[]).find(item => item.code === "cite-unchecked");
	assert.match(diagnostic?.message ?? "", /vault discovery was incomplete/);
	const stale = await runAction(withScan(staleHost(), [], { skipped: [], truncated: false }, "[@nowhere2025gone]"), "cites", { path: "Questions/Q.md", bibliography: true });
	const staleCitation = (stale.files as { citations: { citeStatus: string; uncheckedReason?: string }[] }[])[0].citations[0];
	assert.equal(staleCitation.uncheckedReason, "stale-index");
	assert.match((stale.references as { markdown: string }).markdown, /\(unchecked: index stale\)/);
});
