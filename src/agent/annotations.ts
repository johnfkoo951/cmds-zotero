/**
 * Pure core of the `annotations` action (0.6): a paper's annotations for agents, filtered by color, type, tag and
 * attachment, in Zotero's reading order, each with its Zotero reader link and, for image annotations, the private cache
 * path plus any copy the literature import made in the vault. The action shell (selector, freshness, envelope) lives in
 * `actions.ts`. Never imports `obsidian`.
 */
import type { Annotation, ZoteroIndexEntry } from "../types";
import { ANNOTATION_COLORS, colorName, isAnnotationColor, parseHexColor, type AnnotationColor } from "../annotations/colors";
import { readingOrder } from "../note-writer";
import { indexEntryFor, type RecentRead } from "../recent/recent-reads";

/** The annotation types Zotero's reader creates. */
export const ANNOTATION_TYPES = ["highlight", "underline", "note", "text", "image", "ink"] as const;
export type AnnotationType = typeof ANNOTATION_TYPES[number];

export function isAnnotationType(value: string): value is AnnotationType {
	return (ANNOTATION_TYPES as readonly string[]).includes(value);
}

/** `#rrggbb` (lower case) for a 3- or 6-digit hex color with or without `#`; null for anything else. */
export function normalizeHex(value: string): string | null {
	const rgb = parseHexColor(value);
	return rgb ? `#${rgb.map(part => part.toString(16).padStart(2, "0")).join("")}` : null;
}

export type ColorFilter = { kind: "name"; name: AnnotationColor } | { kind: "hex"; hex: string };

/**
 * A palette name (`yellow`), or a hex value. Bare hex needs six digits (`ffd400`) so that a word is never read as a
 * 3-digit color; with a leading `#` three digits are allowed.
 */
export function parseColorFilter(value: string): ColorFilter | null {
	const text = value.trim().toLowerCase();
	if (isAnnotationColor(text)) return { kind: "name", name: text };
	if (text.startsWith("#") || /^[0-9a-f]{6}$/.test(text)) {
		const hex = normalizeHex(text);
		return hex ? { kind: "hex", hex } : null;
	}
	return null;
}

export interface AnnotationFilterRequest { color?: string; type?: string; tag?: string; attachment?: string }
export interface AnnotationFilters { color?: ColorFilter; type?: AnnotationType; tag?: string; attachment?: string }

/** Validates the filter fields of a request; `error` is the `invalid-request` message. */
export function parseAnnotationFilters(request: AnnotationFilterRequest): { filters: AnnotationFilters } | { error: string } {
	const filters: AnnotationFilters = {};
	if (request.color !== undefined) {
		const color = parseColorFilter(request.color);
		if (!color) return { error: `color must be one of ${ANNOTATION_COLORS.join(", ")} or a hex value such as #ffd400.` };
		filters.color = color;
	}
	if (request.type !== undefined) {
		const type = request.type.trim().toLowerCase();
		if (!isAnnotationType(type)) return { error: `type must be one of ${ANNOTATION_TYPES.join(", ")}.` };
		filters.type = type;
	}
	if (request.tag !== undefined) {
		const tag = request.tag.trim();
		if (!tag) return { error: "tag must not be empty." };
		filters.tag = tag;
	}
	if (request.attachment !== undefined) {
		const attachment = request.attachment.trim();
		if (!/^[A-Za-z0-9]{8}$/.test(attachment)) return { error: "attachment must be an eight-character Zotero attachment key." };
		filters.attachment = attachment;
	}
	return { filters };
}

/** The filters as echoed in the payload (colors by the form they were given in). */
export function describeFilters(filters: AnnotationFilters): Record<string, string> {
	return {
		...(filters.color ? { color: filters.color.kind === "name" ? filters.color.name : filters.color.hex } : {}),
		...(filters.type ? { type: filters.type } : {}),
		...(filters.tag ? { tag: filters.tag } : {}),
		...(filters.attachment ? { attachment: filters.attachment } : {}),
	};
}

