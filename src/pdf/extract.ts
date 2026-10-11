/**
 * pdf.js text extraction into the content-hashed cache (live only; the pdf.js bundle ships with Obsidian).
 * File reads go through `local-file.ts`; naming, eviction and schema live in the pure `cache.ts`.
 */
import { App, FileSystemAdapter, loadPdfJs } from "obsidian";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "crypto";
import { joinTextItems, normalizePageLabel, type PageText, type TextItem } from "./locate";
import { cacheFileName, cachePrefix, evictionSet, evictionSetByPath, normalizeVaultPath, parseCacheName, MAX_CACHE_BYTES, PDF_TEXT_CACHE_DIR, validateCache, type CacheScope, type PdfTextCache } from "./cache";
import { readLocalFile } from "../local-file";
import { assertVaultBoundary, ensureCmdsIgnore, ensureDirectory } from "../vault-storage";
import { PdfExtractError } from "./errors";

export const MAX_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_PAGES = 2000;
/** Per-page text cap (vocabulary §6); longer pages are truncated and reported in `warnings`. */
export const MAX_PAGE_CHARS = 200_000;
/** `%PDF-` */
const PDF_MAGIC = ["255044462d"];
/**
 * Obsidian ships pdf.js's character maps and standard-font data beside its own PDF viewer and passes these URLs to it
 * (`/lib/pdfjs/...` resolves inside the app). Without them, CID-keyed CJK fonts that use a predefined CMap and non-embedded
 * standard fonts extract as empty or wrong text.
 */
export const PDFJS_RESOURCE_OPTIONS: Readonly<Record<string, string | boolean>> = { cMapUrl: "/lib/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/lib/pdfjs/standard_fonts/" };

export { PDF_TEXT_CACHE_DIR };
export type ExtractedPdf = PdfTextCache;

export type ExtractScope =
	/** A Zotero attachment: `path` is the absolute local path from the index, `id` the parent's `<libraryID>:<itemKey>`. */
	| { kind: "attachment"; libraryType: "user" | "group"; libraryID: number; attachmentKey: string; id: string; path: string }
	/** `--file`: `path` is vault-relative (recorded in the cache); `absolutePath` was boundary-checked by the caller. */
	| { kind: "file"; path: string; absolutePath: string };

export interface ExtractOptions {
	/** Re-extract even when a cache with the same content hash exists. */
	force?: boolean;
}

export interface ExtractResult {
	cache: { path: string; hit: boolean; evicted: string[] };
	extracted: PdfTextCache;
	/** Pages whose text reached `MAX_PAGE_CHARS` (derived from the cache, so hits report it too). */
	truncatedPages: number[];
	warnings: string[];
}

/** The vault-side operations the service needs; `vaultCacheStore` backs it with the Obsidian adapter. */
export interface PdfCacheStore {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	remove(path: string): Promise<void>;
	/** File names (basenames) directly inside a vault-relative directory; [] when it does not exist. */
	list(dir: string): Promise<string[]>;
	ensureDirectory(path: string): Promise<void>;
	assertBoundary(path: string): Promise<void>;
	/** Guarantees `.cmds-zotero/.gitignore` = `*` before the first cache write; never removes it. */
	ensureIgnore(): Promise<void>;
}

export function vaultCacheStore(app: App): PdfCacheStore {
	const adapter = app.vault.adapter;
	// 0.5 R13/F11: resolved once; the guarded reader refuses any path whose realpath differs (a symlinked vault root included).
	let root: Promise<string> | null = null;
	const basePath = (): Promise<string> => {
		if (!(adapter instanceof FileSystemAdapter)) return Promise.reject(new Error("A desktop vault is required for PDF caches"));
		root ??= fs.realpath(adapter.getBasePath()).catch(() => adapter.getBasePath());
		return root;
	};
	return {
		exists: path => adapter.exists(path),
		read: async path => {
			await assertVaultBoundary(app, path);
			const bytes = (await readLocalFile(join(await basePath(), path), { maxBytes: MAX_CACHE_BYTES, minBytes: 0, magic: () => true })).bytes;
			return Buffer.from(bytes).toString("utf8");
		},
		write: (path, content) => adapter.write(path, content),
		remove: path => adapter.remove(path),
		list: async dir => (await adapter.exists(dir)) ? (await adapter.list(dir)).files.map(file => file.split("/").pop() ?? file) : [],
		ensureDirectory: path => ensureDirectory(app, path),
		assertBoundary: path => assertVaultBoundary(app, path),
		ensureIgnore: () => ensureCmdsIgnore(app),
	};
}

interface PdfJsModule {
	version?: unknown;
	getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy?(): Promise<void> };
}

interface PdfDocument {
	numPages: number;
	getPageLabels(): Promise<(string | null)[] | null>;
	getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup?: () => void }>;
	destroy(): Promise<void>;
}

