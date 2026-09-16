import { test } from "node:test";
import assert from "node:assert/strict";
import {
	APPLY_ELIGIBLE_FINDINGS, HUB_FINDINGS, STATUS_TRANSITIONS, classifyHub, flagTransitionAllowed, hubAttachmentFinding, noteDiagnostics,
	observeIdentity, parseS01, proposedFrontmatter, proposedS01, reconcileNotes, renderReport, resolveHub, statusTransitionAllowed,
} from "../src/agent/reconcile-core";
import type { HubClassification, NoteRecord } from "../src/agent/types";
import { DIAGNOSTIC_CODES, diagnostic, indexDiagnostics } from "../src/diagnostics";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

const NOW = new Date("2026-09-14T09:30:00.000Z");
const CHECKED = NOW.toISOString();

const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({
	id: "1:LEEAAAA1", libraryID: 1, libraryType: "user", itemKey: "LEEAAAA1", citekey: "lee2019transfer", citekeyHistory: [],
	title: "Transfer of synthetic knowledge", authors: ["Lee, Synthetic"], year: "2019", doi: "10.1000/lee.2019", url: "", collections: [], tags: [],
	attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/LEEAAAA1",
	attachments: [{ key: "LEEPDFA1", openURI: "zotero://open-pdf/library/items/LEEPDFA1", path: "/synthetic/lee2019.pdf", title: "PDF", annotations: [] }],
	attachmentStatus: "complete", contentHash: "", metadata: {}, ...o,
});

const lee = entry({});
const park = entry({ id: "1:PARKAAA1", itemKey: "PARKAAA1", citekey: "parkAttention2021", title: "Attention in synthetic teams", authors: ["Park, Synthetic"], year: "2021", doi: "10.1000/park.2021", zoteroSelectURI: "zotero://select/library/items/PARKAAA1", attachments: [] });
const oh = entry({ id: "1:OHAAAAA1", itemKey: "OHAAAAA1", citekey: "oh2022signal", title: "Signal shapes", year: "2022", doi: "10.1000/oh.2022", zoteroSelectURI: "zotero://select/library/items/OHAAAAA1", attachments: [{ key: "OHPDFAA1", openURI: "zotero://open-pdf/library/items/OHPDFAA1", path: null, title: "PDF", annotations: [] }] });
const kang = entry({ id: "1:KANGAAA1", itemKey: "KANGAAA1", citekey: "kangMemory2020", citekeyHistory: ["kang2020memory"], year: "2020", doi: "10.1000/kang.2020", zoteroSelectURI: "zotero://select/library/items/KANGAAA1" });
const choiA = entry({ id: "1:CHOIAAA1", itemKey: "CHOIAAA1", citekey: "choi2018", year: "2018", doi: "10.1000/dup.2018", zoteroSelectURI: "zotero://select/library/items/CHOIAAA1" });
const choiB = entry({ id: "1:CHOIAAA2", itemKey: "CHOIAAA2", citekey: "choi2018a", year: "2018", doi: "10.1000/dup.2018", zoteroSelectURI: "zotero://select/library/items/CHOIAAA2" });
const twinA = entry({ id: "1:TWINAAA1", itemKey: "TWINAAA1", citekey: "twin2017key", doi: "10.1000/twin.a", zoteroSelectURI: "zotero://select/library/items/TWINAAA1" });
const twinB = entry({ id: "1:TWINAAA2", itemKey: "TWINAAA2", citekey: "twin2017key", doi: "10.1000/twin.b", zoteroSelectURI: "zotero://select/library/items/TWINAAA2" });
const arx = entry({ id: "1:ARXAAAA1", itemKey: "ARXAAAA1", citekey: "arx2023preprint", doi: "", url: "http://arxiv.org/abs/2301.00001", metadata: { extra: "arXiv:2301.00001 [cs.CL]" }, zoteroSelectURI: "zotero://select/library/items/ARXAAAA1" });

const index = (entries: ZoteroIndexEntry[]): ZoteroIndex => ({ schemaVersion: 2, generatedAt: "2026-09-14T09:00:00.000Z", source: "better-bibtex", count: entries.length, entries, capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true });
const INDEX = index([lee, park, oh, kang, choiA, choiB, twinA, twinB, arx]);

const note = (path: string, frontmatter: Record<string, unknown> | null, body?: string): NoteRecord => ({ path, basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path, frontmatter, frontmatterParse: "ok", ...(body === undefined ? {} : { body }) });
const hub = (key: string, extra: Record<string, unknown> = {}, body?: string): NoteRecord => note(`40. Paper Analyses/${key}/${key}.md`, { type: "paper-hub", citekey: key, ...extra }, body);

const S01_CONFIRMED = "## S01 Identity\n- **Zotero**: zotero://select/library/items/LEEAAAA1\n- **citekey**: `lee2019transfer` (Zotero/BBT confirmed 2026-08-20)\n- **DOI**: 10.1000/lee.2019\n";
const S01_NOT_REGISTERED = "## S01 Identity\n- **Zotero**: not registered (BBT server unreachable at ingest time)\n- **citekey**: `oh2022signal` (provisional)\n- **DOI**: `10.1000/oh.2022`\n";
const VAULT = { name: "SyntheticVault", pdfPaths: ["80. References/Attachments/2021-park-attention-parkAttention2021.pdf", "80. References/Attachments/2019-lee-transfer-lee2019transfer.pdf", "10. Raw Sources/loose.pdf"] };
const OPTS = { now: NOW, stale: false, allowStale: false };

