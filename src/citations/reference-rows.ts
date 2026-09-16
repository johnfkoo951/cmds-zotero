import type { ZoteroIndexEntry } from "../types";
import { scanCitations } from "./scan";
import { formatIndexAge } from "../index-service";

/** `unchecked`: no index snapshot is loaded, so the row makes no claim about the citekey. */
export type ReferenceStatus = "resolved" | "ambiguous" | "not-found" | "unchecked";

export interface ReferenceRow {
	citekey: string;
	line: number;
	status: ReferenceStatus;
	entry?: ZoteroIndexEntry;
	candidates?: ZoteroIndexEntry[];
}

/** What the UI knows about the published snapshot: `loaded` is true even for a validated snapshot with zero entries. */
export interface SnapshotState { loaded: boolean; stale: boolean; ageMinutes: number | null }

/**
 * Resolves every distinct citekey in `text` against the published entries (current citekeys and history). Without a
 * loaded snapshot every row is `unchecked`; a negative (`not-found`) is only ever claimed against a loaded snapshot.
 */
export function resolveReferenceRows(text: string, entries: ZoteroIndexEntry[], loaded: boolean): ReferenceRow[] {
	const byKey = new Map<string, ZoteroIndexEntry[]>();
	for (const entry of entries) for (const alias of new Set([entry.citekey, ...entry.citekeyHistory])) (byKey.get(alias) ?? byKey.set(alias, []).get(alias))?.push(entry);
	const rows: ReferenceRow[] = [];
	const seen = new Set<string>();
	for (const occurrence of scanCitations(text)) {
		if (seen.has(occurrence.citekey)) continue;
		seen.add(occurrence.citekey);
		const matches = byKey.get(occurrence.citekey) ?? [];
		if (matches.length === 1) rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: "resolved", entry: matches[0] });
		else if (matches.length > 1) rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: "ambiguous", candidates: matches });
		else rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: loaded ? "not-found" : "unchecked" });
	}
	return rows;
}

/** Header count, with "index not loaded" when no snapshot is published and the snapshot age when it is stale. */
export function referenceHeader(count: number, state: SnapshotState): string {
	const label = `${count} reference${count === 1 ? "" : "s"}`;
	if (!state.loaded) return `${label} · index not loaded`;
	if (state.stale) return `${label} · index ${formatIndexAge(state.ageMinutes)} old`;
	return label;
}

/** Row text for the non-resolved statuses; a `resolved` row renders its bibliography instead. */
export function referenceRowText(row: ReferenceRow, state: SnapshotState): string {
	if (row.status === "ambiguous") return `@${row.citekey} matches ${row.candidates?.length ?? 0} items across libraries. Change the citekey in Zotero or narrow the library.`;
	if (row.status === "unchecked") return `@${row.citekey} — index not loaded; refresh to check`;
	if (row.status === "not-found" && state.stale) return `@${row.citekey} is not in the saved index (${formatIndexAge(state.ageMinutes)} old); refresh to confirm.`;
	if (row.status === "not-found") return `@${row.citekey} is not in the literature index. Refresh the index or check the key.`;
	return `@${row.citekey}`;
}
