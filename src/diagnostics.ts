import type { Diagnostic, ZoteroIndexEntry } from "./types";

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