export interface AnnotationColorInfo { name: AnnotationColor | null; hex: string | null }
/** `private: true` marks `cachePath` as a local path that must not be committed, published or pasted into shared notes. */
export interface AnnotationImageInfo { cachePath: string; private: true; vaultCopies: string[] }

export interface AnnotationRow {
	key: string;
	attachmentKey: string;
	type: string;
	color: AnnotationColorInfo;
	/** One-based position in the PDF (what Zotero's open-pdf links use). */
	page: number;
	/** The page label as printed; may differ from `page`. */
	pageLabel: string;
	text: string;
	comment: string;
	tags: string[];
	/** `zotero://open-pdf/…?page=N&annotation=KEY`: opens the annotation in Zotero's reader (the attachment key, not the parent's). */
	uri: string;
	sortIndex?: string;
	dateModified: string;
	image?: AnnotationImageInfo;
}

export interface AttachmentRows {
	key: string;
	title: string;
	openURI: string;
	contentType?: string;
	/** All annotations of this attachment, before type, color and tag filters. */
	annotationCount: number;
	annotations: AnnotationRow[];
}

export function annotationColorInfo(color: string): AnnotationColorInfo {
	return { name: colorName(color), hex: normalizeHex(color) };
}

function matchesColor(annotation: Annotation, filter: ColorFilter): boolean {
	return filter.kind === "name" ? colorName(annotation.color) === filter.name : normalizeHex(annotation.color) === filter.hex;
}

/** The type, color and tag filters (the attachment filter selects whole attachments, see {@link selectAnnotations}). */
export function matchesFilters(annotation: Annotation, filters: AnnotationFilters): boolean {
	if (filters.type && annotation.type.trim().toLowerCase() !== filters.type) return false;
	if (filters.color && !matchesColor(annotation, filters.color)) return false;
	if (filters.tag) {
		const wanted = filters.tag.toLowerCase();
		if (!annotation.tags.some(tag => tag.toLowerCase() === wanted)) return false;
	}
	return true;
}

export function annotationRow(annotation: Annotation): AnnotationRow {
	return {
		key: annotation.key,
		attachmentKey: annotation.attachmentKey,
		type: annotation.type,
		color: annotationColorInfo(annotation.color),
		page: annotation.page,
		pageLabel: annotation.pageLabel,
		text: annotation.text,
		comment: annotation.comment,
		tags: [...annotation.tags],
		uri: annotation.uri,
		...(annotation.sortIndex ? { sortIndex: annotation.sortIndex } : {}),
		dateModified: annotation.dateModified,
		...(annotation.imagePath ? { image: { cachePath: annotation.imagePath, private: true as const, vaultCopies: [] } } : {}),
	};
}

export interface SelectedAnnotations {
	attachments: AttachmentRows[];
	/** Every annotation of the item, whatever the filters. */
	total: number;
	/** Annotations that passed the filters. */
	matched: number;
	byType: Record<string, number>;
	byColor: Record<string, number>;
	/** The attachment filter names no attachment of the item. */
	unknownAttachment: boolean;
}

/**
 * The item's annotations in Zotero's reading order (attachments as listed, annotations by sort index), grouped by
 * attachment, with the filters applied. Attachments with no matching annotation are left out.
 */
