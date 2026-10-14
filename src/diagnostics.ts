import type { Diagnostic, IndexLibrary, ZoteroIndexEntry } from "./types";
import type { SkippedItem } from "./index/collect-plan";

export type DiagnosticSeverity = Diagnostic["severity"];

/**
 * Every diagnostic code the plugin and CLI may emit, with its fixed severity (vocabulary §2). The first four are the
 * 0.3.0 codes and stay unchanged; the rest are the 0.4 reconcile-, cites- and environment-derived codes.
 */
export const DIAGNOSTIC_CODES = {
	"provisional-citekey": "warning",
	"attachment-path-missing": "warning",
	"attachments-unavailable": "warning",
	"duplicate-citekey": "warning",
	"citekey-unregistered": "error",
	"citekey-not-pinned": "warning",
	"identity-desync": "warning",
	"provisional-now-registered": "info",
	"attachment-missing-for-hub": "warning",
	"dangling-cite": "error",
	"cite-hub-only": "info",
	"cite-raw-only": "warning",
	"cite-unchecked": "warning",
	"citekey-ambiguous": "error",
	"legacy-plugin-enabled": "error",
	"index-stale": "info",
	"index-in-git": "warning",
	"legacy-frontmatter-dialect": "info", // 0.5 R14
	"reader-annotations": "info", // 0.6 epub-snapshot-annotations
	// 0.6 index-refresh-resilience: items a refresh left out instead of aborting.
	"item-skipped": "warning",
	"missing-citekey": "warning",
	// 0.6 group-library-validation (report-only).
	"library-not-indexed": "warning",
	"library-empty": "info",
	"feed-library": "info",
	"collections-unavailable": "info", // 0.6 collection-membership-index
	// 0.6 retraction-flags-from-zotero.
	"retracted-source": "warning",
	"retraction-check-unavailable": "info",
	// 0.6.1 doctor-report (report-only setup checks; `diagnostics --env` and the Diagnose setup view).
	"zotero-unreachable": "warning",
	"zotero-reading-history-unavailable": "info",
	"index-missing": "warning",
	"pdfjs-unavailable": "warning",
	"peer-map-unreadable": "warning",
	"better-notes-in-output": "warning",
	"foreign-notes-in-output": "info",
	"obsidian-unavailable": "info",
} as const satisfies Record<string, DiagnosticSeverity>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

/** v1 `Diagnostic` plus the additive `path` (vault-relative note path) used by reconcile- and cites-derived codes. */
export interface AgentDiagnostic extends Diagnostic {
	path?: string;
}

export interface DiagnosticExtra {
	itemID?: string;
	citekey?: string;
	path?: string;
}

/** Builds a diagnostic whose severity comes from `DIAGNOSTIC_CODES`; undefined extras are omitted rather than serialized. */
export function diagnostic(code: DiagnosticCode, message: string, extra: DiagnosticExtra = {}): AgentDiagnostic {
	const result: AgentDiagnostic = { code, severity: DIAGNOSTIC_CODES[code], message };
	if (extra.itemID !== undefined) result.itemID = extra.itemID;
	if (extra.citekey !== undefined) result.citekey = extra.citekey;
	if (extra.path !== undefined) result.path = extra.path;
	return result;
}

