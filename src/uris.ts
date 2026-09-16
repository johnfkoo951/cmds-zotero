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

export function noteDeepLink(vault: string, entry: ItemIdentity, target: "note" | "pdf" | "import" = "note", page?: number, annotationKey?: string): string {
	identityKey(entry);
	if (!vault.trim()) throw new Error("Vault name is required");
	if (page !== undefined && !positiveInteger(page)) throw new Error("Invalid PDF page");
	if (annotationKey !== undefined && !ITEM_KEY.test(annotationKey)) throw new Error("Invalid annotation key");
	const params = new URLSearchParams({ vault, libraryID: String(entry.libraryID), itemKey: entry.itemKey, target });
	if (page !== undefined) params.set("page", String(page));
	if (annotationKey !== undefined) params.set("annotation", annotationKey);
	return `obsidian://cmds-zotero?${params.toString()}`;
}

export interface MarkdownLinkOptions {
	/**
	 * `[title](url)` without angle brackets, for Hookmark's "Hook to Copied Link" and other clients that split on `](`.
	 * Whitespace, `(`, `)`, `<` and `>` in the URL are percent-encoded instead. Notes and sidebars keep the default bracketed form.
	 */
	bare?: boolean;
}

export function markdownLink(title: string, url: string, options: MarkdownLinkOptions = {}): string {
	const text = title.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ");
	const stripped = url.replace(/[\r\n]/g, "");
	if (options.bare) return `[${text}](${stripped.replace(/[\s()<>]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`;
	return `[${text}](<${stripped.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`;
}

// 0.5 R15 — canonical Obsidian addresses and link classification.

/**
 * The address Obsidian's own "Copy Obsidian URL" produces for a note: `obsidian://open?vault=<vault>&file=<path without .md>`.
 * Both values are percent-encoded with `encodeURIComponent` (spaces become `%20`, never `+`; `/` becomes `%2F`).
 * Hookmark records the same `obsidian://open?vault=&file=` form for notes; whether its path encoding matches byte-for-byte
 * has not been checked against a live "Hook to Copied Link" round-trip (see README, Hookmark).
 */
export function obsidianOpenURI(vault: string, path: string): string {
	if (!vault.trim()) throw new Error("Vault name is required");
	const file = path.replace(/^\/+/, "").replace(/\.md$/i, "");
	if (!file.trim()) throw new Error("Note path is required");
	return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

/** `obsidian://advanced-uri?vault=<vault>&filepath=<relative .md>` for vaults that list the Advanced URI plugin. */
export function advancedURI(vault: string, path: string): string {
	if (!vault.trim()) throw new Error("Vault name is required");
	const file = path.replace(/^\/+/, "");
	if (!file.trim()) throw new Error("Note path is required");
	return `obsidian://advanced-uri?vault=${encodeURIComponent(vault)}&filepath=${encodeURIComponent(file)}`;
}

/** Link for a note in a peer vault: the Advanced URI form when that vault has the plugin, else the native open form. */
export function peerNoteURI(vault: string, path: string, options: { advancedUri: boolean }): string {
	return options.advancedUri ? advancedURI(vault, path) : obsidianOpenURI(vault, path);
}

export const ADVANCED_URI_PLUGIN_ID = "obsidian-advanced-uri";

/** True when a parsed `.obsidian/community-plugins.json` lists the Advanced URI plugin. */
export function listsAdvancedUri(communityPlugins: unknown): boolean {
	return Array.isArray(communityPlugins) && communityPlugins.includes(ADVANCED_URI_PLUGIN_ID);
}

/**
 * Sort rank for note rows shown to a person: paper hubs and `@citekey` literature notes first, everything else after.
 * A hub is a note named like its own folder (`…/park2021adaptive/park2021adaptive.md`) or carrying a "hub" marker in its name.
 */
export function noteRowRank(path: string, citekeys: readonly string[] = []): 0 | 1 {
	const parts = path.replace(/\.md$/i, "").split("/");
	const basename = parts[parts.length - 1] ?? "";
	const folder = parts.length > 1 ? parts[parts.length - 2] : "";
	if (basename.startsWith("@")) return 0;
	if (folder && basename.localeCompare(folder, undefined, { sensitivity: "accent" }) === 0) return 0;
	if (/(^|[\s_-])(hub|s00)([\s_-]|$)/i.test(basename)) return 0;
	if (citekeys.some(key => key && basename.localeCompare(key, undefined, { sensitivity: "accent" }) === 0)) return 0;
	return 1;
}

/** Stable comparator: rank first, then path, so the first row of a paper is its hub or literature note. */
export function compareNoteRows(a: { path: string }, b: { path: string }, citekeys: readonly string[] = []): number {
	return noteRowRank(a.path, citekeys) - noteRowRank(b.path, citekeys) || a.path.localeCompare(b.path);
}
