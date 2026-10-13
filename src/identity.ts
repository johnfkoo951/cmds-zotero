import { createHash } from "crypto";
import type { ItemIdentity, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { identityKey, ITEM_KEY, parseZoteroURI, positiveInteger, selectURI } from "./uris";

export function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function validateIdentity(value: unknown): value is ItemIdentity {
	if (!record(value)) return false;
	try { identityKey(value as unknown as ItemIdentity); return true; } catch { return false; }
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!record(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function contentHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function entryHash(entry: ZoteroIndexEntry): string {
	const { contentHash: _hash, ...rest } = entry;
	return contentHash(rest);
}

/**
 * 0.6 additive `readerAnnotations` (EPUB and snapshot annotations): the PDF annotation fields without a page, a select URI
 * for the attachment in the entry's library, and a position object. Readers of the 0.5 contract ignore the field.
 */
function validReaderAnnotations(value: unknown, attachmentKey: string, item: ZoteroIndexEntry): boolean {
	if (!Array.isArray(value)) return false;
	for (const annotation of value as unknown[]) {
		if (!record(annotation) || typeof annotation.key !== "string" || !ITEM_KEY.test(annotation.key) || annotation.attachmentKey !== attachmentKey || typeof annotation.version !== "number" || !Number.isSafeInteger(annotation.version) || annotation.version < 0 || !strings(annotation.tags) || !record(annotation.position)) return false;
		if ([annotation.type, annotation.text, annotation.comment, annotation.color, annotation.pageLabel, annotation.dateModified, annotation.uri].some(text => typeof text !== "string")) return false;
		if ((annotation.imagePath !== undefined && typeof annotation.imagePath !== "string") || (annotation.sortIndex !== undefined && typeof annotation.sortIndex !== "string")) return false;
		const location = parseZoteroURI(annotation.uri as string);
		if (location.action !== "select" || location.itemKey !== attachmentKey || location.libraryType !== item.libraryType || location.groupID !== item.groupID) return false;
	}
	return true;
}

/**
 * Every check of `validateEntry` except the content hash: identity, field types, attachment and annotation URIs. An entry
 * this process builds is checked with this and then hashed once by `sealEntry`.
 */
export function validateEntryStructure(value: unknown): value is ZoteroIndexEntry {
	if (!record(value) || !validateIdentity(value)) return false;
	const item = value as unknown as ZoteroIndexEntry;
	if (item.id !== identityKey(item) || item.zoteroSelectURI !== selectURI(item)) return false;
	if (!item.citekey || [item.citekey, item.title, item.year, item.doi, item.url, item.attachmentPath, item.contentHash].some(text => typeof text !== "string")) return false;
	if (![item.authors, item.collections, item.tags, item.citekeyHistory].every(strings) || !record(item.metadata)) return false;
	if (!["complete", "unavailable"].includes(item.attachmentStatus) || !Array.isArray(item.attachments)) return false;
	try {
		const keys = new Set<string>();
		for (const attachment of item.attachments) {
			if (!record(attachment) || !ITEM_KEY.test(attachment.key) || typeof attachment.openURI !== "string" || typeof attachment.title !== "string" || !(attachment.path === null || typeof attachment.path === "string") || !Array.isArray(attachment.annotations)) return false;
			const uri = parseZoteroURI(attachment.openURI);
			if (uri.action !== "open-pdf" || uri.itemKey !== attachment.key || uri.itemKey === item.itemKey || uri.libraryType !== item.libraryType || uri.groupID !== item.groupID || keys.has(attachment.key)) return false;
			keys.add(attachment.key);
			for (const annotation of attachment.annotations) {
				if (!record(annotation) || !ITEM_KEY.test(annotation.key) || annotation.attachmentKey !== attachment.key || !positiveInteger(annotation.page) || !Number.isSafeInteger(annotation.version) || annotation.version < 0 || !strings(annotation.tags)) return false;
				if ([annotation.type, annotation.text, annotation.comment, annotation.color, annotation.pageLabel, annotation.dateModified, annotation.uri].some(text => typeof text !== "string") || (annotation.imagePath !== undefined && typeof annotation.imagePath !== "string")) return false;
				const location = parseZoteroURI(annotation.uri);
				if (location.action !== "open-pdf" || location.itemKey !== attachment.key || location.annotationKey !== annotation.key || location.page !== annotation.page || location.libraryType !== item.libraryType || location.groupID !== item.groupID) return false;
			}
			if (attachment.readerAnnotations !== undefined && !validReaderAnnotations(attachment.readerAnnotations, attachment.key, item)) return false;
		}
		return !item.attachmentPath || item.attachments.some(attachment => attachment.path === item.attachmentPath);
	} catch { return false; }
}

/** A complete entry: valid structure and a content hash that matches its bytes. Every trust boundary uses this check. */
export function validateEntry(value: unknown): value is ZoteroIndexEntry {
	if (!validateEntryStructure(value)) return false;
	try { return /^[a-f0-9]{64}$/.test(value.contentHash) && entryHash(value) === value.contentHash; } catch { return false; }
}

/**
 * Entries this process hashed after their last change (`sealEntry`) or verified in full when it read a snapshot
 * (`validateAndSealIndex`). Index entries are never changed after hashing (a changed entry is a new object), so a sealed
 * entry needs no second hash. Membership is by object identity: parsed and copied objects are never sealed.
 */
const sealedEntries = new WeakSet<object>();

/**
 * Hashes an entry built in this process once, after its last change, and seals it. Returns false, leaving the entry
 * unsealed and its hash untouched, when the structure is invalid.
 */
export function sealEntry(entry: ZoteroIndexEntry): boolean {
	if (!validateEntryStructure(entry)) return false;
	entry.contentHash = entryHash(entry);
	sealedEntries.add(entry);
	return true;
}

/** `validateEntry` for entries handed around inside this process: a sealed entry is trusted without hashing it again. */
export function verifyEntry(value: unknown): value is ZoteroIndexEntry {
	return (record(value) && sealedEntries.has(value)) || validateEntry(value);
}

function validateIndexWith(value: unknown, validEntry: (entry: unknown) => entry is ZoteroIndexEntry): value is ZoteroIndex {
	if (!record(value) || value.schemaVersion !== 2 || value.source !== "better-bibtex" || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt)) || typeof value.complete !== "boolean" || !Array.isArray(value.entries) || value.count !== value.entries.length || !value.entries.every(validEntry)) return false;
	if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length || !record(value.capabilities) || !Array.isArray(value.diagnostics)) return false;
	const caps = value.capabilities;
	if (typeof caps.zotero !== "string" || typeof caps.betterbibtex !== "string" || [caps.metadata, caps.attachments, caps.annotations, caps.bibliography].some(flag => typeof flag !== "boolean")) return false;
	return value.diagnostics.every(diagnostic => record(diagnostic) && typeof diagnostic.code === "string" && typeof diagnostic.message === "string" && ["info", "warning", "error"].includes(String(diagnostic.severity)) && (diagnostic.itemID === undefined || typeof diagnostic.itemID === "string") && (diagnostic.citekey === undefined || typeof diagnostic.citekey === "string"));
}

/** Full validation, every entry hashed again: for bytes that cross a trust boundary (a file read, another process). */
export function validateIndex(value: unknown): value is ZoteroIndex {
	return validateIndexWith(value, validateEntry);
}

/**
 * `validateIndex` for an index this process built or read: sealed entries are not hashed again, any other entry is
 * validated in full, and the index-level checks (count, unique IDs, capabilities, diagnostics) always run.
 */
export function verifyIndex(value: unknown): value is ZoteroIndex {
	return validateIndexWith(value, verifyEntry);
}

/** `validateIndex` for a snapshot read from disk that seals its entries when it passes, so later in-process checks skip the hash. */
export function validateAndSealIndex(value: unknown): value is ZoteroIndex {
	if (!validateIndex(value)) return false;
	for (const entry of value.entries) sealedEntries.add(entry);
	return true;
}
