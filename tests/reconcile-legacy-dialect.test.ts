// 0.5 R14: `legacy-frontmatter-dialect` — literature notes carrying pre-0.5 keys are listed for information only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPLY_ELIGIBLE_FINDINGS, DESYNC_FINDINGS, HUB_FINDINGS, LEGACY_DIALECT_SAMPLE, legacyDialectDiagnostic, legacyLiteratureKeys, noteDiagnostics, reconcileNotes, renderReport } from "../src/agent/reconcile-core";
import { LEGACY_LITERATURE_KEYS, type NoteRecord } from "../src/agent/types";
import { DIAGNOSTIC_CODES } from "../src/diagnostics";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

const lee: ZoteroIndexEntry = {
	id: "1:LEEAAAA1", libraryID: 1, libraryType: "user", itemKey: "LEEAAAA1", citekey: "lee2019transfer", citekeyHistory: [],
	title: "Transfer", authors: [], year: "2019", doi: "10.1000/lee.2019", url: "", collections: [], tags: [], attachmentPath: "",
	zoteroSelectURI: "zotero://select/library/items/LEEAAAA1", attachments: [{ key: "LEEPDFA1", openURI: "zotero://open-pdf/library/items/LEEPDFA1", path: "/synthetic/lee2019.pdf", title: "PDF", annotations: [] }], attachmentStatus: "complete", contentHash: "", metadata: {},
};
const INDEX: ZoteroIndex = { schemaVersion: 2, generatedAt: "2026-09-16T00:00:00.000Z", source: "better-bibtex", count: 1, entries: [lee], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const OPTS = { now: new Date("2026-09-16T09:00:00.000Z"), stale: false, allowStale: false };
const VAULT = { name: "SyntheticVault", pdfPaths: [] };
const note = (path: string, frontmatter: Record<string, unknown>): NoteRecord => ({ path, basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path, frontmatter, frontmatterParse: "ok" });

const legacy = note("References/Zotero/@lee2019transfer.md", { type: "zotero", citekey: "lee2019transfer", zoteroID: lee.id, "zotero-id": lee.id, "zotero-key": "LEEAAAA1", "zotero-library-id": 1, zoteroItemKey: "LEEAAAA1", zoteroLibraryID: 1, zoteroLibraryType: "user" });
const modern = note("References/Zotero/@modern.md", { type: "zotero", citekey: "lee2019transfer", zoteroID: lee.id, zoteroSelectURI: lee.zoteroSelectURI, "zotero-key": "LEEAAAA1" });
const hub = note("40. Paper Analyses/lee2019transfer/lee2019transfer.md", { type: "paper-hub", citekey: "lee2019transfer", doi: "10.1000/lee.2019", zoteroID: lee.id, zoteroSelectURI: lee.zoteroSelectURI, zoteroStatus: "resolved", zoteroCheckedAt: "2026-09-01T00:00:00.000Z", citekeyProvisional: false });

test("the finding is registered as report-only and its diagnostic is informational", () => {
	assert.ok(HUB_FINDINGS.includes("legacy-frontmatter-dialect"));
	assert.ok(!APPLY_ELIGIBLE_FINDINGS.includes("legacy-frontmatter-dialect"));
	assert.ok(!DESYNC_FINDINGS.includes("legacy-frontmatter-dialect"));
	assert.equal(DIAGNOSTIC_CODES["legacy-frontmatter-dialect"], "info");
	assert.deepEqual(legacyLiteratureKeys(legacy.frontmatter ?? {}), ["zotero-id", "zotero-library-id", "zoteroItemKey", "zoteroLibraryID", "zoteroLibraryType"]);
	assert.deepEqual(legacyLiteratureKeys(modern.frontmatter ?? {}), []);
	assert.deepEqual(LEGACY_LITERATURE_KEYS.slice(0, 5), ["zotero-id", "zotero-library-id", "zoteroItemKey", "zoteroLibraryID", "zoteroLibraryType"]);
});

test("reconcile lists a pre-0.5 literature note as an informational, never apply-eligible row", () => {
	const result = reconcileNotes([legacy, modern, hub], INDEX, VAULT, OPTS);
	assert.deepEqual(result.scanned, { hubs: 1, rawSources: 0, parseErrors: 0 }, "literature notes are not hubs, raw sources or parse errors");
	assert.deepEqual(result.notes.map(n => [n.path, n.type]), [["40. Paper Analyses/lee2019transfer/lee2019transfer.md", "paper-hub"], ["References/Zotero/@lee2019transfer.md", "literature"]]);
	const row = result.notes[1];
	assert.equal(row.classification, "unchecked");
	assert.equal(row.skippedReason, "not-paper-hub");
	assert.equal(row.proposalEligible, false);
	assert.equal(row.proposed, null);
	assert.equal(row.proposedS01, null);
	assert.equal(row.applied, false);
	assert.equal(row.resolvedVia, "zoteroID");
	assert.equal(row.index?.id, lee.id);
	assert.equal(row.citekey, "lee2019transfer");
	assert.deepEqual(row.findings.map(f => f.code), ["legacy-frontmatter-dialect"]);
	assert.equal(row.findings[0].detail, "zotero-id, zotero-library-id, zoteroItemKey, zoteroLibraryID, zoteroLibraryType");
	assert.match(row.findings[0].message, /pre-0\.5 keys .* user-owned .* not rewritten/);
	assert.deepEqual(result.summary.hubs.registeredConsistent, 1);
	assert.deepEqual(result.diagnostics.map(d => [d.code, d.severity, d.path]), [["legacy-frontmatter-dialect", "info", "References/Zotero/@lee2019transfer.md"]]);
	assert.match(result.diagnostics[0].message, /^1 literature note carries pre-0\.5 frontmatter keys; .* Sample: References\/Zotero\/@lee2019transfer\.md$/);
	assert.deepEqual(noteDiagnostics(row), [], "the per-note row carries the finding; the diagnostic is aggregated per call");
	assert.match(renderReport(result), /\| References\/Zotero\/@lee2019transfer\.md \| literature \| lee2019transfer \| unchecked \| legacy-frontmatter-dialect \| not-paper-hub \|/);
});

test("folders narrow the literature rows and a missing index still reports the dialect", () => {
	const narrowed = reconcileNotes([legacy, hub], INDEX, VAULT, { ...OPTS, folders: ["40. Paper Analyses"] });
	assert.deepEqual(narrowed.notes.map(n => n.type), ["paper-hub"]);
	const offline = reconcileNotes([legacy], null, VAULT, { ...OPTS, stale: true });
	assert.equal(offline.notes[0].type, "literature");
	assert.equal(offline.notes[0].index, null);
	assert.equal(offline.notes[0].resolvedVia, null);
	assert.deepEqual(offline.notes[0].findings.map(f => f.code), ["legacy-frontmatter-dialect"]);
	assert.equal(offline.notes[0].proposalEligible, false);
	const untyped = reconcileNotes([note("x.md", { "zotero-id": lee.id })], INDEX, VAULT, OPTS);
	assert.deepEqual(untyped.notes, [], "only type: zotero notes are inspected for the legacy dialect");
	assert.deepEqual(untyped.diagnostics, []);
});

test("many pre-0.5 literature notes collapse into one aggregated diagnostic with a bounded sample", () => {
	const many = Array.from({ length: LEGACY_DIALECT_SAMPLE + 3 }, (_, i) => note(`References/Zotero/@legacy-${String(i).padStart(2, "0")}.md`, { type: "zotero", zoteroID: lee.id, "zotero-id": lee.id }));
	const result = reconcileNotes([hub, ...many], INDEX, VAULT, OPTS);
	assert.equal(result.notes.filter(n => n.type === "literature").length, many.length, "one row per note");
	assert.equal(result.diagnostics.filter(d => d.code === "legacy-frontmatter-dialect").length, 1, "one diagnostic per call");
	const aggregate = result.diagnostics.find(d => d.code === "legacy-frontmatter-dialect");
	assert.equal(aggregate?.severity, "info");
	assert.equal(aggregate?.path, "References/Zotero/@legacy-00.md");
	assert.match(aggregate?.message ?? "", new RegExp(`^${many.length} literature notes carry pre-0\\.5 frontmatter keys;`));
	assert.match(aggregate?.message ?? "", /Sample: References\/Zotero\/@legacy-00\.md, References\/Zotero\/@legacy-01\.md, References\/Zotero\/@legacy-02\.md, References\/Zotero\/@legacy-03\.md, References\/Zotero\/@legacy-04\.md \(\+3 more\)$/);
	assert.equal(legacyDialectDiagnostic([result.notes[0]]), null, "hub rows alone produce no aggregate");
	assert.equal(legacyDialectDiagnostic(result.notes.slice(1, 2))?.message.includes("+"), false, "no remainder suffix below the sample size");
});
