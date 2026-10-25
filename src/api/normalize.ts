import type { Annotation, Attachment, ItemIdentity, ReaderAnnotation, ZoteroIndexEntry } from "../types";
import { entryHash, record } from "../identity";
import { identityKey, ITEM_KEY, parseZoteroURI, pdfURI, positiveInteger, selectURI } from "../uris";

export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function tags(value: unknown): string[] {
	return Array.isArray(value) ? value.flatMap(tag => typeof tag === "string" ? [tag] : record(tag) && typeof tag.tag === "string" ? [tag.tag] : []) : [];
}

export function parseItemURI(uri: string): Omit<ItemIdentity, "libraryID"> {
	const itemKey = /\/items\/([A-Z0-9]{8})$/.exec(uri)?.[1];
	if (!itemKey) throw new Error("Invalid Zotero item URI");
	const group = /^https?:\/\/(?:www\.)?zotero\.org\/groups\/([1-9]\d*)\/items\/([A-Z0-9]{8})$/.exec(uri);
	const user = /^https?:\/\/(?:www\.)?zotero\.org\/users\/(?:local\/[A-Za-z0-9]+|[1-9]\d*)\/items\/([A-Z0-9]{8})$/.exec(uri);
	if (group && positiveInteger(Number(group[1]))) return { libraryType: "group", groupID: Number(group[1]), itemKey };
	if (user) return { libraryType: "user", itemKey };
	throw new Error("Export has no verifiable library URI");
}

export function normalizeIdentity(raw: Record<string, unknown>): ItemIdentity {
	if (!positiveInteger(raw.libraryID) || typeof raw.itemKey !== "string" || !ITEM_KEY.test(raw.itemKey)) throw new Error("Export is missing canonical itemKey/libraryID");
	const scope = parseItemURI(text(raw.uri));
	if (scope.itemKey !== raw.itemKey) throw new Error("Export item URI mismatch");
	return { ...scope, libraryID: raw.libraryID };
}

/**
 * The normalized parent with an empty `contentHash`, for collectors that add attachments next and hash the entry once
 * after that last change (`sealEntry`).
 */
export function normalizeEntryUnhashed(raw: Record<string, unknown>, previous?: ZoteroIndexEntry): ZoteroIndexEntry {
	const identity = normalizeIdentity(raw);
	const citekey = text(raw.citationKey);
	if (!citekey.trim() || !text(raw.itemType) || ["attachment", "annotation", "note"].includes(text(raw.itemType))) throw new Error("Export is not a citable parent");
	const authors = Array.isArray(raw.creators) ? raw.creators.filter(record).map(creator => text(creator.name) || [text(creator.firstName), text(creator.lastName)].filter(Boolean).join(" ")).filter(Boolean) : [];
	const history = previous?.id === identityKey(identity) ? [...new Set([...previous.citekeyHistory, previous.citekey].filter(key => key !== citekey))] : [];
	return { ...identity, id: identityKey(identity), citekey, citekeyHistory: history, title: text(raw.title), authors, year: /\b\d{4}\b/.exec(text(raw.date))?.[0] ?? "", doi: text(raw.DOI), url: text(raw.url), collections: tags(raw.collections), tags: tags(raw.tags), attachmentPath: "", zoteroSelectURI: selectURI(identity), attachments: [], attachmentStatus: "complete", contentHash: "", metadata: raw };
}

/** The normalized parent without attachments, hashed. */
export function normalizeEntry(raw: Record<string, unknown>, previous?: ZoteroIndexEntry): ZoteroIndexEntry {
	const entry = normalizeEntryUnhashed(raw, previous);
	entry.contentHash = entryHash(entry);
	return entry;
}

/**
 * What kind of file an attachment is (0.6 attachment-content-type), from the strongest evidence available: the MIME type
 * Better BibTeX reported, then the file extension of the path or file name, then the annotations (PDF annotations carry a
 * page index; EPUB ones a `FragmentSelector`, snapshot ones a `CssSelector`). `unknown` when nothing tells (a web link or
 * a missing file without a type). Pure.
 */
export type AttachmentFormat = "pdf" | "epub" | "snapshot" | "file" | "unknown";

const FORMAT_BY_TYPE: Readonly<Record<string, AttachmentFormat>> = { "application/pdf": "pdf", "application/epub+zip": "epub", "text/html": "snapshot", "application/xhtml+xml": "snapshot" };
const FORMAT_BY_EXTENSION: Readonly<Record<string, AttachmentFormat>> = { pdf: "pdf", epub: "epub", html: "snapshot", htm: "snapshot", xhtml: "snapshot" };

