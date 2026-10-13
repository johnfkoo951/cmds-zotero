import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentFormat, attachmentFormatLabel, attachmentSelectURI, isPdfAttachment, normalizeAttachments, normalizeEntry, primaryPdfPath } from "../src/api/normalize";
import { BbtService } from "../src/bbt";
import { entryHash, validateEntry, validateIndex } from "../src/identity";
import { indexDiagnostics } from "../src/diagnostics";
import { DEFAULT_SETTINGS, type Attachment, type ZoteroIndexEntry } from "../src/types";
import * as released from "./fixtures/identity-0.5.0";
import { epubAttachment, pdfAttachment, snapshotAttachment, startMockBbt, type MockAttachment } from "./fixtures/bbt-mock";

// Synthetic records only (AGENTS.md).
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function parent(attachments: MockAttachment[], group?: number): ZoteroIndexEntry {
	const scope = group ? `groups/${group}` : "library";
	return normalizeEntry({
		libraryID: group ? 3 : 1, citationKey: "Reader2026", itemKey: "ABCD2345", uri: group ? `http://zotero.org/groups/${group}/items/ABCD2345` : "http://zotero.org/users/local/Example/items/ABCD2345",
		itemType: "book", title: "Synthetic reader item", date: "2026", creators: [], tags: [], notes: [],
		attachments: attachments.map(attachment => ({ select: `zotero://select/${scope}/items/${attachment.key}`, title: attachment.title, ...(attachment.path ? { path: attachment.path } : {}), ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) })),
	});
}
function bbtAttachments(attachments: MockAttachment[], group?: number): unknown[] {
	return attachments.map(attachment => ({ open: `zotero://open-pdf/${group ? `groups/${group}` : "library"}/items/${attachment.key}`, path: attachment.path, ...(attachment.annotations?.length ? { annotations: attachment.annotations } : {}) }));
}
function withAttachments(attachments: MockAttachment[], group?: number): ZoteroIndexEntry {
	const entry = parent(attachments, group);
	entry.attachments = normalizeAttachments(bbtAttachments(attachments, group), entry);
	entry.attachmentPath = primaryPdfPath(entry.attachments);
	entry.contentHash = entryHash(entry);
	return entry;
}

