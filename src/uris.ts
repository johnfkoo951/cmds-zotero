import type { ItemIdentity } from "./types";

export const ITEM_KEY = /^[A-Z0-9]{8}$/;

export interface ParsedZoteroURI {
	action: "select" | "open-pdf";
	libraryType: "user" | "group";
	groupID?: number;
	itemKey: string;
	page?: number;
	annotationKey?: string;
}

export function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function identityKey(identity: ItemIdentity): string {
	if (!positiveInteger(identity.libraryID) || typeof identity.itemKey !== "string" || !ITEM_KEY.test(identity.itemKey)) throw new Error("Invalid item identity");
	if (identity.libraryType === "group") {
		if (!positiveInteger(identity.groupID)) throw new Error("Missing verified group ID");
	} else if (identity.libraryType !== "user" || identity.groupID !== undefined) throw new Error("Invalid library identity");
	return `${identity.libraryID}:${identity.itemKey}`;
}

export function selectURI(identity: ItemIdentity): string {
	identityKey(identity);
	const scope = identity.libraryType === "group" ? `groups/${identity.groupID}` : "library";
	return `zotero://select/${scope}/items/${identity.itemKey}`;
}

export function parseZoteroURI(uri: string): ParsedZoteroURI {
	const match = /^zotero:\/\/(select|open-pdf)\/(library|groups\/([1-9]\d*))\/items\/([A-Z0-9]{8})(?:\?([^#]*))?$/.exec(uri);
	if (!match) throw new Error("Invalid Zotero URI");
	const groupID = match[3] ? Number(match[3]) : undefined;
	if (groupID !== undefined && !positiveInteger(groupID)) throw new Error("Invalid group ID");
	const result: ParsedZoteroURI = { action: match[1] as ParsedZoteroURI["action"], libraryType: groupID ? "group" : "user", itemKey: match[4], ...(groupID ? { groupID } : {}) };
	const params = new URLSearchParams(match[5] ?? "");
	for (const key of params.keys()) {
		if (!["page", "annotation"].includes(key) || params.getAll(key).length !== 1 || result.action !== "open-pdf") throw new Error("Invalid Zotero URI parameters");
	}
	if (params.has("page")) {
		const raw = params.get("page") ?? "";
		if (!/^[1-9]\d*$/.test(raw) || !positiveInteger(Number(raw))) throw new Error("Invalid PDF page");
		result.page = Number(raw);
	}
	if (params.has("annotation")) {
		const key = params.get("annotation") ?? "";
		if (!ITEM_KEY.test(key)) throw new Error("Invalid annotation key");
		result.annotationKey = key;
	}
	return result;
}

export function pdfURI(openURI: string, page?: number, annotationKey?: string): string {
	const parsed = parseZoteroURI(openURI);
	if (parsed.action !== "open-pdf") throw new Error("A parent selection URI cannot open a PDF");
	const params = new URLSearchParams();
	const effectivePage = page ?? parsed.page;
	const effectiveAnnotation = annotationKey ?? parsed.annotationKey;
	if (effectivePage !== undefined) {
		if (!positiveInteger(effectivePage)) throw new Error("Invalid PDF page");
		params.set("page", String(effectivePage));
	}
	if (effectiveAnnotation !== undefined) {
		if (!ITEM_KEY.test(effectiveAnnotation)) throw new Error("Invalid annotation key");
		params.set("annotation", effectiveAnnotation);
	}
	return openURI.split("?")[0] + (params.size ? `?${params.toString()}` : "");
}

export function noteDeepLink(vault: string, entry: ItemIdentity, target: "note" | "pdf" = "note", page?: number, annotationKey?: string): string {
	identityKey(entry);
	if (!vault.trim()) throw new Error("Vault name is required");
	if (page !== undefined && !positiveInteger(page)) throw new Error("Invalid PDF page");
	if (annotationKey !== undefined && !ITEM_KEY.test(annotationKey)) throw new Error("Invalid annotation key");
	const params = new URLSearchParams({ vault, libraryID: String(entry.libraryID), itemKey: entry.itemKey, target });
	if (page !== undefined) params.set("page", String(page));
	if (annotationKey !== undefined) params.set("annotation", annotationKey);
	return `obsidian://cmds-zotero?${params.toString()}`;
}

export function markdownLink(title: string, url: string): string {
	return `[${title.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}](<${url.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/[\r\n]/g, "")}>)`;
}
