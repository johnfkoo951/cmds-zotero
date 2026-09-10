import type { Annotation, Attachment, ItemIdentity, ZoteroIndexEntry } from "../types";
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

export function normalizeEntry(raw: Record<string, unknown>, previous?: ZoteroIndexEntry): ZoteroIndexEntry {
	const identity = normalizeIdentity(raw);
	const citekey = text(raw.citationKey);
	if (!citekey.trim() || !text(raw.itemType) || ["attachment", "annotation", "note"].includes(text(raw.itemType))) throw new Error("Export is not a citable parent");
	const authors = Array.isArray(raw.creators) ? raw.creators.filter(record).map(creator => text(creator.name) || [text(creator.firstName), text(creator.lastName)].filter(Boolean).join(" ")).filter(Boolean) : [];
	const history = previous?.id === identityKey(identity) ? [...new Set([...previous.citekeyHistory, previous.citekey].filter(key => key !== citekey))] : [];
	const entry: ZoteroIndexEntry = { ...identity, id: identityKey(identity), citekey, citekeyHistory: history, title: text(raw.title), authors, year: /\b\d{4}\b/.exec(text(raw.date))?.[0] ?? "", doi: text(raw.DOI), url: text(raw.url), collections: tags(raw.collections), tags: tags(raw.tags), attachmentPath: "", zoteroSelectURI: selectURI(identity), attachments: [], attachmentStatus: "complete", contentHash: "", metadata: raw };
	entry.contentHash = entryHash(entry);
	return entry;
}

function normalizeAnnotation(raw: Record<string, unknown>, attachment: Attachment): Annotation {
	const key = text(raw.key);
	if (!ITEM_KEY.test(key)) throw new Error("Invalid annotation key");
	if (raw.parentItem !== undefined && raw.parentItem !== attachment.key) throw new Error("Annotation parent identity mismatch");
	let position: unknown = raw.annotationPosition ?? raw.position;
	if (typeof position === "string") position = JSON.parse(position) as unknown;
	if (!record(position) || typeof position.pageIndex !== "number" || !Number.isSafeInteger(position.pageIndex) || position.pageIndex < 0) throw new Error("Invalid annotation position");
	const page = position.pageIndex + 1;
	const version = raw.version === undefined ? 0 : raw.version;
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw new Error("Invalid annotation version");
	const imagePath = raw.annotationImagePath ?? raw.image;
	return { key, attachmentKey: attachment.key, type: text(raw.annotationType ?? raw.type), text: text(raw.annotationText ?? raw.text), comment: text(raw.annotationComment ?? raw.comment), color: text(raw.annotationColor ?? raw.color), page, pageLabel: text(raw.annotationPageLabel ?? raw.pageLabel), version, uri: pdfURI(attachment.openURI, page, key), ...(typeof imagePath === "string" && imagePath ? { imagePath } : {}), tags: tags(raw.tags), dateModified: text(raw.dateModified) };
}

export function normalizeAttachments(raw: unknown, entry: ZoteroIndexEntry): Attachment[] {
	if (!Array.isArray(raw)) throw new Error("Expected BBT attachment array");
	return raw.map(value => {
		if (!record(value) || typeof value.open !== "string" || !(value.path === false || value.path === null || value.path === undefined || typeof value.path === "string")) throw new Error("Malformed BBT attachment");
		const uri = parseZoteroURI(value.open);
		if (uri.action !== "open-pdf" || uri.libraryType !== entry.libraryType || uri.groupID !== entry.groupID || uri.itemKey === entry.itemKey) throw new Error("Attachment URI identity mismatch");
		const exported = Array.isArray(entry.metadata.attachments) ? entry.metadata.attachments.filter(record).find(item => {
			try {
				const identity = typeof item.select === "string" ? parseZoteroURI(item.select) : parseItemURI(text(item.uri));
				return identity.itemKey === uri.itemKey && identity.libraryType === uri.libraryType && identity.groupID === uri.groupID;
			} catch { return false; }
		}) : undefined;
		if (!exported) throw new Error("Attachment does not match the exported parent's attachment identities; refresh again.");
		const attachment: Attachment = { key: uri.itemKey, openURI: value.open, path: typeof value.path === "string" ? value.path : null, title: text(exported.title), annotations: [] };
		if (value.annotations !== undefined && !Array.isArray(value.annotations)) throw new Error("Invalid annotations array");
		attachment.annotations = (Array.isArray(value.annotations) ? value.annotations : []).map(annotation => {
			if (!record(annotation)) throw new Error("Invalid annotation");
			return normalizeAnnotation(annotation, attachment);
		});
		return attachment;
	});
}
