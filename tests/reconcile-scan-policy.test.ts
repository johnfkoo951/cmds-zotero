// 0.5 R8 (F03/LIVE-06): scoped scan policy for reconcile apply, `blocked-by-parse-error`, `yamlNormalisable`.
import test from "node:test";
import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import { runAction, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { HUB_FINDINGS, reconcileNotes, type ReconcileResult } from "../src/agent/reconcile-core";
import type { NoteRecord, ReconcileScanReport, ScanSkip } from "../src/agent/types";
import { DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";

const now = new Date("2026-09-16T10:00:00.000Z");
const entry: ZoteroIndexEntry = { id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "smith2020", citekeyHistory: [], title: "Knowledge sharing", authors: ["Smith, Ann"], year: "2020", doi: "10.1000/example", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {} };
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: now.toISOString(), source: "better-bibtex", count: 1, entries: [entry], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const HUB = "40. Paper Analyses/smith2020/smith2020.md";
const hubText = "---\ntype: paper-hub\ncitekey: smith2020\ncitekeyProvisional: true\nzoteroStatus: not-found\n---\n## S01 Identity\n";
const hubNote: NoteRecord = { path: HUB, basename: "smith2020", frontmatter: parse(/^---\n([\s\S]*?)\n---/.exec(hubText)![1]) as Record<string, unknown>, frontmatterParse: "ok" };
const broken = (path: string): NoteRecord => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, ""), frontmatter: null, frontmatterParse: "error" });

test("core: a parse-error note that mentions the hub citekey withholds the proposal as blocked-by-parse-error", () => {
	assert.equal(HUB_FINDINGS.at(-1), "blocked-by-parse-error");
	const opts = { now, stale: false, allowStale: false };
	const free = reconcileNotes([{ ...hubNote, body: hubText }], index, { name: "Research", pdfPaths: [] }, { ...opts, parseErrorSources: [{ path: "70. Outputs/other.md", text: "cites smith2020a and smith2020_draft but not the key" }] }).notes[0];
	assert.equal(free.proposalEligible, true);
	assert.ok(free.proposed);
	assert.equal(free.blockedBy, undefined);
	const blocked = reconcileNotes([{ ...hubNote, body: hubText }], index, { name: "Research", pdfPaths: [] }, { ...opts, parseErrorSources: [{ path: "40. Paper Analyses/smith2020/S02.md", text: "---\ntype: [\n---\nSee [[smith2020]]" }, { path: "70. Outputs/a.md", text: "[@smith2020]" }] }).notes[0];
	assert.equal(blocked.proposalEligible, false);
	assert.equal(blocked.proposed, null);
	assert.equal(blocked.skippedReason, "blocked-by-parse-error");
	assert.deepEqual(blocked.blockedBy, ["40. Paper Analyses/smith2020/S02.md", "70. Outputs/a.md"]);
	const finding = blocked.findings.at(-1);
	assert.equal(finding?.code, "blocked-by-parse-error");
	assert.match(finding?.message ?? "", /2 notes with unparseable frontmatter mention citekey "smith2020"/);
	assert.equal(finding?.detail, "40. Paper Analyses/smith2020/S02.md, 70. Outputs/a.md");
});

test("core: yamlNormalisable is informational and present only with a codec and a body", () => {
	const opts = { now, stale: false, allowStale: false, yaml: { parse, stringify } };
	const canonical = reconcileNotes([{ ...hubNote, body: hubText }], index, { name: "Research", pdfPaths: [] }, opts).notes[0];
	assert.equal(canonical.yamlNormalisable, true);
	const hand = "---\ntype: paper-hub\ncitekey: \"smith2020\"   # quoted by hand\ncitekeyProvisional: true\nzoteroStatus: not-found\n---\n";
	const quoted = reconcileNotes([{ ...hubNote, body: hand }], index, { name: "Research", pdfPaths: [] }, opts).notes[0];
	assert.equal(quoted.yamlNormalisable, false);
	assert.equal(quoted.proposalEligible, true, "hand formatting never withholds a proposal");
	assert.equal(reconcileNotes([hubNote], index, { name: "Research", pdfPaths: [] }, opts).notes[0].yamlNormalisable, undefined);
	assert.equal(reconcileNotes([{ ...hubNote, body: hubText }], index, { name: "Research", pdfPaths: [] }, { now, stale: false, allowStale: false }).notes[0].yamlNormalisable, undefined);
});