export function attachmentFormat(attachment: Pick<Attachment, "path"> & Partial<Pick<Attachment, "contentType" | "filename" | "annotations" | "readerAnnotations">>): AttachmentFormat {
	const type = (attachment.contentType ?? "").split(";")[0].trim().toLowerCase();
	if (type) return FORMAT_BY_TYPE[type] ?? "file";
	for (const name of [attachment.path, attachment.filename]) {
		const extension = /\.([A-Za-z0-9]{1,8})$/.exec(typeof name === "string" ? name.trim() : "")?.[1]?.toLowerCase();
		if (extension) return Object.prototype.hasOwnProperty.call(FORMAT_BY_EXTENSION, extension) ? FORMAT_BY_EXTENSION[extension] : "file";
	}
	if (attachment.annotations?.length) return "pdf";
	const selectors = new Set((attachment.readerAnnotations ?? []).map(annotation => annotation.position.type));
	if (selectors.has("FragmentSelector")) return "epub";
	if (selectors.has("CssSelector")) return "snapshot";
	return "unknown";
}

const FORMAT_LABELS: Readonly<Record<AttachmentFormat, string>> = { pdf: "PDF", epub: "EPUB", snapshot: "Snapshot", file: "File", unknown: "Attachment" };

/** Short label for pickers and sidebars: `PDF`, `EPUB`, `Snapshot`, `File` or `Attachment`. */
export function attachmentFormatLabel(format: AttachmentFormat): string { return FORMAT_LABELS[format]; }

export function isPdfAttachment(attachment: Parameters<typeof attachmentFormat>[0]): boolean { return attachmentFormat(attachment) === "pdf"; }

/**
 * The entry's PDF path: the first attachment whose path ends in `.pdf` (the 0.5 rule, so existing indexes keep their
 * value), else the first PDF by MIME type that has a path; "" when there is none.
 */
export function primaryPdfPath(attachments: readonly Attachment[]): string {
	return attachments.find(attachment => attachment.path?.toLowerCase().endsWith(".pdf"))?.path
		?? attachments.find(attachment => attachment.path && isPdfAttachment(attachment))?.path
		?? "";
}

/** `zotero://select/…/items/<attachmentKey>` in the entry's library: selects the attachment in Zotero's item list. */
export function attachmentSelectURI(entry: Pick<ItemIdentity, "libraryType" | "groupID">, attachmentKey: string): string {
	if (!ITEM_KEY.test(attachmentKey)) throw new Error("Invalid attachment key");
	if (entry.libraryType === "group" && !positiveInteger(entry.groupID)) throw new Error("Missing verified group ID");
	return `zotero://select/${entry.libraryType === "group" ? `groups/${entry.groupID}` : "library"}/items/${attachmentKey}`;
}

/** Largest serialized EPUB/snapshot position kept in the index (a CFI or CSS selector is far smaller). */
const MAX_READER_POSITION = 16 * 1024;

/** Fields every Zotero annotation shares, PDF or not. */
function annotationFields(raw: Record<string, unknown>, attachment: Attachment): Omit<Annotation, "page" | "uri"> {
	const key = text(raw.key);
	if (!ITEM_KEY.test(key)) throw new Error("Invalid annotation key");
	if (raw.parentItem !== undefined && raw.parentItem !== attachment.key) throw new Error("Annotation parent identity mismatch");
	const version = raw.version === undefined ? 0 : raw.version;
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw new Error("Invalid annotation version");
	const imagePath = raw.annotationImagePath ?? raw.image;
	return { key, attachmentKey: attachment.key, type: text(raw.annotationType ?? raw.type), text: text(raw.annotationText ?? raw.text), comment: text(raw.annotationComment ?? raw.comment), color: text(raw.annotationColor ?? raw.color), pageLabel: text(raw.annotationPageLabel ?? raw.pageLabel), version, ...(typeof imagePath === "string" && imagePath ? { imagePath } : {}), tags: tags(raw.tags), dateModified: text(raw.dateModified), ...(/^[0-9|]{1,64}$/.test(text(raw.annotationSortIndex)) ? { sortIndex: text(raw.annotationSortIndex) } : {}) };
}

function annotationPosition(raw: Record<string, unknown>): unknown {
	const position: unknown = raw.annotationPosition ?? raw.position;
	return typeof position === "string" ? JSON.parse(position) as unknown : position;
}

function hasPageIndex(position: unknown): position is { pageIndex: number } {
	return record(position) && typeof position.pageIndex === "number" && Number.isSafeInteger(position.pageIndex) && position.pageIndex >= 0;
}