test("parseS01 reads the identity lines, strips backticks and classifies markers", () => {
	const confirmed = parseS01(S01_CONFIRMED);
	assert.deepEqual(confirmed, { zotero: "zotero://select/library/items/LEEAAAA1", citekey: "lee2019transfer", citekeyNote: "(Zotero/BBT confirmed 2026-08-20)", doi: "10.1000/lee.2019", marker: "confirmed" });
	const provisional = parseS01(S01_NOT_REGISTERED);
	assert.equal(provisional.marker, "provisional");
	assert.equal(provisional.citekey, "oh2022signal");
	assert.equal(provisional.doi, "10.1000/oh.2022");
	assert.equal(parseS01("- **Zotero**: not registered\n- **citekey**: oh2022signal\n").marker, "not-registered");
	assert.equal(parseS01("- **citekey**: oh2022signal (provisional — see Raw Source warning callout)\n").marker, "provisional");
	assert.equal(parseS01("- **citekey**: `oh2022signal` (pinned 2026-09-01)\n").marker, "registered");
	assert.equal(parseS01("- **Zotero**: zotero://select/library/items/OHAAAAA1\n- **citekey**: oh2022signal\n").marker, "registered");
	assert.equal(parseS01("- **citekey**: `oh2022signal`\r\n- **Zotero**: not registered\r\n").marker, "not-registered");
	assert.equal(parseS01("- **citekey**: `oh2022signal`\n> [!check] Zotero citekey confirmed\n").marker, "confirmed");
	assert.equal(parseS01("- **citekey**: `oh2022signal`\n> [!warning]+ Provisional citekey\n").marker, "provisional");
	assert.equal(parseS01("- **citekey**: `oh2022signal`\n> [!info] Citekey pinned\n").marker, "registered");
	assert.equal(parseS01("- **citekey**: `oh2022signal` (provisional)\n> [!check] Zotero citekey confirmed\n").marker, "provisional", "the citekey line wins over callouts");
	assert.deepEqual(parseS01("# No identity here\n"), { zotero: null, citekey: null, citekeyNote: "", doi: null, marker: null });
	assert.equal(parseS01("- **citekey**: {authYearShorttitle}\n").citekey, "{authYearShorttitle}");
});

test("resolveHub follows zoteroID → zoteroSelectURI → citekey → citekeyHistory → folder → doi/arXiv", () => {
	const byId = resolveHub(hub("wrong2000key", { zoteroID: "1:LEEAAAA1" }), INDEX);
	assert.equal(byId.resolvedVia, "zoteroID");
	assert.equal(byId.entry?.id, "1:LEEAAAA1");
	assert.equal(byId.citekey, "wrong2000key", "the vault key is never replaced by entry.citekey");
	const staleId = resolveHub(hub("lee2019transfer", { zoteroID: "1:GONEAAA1", zoteroSelectURI: "zotero://select/library/items/OHAAAAA1" }), INDEX);
	assert.equal(staleId.status, "ambiguous", "URI and current citekey evidence for different entries never resolve by precedence");
	assert.equal(staleId.identityConflict, true);
	assert.deepEqual(staleId.candidates.map(item => item.id), ["1:LEEAAAA1", "1:OHAAAAA1"]);
	assert.equal(resolveHub(hub("lee2019transfer", { zoteroSelectURI: "zotero://select/groups/7/items/OHAAAAA1" }), INDEX).resolvedVia, "citekey", "a group URI does not match a user-library item");
	assert.equal(resolveHub(hub("lee2019transfer", { zoteroSelectURI: "not a uri" }), INDEX).resolvedVia, "citekey");
	const history = resolveHub(hub("kang2020memory"), INDEX);
	assert.equal(history.resolvedVia, "citekeyHistory");
	assert.equal(history.entry?.citekey, "kangMemory2020");
	const folder = resolveHub(note("40. Paper Analyses/lee2019transfer/hub.md", { type: "paper-hub" }), INDEX);
	assert.equal(folder.resolvedVia, "folder");
	assert.equal(folder.citekey, "lee2019transfer");
	assert.equal(folder.citekeySource, "folder");
	const folderIgnored = resolveHub(note("40. Paper Analyses/lee2019transfer/hub.md", { type: "paper-hub", citekey: "other2019key" }), INDEX);
	assert.equal(folderIgnored.status, "not-found", "the folder key is only used when the frontmatter key is absent");
	assert.equal(folderIgnored.citekey, "other2019key");
	const byDoi = resolveHub(hub("park2021attention", { doi: "https://doi.org/10.1000/PARK.2021" }), INDEX);
	assert.equal(byDoi.resolvedVia, "doi");
	assert.equal(byDoi.entry?.citekey, "parkAttention2021");
	const byArxiv = resolveHub(hub("arx2023other", { arxiv: "arXiv:2301.00001v2" }), INDEX);
	assert.equal(byArxiv.resolvedVia, "arxiv");
	const dupDoi = resolveHub(hub("choi2018teams", { doi: "10.1000/dup.2018" }), INDEX);
	assert.equal(dupDoi.status, "ambiguous");
	assert.equal(dupDoi.ambiguous, true);
	assert.deepEqual(dupDoi.candidates.map(c => c.citekey), ["choi2018", "choi2018a"]);
	const dupKey = resolveHub(hub("twin2017key"), INDEX);
	assert.equal(dupKey.status, "ambiguous");
	assert.equal(resolveHub(hub("nobody2001here"), INDEX).status, "not-found");
	const unavailable = resolveHub(hub("lee2019transfer"), null);
	assert.equal(unavailable.status, "unavailable");
	assert.equal(unavailable.resolvedVia, null);
	assert.equal(resolveHub(note("loose.md", { type: "paper-hub" }), INDEX).citekey, "");
});

test("registered-consistent anchor: confirmed S01, flag false, only missing-* proposed", () => {
	const anchor = hub("lee2019transfer", { citekeyProvisional: false, doi: "10.1000/lee.2019" }, S01_CONFIRMED);
	const resolution = resolveHub(anchor, INDEX);
	const verdict = classifyHub(anchor, resolution, false, false);
	assert.equal(verdict.classification, "registered-consistent");
	assert.deepEqual(verdict.findings.map(f => f.code), ["missing-zoteroID", "missing-zoteroSelectURI", "missing-zoteroStatus", "missing-zoteroCheckedAt"]);
	assert.equal(verdict.citekeyCurrent, undefined);
	assert.deepEqual(proposedFrontmatter(observeIdentity(anchor), resolution, verdict.classification, NOW, false), { zoteroID: "1:LEEAAAA1", zoteroSelectURI: "zotero://select/library/items/LEEAAAA1", zoteroStatus: "resolved", zoteroCheckedAt: CHECKED });
	assert.equal(proposedS01(anchor, resolution, verdict.classification, NOW, true), null, "a dated confirmed line is never rewritten");
	assert.deepEqual(noteDiagnostics({ ...reconcileNotes([anchor], INDEX, VAULT, OPTS).notes[0] }), []);
	const complete = hub("lee2019transfer", { citekeyProvisional: false, doi: "10.1000/lee.2019", zoteroID: "1:LEEAAAA1", zoteroSelectURI: "zotero://select/library/items/LEEAAAA1", zoteroStatus: "resolved", zoteroCheckedAt: "2026-09-01T00:00:00.000Z" }, S01_CONFIRMED);
	const done = classifyHub(complete, resolveHub(complete, INDEX), false, false);
	assert.deepEqual(done.findings, []);
	assert.equal(proposedFrontmatter(observeIdentity(complete), resolveHub(complete, INDEX), done.classification, NOW, false), null, "nothing to write means no zoteroCheckedAt churn");
});