interface Fixture { host: ActionHost; applied: ReconcileResult[] }

function fixture(extra: NoteRecord[], scan: { skipped: string[]; truncated: boolean; skippedDetail?: ScanSkip[] }, texts: Record<string, string> = {}): Fixture {
	const connection = buildConnection({ mode: "live", obsidian: "ok", pluginVersion: "0.5.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: true, zotero: "7", betterbibtex: "7" }, index: { source: "plugin", path: "80. References/zotero-index.json", generatedAt: index.generatedAt, count: 1, complete: true, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now });
	const bodies: Record<string, string> = { [HUB]: hubText, ...texts };
	const notes = [hubNote, ...extra];
	const applied: ReconcileResult[] = [];
	const host: ActionHost = {
		vault: "Research", now, connection, settings: DEFAULT_SETTINGS, indexView: { index, stale: false, ageMinutes: 0 }, indexFailure: null,
		reader: { vaultName: () => "Research", scanWarnings: () => scan, listNotes: async () => notes, readNote: async path => { if (!(path in bodies)) throw new Error(`missing ${path}`); return bodies[path]; }, exists: async path => path in bodies },
		bibliography: null, bibliographyReason: "disabled", vaultLinks: async () => ({ links: [], warnings: [] }),
		pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
		yaml: { parse, stringify },
	};
	host.applyReconcile = async result => { applied.push(result); const notes = result.notes.filter(note => note.proposalEligible).map(note => ({ path: note.path, status: "applied" })); return { mode: "applied", attempted: notes.length, applied: notes.length, unchanged: 0, failed: 0, integrityFailure: false, notes }; };
	return { host, applied };
}

const scanOf = (payload: Record<string, unknown>): ReconcileScanReport => payload.scan as ReconcileScanReport;

test("apply: a parse-error note elsewhere in the vault no longer vetoes; it is echoed in scan.parseErrors and skippedDetail", async () => {
	const other = broken("70. Outputs/graphify/broken-description.md");
	const { host, applied } = fixture([other], { skipped: [other.path], truncated: false, skippedDetail: [{ path: other.path, kind: "parse-error" }] }, { [other.path]: "---\ndescription: unbalanced: [\n---\nnothing about the hub" });
	const dry = await runAction(host, "reconcile", {});
	assert.equal(dry.ok, true);
	assert.deepEqual(scanOf(dry), { skipped: [other.path], truncated: false, skippedDetail: [{ path: other.path, kind: "parse-error" }], parseErrors: [other.path] });
	const rows = dry.notes as { path: string; findings: { code: string }[]; yamlNormalisable?: boolean }[];
	assert.equal(rows.find(row => row.path === HUB)?.yamlNormalisable, true);
	assert.ok(!rows.find(row => row.path === HUB)?.findings.some(item => item.code === "blocked-by-parse-error"));
	const result = await runAction(host, "reconcile", { apply: true });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.reason, undefined);
	assert.equal(applied.length, 1);
	assert.equal((result.notes as { path: string; applied: boolean }[]).find(row => row.path === HUB)?.applied, true);
	assert.deepEqual(scanOf(result).parseErrors, [other.path]);
});

test("apply: a parse-error note inside --folders scope vetoes the whole apply with the path named", async () => {
	const inside = broken("40. Paper Analyses/other/other.md");
	const { host, applied } = fixture([inside], { skipped: [inside.path], truncated: false, skippedDetail: [{ path: inside.path, kind: "parse-error" }] }, { [inside.path]: "---\ntype: [\n---\nunrelated" });
	const outsideScope = await runAction(host, "reconcile", { apply: true, folders: ["40. Paper Analyses/smith2020"] });
	assert.equal(outsideScope.ok, true);
	assert.equal(applied.length, 1);
	const result = await runAction(host, "reconcile", { apply: true, folders: ["40. Paper Analyses"] });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "scan-incomplete");
	assert.match(result.message as string, /inside the apply scope \(40\. Paper Analyses\/other\/other\.md\)/);
	assert.deepEqual(result.apply, { mode: "refused", refusedReason: "scan-incomplete", refusedMessage: result.message });
	assert.equal(applied.length, 1, "the host writer is not invoked");
	assert.equal((result.notes as { path: string; applied: boolean }[]).find(row => row.path === HUB)?.applied, false);
});

