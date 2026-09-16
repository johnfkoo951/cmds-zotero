/**
 * PDF text cache naming, selection, eviction and schema validation. Pure: never imports `obsidian`;
 * directory listings and file stats are injected by the host. Vocabulary §6.
 */
import type { PageText } from "./locate";

export const PDF_TEXT_CACHE_DIR = ".cmds-zotero/pdf-text";
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;

/** Schema descriptor for the on-disk cache: the version and the keys `validateCache` requires. */
export const CACHE_SCHEMA = {
	version: 1,
	keys: ["version", "sha256", "bytes", "mtimeMs", "pageCount", "extractedAt", "pages", "id", "attachmentKey", "path", "tool"],
} as const;

export interface PdfTextCache {
	version: 1;
	sha256: string;
	bytes: number;
	mtimeMs: number;
	pageCount: number;
	extractedAt: string;
	pages: PageText[];
	/** Index `entry.id` (`<libraryID>:<itemKey>`) of the parent item; null for `--file` caches. */
	id: string | null;
	attachmentKey: string | null;
	/** Absolute local path (Zotero attachment) or vault-relative path (`--file`). */
	path: string;
	/** Extraction tool and version, e.g. `pdfjs/4.0.379`. */
	tool: string;
}

export type CacheScope =
	| { kind: "attachment"; libraryType: "user" | "group"; libraryID: number; attachmentKey: string }
	| { kind: "file" };

export interface ParsedCacheName {
	scope: CacheScope;
	prefix: string;
	sha16: string;
}

const ATTACHMENT_KEY = /^[A-Z0-9]{8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CACHE_NAME = /^(?:(user|group)-([1-9]\d*)-([A-Z0-9]{8})|file)-([0-9a-f]{16})\.json$/;

/** `<libraryType>-<libraryID>-<attachmentKey>` for Zotero attachments, `file` for vault PDFs. */
export function cachePrefix(scope: CacheScope): string {
	if (scope.kind === "file") return "file";
	if (scope.libraryType !== "user" && scope.libraryType !== "group") throw new Error("Invalid library type for the PDF text cache");
	if (!Number.isSafeInteger(scope.libraryID) || scope.libraryID < 1) throw new Error("Invalid library ID for the PDF text cache");
	if (!ATTACHMENT_KEY.test(scope.attachmentKey)) throw new Error("Invalid attachment key for the PDF text cache");
	return `${scope.libraryType}-${scope.libraryID}-${scope.attachmentKey}`;
}

/** `<prefix>-<sha16>.json`; the content hash keeps a re-downloaded or annotated PDF from reusing stale text. */
export function cacheFileName(scope: CacheScope, sha256: string): string {
	if (!SHA256.test(sha256)) throw new Error("Invalid SHA-256 for the PDF text cache");
	return `${cachePrefix(scope)}-${sha256.slice(0, 16)}.json`;
}

/** Inverse of `cacheFileName`; null for foreign files in the cache directory. */
export function parseCacheName(name: string): ParsedCacheName | null {
	const match = CACHE_NAME.exec(name);
	if (!match) return null;
	const sha16 = match[4];
	if (!match[1]) return { scope: { kind: "file" }, prefix: "file", sha16 };
	const libraryID = Number(match[2]);
	if (!Number.isSafeInteger(libraryID) || libraryID < 1) return null;
	const scope: CacheScope = { kind: "attachment", libraryType: match[1] as "user" | "group", libraryID, attachmentKey: match[3] };
	return { scope, prefix: cachePrefix(scope), sha16 };
}

export interface CacheEntry {
	name: string;
	extractedAt: string;
}

function extractedOrder(value: string): number {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** The most recently extracted cache for a prefix (ties broken by name for determinism); null when none. */
export function pickNewest(entries: CacheEntry[], prefix: string): CacheEntry | null {
	let newest: CacheEntry | null = null;
	for (const entry of entries) {
		if (parseCacheName(entry.name)?.prefix !== prefix) continue;
		if (!newest) { newest = entry; continue; }
		const delta = extractedOrder(entry.extractedAt) - extractedOrder(newest.extractedAt);
		if (delta > 0 || (delta === 0 && entry.name > newest.name)) newest = entry;
	}
	return newest;
}

/**
 * Every cache name sharing `keepName`'s attachment prefix except `keepName` itself, sorted; foreign names are left alone.
 * `file-<sha16>` names carry no file identity, so the `file` prefix never evicts by name: use `evictionSetByPath`.
 */
export function evictionSet(names: string[], keepName: string): string[] {
	const keep = parseCacheName(keepName);
	if (!keep) throw new Error("Invalid PDF text cache name");
	if (keep.scope.kind === "file") return [];
	return [...new Set(names.filter(name => name !== keepName && parseCacheName(name)?.prefix === keep.prefix))].sort();
}

/** `--file` eviction: older `file-` caches whose recorded vault-relative `path` equals the one just extracted. */
export function evictionSetByPath(entries: { name: string; path: string }[], keepName: string, path: string): string[] {
	const keep = parseCacheName(keepName);
	if (!keep || keep.scope.kind !== "file") throw new Error("Invalid PDF text cache name for a file scope");
	return [...new Set(entries.filter(entry => entry.name !== keepName && entry.path === path && parseCacheName(entry.name)?.prefix === "file").map(entry => entry.name))].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonNegativeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const stringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function validPage(value: unknown): value is PageText {
	return isRecord(value) && positiveInt(value.page) && typeof value.pageLabel === "string" && typeof value.text === "string" && value.text.length <= 200_000 && value.pageLabel.length <= 1024;
}

/** Structural check for a cache file read back from disk; a damaged or pre-0.4 cache is simply rebuilt. */
export function validateCache(value: unknown): value is PdfTextCache {
	if (!isRecord(value) || value.version !== CACHE_SCHEMA.version) return false;
	if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) return false;
	if (!nonNegativeInt(value.bytes) || value.bytes < 8 || value.bytes > 64 * 1024 * 1024 || typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs) || value.mtimeMs < 0) return false;
	if (!positiveInt(value.pageCount) || value.pageCount > 2000 || typeof value.extractedAt !== "string" || Number.isNaN(Date.parse(value.extractedAt))) return false;
	if (!Array.isArray(value.pages) || value.pages.length !== value.pageCount || !value.pages.every((page, i) => validPage(page) && page.page === i + 1)) return false;
	if (!stringOrNull(value.id) || !stringOrNull(value.attachmentKey)) return false;
	if ((value.id === null) !== (value.attachmentKey === null)) return false;
	if (typeof value.id === "string" && !/^[1-9]\d*:[A-Z0-9]{8}$/.test(value.id)) return false;
	if (typeof value.attachmentKey === "string" && !ATTACHMENT_KEY.test(value.attachmentKey)) return false;
	return typeof value.path === "string" && value.path.length > 0 && typeof value.tool === "string" && value.tool.length > 0;
}

export type CacheVerification = true | false | "unchecked";

/**
 * `locate`'s lstat check: true when the PDF still has the cached size and mtime, false when either changed,
 * Modification times are compared at whole-millisecond precision for adapter interoperability.
 * "unchecked" when the host could not stat the file (offline, path null). The host lstats; this compares.
 */
export function verifyCache(cache: Pick<PdfTextCache, "bytes" | "mtimeMs">, stat: { size: number; mtimeMs: number } | null): CacheVerification {
	if (!stat) return "unchecked";
	return stat.size === cache.bytes && Math.trunc(stat.mtimeMs) === Math.trunc(cache.mtimeMs);
}
