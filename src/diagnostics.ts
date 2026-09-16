import type { Diagnostic, ZoteroIndexEntry } from "./types";

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
	}
	for (const [citekey, matches] of citekeys) {
		if (matches.length > 1) diagnostics.push({ code: "duplicate-citekey", severity: "warning", message: `Citation key matches ${matches.length} parent items; explicit identity is required.`, citekey });
	}
	return diagnostics;
}