test("registered-desynced: selectURI present, S01 not registered, flag absent", () => {
	const desynced = hub("oh2022signal", { zoteroSelectURI: "zotero://select/library/items/OHAAAAA1", doi: "10.1000/oh.2022" }, S01_NOT_REGISTERED);
	const resolution = resolveHub(desynced, INDEX);
	assert.equal(resolution.resolvedVia, "zoteroSelectURI");
	const verdict = classifyHub(desynced, resolution, false, false);
	assert.equal(verdict.classification, "registered-desynced");
	assert.deepEqual(verdict.findings.map(f => f.code), ["missing-zoteroID", "missing-zoteroStatus", "missing-zoteroCheckedAt", "citekeyProvisional-absent", "s01-says-unregistered"]);
	assert.deepEqual(proposedFrontmatter(observeIdentity(desynced), resolution, verdict.classification, NOW, false), { citekeyProvisional: false, zoteroID: "1:OHAAAAA1", zoteroStatus: "resolved", zoteroCheckedAt: CHECKED });
	assert.deepEqual(proposedS01(desynced, resolution, verdict.classification, NOW, true), { zotero: "zotero://select/library/items/OHAAAAA1", citekey: "`oh2022signal` (Zotero/BBT confirmed 2026-09-14)" });
	const mismatch = hub("lee2019transfer", { citekeyProvisional: false, zoteroID: "1:OHAAAAA1", zoteroSelectURI: "zotero://select/library/items/LEEAAAA1", zoteroStatus: "not-found", zoteroCheckedAt: "2025-01-01T00:00:00Z" }, S01_CONFIRMED);
	const mismatchResolution = resolveHub(mismatch, INDEX);
	assert.equal(mismatchResolution.status, "ambiguous", "valid ID-A must not win over URI/citekey-B");
	assert.equal(mismatchResolution.identityConflict, true);
	const byKey = hub("lee2019transfer", { citekeyProvisional: false, zoteroID: "1:GONEAAA1", zoteroStatus: "unavailable", zoteroCheckedAt: "2025-01-01T00:00:00Z" }, S01_CONFIRMED);
	const byKeyResolution = resolveHub(byKey, INDEX);
	const byKeyVerdict = classifyHub(byKey, byKeyResolution, false, false);
	assert.equal(byKeyVerdict.classification, "registered-desynced");
	assert.deepEqual(byKeyVerdict.findings.map(f => f.code), ["missing-zoteroSelectURI", "identity-conflict", "zoteroID-mismatch", "zoteroStatus-stale"]);
	assert.equal(byKeyResolution.identityConflict, true, "a valid but unmatched write-once ID contradicts the resolved item");
	assert.equal(proposedFrontmatter(observeIdentity(byKey), byKeyResolution, byKeyVerdict.classification, NOW, false), null, "identity conflicts are report-only");
	const diagnostics = reconcileNotes([desynced], INDEX, VAULT, OPTS).diagnostics;
	assert.equal(diagnostics.length, 2);
	assert.equal(diagnostics[0].code, "identity-desync");
	assert.equal(diagnostics[0].severity, "warning");
	assert.equal(diagnostics[0].path, desynced.path);
	assert.equal(diagnostics[1].code, "attachment-missing-for-hub");
});

test("registered-unpinned: hub doi resolves to a bbt-default key; flag stays true, never not-found", () => {
	const unpinned = hub("park2021attention", { doi: "10.1000/park.2021" }, "- **Zotero**: not registered\n- **citekey**: `park2021attention` (provisional)\n");
	const resolution = resolveHub(unpinned, INDEX);
	assert.equal(resolution.resolvedVia, "doi");
	const verdict = classifyHub(unpinned, resolution, false, false);
	assert.equal(verdict.classification, "registered-unpinned");
	assert.equal(verdict.citekeyCurrent, "parkAttention2021");
	assert.match(verdict.pinInstruction ?? "", /Citation Key: park2021attention/);
	assert.deepEqual(verdict.findings.map(f => f.code), ["missing-zoteroID", "missing-zoteroSelectURI", "missing-zoteroStatus", "missing-zoteroCheckedAt", "citekeyProvisional-absent", "s01-says-unregistered", "citekey-not-pinned"]);
	assert.deepEqual(proposedFrontmatter(observeIdentity(unpinned), resolution, verdict.classification, NOW, false), { citekeyProvisional: true, zoteroID: "1:PARKAAA1", zoteroSelectURI: "zotero://select/library/items/PARKAAA1", zoteroStatus: "resolved", zoteroCheckedAt: CHECKED });
	assert.deepEqual(proposedS01(unpinned, resolution, verdict.classification, NOW, true), { zotero: "zotero://select/library/items/PARKAAA1", citekey: "`park2021attention` (Zotero key: parkAttention2021 — pin pending)" });
	const flagged = hub("park2021attention", { doi: "10.1000/park.2021", citekeyProvisional: true, zoteroStatus: "not-found" }, "- **Zotero**: zotero://select/library/items/PARKAAA1\n- **citekey**: `park2021attention` (Zotero key: parkAttention2021 — pin pending)\n");
	const flaggedResolution = resolveHub(flagged, INDEX);
	const flaggedVerdict = classifyHub(flagged, flaggedResolution, false, false);
	assert.equal(flaggedVerdict.classification, "registered-unpinned");
	assert.ok(!flaggedVerdict.findings.some(f => f.code === "s01-says-unregistered"), "a pin-pending line is not a contradiction");
	const proposal = proposedFrontmatter(observeIdentity(flagged), flaggedResolution, flaggedVerdict.classification, NOW, false);
	assert.equal(proposal?.citekeyProvisional, undefined, "true stays true while the key is unpinned");
	assert.equal(proposal?.zoteroStatus, "resolved");
	assert.equal(proposedS01(flagged, flaggedResolution, flaggedVerdict.classification, NOW, true), null);
	const falseFlag = hub("park2021attention", { doi: "10.1000/park.2021", citekeyProvisional: false });
	const falseVerdict = classifyHub(falseFlag, resolveHub(falseFlag, INDEX), false, false);
	assert.ok(falseVerdict.findings.some(f => f.code === "citekeyProvisional-stale"));
	const result = reconcileNotes([unpinned], INDEX, VAULT, OPTS);
	assert.equal(result.notes[0].index?.citekeyShape, "bbt-default");
	assert.equal(result.notes[0].index?.hasPdf, false);
	assert.deepEqual(result.diagnostics.map(d => d.code), ["citekey-not-pinned", "attachment-missing-for-hub"]);
	assert.equal(result.diagnostics[0].itemID, "1:PARKAAA1");
	assert.equal(result.diagnostics[0].citekey, "park2021attention");
	assert.match(result.diagnostics[1].message, /80\. References\/Attachments\/2021-park-attention-parkAttention2021\.pdf/);
});

