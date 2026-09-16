// 0.5 R13: performance and hygiene minors at the action layer (F11 premise, F13, F14, F17).
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { findNote, runAction, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { cacheFileName, filePathHash, PDF_TEXT_CACHE_DIR, type PdfTextCache } from "../src/pdf/cache";
import { LocalFileError, readLocalFile } from "../src/local-file";
import { DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";
import type { NoteRecord } from "../src/agent/types";
import type { PdfCacheStore } from "../src/pdf/extract";

const now = new Date("2026-09-16T10:00:00.000Z");
const entry: ZoteroIndexEntry = { id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "smith2020", citekeyHistory: [], title: "Knowledge sharing", authors: ["Smith, Ann"], year: "2020", doi: "", url: "", collections: [], tags: [], attachmentPath: "/synthetic/paper.pdf", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [{ key: "PDF00001", openURI: "zotero://open-pdf/library/items/PDF00001", path: "/synthetic/paper.pdf", title: "PDF", annotations: [] }], attachmentStatus: "complete", contentHash: "", metadata: {} };
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: now.toISOString(), source: "better-bibtex", count: 1, entries: [entry], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const HUB = "40. Paper Analyses/smith2020/Smith 2020 - S00 Hub.md";
const notes: NoteRecord[] = [
	{ path: "Questions/Q.md", basename: "Q", frontmatter: { type: "research-question" }, frontmatterParse: "ok" },
	{ path: HUB, basename: "Smith 2020 - S00 Hub", frontmatter: { type: "paper-hub", citekey: "smith2020", citekeyProvisional: false, zoteroID: entry.id, zoteroSelectURI: entry.zoteroSelectURI, zoteroStatus: "resolved", zoteroCheckedAt: now.toISOString() }, frontmatterParse: "ok" },
];
const bodies = new Map([["Questions/Q.md", "[@smith2020]"], [HUB, "---\ntype: paper-hub\ncitekey: smith2020\n---\n> [!quote] 원문\n> store factual knowledge in their parameters\n"]]);
const SHA = "a".repeat(64);
const cacheFor = (path: string): PdfTextCache => ({ version: 1, sha256: SHA, bytes: 8, mtimeMs: 1, pageCount: 1, extractedAt: now.toISOString(), pages: [{ page: 1, pageLabel: "1", text: "models store factual knowledge in their parameters" }], id: null, attachmentKey: null, path, tool: "pdfjs/test" });

function host(): ActionHost & { calls: { listNotes: number; readNote: string[] } } {
	const connection = buildConnection({ mode: "live", obsidian: "ok", pluginVersion: "0.5.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: true, zotero: "7", betterbibtex: "7" }, index: { source: "plugin", path: "80. References/zotero-index.json", generatedAt: index.generatedAt, count: 1, complete: true, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now });
	const calls = { listNotes: 0, readNote: [] as string[] };
	const value = {
		calls, vault: "Research", now, connection, settings: DEFAULT_SETTINGS, indexView: { index, stale: false, ageMinutes: 0 }, indexFailure: null,
		reader: {
			vaultName: () => "Research", scanWarnings: () => ({ skipped: [], truncated: false }),
			listNotes: async () => { calls.listNotes++; return notes; },
			readNote: async (path: string) => { calls.readNote.push(path); const body = bodies.get(path); if (body === undefined) throw new Error(`Note not found: ${path}`); return body; },
			exists: async (path: string) => bodies.has(path),
		},
		bibliography: async () => "Smith (2020).", bibliographyReason: null, vaultLinks: async () => ({ links: [], warnings: [] }),
		pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
	};
	return value;
}

test("F13: cites and diagnostics list the vault exactly once per request", async () => {
	const cites = host();
	const citesResult = await runAction(cites, "cites", { path: "Questions/Q.md", bibliography: true });
	assert.equal(citesResult.ok, true);
	assert.equal(cites.calls.listNotes, 1);
	const recursive = host();
	await runAction(recursive, "cites", { path: "Questions", recursive: true });
	assert.equal(recursive.calls.listNotes, 1);
	const diagnostics = host();
	const diagnosticsResult = await runAction(diagnostics, "diagnostics", {});
	assert.equal(diagnosticsResult.ok, true);
	assert.equal(diagnostics.calls.listNotes, 1, "diagnostics threads its listing through the reconcile dry-run");
	const reconcile = host();
	await runAction(reconcile, "reconcile", {});
	assert.equal(reconcile.calls.listNotes, 1);
	const resolve = host();
	await runAction(resolve, "resolve", { citekey: "smith2020" });
	assert.equal(resolve.calls.listNotes, 1);
});

test("F14: findNote accepts a path with or without .md and ignores wrapping slashes", () => {
	assert.equal(findNote(notes, HUB)?.path, HUB);
	assert.equal(findNote(notes, HUB.slice(0, -3))?.path, HUB);
	assert.equal(findNote(notes, `/${HUB.slice(0, -3)}/`)?.path, HUB);
	assert.equal(findNote(notes, "Questions/Q")?.path, "Questions/Q.md");
	assert.equal(findNote(notes, "Questions/Missing"), null);
});

test("F14: locate --path accepts an extension-less note path exactly like cites and reads the note's real path", async () => {
	const bare = host();
	bare.pdfCache = { list: async () => [cacheFileName({ kind: "file", path: "Attachments/paper.pdf" }, SHA)], read: async () => JSON.stringify(cacheFor("Attachments/paper.pdf")), statLocal: async () => null, fileHash: async () => ({ sha256: SHA, absolutePath: "/synthetic/vault/Attachments/paper.pdf" }) };
	const located = await runAction(bare, "locate", { path: HUB.slice(0, -3), file: "Attachments/paper.pdf" });
	assert.equal(located.ok, true, JSON.stringify(located));
	assert.deepEqual(bare.calls.readNote, [HUB], "the note is read by its resolved path, never by the bare request path");
	assert.equal((located.summary as { found: number }).found, 1);
	// Without a file/citekey target the hub's own citekey drives the attachment lookup, as before.
	const viaCitekey = host();
	const fromHub = await runAction(viaCitekey, "locate", { path: HUB.slice(0, -3) });
	assert.equal(fromHub.reason, "no-cache");
	assert.deepEqual((fromHub.item as { citekey: string }).citekey, "smith2020");
});

test("F14: a missing or outside note path is a structured refusal, never a thrown error", async () => {
	const missing = await runAction(host(), "locate", { path: "40. Paper Analyses/nobody/Nobody - S00 Hub" });
	assert.equal(missing.ok, false);
	assert.equal(missing.reason, "invalid-request");
	assert.match(missing.message as string, /Note not found/);
	for (const path of ["../outside/Hub", "/abs/Hub.md", "C:/vault/Hub.md", "Hubs\\Hub.md"]) {
		const outside = await runAction(host(), "locate", { path });
		assert.equal(outside.ok, false, path);
		assert.equal(outside.reason, "path-outside-vault", path);
	}
});

test("F17: identical vault PDFs at two paths keep separate file caches; the other path reports no-cache", async () => {
	const pathA = "80. References/Attachments/copy-a.pdf";
	const pathB = "80. References/Attachments/copy-b.pdf";
	const nameA = cacheFileName({ kind: "file", path: pathA }, SHA);
	assert.notEqual(nameA, cacheFileName({ kind: "file", path: pathB }, SHA));
	const make = (): ActionHost => {
		const value = host();
		value.pdfCache = { list: async () => [nameA, "file-aaaaaaaaaaaaaaaa.json"], read: async path => path === `${PDF_TEXT_CACHE_DIR}/${nameA}` ? JSON.stringify(cacheFor(pathA)) : null, statLocal: async () => ({ size: 8, mtimeMs: 1 }), fileHash: async () => ({ sha256: SHA, absolutePath: "/synthetic/vault/copy.pdf" }) };
		return value;
	};
	const a = await runAction(make(), "locate", { file: pathA, quote: "store factual knowledge in their parameters" });
	assert.equal(a.ok, true, JSON.stringify(a));
	assert.equal((a.cache as { path: string }).path, `${PDF_TEXT_CACHE_DIR}/${nameA}`);
	assert.equal((a.attachment as { path: string }).path, pathA);
	const b = await runAction(make(), "locate", { file: pathB, quote: "store factual knowledge in their parameters" });
	assert.equal(b.ok, false);
	assert.equal(b.reason, "no-cache", "the first copy's cache is neither selected nor reported as source-changed for the second copy");
});

/** PdfTextService bundled against a fake pdf.js host and an in-memory store (same shape as tests/pdf-extract.test.ts). */
async function extractModule(): Promise<{ PdfTextService: new (app: unknown, store: PdfCacheStore) => { extract(scope: unknown): Promise<{ cache: { path: string; hit: boolean; evicted: string[] } }> } }> {
	const result = await build({ stdin: { contents: 'export * from "./src/pdf/extract.ts";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, plugins: [{
		name: "pdf-fake-host", setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
			builder.onResolve({ filter: /local-file$/ }, () => ({ path: "local-file", namespace: "mock" }));
			builder.onResolve({ filter: /vault-storage$/ }, () => ({ path: "storage", namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian"
				? "export class App{}; export class FileSystemAdapter{}; export async function loadPdfJs(){return {version:'test',getDocument(){return {destroy:async()=>{},promise:Promise.resolve({numPages:1,getPageLabels:async()=>null,getPage:async()=>({getTextContent:async()=>({items:[{str:'synthetic',hasEOL:false}]}),cleanup(){}}),destroy:async()=>{}})}}}};"
				: args.path === "local-file" ? "export async function readLocalFile(){return {bytes:new Uint8Array(512).fill(7),mtimeMs:1234.5}};"
				: "export async function assertVaultBoundary(){}; export async function ensureCmdsIgnore(){}; export async function ensureDirectory(){};" }));
		},
	}] });
	return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")) as never;
}

test("F17: extraction of identical bytes at two vault paths writes two caches and neither evicts the other", async () => {
	const { PdfTextService } = await extractModule();
	const files = new Map<string, string>();
	const store: PdfCacheStore = {
		exists: async path => files.has(path), read: async path => files.get(path)!, write: async (path, content) => { files.set(path, content); },
		remove: async path => { files.delete(path); }, list: async () => [...files.keys()].map(path => path.split("/").pop()!),
		ensureDirectory: async () => {}, assertBoundary: async () => {}, ensureIgnore: async () => {},
	};
	const service = new PdfTextService({}, store);
	const a = await service.extract({ kind: "file", path: "Attachments/copy-a.pdf", absolutePath: "/synthetic/vault/Attachments/copy-a.pdf" });
	const b = await service.extract({ kind: "file", path: "Attachments/copy-b.pdf", absolutePath: "/synthetic/vault/Attachments/copy-b.pdf" });
	assert.notEqual(a.cache.path, b.cache.path);
	assert.ok(a.cache.path.includes(`file-${filePathHash("Attachments/copy-a.pdf")}-`));
	assert.deepEqual(b.cache.evicted, [], "the other path's cache survives");
	assert.equal(files.size, 2);
	const again = await service.extract({ kind: "file", path: "Attachments/copy-a.pdf", absolutePath: "/synthetic/vault/Attachments/copy-a.pdf" });
	assert.equal(again.cache.hit, true);
	assert.equal(again.cache.path, a.cache.path);
	assert.equal(files.size, 2);
});

test("F11 premise: the guarded reader refuses a path through a symlinked directory but accepts the same file via its realpath", async () => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-symlink-root-")));
	try {
		const vault = join(directory, "vault");
		await fs.mkdir(vault);
		await fs.writeFile(join(vault, "paper.pdf"), Buffer.from("%PDF-1.7\n%synthetic body\n%%EOF\n", "latin1"));
		const linked = join(directory, "vault-link");
		await fs.symlink(vault, linked);
		const viaLink = await readLocalFile(join(linked, "paper.pdf"), { maxBytes: 1024, magic: ["255044462d"], label: "PDF" }).then(() => "resolved", error => error instanceof LocalFileError ? error.code : String(error));
		assert.equal(viaLink, "symlink", "joining onto the un-resolved base path is refused, which is why the hosts realpath the base once");
		const viaRealpath = await readLocalFile(join(await fs.realpath(linked), "paper.pdf"), { maxBytes: 1024, magic: ["255044462d"], label: "PDF" });
		assert.equal(viaRealpath.bytes.length, 31);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