export function selectAnnotations(entry: ZoteroIndexEntry, filters: AnnotationFilters): SelectedAnnotations {
	const total = entry.attachments.reduce((sum, attachment) => sum + attachment.annotations.length, 0);
	const unknownAttachment = filters.attachment !== undefined && !entry.attachments.some(attachment => attachment.key === filters.attachment);
	const byType: Record<string, number> = {};
	const byColor: Record<string, number> = {};
	const rowsByAttachment = new Map<string, AnnotationRow[]>();
	let matched = 0;
	for (const { attachment, annotation } of readingOrder(entry)) {
		if (filters.attachment && attachment.key !== filters.attachment) continue;
		if (!matchesFilters(annotation, filters)) continue;
		const row = annotationRow(annotation);
		matched++;
		byType[row.type || "unknown"] = (byType[row.type || "unknown"] ?? 0) + 1;
		byColor[row.color.name ?? "unknown"] = (byColor[row.color.name ?? "unknown"] ?? 0) + 1;
		const rows = rowsByAttachment.get(attachment.key);
		if (rows) rows.push(row); else rowsByAttachment.set(attachment.key, [row]);
	}
	const attachments: AttachmentRows[] = [];
	for (const attachment of entry.attachments) {
		const annotations = rowsByAttachment.get(attachment.key);
		if (!annotations) continue;
		attachments.push({ key: attachment.key, title: attachment.title, openURI: attachment.openURI, ...(attachment.contentType ? { contentType: attachment.contentType } : {}), annotationCount: attachment.annotations.length, annotations });
	}
	return { attachments, total, matched, byType, byColor, unknownAttachment };
}

// Vault copies of image annotations: the literature import names them
// `<imageFolder>/<libraryType>-<library>-<attachmentKey>-<annotationKey>-<sha256>.<ext>` (see note-writer).
const COPY_TAIL = /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp)$/i;

/** The file name prefix of an annotation's vault copies, or null when the item has no usable library identity. */
export function imageCopyPrefix(entry: Pick<ZoteroIndexEntry, "libraryType" | "libraryID" | "groupID">, attachmentKey: string, annotationKey: string): string | null {
	const library = entry.libraryType === "group" ? entry.groupID : entry.libraryID;
	if (library === undefined || !Number.isSafeInteger(library) || library < 0) return null;
	return `${entry.libraryType}-${library}-${attachmentKey}-${annotationKey}-`;
}

/** Vault-relative paths of the copies the import made for one annotation, in name order (several when its image changed). */
export function vaultImageCopies(entry: Pick<ZoteroIndexEntry, "libraryType" | "libraryID" | "groupID">, row: Pick<AnnotationRow, "key" | "attachmentKey">, folder: string, names: readonly string[]): string[] {
	const prefix = imageCopyPrefix(entry, row.attachmentKey, row.key);
	if (prefix === null) return [];
	const base = folder.replace(/\/+$/, "");
	return names.filter(name => name.startsWith(prefix) && COPY_TAIL.test(name.slice(prefix.length))).sort().map(name => `${base}/${name}`);
}

/** True when any selected annotation is an image (so the image folder is worth listing). */
export function hasImages(selected: SelectedAnnotations): boolean {
	return selected.attachments.some(attachment => attachment.annotations.some(row => row.image));
}

/** Attaches `vaultCopies` to every image row from the file names found in the image folder. */
export function attachVaultCopies(entry: Pick<ZoteroIndexEntry, "libraryType" | "libraryID" | "groupID">, selected: SelectedAnnotations, folder: string, names: readonly string[]): void {
	for (const attachment of selected.attachments) {
		for (const row of attachment.annotations) if (row.image) row.image.vaultCopies = vaultImageCopies(entry, row, folder, names);
	}
}

/** One paper Zotero opened on the requested day, as `annotations --today` lists it when several qualify. */
export interface ReadCandidate {
	citekey: string;
	itemKey: string;
	libraryType: "user" | "group";
	groupID?: number;
	library: string;
	title: string;
	year: string;
	authors: string[];
	readOn: string | null;
	/** `libraryID:itemKey` when the saved index knows the paper, else null. */
	id: string | null;
	inIndex: boolean;
}

export function readCandidates(reads: readonly RecentRead[], entries: readonly ZoteroIndexEntry[]): ReadCandidate[] {
	return reads.map(read => {
		const entry = indexEntryFor(read, entries);
		return {
			citekey: read.citekey, itemKey: read.itemKey, libraryType: read.libraryType, ...(read.groupID !== undefined ? { groupID: read.groupID } : {}),
			library: read.library, title: read.title, year: read.year, authors: read.authors, readOn: read.readOn, id: entry?.id ?? null, inIndex: entry !== null,
		};
	});
}