test("provisional-now-registered: resolved by key with flag true proposes the flip", () => {
	const now = hub("lee2019transfer", { citekeyProvisional: true, doi: "10.1000/lee.2019" }, "- **Zotero**: not registered\n- **citekey**: `lee2019transfer` (provisional)\n");
	const resolution = resolveHub(now, INDEX);
	assert.equal(resolution.resolvedVia, "citekey");
	const verdict = classifyHub(now, resolution, false, false);
	assert.equal(verdict.classification, "provisional-now-registered");
	assert.ok(verdict.findings.some(f => f.code === "s01-says-unregistered"));
	assert.ok(!verdict.findings.some(f => f.code === "citekeyProvisional-absent"));
	assert.deepEqual(proposedFrontmatter(observeIdentity(now), resolution, verdict.classification, NOW, false), { citekeyProvisional: false, zoteroID: "1:LEEAAAA1", zoteroSelectURI: "zotero://select/library/items/LEEAAAA1", zoteroStatus: "resolved", zoteroCheckedAt: CHECKED });
	const onStale = proposedFrontmatter(observeIdentity(now), resolution, verdict.classification, NOW, true);
	assert.equal(onStale, null, "stale state is report-only even for positive matches");
	const diagnostics = reconcileNotes([now], INDEX, VAULT, OPTS).diagnostics;
	assert.deepEqual(diagnostics.map(d => [d.code, d.severity]), [["provisional-now-registered", "info"]]);
	const history = hub("kang2020memory", { citekeyProvisional: true });
	const historyResolution = resolveHub(history, INDEX);
	const historyVerdict = classifyHub(history, historyResolution, false, false);
	assert.equal(historyVerdict.classification, "registered-consistent", "a former key is registered but pin pending, so true is correct");
	assert.equal(historyVerdict.citekeyCurrent, "kangMemory2020");
	assert.equal(proposedFrontmatter(observeIdentity(history), historyResolution, historyVerdict.classification, NOW, false)?.citekeyProvisional, undefined);
});

test("unregistered hubs: flagged keeps the flag, unflagged proposes true + not-found + checkedAt", () => {
	const flagged = hub("huang2020fresh", { citekeyProvisional: true });
	const flaggedResolution = resolveHub(flagged, INDEX);
	const flaggedVerdict = classifyHub(flagged, flaggedResolution, false, false);
	assert.equal(flaggedVerdict.classification, "unregistered-flagged");
	assert.deepEqual(flaggedVerdict.findings.map(f => f.code), ["missing-zoteroStatus", "missing-zoteroCheckedAt"]);
	assert.deepEqual(proposedFrontmatter(observeIdentity(flagged), flaggedResolution, flaggedVerdict.classification, NOW, false), { zoteroStatus: "not-found", zoteroCheckedAt: CHECKED });
	assert.deepEqual(proposedS01(hub("huang2020fresh", { citekeyProvisional: true }, "- **Zotero**: not registered (BBT server unreachable at ingest time)\n- **citekey**: `huang2020fresh` (provisional)\n"), flaggedResolution, flaggedVerdict.classification, NOW, true), null);
	assert.deepEqual(proposedS01(hub("huang2020fresh", { citekeyProvisional: true }, "- **Zotero**: zotero://select/library/items/ZZZZZZZ1\n- **citekey**: `huang2020fresh` (Zotero/BBT confirmed 2026-01-01)\n"), flaggedResolution, flaggedVerdict.classification, NOW, true), { zotero: "not registered", citekey: "`huang2020fresh` (provisional)" });
	const unflagged = hub("ahn2021blind", {});
	const unflaggedResolution = resolveHub(unflagged, INDEX);
	const unflaggedVerdict = classifyHub(unflagged, unflaggedResolution, false, false);
	assert.equal(unflaggedVerdict.classification, "unregistered-unflagged");
	assert.deepEqual(unflaggedVerdict.findings.map(f => f.code), ["missing-zoteroStatus", "missing-zoteroCheckedAt", "citekeyProvisional-absent"]);
	assert.deepEqual(proposedFrontmatter(observeIdentity(unflagged), unflaggedResolution, unflaggedVerdict.classification, NOW, false), { citekeyProvisional: true, zoteroStatus: "not-found", zoteroCheckedAt: CHECKED });
	const falseFlag = hub("ahn2021blind", { citekeyProvisional: false, zoteroStatus: "resolved", zoteroCheckedAt: "2025-01-01T00:00:00Z" });
	const falseVerdict = classifyHub(falseFlag, resolveHub(falseFlag, INDEX), false, false);
	assert.equal(falseVerdict.classification, "unregistered-unflagged");
	assert.deepEqual(falseVerdict.findings.map(f => f.code), ["citekeyProvisional-stale", "zoteroStatus-stale"]);
	assert.equal(proposedFrontmatter(observeIdentity(falseFlag), resolveHub(falseFlag, INDEX), falseVerdict.classification, NOW, false), null, "false never flips to true and resolved never moves");
	const claimsIdentity = hub("ahn2021blind", { zoteroID: "1:GONEAAA1" });
	const claimsVerdict = classifyHub(claimsIdentity, resolveHub(claimsIdentity, INDEX), false, false);
	assert.ok(claimsVerdict.findings.some(f => f.code === "zoteroID-mismatch"));
	assert.equal(proposedFrontmatter(observeIdentity(claimsIdentity), resolveHub(claimsIdentity, INDEX), claimsVerdict.classification, NOW, false), null, "not-found is never written over a present identity key");
	const diagnostics = reconcileNotes([flagged, unflagged], INDEX, VAULT, OPTS).diagnostics;
	assert.deepEqual(diagnostics.map(d => [d.code, d.severity, d.citekey]), [["citekey-unregistered", "error", "ahn2021blind"]]);
});

