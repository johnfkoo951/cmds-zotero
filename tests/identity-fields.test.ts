import { test } from "node:test";
import assert from "node:assert/strict";
import { callout, emitDoi, identityFrontmatter, pickPdf, s01Lines, yamlFragment } from "../src/agent/identity-fields";
import type { AttachmentEvidence, PdfPick } from "../src/agent/identity-fields";
import { noteRef } from "../src/agent/types";
import type { HubIdentityFrontmatter, QueryEcho, ResolveOutcome } from "../src/agent/types";
import type { Attachment, ZoteroIndexEntry } from "../src/types";

// Synthetic fixtures only: keys, titles and paths never come from a real vault.
const NOW = new Date("2026-09-14T03:00:00.000Z");
const ISO = "2026-09-14T03:00:00.000Z";
const ARXIV_DOI = "10.48550/arXiv.2101.00001";

const attachment = (o: Partial<AttachmentEvidence>): Attachment => ({ key: "ATTACH01", openURI: "zotero://open-pdf/library/items/ATTACH01", path: "/tmp/zotero/storage/ATTACH01/Doe et al. - 2021 - Widget.pdf", title: "Full Text PDF", annotations: [], ...o });

const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({ id: "1:PARENT01", libraryID: 1, libraryType: "user", itemKey: "PARENT01", citekey: "doe2021widget", citekeyHistory: [], title: "Widget retrieval for synthetic tasks", authors: ["Doe, Jane"], year: "2021", doi: ARXIV_DOI, url: "http://arxiv.org/abs/2101.00001", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/PARENT01", attachments: [attachment({})], attachmentStatus: "complete", contentHash: "", metadata: {}, ...o });

const query: QueryEcho = { kind: "citekey", raw: "doe2021widget", normalized: "doe2021widget" };
const outcome = (o: Partial<ResolveOutcome>): ResolveOutcome => ({ status: "not-found", matchedBy: null, entry: null, matchedHistory: false, candidates: [], ranked: [], query, ...o });
const resolved = (item: ZoteroIndexEntry): ResolveOutcome => outcome({ status: "resolved", matchedBy: "citekey", entry: item });

const noPdf: PdfPick = { pdfStatus: "none", attachmentKey: null, openURI: null, path: null };

test("emitDoi preserves case, strips prefixes and trailing punctuation, and empties absent conventions", () => {
	assert.equal(emitDoi(ARXIV_DOI), ARXIV_DOI);
	assert.equal(emitDoi(`  doi: ${ARXIV_DOI}.`), ARXIV_DOI);
	assert.equal(emitDoi("https://doi.org/10.1000/ABC.Def-12)"), "10.1000/ABC.Def-12");
	assert.equal(emitDoi("http://dx.doi.org/10.1000/xyz;"), "10.1000/xyz");
	assert.equal(emitDoi("doi.org/10.1000/xyz>"), "10.1000/xyz");
	for (const absent of ["", "none", "n/a", "—", "없음", "none listed in PDF", "none — poster, not indexed", "not a doi"]) assert.equal(emitDoi(absent), "", absent);
});

test("resolved and pinned: provisional false, ids present, no callout", () => {
	const item = entry({});
	const fm = identityFrontmatter({ requestedCitekey: "doe2021widget", outcome: resolved(item), stale: false, now: NOW, emittedDoi: "" });
	assert.deepEqual(fm, { citekey: "doe2021widget", citekeyProvisional: false, doi: ARXIV_DOI, zoteroID: "1:PARENT01", zoteroSelectURI: "zotero://select/library/items/PARENT01", zoteroStatus: "resolved", zoteroCheckedAt: ISO });
	assert.equal(yamlFragment(fm), [
		'citekey: "doe2021widget"',
		"citekeyProvisional: false",
		`doi: "${ARXIV_DOI}"`,
		'zoteroID: "1:PARENT01"',
		'zoteroSelectURI: "zotero://select/library/items/PARENT01"',
		'zoteroStatus: "resolved"',
		`zoteroCheckedAt: "${ISO}"`,
	].join("\n"));
	assert.equal(callout("resolved", "doe2021widget", ISO, null), null);
	const s01 = s01Lines({ frontmatter: fm, citekeyCurrent: "doe2021widget", bibliography: "Doe, J. (2021). Widget retrieval\n for synthetic tasks.", pdf: pickPdf(item), rawSource: null, rawNotes: [] });
	assert.equal(s01.fullCitation, "Doe, J. (2021). Widget retrieval for synthetic tasks.");
	assert.deepEqual(s01.lines, [
		"- **Full citation**: Doe, J. (2021). Widget retrieval for synthetic tasks.",
		"- **citekey**: `doe2021widget`",
		`- **DOI**: ${ARXIV_DOI}`,
		"- **Zotero**: zotero://select/library/items/PARENT01",
		"- **PDF**: zotero://open-pdf/library/items/ATTACH01?page=1",
		"- **Raw Source**: [[{YYYY-MM-DD-Paper-Title}]]",
	]);
	assert.equal(s01.markdown, s01.lines.join("\n"));
});

test("resolved under another BBT key: requested key kept, provisional true, pin pending", () => {
	const item = entry({ citekey: "doeWidgetRetrieval2021" });
	const fm = identityFrontmatter({ requestedCitekey: "doe2021widget", outcome: outcome({ status: "resolved", matchedBy: "doi", entry: item }), stale: false, now: NOW, emittedDoi: `https://doi.org/${ARXIV_DOI}` });
	assert.equal(fm.citekey, "doe2021widget");
	assert.equal(fm.citekeyProvisional, true);
	assert.equal(fm.zoteroStatus, "resolved");
	assert.equal(fm.zoteroID, "1:PARENT01");
	assert.equal(fm.doi, ARXIV_DOI);
	const pin = "Zotero → item → Extra field → add line `Citation Key: doe2021widget` (Better BibTeX pins it on save; the plugin cannot write it)";
	const s01 = s01Lines({ frontmatter: fm, citekeyCurrent: "doeWidgetRetrieval2021", bibliography: null, pdf: pickPdf(item), rawSource: "2026-09-01-Widget Retrieval", rawNotes: [] });
	assert.equal(s01.fullCitation, null);
	assert.equal(s01.lines[0], "- **Full citation**: {APA 등 완전한 서지 — 원문 표기 그대로}");
	assert.equal(s01.lines[1], "- **citekey**: `doe2021widget` (Zotero key: doeWidgetRetrieval2021 — pin pending)");
	assert.equal(s01.lines[5], "- **Raw Source**: [[2026-09-01-Widget Retrieval]]");
	assert.equal(callout("resolved", "doe2021widget", ISO, pin, { citekeyCurrent: "doeWidgetRetrieval2021" }), [
		"> [!info] Citekey pin pending",
		"> Zotero 등록됨 — BBT 키 `doeWidgetRetrieval2021` ≠ 볼트 citekey `doe2021widget`. Zotero에서 **PIN**(고정), 노트/폴더 재명명 금지.",
		`> ${pin}`,
	].join("\n"));
});

test("not-found: provisional, no ids, byte-exact paper-ingest callout", () => {
	const fm = identityFrontmatter({ requestedCitekey: "doe2021widget", outcome: outcome({}), stale: false, now: NOW, emittedDoi: "none listed in PDF" });
	assert.deepEqual(fm, { citekey: "doe2021widget", citekeyProvisional: true, doi: "", zoteroStatus: "not-found", zoteroCheckedAt: ISO });
	assert.equal(yamlFragment(fm), ['citekey: "doe2021widget"', "citekeyProvisional: true", 'doi: ""', 'zoteroStatus: "not-found"', `zoteroCheckedAt: "${ISO}"`].join("\n"));
	assert.equal(callout("not-found", "doe2021widget", ISO, "ignored for not-found"), "> [!warning] Provisional citekey\n> `doe2021widget` 는 로컬 생성 — Zotero 미등록. 등록 시 BBT 키를 이 값으로 **PIN**(고정), 노트/폴더 재명명 금지.");
	const s01 = s01Lines({ frontmatter: fm, citekeyCurrent: null, bibliography: "  ", pdf: noPdf, rawSource: null, rawNotes: [noteRef("Vault", "10. Raw Sources/12. Papers/2026-09-01-Widget Retrieval.md")] });
	assert.deepEqual(s01.lines, [
		"- **Full citation**: {APA 등 완전한 서지 — 원문 표기 그대로}",
		"- **citekey**: `doe2021widget` (provisional)",
		"- **DOI**: none",
		`- **Zotero**: not registered (checked ${ISO})`,
		"- **Raw Source**: [[2026-09-01-Widget Retrieval]]",
	]);
	const two = s01Lines({ frontmatter: fm, citekeyCurrent: null, bibliography: null, pdf: noPdf, rawSource: null, rawNotes: [noteRef("Vault", "a/one.md"), noteRef("Vault", "a/two.md")] });
	assert.equal(two.lines[4], "- **Raw Source**: [[{YYYY-MM-DD-Paper-Title}]]");
	const none = identityFrontmatter({ requestedCitekey: null, outcome: outcome({}), stale: false, now: NOW, emittedDoi: "" });
	assert.equal(none.citekey, undefined);
	assert.equal(none.citekeyProvisional, true);
	assert.equal(yamlFragment(none).startsWith("citekeyProvisional: true"), true);
	assert.doesNotMatch(yamlFragment(none), /^citekey:/m);
	const noKeyLine = s01Lines({ frontmatter: none, citekeyCurrent: null, bibliography: null, pdf: noPdf, rawSource: null, rawNotes: [] });
	assert.equal(noKeyLine.lines[1], "- **citekey**: unassigned");
});

test("stale gate: a withheld not-found becomes unavailable; a stale resolved stays resolved", () => {
	const fm = identityFrontmatter({ requestedCitekey: "doe2021widget", outcome: outcome({}), stale: true, now: NOW, emittedDoi: "" });
	assert.equal(fm.zoteroStatus, "unavailable");
	assert.equal(fm.citekeyProvisional, true);
	assert.equal(fm.zoteroID, undefined);
	const s01 = s01Lines({ frontmatter: fm, citekeyCurrent: null, bibliography: null, pdf: noPdf, rawSource: null, rawNotes: [], unavailableReason: "stale-index" });
	assert.equal(s01.lines[3], `- **Zotero**: unavailable at ingest (checked ${ISO}; stale-index)`);
	assert.equal(callout("unavailable", "doe2021widget", ISO, "x", { unavailableReason: "stale-index" }), [
		"> [!warning] Zotero unavailable",
		`> \`doe2021widget\` 는 로컬 생성 — Zotero 확인 불가 (checked ${ISO}; stale-index). 연결 복구 후 \`identity\` 로 재확인. 등록 시 BBT 키를 이 값으로 **PIN**(고정), 노트/폴더 재명명 금지.`,
	].join("\n"));
	const still = identityFrontmatter({ requestedCitekey: null, outcome: resolved(entry({})), stale: true, now: NOW, emittedDoi: "" });
	assert.equal(still.zoteroStatus, "resolved");
	assert.equal(still.citekey, undefined);
	assert.equal(still.citekeyProvisional, true);
	assert.doesNotMatch(yamlFragment(still), /^citekey:/m);
	const resolvedWithoutRequest = s01Lines({ frontmatter: still, citekeyCurrent: "doe2021widget", bibliography: null, pdf: noPdf, rawSource: null, rawNotes: [] });
	assert.equal(resolvedWithoutRequest.lines[1], "- **citekey**: `doe2021widget`");
	assert.doesNotMatch(resolvedWithoutRequest.markdown, /undefined|pin pending/);
});

test("unavailable and ambiguous outcomes", () => {
	const unavailable = identityFrontmatter({ requestedCitekey: "doe2021widget", outcome: outcome({ status: "unavailable", message: "bbt-unreachable" }), stale: false, now: NOW, emittedDoi: "" });
	assert.equal(unavailable.zoteroStatus, "unavailable");
	assert.equal(unavailable.citekeyProvisional, true);
	const ambiguous = identityFrontmatter({ requestedCitekey: "doe2021widget", outcome: outcome({ status: "ambiguous", matchedBy: "title", candidates: [entry({}), entry({ id: "1:PARENT02", itemKey: "PARENT02" })] }), stale: false, now: NOW, emittedDoi: "" });
	assert.deepEqual(ambiguous, { citekey: "doe2021widget", citekeyProvisional: true, doi: "", zoteroStatus: "ambiguous", zoteroCheckedAt: ISO });
	const s01 = s01Lines({ frontmatter: ambiguous, citekeyCurrent: null, bibliography: null, pdf: noPdf, rawSource: null, rawNotes: [], candidateCount: 2 });
	assert.equal(s01.lines[3], "- **Zotero**: ambiguous (2 candidates; see identity ranked[])");
	assert.equal(callout("ambiguous", "doe2021widget", ISO, null, { candidateCount: 2 }), [
		"> [!warning] Zotero ambiguous",
		`> \`doe2021widget\` — Zotero 후보 2건 (checked ${ISO}). \`identity\` ranked[] 에서 항목을 확인한 뒤 \`--item-key ITEMKEY --library ID\` 로 재조회. 확정 전 zoteroID 기록 금지, 노트/폴더 재명명 금지.`,
	].join("\n"));
});

test("pickPdf status matrix", () => {
	assert.deepEqual(pickPdf(entry({})), { pdfStatus: "present", attachmentKey: "ATTACH01", openURI: "zotero://open-pdf/library/items/ATTACH01", path: "/tmp/zotero/storage/ATTACH01/Doe et al. - 2021 - Widget.pdf" });
	assert.equal(pickPdf(entry({ attachments: [attachment({ path: null, title: "Doe et al. - 2021 - Widget.pdf" })] })).pdfStatus, "missing-file");
	assert.equal(pickPdf(entry({ attachments: [attachment({ path: null, contentType: "application/pdf" })] })).pdfStatus, "missing-file");
	assert.equal(pickPdf(entry({ attachments: [attachment({ path: null, filename: "widget.PDF" })] })).pdfStatus, "missing-file");
	// Two-attachment shape (PDF + HTML snapshot) with null paths and no evidence: unknown-type, never missing-file.
	const twoUnknown = pickPdf(entry({ attachments: [attachment({ path: null }), attachment({ key: "ATTACH02", openURI: "zotero://open-pdf/library/items/ATTACH02", path: null, title: "Snapshot" })] }));
	assert.equal(twoUnknown.pdfStatus, "unknown-type");
	assert.equal(twoUnknown.attachmentKey, null);
	assert.deepEqual(twoUnknown.candidates?.map(c => c.key), ["ATTACH01", "ATTACH02"]);
	assert.equal(pickPdf(entry({ attachments: [attachment({ path: "/tmp/zotero/storage/ATTACH01/snapshot.html", title: "Snapshot" })] })).pdfStatus, "none");
	assert.equal(pickPdf(entry({ attachments: [attachment({ path: null, contentType: "text/html", title: "Snapshot" })] })).pdfStatus, "none");
	assert.equal(pickPdf(entry({ attachments: [] })).pdfStatus, "none");
	assert.deepEqual(pickPdf(entry({ attachmentStatus: "unavailable" })), { pdfStatus: "unavailable", attachmentKey: null, openURI: null, path: null });
	const second = attachment({ key: "ATTACH02", openURI: "zotero://open-pdf/library/items/ATTACH02", path: "/tmp/zotero/storage/ATTACH02/supplement.pdf", title: "Supplement" });
	const ambiguous = pickPdf(entry({ attachments: [attachment({}), second] }));
	assert.equal(ambiguous.pdfStatus, "ambiguous");
	assert.equal(ambiguous.attachmentKey, null);
	assert.deepEqual(ambiguous.candidates, [{ key: "ATTACH01", title: "Full Text PDF", path: "/tmp/zotero/storage/ATTACH01/Doe et al. - 2021 - Widget.pdf" }, { key: "ATTACH02", title: "Supplement", path: "/tmp/zotero/storage/ATTACH02/supplement.pdf" }]);
	const chosen = pickPdf(entry({ attachments: [attachment({}), second] }), "ATTACH02");
	assert.equal(chosen.pdfStatus, "present");
	assert.equal(chosen.attachmentKey, "ATTACH02");
	assert.equal(pickPdf(entry({ attachments: [attachment({ path: null })] }), "ATTACH01").pdfStatus, "unknown-type");
	assert.throws(() => pickPdf(entry({}), "PARENT01"), /parent item key/);
	assert.throws(() => pickPdf(entry({}), "NOPE0000"), /not attached/);
	assert.throws(() => pickPdf(entry({ attachments: [attachment({ path: "/tmp/zotero/storage/ATTACH01/snapshot.html" })] }), "ATTACH01"), /not a PDF/);
});

test("S01 PDF line uses the attachment key with page 1, marks missing files, and refuses parent select URIs", () => {
	const fm: HubIdentityFrontmatter = { citekey: "doe2021widget", citekeyProvisional: false, doi: "", zoteroID: "1:PARENT01", zoteroSelectURI: "zotero://select/library/items/PARENT01", zoteroStatus: "resolved", zoteroCheckedAt: ISO };
	const base = { frontmatter: fm, citekeyCurrent: "doe2021widget", bibliography: null, rawSource: null, rawNotes: [] };
	const missing = s01Lines({ ...base, pdf: pickPdf(entry({ attachments: [attachment({ path: null, title: "Doe et al. - 2021 - Widget.pdf" })] })) });
	assert.equal(missing.lines[4], "- **PDF**: zotero://open-pdf/library/items/ATTACH01?page=1 (file not downloaded)");
	assert.equal(missing.lines[5], "- **Raw Source**: [[{YYYY-MM-DD-Paper-Title}]]");
	for (const pdf of [noPdf, { ...noPdf, pdfStatus: "unavailable" as const }, { ...noPdf, pdfStatus: "unknown-type" as const, attachmentKey: "ATTACH01", openURI: "zotero://open-pdf/library/items/ATTACH01" }]) {
		const lines = s01Lines({ ...base, pdf }).lines;
		assert.equal(lines.length, 5);
		assert.equal(lines.some(line => line.startsWith("- **PDF**")), false);
	}
	assert.throws(() => s01Lines({ ...base, pdf: { pdfStatus: "present", attachmentKey: "PARENT01", openURI: "zotero://select/library/items/PARENT01", path: "/tmp/x.pdf" } }), /parent selection URI/);
});
