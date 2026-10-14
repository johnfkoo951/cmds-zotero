/**
 * The data an annotation card carries while it is dragged (0.6.1 annotation-drag-insert). `text/plain` is the callout,
 * so a plain drop works in any editor or app; the custom type names the annotation by identity so the plugin's editor
 * drop handler can copy an image first. Foreign or malformed payloads are ignored. Pure: no `obsidian` import.
 */
import type { Annotation, Attachment, ZoteroIndexEntry } from "../types";
import { ITEM_KEY, positiveInteger } from "../uris";

export const ANNOTATION_DRAG_TYPE = "application/x-cmds-zotero-annotation";
const VERSION = 1;
/** A payload larger than this is not ours. */
const MAX_PAYLOAD = 512;

export interface AnnotationDragPayload { libraryID: number; itemKey: string; attachmentKey: string; key: string }

export function dragPayload(entry: Pick<ZoteroIndexEntry, "libraryID" | "itemKey">, attachmentKey: string, annotationKey: string): AnnotationDragPayload {
	return { libraryID: entry.libraryID, itemKey: entry.itemKey, attachmentKey, key: annotationKey };
}

export function encodeDragPayload(payload: AnnotationDragPayload): string {
	return JSON.stringify({ v: VERSION, id: `${payload.libraryID}:${payload.itemKey}`, attachmentKey: payload.attachmentKey, key: payload.key });
}

/** The payload a drop carries, or null for anything this plugin did not write (wrong version, shape or keys). */
export function parseDragPayload(raw: string | null | undefined): AnnotationDragPayload | null {
	if (!raw || raw.length > MAX_PAYLOAD) return null;
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return null; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const data = parsed as Record<string, unknown>;
	if (data.v !== VERSION || typeof data.id !== "string" || typeof data.attachmentKey !== "string" || typeof data.key !== "string") return null;
	const match = /^(\d+):([A-Z0-9]{8})$/.exec(data.id);
	const libraryID = match ? Number(match[1]) : Number.NaN;
	if (!match || !positiveInteger(libraryID) || !ITEM_KEY.test(data.attachmentKey) || !ITEM_KEY.test(data.key)) return null;
	return { libraryID, itemKey: match[2], attachmentKey: data.attachmentKey, key: data.key };
}

export interface DraggedAnnotation { entry: ZoteroIndexEntry; attachment: Attachment; annotation: Annotation }

/**
 * The annotation a payload names, looked up by identity in `candidates` in order (the sidebar's shown entry first, so a
 * freshly fetched annotation is found, then the index). Null when no candidate has exactly that item, attachment and annotation.
 */
export function resolveDragPayload(candidates: readonly (ZoteroIndexEntry | null | undefined)[], payload: AnnotationDragPayload): DraggedAnnotation | null {
	for (const entry of candidates) {
		if (!entry || entry.libraryID !== payload.libraryID || entry.itemKey !== payload.itemKey) continue;
		const attachment = entry.attachments.find(item => item.key === payload.attachmentKey);
		const annotation = attachment?.annotations.find(item => item.key === payload.key && item.attachmentKey === payload.attachmentKey);
		if (attachment && annotation) return { entry, attachment, annotation };
	}
	return null;
}

/**
 * The text a drop inserts at `column` of a line: a callout must start its own line and end with a line break, so a drop
 * inside a line breaks it first.
 */
export function dropText(text: string, column: number): string {
	return `${column > 0 ? "\n" : ""}${text.replace(/\n+$/, "")}\n`;
}