test("ambiguous and unchecked verdicts propose nothing and are skipped", () => {
	const dup = hub("choi2018teams", { doi: "10.1000/dup.2018" });
	const dupVerdict = classifyHub(dup, resolveHub(dup, INDEX), false, false);
	assert.equal(dupVerdict.classification, "ambiguous");
	assert.deepEqual(dupVerdict.findings, []);
	assert.equal(proposedFrontmatter(observeIdentity(dup), resolveHub(dup, INDEX), "ambiguous", NOW, false), null);
	const unavailable = hub("lee2019transfer", { citekeyProvisional: false });
	const unavailableVerdict = classifyHub(unavailable, resolveHub(unavailable, null), false, false);
	assert.equal(unavailableVerdict.classification, "unchecked");
	assert.deepEqual(unavailableVerdict.findings, []);
	const staleMiss = hub("ahn2021blind", {});
	const staleVerdict = classifyHub(staleMiss, resolveHub(staleMiss, INDEX), true, false);
	assert.equal(staleVerdict.classification, "unchecked");
	assert.deepEqual(staleVerdict.findings.map(f => f.code), ["index-stale"]);
	assert.equal(proposedFrontmatter(observeIdentity(staleMiss), resolveHub(staleMiss, INDEX), staleVerdict.classification, NOW, true), null);
	const allowed = classifyHub(staleMiss, resolveHub(staleMiss, INDEX), true, true);
	assert.equal(allowed.classification, "unregistered-unflagged");
	assert.equal(proposedFrontmatter(observeIdentity(staleMiss), resolveHub(staleMiss, INDEX), allowed.classification, NOW, true), null, "negative verdicts are never proposed on a stale index");
	const staleHit = hub("lee2019transfer", { citekeyProvisional: true });
	assert.equal(classifyHub(staleHit, resolveHub(staleHit, INDEX), true, false).classification, "provisional-now-registered", "positive verdicts survive staleness");
	const result = reconcileNotes([dup, unavailable, staleMiss], INDEX, VAULT, { ...OPTS, stale: true });
	assert.deepEqual(result.notes.map(n => [n.classification, n.skippedReason, n.proposed, n.proposedS01]), [["unchecked", "index-stale", null, null], ["ambiguous", "index-stale", null, null], ["registered-consistent", "index-stale", null, null]]);
	assert.deepEqual(result.diagnostics.map(d => d.code), ["citekey-ambiguous"]);
	assert.equal(reconcileNotes([unavailable], null, VAULT, OPTS).notes[0].classification, "unchecked");
});

test("transition table is exhaustive and guarded", () => {
	const statuses = ["absent", "not-found", "unavailable", "ambiguous", "resolved"] as const;
	const expected: Record<typeof statuses[number], { resolved: boolean; notFound: boolean }> = {
		absent: { resolved: true, notFound: true }, "not-found": { resolved: true, notFound: false }, unavailable: { resolved: true, notFound: true },
		ambiguous: { resolved: true, notFound: true }, resolved: { resolved: false, notFound: false },
	};
	for (const from of statuses) {
		const observed = from === "absent" ? undefined : from;
		assert.equal(statusTransitionAllowed(observed, "resolved", false), expected[from].resolved, `${from} → resolved`);
		assert.equal(statusTransitionAllowed(observed, "resolved", true), expected[from].resolved, `${from} → resolved (stale)`);
		assert.equal(statusTransitionAllowed(observed, "not-found", false), expected[from].notFound, `${from} → not-found`);
		assert.equal(statusTransitionAllowed(observed, "not-found", true), false, `${from} → not-found is refused on a stale index`);
	}
	assert.equal(statusTransitionAllowed("registered", "resolved", false), false, "unknown values never transition");
	for (const pinned of [true, false]) {
		assert.equal(flagTransitionAllowed(undefined, true, pinned), true);
		assert.equal(flagTransitionAllowed(undefined, false, pinned), true);
		assert.equal(flagTransitionAllowed(true, true, pinned), false);
		assert.equal(flagTransitionAllowed(false, true, pinned), false, "false never flips to true");
		assert.equal(flagTransitionAllowed(false, false, pinned), false);
	}
	assert.equal(flagTransitionAllowed(true, false, true), true);
	assert.equal(flagTransitionAllowed(true, false, false), false, "true flips to false only when pinned");
	assert.deepEqual(Object.keys(STATUS_TRANSITIONS.zoteroStatus), [...statuses]);
	assert.deepEqual(STATUS_TRANSITIONS.citekeyProvisional, { absent: ["true", "false"], true: ["false"], false: [] });
	assert.deepEqual(STATUS_TRANSITIONS.zoteroID, { absent: ["value"], present: [] });
	assert.deepEqual(STATUS_TRANSITIONS.zoteroSelectURI, { absent: ["value"], present: [] });
	assert.equal(HUB_FINDINGS.length, 19); // 0.5 R14: + legacy-frontmatter-dialect
	assert.equal(APPLY_ELIGIBLE_FINDINGS.length, 5);
});