test("EPUB and snapshot annotations become reader annotations with their position and a select link; PDF annotations are unchanged", () => {
	const pdf = pdfAttachment("PDFA2345", ["HLPA2345", "HLPB2345"]);
	const epub = epubAttachment("EPUB2345", ["EPAA2345", "EPAB2345"]);
	const snapshot = snapshotAttachment("SNAP2345", ["SNAA2345"]);
	const entry = withAttachments([pdf, epub, snapshot]);
	assert.ok(validateEntry(entry));
	const [first, second, third] = entry.attachments;
	assert.deepEqual(first.annotations.map(annotation => [annotation.key, annotation.page, annotation.uri]), [["HLPA2345", 1, "zotero://open-pdf/library/items/PDFA2345?page=1&annotation=HLPA2345"], ["HLPB2345", 2, "zotero://open-pdf/library/items/PDFA2345?page=2&annotation=HLPB2345"]]);
	assert.equal(first.readerAnnotations, undefined, "a PDF attachment gains no new field");
	assert.deepEqual(Object.keys(first.annotations[0]), ["key", "attachmentKey", "type", "text", "comment", "color", "page", "pageLabel", "version", "uri", "tags", "dateModified"], "PDF annotation fields keep the 0.5 order (stable stored bytes)");
	assert.deepEqual(second.annotations, [], "EPUB annotations never enter the PDF contract");
	assert.equal(second.readerAnnotations?.length, 2);
	assert.deepEqual(second.readerAnnotations?.[0], {
		key: "EPAA2345", attachmentKey: "EPUB2345", type: "highlight", text: "EPUB text EPAA2345", comment: "", color: "#5fb236", pageLabel: "", version: 2,
		tags: [], dateModified: "2026-03-02T10:00:00Z", sortIndex: "00002|00000000", uri: "zotero://select/library/items/EPUB2345",
		position: { type: "FragmentSelector", conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html", value: "epubcfi(/6/4!/4/2/1,/1:0,/1:12)" },
	});
	assert.equal(third.readerAnnotations?.[0].position.type, "CssSelector");
	assert.deepEqual(third.readerAnnotations?.[0].tags, ["web"]);
	assert.equal(entry.attachmentPath, "/synthetic/PDFA2345.pdf");
	assert.deepEqual(entry.attachments.map(attachment => attachmentFormatLabel(attachmentFormat(attachment))), ["PDF", "EPUB", "Snapshot"]);
	assert.deepEqual(indexDiagnostics([entry]).map(diagnostic => [diagnostic.code, diagnostic.severity, diagnostic.itemID]), [["reader-annotations", "info", entry.id]]);
	assert.match(indexDiagnostics([entry])[0].message, /^3 annotations on EPUB or web-snapshot attachments have no PDF page/);
});

test("reader annotations in a group library link to the group's attachment; tampered links fail validation", () => {
	const entry = withAttachments([epubAttachment("EPUB2345", ["EPAA2345"])], 4242);
	assert.equal(entry.attachments[0].readerAnnotations?.[0].uri, "zotero://select/groups/4242/items/EPUB2345");
	assert.equal(attachmentSelectURI({ libraryType: "group", groupID: 4242 }, "EPUB2345"), "zotero://select/groups/4242/items/EPUB2345");
	assert.throws(() => attachmentSelectURI({ libraryType: "group" }, "EPUB2345"), /group ID/);
	const retarget = (change: (annotation: Record<string, unknown>) => void): ZoteroIndexEntry => {
		const copy = JSON.parse(JSON.stringify(entry)) as ZoteroIndexEntry;
		change(copy.attachments[0].readerAnnotations![0] as unknown as Record<string, unknown>);
		copy.contentHash = entryHash(copy);
		return copy;
	};
	assert.equal(validateEntry(retarget(annotation => { annotation.uri = "zotero://select/library/items/EPUB2345"; })), false, "another library's link");
	assert.equal(validateEntry(retarget(annotation => { annotation.uri = "zotero://open-pdf/groups/4242/items/EPUB2345?annotation=EPAA2345"; })), false, "non-PDF annotations are not open-pdf links");
	assert.equal(validateEntry(retarget(annotation => { annotation.attachmentKey = "OTHR2345"; })), false);
	assert.equal(validateEntry(retarget(annotation => { annotation.position = "epubcfi(/6/4)"; })), false);
	assert.equal(validateEntry(retarget(annotation => { annotation.version = -1; })), false);
});

test("mimeType from the BBT JSON export sets contentType; the format falls back to extensions and annotation evidence", () => {
	const typed = withAttachments([{ key: "PDFA2345", path: false, title: "Full Text", mimeType: "application/pdf" }]);
	assert.equal(typed.attachments[0].contentType, "application/pdf");
	assert.equal(typed.attachments[0].path, null);
	assert.ok(isPdfAttachment(typed.attachments[0]), "a PDF without a local file is still a PDF");
	const untyped = withAttachments([{ key: "PDFA2345", path: "/synthetic/a.pdf" }]);
	assert.equal(untyped.attachments[0].contentType, undefined, "no mimeType: no contentType");
	const base: Attachment = { key: "AAAA2345", openURI: "zotero://open-pdf/library/items/AAAA2345", path: null, title: "", annotations: [] };
	const formats: [Partial<Attachment>, string][] = [
		[{ contentType: "application/epub+zip" }, "epub"], [{ contentType: "text/html; charset=utf-8" }, "snapshot"], [{ contentType: "image/png" }, "file"],
		[{ path: "/x/Book.EPUB" }, "epub"], [{ path: "/x/page.htm" }, "snapshot"], [{ path: "/x/data.csv" }, "file"], [{ filename: "paper.pdf" }, "pdf"],
		[{ annotations: [{} as never] }, "pdf"], [{ readerAnnotations: [{ position: { type: "FragmentSelector" } } as never] }, "epub"],
		[{ readerAnnotations: [{ position: { type: "CssSelector" } } as never] }, "snapshot"], [{}, "unknown"], [{ path: "/x/archive.zip" }, "file"], [{ path: "/x/README" }, "unknown"],
	];
	for (const [change, expected] of formats) assert.equal(attachmentFormat({ ...base, ...change }), expected, JSON.stringify(change));
	assert.equal(attachmentFormatLabel("unknown"), "Attachment");
	assert.equal(primaryPdfPath([{ ...base, path: "/x/notes.txt" }, { ...base, key: "BBBB2345", path: "/x/blob", contentType: "application/pdf" }]), "/x/blob", "a PDF by type is used when no path ends in .pdf");
	assert.equal(primaryPdfPath([{ ...base, path: "/x/blob", contentType: "application/pdf" }, { ...base, key: "BBBB2345", path: "/x/a.pdf" }]), "/x/a.pdf", "the 0.5 rule (.pdf path) still wins");
	assert.equal(primaryPdfPath([{ ...base, path: "/x/b.epub" }]), "");
});

test("a PDF annotation without a page still fails its attachment set; empty rects and EPUB annotations never do", () => {
	const broken = pdfAttachment("PDFA2345", ["HLPA2345"]);
	(broken.annotations![0] as Record<string, unknown>).annotationPosition = { type: "FragmentSelector", value: "epubcfi(/6/4)" };
	assert.throws(() => withAttachments([broken]), /Invalid annotation position/, "a .pdf attachment keeps the strict page rule");
	const huge = epubAttachment("EPUB2345", ["EPAA2345"]);
	(huge.annotations![0] as Record<string, unknown>).annotationPosition = { type: "FragmentSelector", value: "x".repeat(20_000) };
	assert.throws(() => withAttachments([huge]), /Invalid annotation position/, "an oversized position is refused");
	const untyped = epubAttachment("EPUB2345", ["EPAA2345"]);
	(untyped.annotations![0] as Record<string, unknown>).annotationPosition = { value: "epubcfi(/6/4)" };
	assert.throws(() => withAttachments([untyped]), /Invalid annotation position/, "a position without a selector type is refused");
	const stringPosition = epubAttachment("EPUB2345", ["EPAA2345"]);
	(stringPosition.annotations![0] as Record<string, unknown>).annotationPosition = JSON.stringify({ type: "FragmentSelector", value: "epubcfi(/6/2)" });
	assert.equal(withAttachments([stringPosition]).attachments[0].readerAnnotations?.[0].position.value, "epubcfi(/6/2)", "a JSON string position is parsed as before");
	assert.doesNotThrow(() => withAttachments([pdfAttachment("PDFA2345", ["HLPA2345"])]), "rects: [] is fine");
});

test("an index with EPUB and snapshot annotations is accepted by the 0.5.0 validator, the current one and the offline core", async () => {
	const api = await startMockBbt([{ id: 1, name: "My Library", items: [
		{ itemKey: "ABCD2345", citekey: "Reader2026", attachments: [epubAttachment("EPUB2345", ["EPAA2345"]), snapshotAttachment("SNAP2345", ["SNAA2345"])] },
		{ itemKey: "EFGH2345", citekey: "Paper2026", attachments: [pdfAttachment("PDFA2345", ["HLPA2345"])] },
	] }]);
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint });
	try {
		const index = await service.collect();
		assert.equal(index.complete, true, "a non-PDF attachment never makes the index incomplete");
		assert.deepEqual(index.entries.map(entry => entry.attachmentStatus), ["complete", "complete"]);
		const bytes = JSON.parse(JSON.stringify(index)) as unknown;
		assert.ok(validateIndex(bytes), "current validator");
		assert.ok(released.validateIndex(bytes), "the released 0.5.0 validator ignores the additive field and accepts the hashes");
		assert.ok(index.diagnostics.some(diagnostic => diagnostic.code === "reader-annotations"));

		const root = mkdtempSync(join(tmpdir(), "cmds-zotero-reader-"));
		roots.push(root);
		mkdirSync(join(root, ".obsidian", "plugins", "cmds-zotero"), { recursive: true });
		mkdirSync(join(root, "80. References"), { recursive: true });
		writeFileSync(join(root, ".obsidian", "plugins", "cmds-zotero", "data.json"), JSON.stringify({ zoteroIndexPath: "80. References/zotero-index.json" }));
		writeFileSync(join(root, "80. References", "zotero-index.json"), JSON.stringify(index));
		const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "ingest.mjs"), "--vault", "Research", "--vault-path", root, "--offline", "--action", "resolve", "--citekey", "Reader2026"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout) as { status: string; item?: { citekey: string } };
		assert.equal(payload.status, "resolved", "the offline core accepts the index");
	} finally { service.dispose(); await api.close(); }
});