function toCacheScope(scope: ExtractScope): CacheScope {
	return scope.kind === "file" ? { kind: "file", path: scope.path } : { kind: "attachment", libraryType: scope.libraryType, libraryID: scope.libraryID, attachmentKey: scope.attachmentKey };
}

export function truncatedPages(pages: PageText[]): number[] {
	return pages.filter(page => page.text.length >= MAX_PAGE_CHARS).map(page => page.page);
}

export class PdfTextService {
	private flights = new Map<string, Promise<ExtractResult>>();
	private readonly store: PdfCacheStore;

	constructor(app: App, store?: PdfCacheStore, private canWrite: () => boolean = () => true) {
		this.store = store ?? vaultCacheStore(app);
	}

	private assertWritable(): void {
		// 0.5 R13/F08: typed so the ingest API never classifies this by its wording.
		if (!this.canWrite()) throw new PdfExtractError("cancelled", "The plugin was unloaded or reconfigured; PDF cache publication was cancelled");
	}

	/** Per-page text for one PDF; concurrent requests for the same target share one extraction. */
	extract(requested: ExtractScope, options: ExtractOptions = {}): Promise<ExtractResult> {
		// 0.5 R13/F17: one spelling of a vault path per cache (recorded, compared and hashed in normalized form).
		const scope: ExtractScope = requested.kind === "file" ? { ...requested, path: normalizeVaultPath(requested.path) } : requested;
		const key = `${cachePrefix(toCacheScope(scope))}:${scope.kind === "file" ? scope.absolutePath : scope.path}:${options.force ? "force" : "cache"}`;
		const flight = this.flights.get(key);
		if (flight) return flight;
		const request = this.extractNow(scope, options).finally(() => { this.flights.delete(key); });
		this.flights.set(key, request);
		return request;
	}

	private async extractNow(scope: ExtractScope, options: ExtractOptions): Promise<ExtractResult> {
		this.assertWritable();
		const cacheScope = toCacheScope(scope);
		const localPath = scope.kind === "file" ? scope.absolutePath : scope.path;
		const { bytes, mtimeMs } = await readLocalFile(localPath, { maxBytes: MAX_PDF_BYTES, magic: PDF_MAGIC, label: "PDF" });
		const byteLength = bytes.byteLength;
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const name = cacheFileName(cacheScope, sha256);
		const cachePath = `${PDF_TEXT_CACHE_DIR}/${name}`;
		await this.store.assertBoundary(cachePath);
		if (!options.force) {
			const hit = await this.readCache(cachePath, sha256, scope, byteLength, mtimeMs);
			if (hit) {
				const evicted = await this.evictOthers(name, scope);
				const truncated = truncatedPages(hit.pages);
				return { cache: { path: cachePath, hit: true, evicted }, extracted: hit, truncatedPages: truncated, warnings: truncated.map(page => `Page ${page} text reached the ${MAX_PAGE_CHARS} character limit`) };
			}
		}
		const warnings: string[] = [];
		const { pages, pageCount, tool } = await this.extractPages(bytes, warnings);
		const extracted: PdfTextCache = {
			version: 1, sha256, bytes: byteLength, mtimeMs, pageCount, extractedAt: new Date().toISOString(), pages,
			id: scope.kind === "attachment" ? scope.id : null,
			attachmentKey: scope.kind === "attachment" ? scope.attachmentKey : null,
			path: scope.path,
			tool,
		};
		if (!validateCache(extracted)) throw new PdfExtractError("invalid-cache", "PDF extraction produced invalid cache metadata");
		const serialized = JSON.stringify(extracted);
		if (Buffer.byteLength(serialized) > MAX_CACHE_BYTES) throw new PdfExtractError("cache-too-large", "PDF text cache exceeds the 32 MiB limit");
		this.assertWritable();
		await this.store.ensureIgnore();
		this.assertWritable();
		await this.store.ensureDirectory(cachePath);
		this.assertWritable();
		await this.store.write(cachePath, serialized);
		const evicted = await this.evictOthers(name, scope);
		return { cache: { path: cachePath, hit: false, evicted }, extracted, truncatedPages: truncatedPages(pages), warnings };
	}

	private async readCache(cachePath: string, sha256: string, scope: ExtractScope, byteLength: number, mtimeMs: number): Promise<PdfTextCache | null> {
		if (!(await this.store.exists(cachePath))) return null;
		try {
			const content = await this.store.read(cachePath);
			if (Buffer.byteLength(content) > MAX_CACHE_BYTES) return null;
			const parsed: unknown = JSON.parse(content);
			if (!validateCache(parsed) || parsed.sha256 !== sha256 || parsed.bytes !== byteLength || parsed.path !== scope.path) return null;
			if (scope.kind === "attachment" ? parsed.id !== scope.id || parsed.attachmentKey !== scope.attachmentKey : parsed.id !== null || parsed.attachmentKey !== null) return null;
			if (parsed.mtimeMs !== mtimeMs) {
				parsed.mtimeMs = mtimeMs;
				this.assertWritable();
				await this.store.ensureIgnore();
				this.assertWritable();
				await this.store.write(cachePath, JSON.stringify(parsed));
			}
			return parsed;
		} catch { return null; /* A damaged or mismatched cache is rebuilt. */ }
	}

