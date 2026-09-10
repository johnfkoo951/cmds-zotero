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

export function validateEntry(value: unknown): value is ZoteroIndexEntry {
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
		}
		if (item.attachmentPath && !item.attachments.some(attachment => attachment.path === item.attachmentPath)) return false;
		return /^[a-f0-9]{64}$/.test(item.contentHash) && entryHash(item) === item.contentHash;
	} catch { return false; }
}

export function validateIndex(value: unknown): value is ZoteroIndex {
	if (!record(value) || value.schemaVersion !== 2 || value.source !== "better-bibtex" || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt)) || typeof value.complete !== "boolean" || !Array.isArray(value.entries) || value.count !== value.entries.length || !value.entries.every(validateEntry)) return false;
	if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length || !record(value.capabilities) || !Array.isArray(value.diagnostics)) return false;
	const caps = value.capabilities;
	if (typeof caps.zotero !== "string" || typeof caps.betterbibtex !== "string" || [caps.metadata, caps.attachments, caps.annotations, caps.bibliography].some(flag => typeof flag !== "boolean")) return false;
	return value.diagnostics.every(diagnostic => record(diagnostic) && typeof diagnostic.code === "string" && typeof diagnostic.message === "string" && ["info", "warning", "error"].includes(String(diagnostic.severity)) && (diagnostic.itemID === undefined || typeof diagnostic.itemID === "string") && (diagnostic.citekey === undefined || typeof diagnostic.citekey === "string"));
}