test("apply: unreadable or symlinked entries and a truncated scan still veto; parse errors are read once and a vanished one counts as unreadable", async () => {
	const unreadable = fixture([], { skipped: ["50. Other/locked.md"], truncated: false, skippedDetail: [{ path: "50. Other/locked.md", kind: "unreadable" }] });
	const refusedUnreadable = await runAction(unreadable.host, "reconcile", { apply: true });
	assert.equal(refusedUnreadable.reason, "scan-incomplete");
	assert.match(refusedUnreadable.message as string, /1 unreadable or symlinked entry \(50\. Other\/locked\.md\)/);
	const symlink = fixture([], { skipped: ["linked.md"], truncated: false, skippedDetail: [{ path: "linked.md", kind: "symlink" }] });
	assert.equal((await runAction(symlink.host, "reconcile", { apply: true })).reason, "scan-incomplete");
	const truncated = fixture([], { skipped: [], truncated: true, skippedDetail: [] });
	const refusedTruncated = await runAction(truncated.host, "reconcile", { apply: true });
	assert.equal(refusedTruncated.reason, "scan-incomplete");
	assert.match(refusedTruncated.message as string, /truncated at the note limit/);
	assert.equal(unreadable.applied.length + symlink.applied.length + truncated.applied.length, 0);
	// A parse-error note listed by the scan but unreadable now is reclassified as unreadable and vetoes.
	const vanished = broken("70. Outputs/gone.md");
	const gone = fixture([vanished], { skipped: [vanished.path], truncated: false, skippedDetail: [{ path: vanished.path, kind: "parse-error" }] });
	const refusedGone = await runAction(gone.host, "reconcile", { apply: true });
	assert.equal(refusedGone.reason, "scan-incomplete");
	assert.deepEqual(scanOf(refusedGone).skippedDetail, [{ path: vanished.path, kind: "parse-error" }, { path: vanished.path, kind: "unreadable" }]);
});

test("apply: a parse-error note that mentions the hub citekey withholds that hub only; dry-run reports the same", async () => {
	const sibling = broken("40. Paper Analyses/smith2020/smith2020 - S02.md");
	const { host, applied } = fixture([sibling], { skipped: [sibling.path], truncated: false, skippedDetail: [{ path: sibling.path, kind: "parse-error" }] }, { [sibling.path]: "---\ntype: paper-atom\ncitekey: [smith2020\n---\nPart of [[smith2020]]" });
	const dry = await runAction(host, "reconcile", {});
	const row = (dry.notes as { path: string; findings: { code: string }[]; skippedReason?: string; proposed: unknown; blockedBy?: string[] }[]).find(item => item.path === HUB);
	assert.equal(row?.skippedReason, "blocked-by-parse-error");
	assert.equal(row?.proposed, null);
	assert.deepEqual(row?.blockedBy, [sibling.path]);
	assert.ok(row?.findings.some(item => item.code === "blocked-by-parse-error"));
	const result = await runAction(host, "reconcile", { apply: true });
	assert.equal(result.ok, true, "nothing is eligible, so nothing is refused vault-wide");
	assert.equal(applied.length, 1);
	assert.equal(applied[0].notes.find(note => note.path === HUB)?.proposalEligible, false);
	assert.equal((result.notes as { path: string; applied: boolean }[]).find(item => item.path === HUB)?.applied, false);
});

test("apply: a reader without skippedDetail is classified from the listing (parse-error rows tolerated, unknown skips veto)", async () => {
	const other = broken("70. Outputs/broken.md");
	const tolerated = fixture([other], { skipped: [other.path], truncated: false }, { [other.path]: "---\nx: [\n---\n" });
	const ok = await runAction(tolerated.host, "reconcile", { apply: true });
	assert.equal(ok.ok, true);
	assert.deepEqual(scanOf(ok).skippedDetail, [{ path: other.path, kind: "parse-error" }]);
	const unknown = fixture([], { skipped: ["50. Other/mystery.md"], truncated: false });
	const refused = await runAction(unknown.host, "reconcile", { apply: true });
	assert.equal(refused.reason, "scan-incomplete");
	assert.deepEqual(scanOf(refused).skippedDetail, [{ path: "50. Other/mystery.md", kind: "unreadable" }]);
});