test("DOI observations distinguish valid, absent, and malformed raw values", () => {
	const prose = hub("lee2019transfer", { citekeyProvisional: false, doi: "none — poster, not indexed" }, S01_CONFIRMED);
	const verdict = classifyHub(prose, resolveHub(prose, INDEX), false, false);
	assert.deepEqual(verdict.findings.filter(f => f.code === "malformed-identity" || f.code === "doi-nonconforming").map(f => f.code), ["malformed-identity", "doi-nonconforming"]);
	assert.equal(verdict.classification, "registered-desynced");
	assert.equal(observeIdentity(hub("x2000key", { doi: "10.1000/lee.2019" })).fields?.doi.state, "valid");
	assert.equal(observeIdentity(hub("x2000key", {})).fields?.doi.state, "absent");
	for (const doi of [null, 12]) {
		const observed = observeIdentity(hub("x2000key", { doi }));
		assert.equal(observed.fields?.doi.state, "malformed", String(doi));
	}
	assert.equal(observeIdentity(hub("x2000key", { doi: null })).doi, "");
	assert.equal(observeIdentity(hub("x2000key", {})).doi, undefined);
	assert.equal(observeIdentity(hub("x2000key", { doi: 12 })).doi, "12");
});

test("hubAttachmentFinding names the vault copy only for complete listings without a local PDF", () => {
	const copy = hubAttachmentFinding(park, VAULT.pdfPaths, "park2021attention");
	assert.equal(copy?.code, "hub-attachment-missing");
	assert.equal(copy?.detail, "80. References/Attachments/2021-park-attention-parkAttention2021.pdf");
	const byHubKey = hubAttachmentFinding({ ...park, citekey: "otherKey2021" }, ["80. References/Attachments/2021-park-park2021attention.pdf"], "park2021attention");
	assert.equal(byHubKey?.detail, "80. References/Attachments/2021-park-park2021attention.pdf");
	const none = hubAttachmentFinding(park, ["10. Raw Sources/2021-park-parkAttention2021.pdf"]);
	assert.equal(none?.detail, undefined);
	assert.match(none?.message ?? "", /no vault copy under 80\. References\/Attachments\//);
	assert.match(hubAttachmentFinding(oh, [])?.message ?? "", /no PDF attachment has a local file/);
	assert.equal(hubAttachmentFinding(lee, VAULT.pdfPaths), null);
	assert.equal(hubAttachmentFinding({ ...park, attachmentStatus: "unavailable" }, VAULT.pdfPaths), null);
	assert.equal(hubAttachmentFinding({ ...park, attachmentPath: "/synthetic/park.PDF" }, VAULT.pdfPaths), null);
});

test("reconcileNotes walks hubs and raw sources, narrows by folders and counts hubs only", () => {
	const notes = [
		hub("lee2019transfer", { citekeyProvisional: false }, S01_CONFIRMED),
		note("10. Raw Sources/2021-park.md", { type: "raw-source", citekey: "park2021attention", doi: "10.1000/park.2021" }),
		note("10. Raw Sources/2021-ahn.md", { type: "raw-source", citekey: "ahn2021blind" }),
		note("10. Raw Sources/no-key.md", { type: "raw-source" }),
		note("20. Wiki/25. Questions/rq.md", { type: "research-question", citekey: "lee2019transfer" }),
		note("40. Paper Analyses/ahn2021blind/ahn2021blind.md", { type: "paper-hub", citekey: "ahn2021blind" }),
		note("40. Paper Analyses/broken/broken.md", null),
	];
	notes[6].frontmatterParse = "error";
	const result = reconcileNotes(notes, INDEX, VAULT, OPTS);
	assert.deepEqual(result.scanned, { hubs: 2, rawSources: 2, parseErrors: 1 });
	assert.deepEqual(result.notes.map(n => n.path), ["10. Raw Sources/2021-ahn.md", "10. Raw Sources/2021-park.md", "40. Paper Analyses/ahn2021blind/ahn2021blind.md", "40. Paper Analyses/broken/broken.md", "40. Paper Analyses/lee2019transfer/lee2019transfer.md"]);
	const raw = result.notes[1];
	assert.equal(raw.type, "raw-source");
	assert.equal(raw.classification, "registered-unpinned");
	assert.equal(raw.skippedReason, "raw-source");
	assert.equal(raw.proposed, null);
	assert.equal(raw.proposedS01, null);
	assert.equal(raw.applied, false);
	assert.deepEqual(raw.findings.map(f => f.code), ["citekey-not-pinned"], "apply-eligible and attachment findings are not reported for raw sources");
	assert.deepEqual(result.summary.hubs, { registeredConsistent: 1, registeredDesynced: 0, registeredUnpinned: 0, provisionalNowRegistered: 0, unregisteredFlagged: 0, unregisteredUnflagged: 1, ambiguous: 0, unchecked: 0 });
	assert.deepEqual(result.diagnostics.map(d => [d.code, d.path]), [["citekey-unregistered", "10. Raw Sources/2021-ahn.md"], ["citekey-not-pinned", "10. Raw Sources/2021-park.md"], ["citekey-unregistered", "40. Paper Analyses/ahn2021blind/ahn2021blind.md"]]);
	const narrowed = reconcileNotes(notes, INDEX, VAULT, { ...OPTS, folders: ["40. Paper Analyses/", "./40. Paper Analyses"] });
	assert.deepEqual(narrowed.folders, ["40. Paper Analyses"]);
	assert.deepEqual(narrowed.scanned, { hubs: 2, rawSources: 0, parseErrors: 1 });
	assert.equal(result.notes[3].skippedReason, "frontmatter-parse-error");
	assert.equal(result.notes[3].findings[0].code, "frontmatter-parse-error");
	assert.deepEqual(result.notes[4].observed.fields, {
		citekey: { state: "valid", raw: "lee2019transfer" }, doi: { state: "absent" },
		citekeyProvisional: { state: "valid", raw: false }, zoteroID: { state: "absent" }, zoteroSelectURI: { state: "absent" },
		zoteroStatus: { state: "absent" }, zoteroCheckedAt: { state: "absent" },
	});
	assert.equal(result.notes[4].observed.s01Zotero, "zotero://select/library/items/LEEAAAA1");
	assert.equal(reconcileNotes(notes, INDEX, VAULT, { ...OPTS, folders: ["99. Nowhere"] }).notes.length, 0);
});

test("renderReport snapshot", () => {
	const result = reconcileNotes([hub("ahn2021blind", {}), note("10. Raw Sources/2021-park.md", { type: "raw-source", citekey: "park2021attention", doi: "10.1000/park.2021" })], INDEX, VAULT, { ...OPTS, folders: ["40. Paper Analyses", "10. Raw Sources"] });
	assert.equal(renderReport(result), [
		"# Reconcile report",
		"",
		"Hubs: 1 · Raw sources: 1 · Parse errors: 0 · Folders: 10. Raw Sources, 40. Paper Analyses",
		"",
		"registered-consistent 0 · registered-desynced 0 · registered-unpinned 0 · provisional-now-registered 0 · unregistered-flagged 0 · unregistered-unflagged 1 · ambiguous 0 · unchecked 0",
		"",
		"| Path | Type | Citekey | Classification | Findings | Proposed |",
		"|---|---|---|---|---|---|",
		"| 10. Raw Sources/2021-park.md | raw-source | park2021attention | registered-unpinned | citekey-not-pinned | raw-source |",
		"| 40. Paper Analyses/ahn2021blind/ahn2021blind.md | paper-hub | ahn2021blind | unregistered-unflagged | missing-zoteroStatus, missing-zoteroCheckedAt, citekeyProvisional-absent | citekeyProvisional, zoteroStatus, zoteroCheckedAt |",
		"",
		"Diagnostics: 2 (error 1, warning 1, info 0)",
		"",
	].join("\n"));
	const empty = reconcileNotes([], INDEX, VAULT, OPTS);
	assert.match(renderReport(empty), /^# Reconcile report\n\nHubs: 0 · Raw sources: 0 · Parse errors: 0\n/);
});

test("diagnostic codes carry fixed severities and the factory omits undefined extras", () => {
	const severities: Record<string, string> = {
		"citekey-unregistered": "error", "citekey-not-pinned": "warning", "identity-desync": "warning", "provisional-now-registered": "info",
		"attachment-missing-for-hub": "warning", "dangling-cite": "error", "cite-hub-only": "info", "cite-raw-only": "warning", "cite-unchecked": "warning",
		"citekey-ambiguous": "error", "legacy-plugin-enabled": "error", "index-stale": "info", "index-in-git": "warning",
		"provisional-citekey": "warning", "attachment-path-missing": "warning", "attachments-unavailable": "warning", "duplicate-citekey": "warning",
	};
	for (const [code, severity] of Object.entries(severities)) assert.equal(DIAGNOSTIC_CODES[code as keyof typeof DIAGNOSTIC_CODES], severity, code);
	assert.deepEqual(diagnostic("index-in-git", "Index file is tracked by git."), { code: "index-in-git", severity: "warning", message: "Index file is tracked by git." });
	assert.deepEqual(diagnostic("dangling-cite", "No item.", { citekey: "x2000key", path: "a.md" }), { code: "dangling-cite", severity: "error", message: "No item.", citekey: "x2000key", path: "a.md" });
	assert.deepEqual(indexDiagnostics([oh, twinA, twinB]).map(d => d.code), ["attachment-path-missing", "duplicate-citekey"]);
	const classifications: HubClassification[] = ["registered-consistent", "registered-desynced", "registered-unpinned", "provisional-now-registered", "unregistered-flagged", "unregistered-unflagged", "ambiguous", "unchecked"];
	assert.equal(classifications.length, 8);
});


test("malformed-present identity keys are findings, never backfill candidates", () => {
	const cases: Array<[string, unknown]> = [
		["citekey", null], ["citekey", ""], ["citekey", 42], ["doi", null], ["doi", " "], ["doi", 12],
		["zoteroID", null], ["zoteroSelectURI", ""], ["citekeyProvisional", "false"], ["zoteroStatus", "registered"], ["zoteroStatus", "constructor"], ["zoteroStatus", "absent"], ["zoteroCheckedAt", "garbage"], ["zoteroCheckedAt", null],
	];
	for (const [key, value] of cases) {
		const malformed = hub("lee2019transfer", { citekeyProvisional: false, [key]: value });
		const observed = observeIdentity(malformed);
		assert.equal(observed.fields?.[key as keyof NonNullable<typeof observed.fields>].state, "malformed", key);
		const resolution = resolveHub(malformed, INDEX);
		const verdict = classifyHub(malformed, resolution, false, false);
		assert.ok(verdict.findings.some(item => item.code === "malformed-identity" && item.detail === key), key);
		assert.equal(proposedFrontmatter(observed, resolution, verdict.classification, NOW, false), null, key);
		const result = reconcileNotes([malformed], INDEX, VAULT, OPTS).notes[0];
		assert.equal(result.proposed, null, key);
		assert.equal(result.proposedS01, null, key);
		assert.equal(result.skippedReason, "malformed-identity", key);
		assert.ok(!result.findings.some(item => item.code === `missing-${key}`), `${key} must not become missing`);
	}
});

test("ID/URI/DOI conflicts union by entry id and remain immutable report-only", () => {
	const idUri = hub("lee2019transfer", { zoteroID: lee.id, zoteroSelectURI: park.zoteroSelectURI });
	const idUriResolution = resolveHub(idUri, INDEX);
	assert.equal(idUriResolution.status, "ambiguous");
	assert.equal(idUriResolution.identityConflict, true);
	assert.deepEqual(idUriResolution.evidence.map(item => [item.via, item.entryID]), [
		["zoteroID", lee.id], ["zoteroSelectURI", park.id], ["citekey", lee.id],
	]);
	const idUriResult = reconcileNotes([idUri], INDEX, VAULT, OPTS).notes[0];
	assert.deepEqual(idUriResult.findings.map(item => item.code), ["identity-conflict"]);
	assert.equal(idUriResult.proposed, null);
	assert.equal(idUriResult.proposedS01, null);
	assert.equal(idUriResult.skippedReason, "identity-conflict");

	const idDoi = hub("lee2019transfer", { zoteroID: lee.id, doi: park.doi });
	const idDoiResolution = resolveHub(idDoi, INDEX);
	assert.equal(idDoiResolution.status, "ambiguous");
	assert.deepEqual(idDoiResolution.candidates.map(item => item.id), [lee.id, park.id]);

	const noDoi = { ...lee, doi: "" };
	const unmatchedDoi = hub(lee.citekey, { zoteroID: lee.id, doi: "10.1000/not-in-index" });
	const unmatchedResolution = resolveHub(unmatchedDoi, index([noDoi]));
	assert.equal(unmatchedResolution.status, "resolved");
	assert.equal(unmatchedResolution.entry?.id, lee.id);
	assert.equal(unmatchedResolution.identityConflict, true, "a supplied valid DOI contradicts an entry with no DOI");
	const unmatchedResult = reconcileNotes([unmatchedDoi], index([noDoi]), VAULT, OPTS).notes[0];
	assert.ok(unmatchedResult.findings.some(item => item.code === "identity-conflict"));
	assert.equal(unmatchedResult.proposed, null);
	assert.equal(unmatchedResult.proposedS01, null);
	assert.equal(unmatchedResult.skippedReason, "identity-conflict");
});

test("current and history matches are unioned; history alone never proves a pin", () => {
	const historicalConflict = entry({ id: "1:HISTAAA1", itemKey: "HISTAAA1", citekey: "newKey2024", citekeyHistory: [lee.citekey], doi: "10.1000/history", zoteroSelectURI: "zotero://select/library/items/HISTAAA1" });
	const conflictIndex = index([lee, historicalConflict]);
	const conflict = resolveHub(hub(lee.citekey), conflictIndex);
	assert.equal(conflict.status, "ambiguous");
	assert.equal(conflict.identityConflict, true);
	assert.deepEqual(conflict.evidence.map(item => item.via), ["citekey", "citekeyHistory"]);

	const historyOnly = hub("kang2020memory", { citekeyProvisional: true });
	const historyResolution = resolveHub(historyOnly, INDEX);
	assert.equal(historyResolution.status, "resolved");
	assert.equal(historyResolution.resolvedVia, "citekeyHistory");
	const historyVerdict = classifyHub(historyOnly, historyResolution, false, false);
	assert.equal(proposedFrontmatter(observeIdentity(historyOnly), historyResolution, historyVerdict.classification, NOW, false)?.citekeyProvisional, undefined);

	const unpinned = hub("oldVaultKeyAbsentFromIndex", { doi: park.doi, citekeyProvisional: true });
	const unpinnedResolution = resolveHub(unpinned, INDEX);
	assert.equal(unpinnedResolution.status, "resolved");
	assert.equal(unpinnedResolution.identityConflict, false, "an absent old vault key is not conflicting positive evidence");
	assert.equal(classifyHub(unpinned, unpinnedResolution, false, false).classification, "registered-unpinned");
});

test("proposedS01 fails closed unless proposal eligibility is explicit", () => {
	const staleMiss = hub("missing2026key", {}, "- **Zotero**: zotero://select/library/items/OLDOLD01\n- **citekey**: `missing2026key` (confirmed)\n");
	const resolution = resolveHub(staleMiss, INDEX);
	const verdict = classifyHub(staleMiss, resolution, true, true);
	assert.equal(verdict.classification, "unregistered-unflagged");
	assert.equal(proposedS01(staleMiss, resolution, verdict.classification, NOW), null, "allow-stale reporting cannot authorize a negative body proposal");
	assert.deepEqual(proposedS01(staleMiss, resolution, verdict.classification, NOW, true), { zotero: "not registered", citekey: "`missing2026key` (provisional)" }, "a caller must explicitly supply a verified eligibility decision");
});

test("Raw Sources path and incomplete indexes are always report-only", () => {
	const mislabeled = note("10. Raw Sources/mislabeled.md", { type: "paper-hub", citekey: lee.citekey, citekeyProvisional: true }, S01_NOT_REGISTERED);
	const raw = reconcileNotes([mislabeled], INDEX, VAULT, OPTS);
	assert.deepEqual(raw.scanned, { hubs: 0, rawSources: 1, parseErrors: 0 });
	assert.equal(raw.notes[0].type, "raw-source");
	assert.equal(raw.notes[0].skippedReason, "raw-source-path");
	assert.ok(raw.notes[0].findings.some(item => item.code === "raw-source-path"));
	assert.equal(raw.notes[0].proposed, null);
	assert.equal(raw.notes[0].proposedS01, null);

	const incomplete = { ...INDEX, complete: false };
	const positive = reconcileNotes([hub(lee.citekey, { citekeyProvisional: true }, S01_NOT_REGISTERED)], incomplete, VAULT, OPTS).notes[0];
	assert.ok(positive.findings.some(item => item.code === "index-incomplete"));
	assert.equal(positive.proposed, null);
	assert.equal(positive.proposedS01, null);
	assert.equal(positive.skippedReason, "index-incomplete");
	const negative = reconcileNotes([hub("missing2026key")], incomplete, VAULT, OPTS).notes[0];
	assert.equal(negative.classification, "unchecked");
	assert.equal(negative.skippedReason, "index-incomplete");
	assert.equal(negative.proposed, null);
});

test("reconcile proposals are deterministic and idempotent without timestamp-only churn", () => {
	const initial = hub(lee.citekey, { citekeyProvisional: true }, S01_NOT_REGISTERED);
	const first = reconcileNotes([initial], INDEX, VAULT, OPTS).notes[0];
	const second = reconcileNotes([initial], INDEX, VAULT, OPTS).notes[0];
	assert.deepEqual(first, second);
	assert.ok(first.proposed);
	const appliedFrontmatter = { ...initial.frontmatter, ...first.proposed };
	const after = hub(lee.citekey, appliedFrontmatter, S01_CONFIRMED);
	const noOp = reconcileNotes([after], INDEX, VAULT, OPTS).notes[0];
	assert.equal(noOp.proposed, null);
	assert.equal(noOp.proposedS01, null);
});

test("empty DOI is the documented absent sentinel, not malformed identity", () => {
 const record=hub(lee.citekey,{doi:"",citekeyProvisional:true});
 assert.equal(observeIdentity(record).fields?.doi.state,"valid");
 const report=reconcileNotes([record],INDEX,VAULT,OPTS).notes[0];
 assert.ok(report.proposed);
 assert.equal(report.proposed?.citekeyProvisional,false);
});

test("positive identity conflicts override provisional registration classification", () => {
	const record = hub(lee.citekey, { zoteroID: lee.id, doi: park.doi, citekeyProvisional: true });
	const report = reconcileNotes([record], INDEX, VAULT, OPTS).notes[0];
	assert.equal(report.classification, "ambiguous");
	assert.equal(report.proposed, null);
	assert.equal(report.proposedS01, null);
	assert.equal(report.proposalEligible, false);
});
