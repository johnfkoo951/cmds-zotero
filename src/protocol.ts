import { parseZoteroURI, type ParsedZoteroURI } from "./uris";

export interface ProtocolRequest {
	vault: string;
	libraryID: number;
	itemKey: string;
	target: "note" | "pdf" | "import";
	page?: number;
	annotation?: string;
}

export function parseProtocolRequest(params: Record<string, string>, routedVault?: string): ProtocolRequest {
	// Obsidian consumes the vault parameter while routing and omits it from callbacks.
	const vault = params.vault ?? routedVault;
	if (params.vault && routedVault && params.vault !== routedVault) throw new Error("Link was routed to the wrong vault.");
	const allowed = new Set(["action", "vault", "libraryID", "itemKey", "target", "page", "annotation"]);
	if (Object.keys(params).some(key => !allowed.has(key))) throw new Error("Unsupported link parameter.");
	if (!vault || vault.length > 300 || /[\0\r\n]/.test(vault)) throw new Error("A vault name is required.");
	if (!/^[1-9]\d*$/.test(params.libraryID ?? "")) throw new Error("Invalid library ID.");
	const libraryID = Number(params.libraryID);
	if (!Number.isSafeInteger(libraryID)) throw new Error("Invalid library ID.");
	if (!/^[A-Z0-9]{8}$/.test(params.itemKey ?? "")) throw new Error("Invalid item key.");
	const target = params.target ?? "note";
	if (target === "import" && (params.page !== undefined || params.annotation !== undefined)) throw new Error("Import links do not take page or annotation parameters.");
	if (target !== "note" && target !== "pdf" && target !== "import") throw new Error("This link can only open a note or PDF, or import a note.");
	let page: number | undefined;
	if (params.page !== undefined) {
		if (!/^[1-9]\d*$/.test(params.page) || !Number.isSafeInteger(Number(params.page))) throw new Error("Page must be a positive integer.");
		page = Number(params.page);
	}
	if (params.annotation !== undefined && !/^[A-Z0-9]{8}$/.test(params.annotation)) throw new Error("Invalid annotation key.");
	return { vault, libraryID, itemKey: params.itemKey, target, page, annotation: params.annotation };
}

// 0.5 R15 — link classification for "Open link under cursor".
export type LinkUnderCursor =
	| { kind: "select" | "open-pdf"; uri: string; parsed: ParsedZoteroURI }
	| { kind: "citekey"; citekey: string }
	| { kind: "none" };

const ZOTERO_URI = /zotero:\/\/(?:select|open-pdf)\/[^\s<>()[\]"']+/g;

/**
 * Classifies what sits under the cursor: a `zotero://select` or `zotero://open-pdf` URI (bare, `<…>` or `[t](…)`),
 * a `[@citekey]` / `@citekey` / `[[@citekey]]` citation, or nothing. A non-empty selection is classified as a whole.
 * Malformed Zotero URIs are `none`, never a guess.
 */
export function classifyLink(line: string, column = 0, selection = ""): LinkUnderCursor {
	const text = selection.trim() ? selection.trim() : line;
	const at = selection.trim() ? -1 : column;
	ZOTERO_URI.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ZOTERO_URI.exec(text)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (at !== -1 && (at < start || at > end)) continue;
		try {
			const parsed = parseZoteroURI(match[0]);
			return { kind: parsed.action, uri: match[0], parsed };
		} catch { /* not a valid Zotero URI at this position */ }
	}
	const wikilink = /^\[\[@([^\s\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(selection.trim());
	const citekey = wikilink ? wikilink[1] : citekeyAtCursor(line, column, selection);
	return citekey ? { kind: "citekey", citekey } : { kind: "none" };
}

export function citekeyAtCursor(line: string, column: number, selection = ""): string {
	if (selection.trim()) {
		const trimmed = selection.trim();
		const selected = trimmed.match(/^\[?@([^\s\],;]+)\]?$/);
		return selected ? selected[1] : /^[\w:.+/-]+$/.test(trimmed) ? trimmed : "";
	}
	const pattern = /@([^\s\],;]+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(line)) !== null) {
		if (column >= match.index && column <= match.index + match[0].length) return match[1];
	}
	return "";
}
