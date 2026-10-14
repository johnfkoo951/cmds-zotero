import type { ZoteroIndexEntry } from "../types";
import { scanCitations } from "./scan";
import { formatIndexAge } from "../index-service";
import { indexDerived } from "../index-derived";
import type { BibliographyDetail } from "../bibliography-store"; // 0.5 R12

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
export function resolveReferenceRows(text: string, entries: readonly ZoteroIndexEntry[], loaded: boolean): ReferenceRow[] {
	// 0.6 PERF-05: the citekey map (current keys and history) is built once per index generation, not on every render.
	const derived = indexDerived(entries);
	const rows: ReferenceRow[] = [];
	const seen = new Set<string>();
	for (const occurrence of scanCitations(text)) {
		if (seen.has(occurrence.citekey)) continue;
		seen.add(occurrence.citekey);
		const matches = derived.entriesWithCitekey(occurrence.citekey);
		if (matches.length === 1) rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: "resolved", entry: matches[0] });
		else if (matches.length > 1) rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: "ambiguous", candidates: [...matches] });
		else rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: loaded ? "not-found" : "unchecked" });
	}
	return rows;
}

/**
 * The entries the resolved rows name, each once, in row order: two rows (a current and a previous citekey) can resolve to
 * one entry. 0.6 STRUCT-02: shared by the References sidebar and the active-note exports, one Set lookup per row.
 */
export function resolvedEntries(rows: readonly ReferenceRow[]): ZoteroIndexEntry[] {
	const seen = new Set<string>();
	const entries: ZoteroIndexEntry[] = [];
	for (const row of rows) {
		if (row.status !== "resolved" || !row.entry || seen.has(row.entry.id)) continue;
		seen.add(row.entry.id);
		entries.push(row.entry);
	}
	return entries;
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

// 0.5 R12: offline bibliography — where a row's text came from, and the copy Notice that says so.

/** Short row tag for a text that did not come from a live BBT call; null for live text. */
export function bibliographySourceTag(detail: Pick<BibliographyDetail, "source" | "renderedAt">): string | null {
	if (detail.source === "cached") {
		const day = detail.renderedAt && Number.isFinite(Date.parse(detail.renderedAt)) ? ` ${detail.renderedAt.slice(0, 10)}` : "";
		return `cached${day}`;
	}
	if (detail.source === "fallback") return "offline: author-year fallback";
	return null;
}

/** Author-year line used when no bibliography text is available (also the row text before BBT answers). */
export function fallbackCitation(entry: Pick<ZoteroIndexEntry, "authors" | "year" | "title">): string {
	return `${entry.authors.slice(0, 3).join(", ")}${entry.authors.length > 3 ? " et al." : ""} (${entry.year || "n.d."}). ${entry.title}`;
}

export interface BibliographySourceCounts { live: number; cached: number; fallback: number }

export function countBibliographySources(details: Pick<BibliographyDetail, "source">[]): BibliographySourceCounts {
	const counts: BibliographySourceCounts = { live: 0, cached: 0, fallback: 0 };
	for (const detail of details) counts[detail.source] += 1;
	return counts;
}

/** `Copied 3 entries.` / `Copied 3 entries (2 from cache, 1 fallback; Zotero offline).` */
export function copyBibliographyNotice(counts: BibliographySourceCounts): string {
	const total = counts.live + counts.cached + counts.fallback;
	const label = `Copied ${total} entr${total === 1 ? "y" : "ies"}`;
	if (!counts.cached && !counts.fallback) return `${label}.`;
	const parts = [counts.cached ? `${counts.cached} from cache` : "", counts.fallback ? `${counts.fallback} fallback` : ""].filter(Boolean).join(", ");
	return `${label} (${parts}; Zotero offline).`;
}