	/**
	 * Removes older caches of the same PDF: by attachment prefix, or for `--file` by the path-hash prefix *and* the
	 * vault-relative path each `file-` cache recorded (another paper's cache must never be evicted).
	 */
	private async evictOthers(keepName: string, scope: ExtractScope): Promise<string[]> {
		const names = await this.store.list(PDF_TEXT_CACHE_DIR);
		// 0.5 R13/F17: only caches sharing the kept path prefix are opened; every other `file-` cache stays unread.
		const stale = scope.kind === "file" ? evictionSetByPath(await this.fileCachePaths(names.filter(name => name !== keepName), cachePrefix(scope)), keepName, scope.path) : evictionSet(names, keepName);
		const evicted: string[] = [];
		for (const name of stale) {
			const path = `${PDF_TEXT_CACHE_DIR}/${name}`;
			await this.store.assertBoundary(path);
			this.assertWritable();
			await this.store.remove(path);
			evicted.push(path);
		}
		return evicted;
	}

	/** The recorded `path` of every valid `file-` cache under `prefix`; damaged ones are skipped (never evicted blindly). */
	private async fileCachePaths(names: string[], prefix: string): Promise<{ name: string; path: string }[]> {
		const entries: { name: string; path: string }[] = [];
		for (const name of names) {
			const parsed = parseCacheName(name);
			if (parsed?.scope.kind !== "file" || parsed.prefix !== prefix) continue;
			try {
				const path = `${PDF_TEXT_CACHE_DIR}/${name}`;
				await this.store.assertBoundary(path);
				const content = await this.store.read(path);
				if (Buffer.byteLength(content) > MAX_CACHE_BYTES) continue;
				const parsed: unknown = JSON.parse(content);
				if (validateCache(parsed)) entries.push({ name, path: parsed.path });
			} catch { /* unreadable: leave it alone */ }
		}
		return entries;
	}

	private async extractPages(bytes: Uint8Array, warnings: string[]): Promise<{ pages: PageText[]; pageCount: number; tool: string }> {
		// 0.5 R13/F08: every failure of this stage carries a code; pdf.js's own message is kept inside `unreadable`.
		let pdfjs: PdfJsModule;
		try { pdfjs = await loadPdfJs() as PdfJsModule; }
		catch (error) { throw new PdfExtractError("pdfjs-unavailable", `pdf.js could not be loaded: ${error instanceof Error ? error.message : String(error)}`); }
		const tool = `pdfjs/${typeof pdfjs.version === "string" && pdfjs.version ? pdfjs.version : "unknown"}`;
		const task = pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, useSystemFonts: false, stopAtErrors: false, ...PDFJS_RESOURCE_OPTIONS });
		let doc: PdfDocument | null = null;
		try {
			try { doc = await task.promise; }
			catch (error) { throw new PdfExtractError("unreadable", `pdf.js could not parse the PDF: ${error instanceof Error ? error.message : String(error)}`); }
			if (doc.numPages > MAX_PDF_PAGES) throw new PdfExtractError("too-many-pages", `PDF has ${doc.numPages} pages; the extraction limit is ${MAX_PDF_PAGES}`);
			if (doc.numPages < 1) throw new PdfExtractError("no-pages", "PDF has no pages");
			let labels: (string | null)[] | null = null;
			try { labels = await doc.getPageLabels(); } catch { labels = null; }
			const pages: PageText[] = [];
			let serializedBytes = 0;
			for (let n = 1; n <= doc.numPages; n++) {
				const page = await doc.getPage(n);
				const content = await page.getTextContent();
				let text = joinTextItems(content.items as TextItem[]);
				if (text.length > MAX_PAGE_CHARS) {
					text = text.slice(0, MAX_PAGE_CHARS);
					warnings.push(`Page ${n} text was truncated to ${MAX_PAGE_CHARS} characters`);
				}
				const extractedPage = { page: n, pageLabel: normalizePageLabel(labels?.[n - 1], n), text };
				serializedBytes += Buffer.byteLength(JSON.stringify(extractedPage));
				if (serializedBytes > MAX_CACHE_BYTES - 8192) throw new PdfExtractError("cache-too-large", "PDF text cache exceeds the 32 MiB limit");
				pages.push(extractedPage);
				page.cleanup?.();
			}
			return { pages, pageCount: doc.numPages, tool };
		} finally { if (doc) await doc.destroy(); else await task.destroy?.(); }
	}
}