export function indexDiagnostics(entries: ZoteroIndexEntry[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const citekeys = new Map<string, ZoteroIndexEntry[]>();
	for (const entry of entries) {
		const matches = citekeys.get(entry.citekey) ?? [];
		matches.push(entry);
		citekeys.set(entry.citekey, matches);
		if (entry.attachments.some(attachment => attachment.path === null)) diagnostics.push({ code: "attachment-path-missing", severity: "warning", message: "An attachment has no available local file path; its verified Zotero URI is retained.", itemID: entry.id, citekey: entry.citekey });
		if (entry.attachmentStatus === "unavailable") diagnostics.push({ code: "attachments-unavailable", severity: "warning", message: "Attachment refresh failed; only previously validated attachment data was retained.", itemID: entry.id, citekey: entry.citekey });
		const reader = entry.attachments.reduce((count, attachment) => count + (attachment.readerAnnotations?.length ?? 0), 0);
		if (reader) diagnostics.push(diagnostic("reader-annotations", `${reader} annotation${reader === 1 ? "" : "s"} on EPUB or web-snapshot attachments ${reader === 1 ? "has" : "have"} no PDF page; ${reader === 1 ? "it is" : "they are"} kept in the index as reader annotations.`, { itemID: entry.id, citekey: entry.citekey }));
	}
	for (const [citekey, matches] of citekeys) {
		if (matches.length > 1) diagnostics.push({ code: "duplicate-citekey", severity: "warning", message: `Citation key matches ${matches.length} parent items; explicit identity is required.`, citekey });
	}
	return diagnostics;
}

function libraryLabel(name: string, libraryID?: number): string {
	return name ? `library "${name}"` : libraryID !== undefined ? `library ${libraryID}` : "an unnamed library";
}

const SKIP_TEXT: Readonly<Record<SkippedItem["reason"], string>> = {
	"duplicate-citekey": "Better BibTeX gives its citation key to another item of the same library",
	"missing-citekey": "it has no Better BibTeX citation key yet",
	"invalid-uri": "Better BibTeX gave no verifiable Zotero item URI",
	"library-scope": "its search row belongs to another library",
	"library-name": "the item's library cannot be told apart by name",
	"export-failed": "the Better BibTeX export failed",
	"export-mismatch": "the Better BibTeX export answered with another item",
	"invalid-item": "its metadata cannot be indexed",
};

/**
 * 0.6 index-refresh-resilience: one diagnostic per item a refresh left out, naming why and whether its previous entry was
 * kept (so notes linked to it still resolve). Duplicate keys use `duplicate-citekey`, a missing key `missing-citekey`.
 */
export function skippedItemDiagnostic(item: SkippedItem, kept: boolean): AgentDiagnostic {
	const subject = `${item.itemKey ? `Item ${item.itemKey}` : item.citekey ? `@${item.citekey}` : "An item"} in ${libraryLabel(item.library, item.libraryID)}`;
	const detail = item.detail && !["duplicate-citekey", "missing-citekey"].includes(item.reason) ? ` (${item.detail})` : "";
	const keptText = kept ? "; its previous index entry was kept" : "";
	const extra = { ...(item.libraryID !== undefined && item.itemKey ? { itemID: `${item.libraryID}:${item.itemKey}` } : {}), ...(item.citekey ? { citekey: item.citekey } : {}) };
	if (item.reason === "duplicate-citekey") return diagnostic("duplicate-citekey", `${subject} was left out of this refresh because Better BibTeX gives @${item.citekey ?? ""} to ${item.detail ?? "more than one item"} in that library${keptText}. Give each item its own key in Zotero.`, extra);
	if (item.reason === "missing-citekey") return diagnostic("missing-citekey", `${subject} has no Better BibTeX citation key yet and was left out of this refresh${keptText}.`, extra);
	return diagnostic("item-skipped", `${subject} was left out of this refresh: ${SKIP_TEXT[item.reason]}${detail}${keptText}.`, extra);
}

/** What the collector learned about one listed library (0.6 group-library-validation). */
export interface LibraryReport { library: IndexLibrary; unreadable?: string; keptEntries: number }

/**
 * Report-only library diagnostics: feeds (never indexed), empty libraries, libraries whose search failed (previous entries
 * kept) and libraries whose items were all left out.
 */
export function libraryDiagnostics(reports: readonly LibraryReport[]): AgentDiagnostic[] {
	const diagnostics: AgentDiagnostic[] = [];
	for (const { library, unreadable, keptEntries } of reports) {
		const label = libraryLabel(library.name, library.libraryID);
		const subject = label.charAt(0).toUpperCase() + label.slice(1);
		if (unreadable !== undefined) diagnostics.push(diagnostic("library-not-indexed", `${subject} could not be read (${unreadable}); ${keptEntries ? `its ${keptEntries} previous entr${keptEntries === 1 ? "y was" : "ies were"} kept` : "nothing was indexed from it"}.`));
		else if (library.kind === "feed") diagnostics.push(diagnostic("feed-library", `${subject} is a Zotero feed; feed items are not indexed.`));
		else if (library.items === 0) diagnostics.push(diagnostic("library-empty", `${subject} has no parent items; nothing was indexed from it.`));
		else if (library.indexed === keptEntries) diagnostics.push(diagnostic("library-not-indexed", `${subject} lists ${library.items} item${library.items === 1 ? "" : "s"} but none could be indexed in this refresh; see the item diagnostics.`));
	}
	return diagnostics;
}

/** 0.6 collection-membership-index: membership of one library could not be read; entries keep their previous collections. */
export function collectionsUnavailableDiagnostic(name: string, libraryID: number, detail: string): AgentDiagnostic {
	return diagnostic("collections-unavailable", `Collection membership in ${libraryLabel(name, libraryID)} could not be read (${detail}); its entries keep the collections of the previous refresh.`);
}

/** 0.6 retraction-flags-from-zotero: one warning per entry Zotero marks as retracted. */
export function retractedDiagnostics(ids: readonly string[], entries: readonly ZoteroIndexEntry[]): AgentDiagnostic[] {
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	return ids.flatMap(id => {
		const entry = byId.get(id);
		return entry ? [diagnostic("retracted-source", `Zotero marks @${entry.citekey} as retracted (Retraction Watch data in Zotero); check the source before citing it.`, { itemID: entry.id, citekey: entry.citekey })] : [];
	});
}

export function retractionUnavailableDiagnostic(detail: string): AgentDiagnostic {
	return diagnostic("retraction-check-unavailable", `Zotero's retraction flags could not be read (${detail}); retracted sources are not marked in this index.`);
}