function normalizeAnnotation(raw: Record<string, unknown>, attachment: Attachment, position = annotationPosition(raw)): Annotation {
	if (!hasPageIndex(position)) throw new Error("Invalid annotation position");
	const fields = annotationFields(raw, attachment);
	const page = position.pageIndex + 1;
	const { key, attachmentKey, type, text: body, comment, color, pageLabel, version, imagePath, tags: labels, dateModified, sortIndex } = fields;
	// Field order is the 0.5 order: the stored bytes (and so every content hash) of PDF annotations stay the same.
	return { key, attachmentKey, type, text: body, comment, color, page, pageLabel, version, uri: pdfURI(attachment.openURI, page, key), ...(imagePath ? { imagePath } : {}), tags: labels, dateModified, ...(sortIndex ? { sortIndex } : {}) };
}

/**
 * An EPUB (`FragmentSelector`) or snapshot (`CssSelector`) annotation: no page, its position kept as Zotero reports it,
 * linked by selecting the attachment in Zotero (0.6 epub-snapshot-annotations).
 */
function normalizeReaderAnnotation(raw: Record<string, unknown>, position: Record<string, unknown>, attachment: Attachment, entry: ZoteroIndexEntry): ReaderAnnotation {
	if (typeof position.type !== "string" || !position.type || JSON.stringify(position).length > MAX_READER_POSITION) throw new Error("Invalid annotation position");
	return { ...annotationFields(raw, attachment), uri: attachmentSelectURI(entry, attachment.key), position };
}

export function normalizeAttachments(raw: unknown, entry: ZoteroIndexEntry): Attachment[] {
	if (!Array.isArray(raw)) throw new Error("Expected BBT attachment array");
	const exportedByKey = new Map<string, Record<string, unknown>>();
	if (Array.isArray(entry.metadata.attachments)) {
		for (const item of entry.metadata.attachments) {
			if (!record(item)) continue;
			try {
				const identity = typeof item.select === "string" ? parseZoteroURI(item.select) : parseItemURI(text(item.uri));
				if (identity.libraryType === entry.libraryType && identity.groupID === entry.groupID && !exportedByKey.has(identity.itemKey)) {
					exportedByKey.set(identity.itemKey, item);
				}
			} catch { /* ignore malformed metadata attachment rows */ }
		}
	}
	return raw.map(value => {
		if (!record(value) || typeof value.open !== "string" || !(value.path === false || value.path === null || value.path === undefined || typeof value.path === "string")) throw new Error("Malformed BBT attachment");
		const uri = parseZoteroURI(value.open);
		if (uri.action !== "open-pdf" || uri.libraryType !== entry.libraryType || uri.groupID !== entry.groupID || uri.itemKey === entry.itemKey) throw new Error("Attachment URI identity mismatch");
		const exported = exportedByKey.get(uri.itemKey);
		if (!exported) throw new Error("Attachment does not match the exported parent's attachment identities; refresh again.");
		const attachment: Attachment = { key: uri.itemKey, openURI: value.open, path: typeof value.path === "string" ? value.path : null, title: text(exported.title), annotations: [] };
		// BBT JSON keeps `mimeType` for attachments (its `contentType` is dropped by the BBT JSON field filter).
		const contentType = text(exported.contentType) || text(exported.mimeType) || text(value.contentType) || text(value.mimeType);
		const filename = text(exported.filename) || (typeof exported.path === "string" ? exported.path.split(/[\\/]/).pop() ?? "" : "");
		if (contentType) attachment.contentType = contentType;
		if (filename) attachment.filename = filename;
		if (value.annotations !== undefined && !Array.isArray(value.annotations)) throw new Error("Invalid annotations array");
		const readerAnnotations: ReaderAnnotation[] = [];
		// A page index makes a PDF annotation; a selector position on an attachment that is not known to be a PDF makes an
		// EPUB or snapshot annotation. Anything else (a PDF annotation without a valid page) still fails the attachment set.
		const pdf = isPdfAttachment(attachment);
		for (const annotation of Array.isArray(value.annotations) ? value.annotations : []) {
			if (!record(annotation)) throw new Error("Invalid annotation");
			const position = annotationPosition(annotation);
			if (!pdf && !hasPageIndex(position) && record(position)) readerAnnotations.push(normalizeReaderAnnotation(annotation, position, attachment, entry));
			else attachment.annotations.push(normalizeAnnotation(annotation, attachment, position));
		}
		if (readerAnnotations.length) attachment.readerAnnotations = readerAnnotations;
		return attachment;
	});
}
