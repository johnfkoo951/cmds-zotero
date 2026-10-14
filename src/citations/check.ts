/**
 * 0.6.2 check-citations: what the saved index says about every key a note cites (pandoc semantics, `cited-keys.ts`).
 * Reads the snapshot only; a negative (`unknown`) is claimed only against a loaded snapshot, and a stale snapshot says
 * so. Pure: no `obsidian` import.
 */
import type { ZoteroIndexEntry } from "../types";
import { indexDerived } from "../index-derived";
import { formatIndexAge } from "../index-service";
import type { CitedKeySet } from "./cited-keys";
import type { SnapshotState } from "./reference-rows";

/** `ok`: one item carries the key as its current citekey; `renamed`: one item carried it before (former key). */
export type CheckStatus = "ok" | "renamed" | "ambiguous" | "unknown" | "unchecked";

export interface CheckRow {
	citekey: string;
	status: CheckStatus;
	entry?: ZoteroIndexEntry;
	/** The item's current citekey, for a `renamed` row. */
	currentKey?: string;
	candidates?: ZoteroIndexEntry[];
	/** Resolved, but no literature note in this vault carries the item (null: the note map was not available). */
	noNote: boolean | null;
	/** Listed in `nocite` (also or only). */
	nocite: boolean;
	/** Body occurrences (0-based line, column) in text order; empty for a nocite-only key. */
	occurrences: { line: number; column: number }[];
	/** The 0-based frontmatter line of its first `nocite` mention, when there is one. */
	nociteLine?: number;
}

export interface CheckReport {
	rows: CheckRow[];
	nociteAll: boolean;
	counts: Record<CheckStatus, number> & { noNote: number; nocite: number };
	snapshot: SnapshotState;
}

/**
 * One row per distinct cited key. `notesFor` answers how many literature notes carry an entry (null when unknown).
 * Exact current-citekey matches win over former keys, as everywhere else in the plugin.
 */
export function checkCitations(set: CitedKeySet, entries: readonly ZoteroIndexEntry[], snapshot: SnapshotState, notesFor: (entry: ZoteroIndexEntry) => number | null): CheckReport {
	const derived = indexDerived(entries);
	const rows: CheckRow[] = [];
	for (const citekey of set.keys) {
		const occurrences = set.occurrences.filter(item => item.citekey === citekey).map(item => ({ line: item.line, column: item.column }));
		const nociteHit = set.nocite.find(item => item.citekey === citekey);
		const base = { citekey, occurrences, nocite: !!nociteHit, ...(nociteHit ? { nociteLine: nociteHit.line } : {}) };
		const matches = derived.entriesWithCitekey(citekey);
		const exact = matches.filter(entry => entry.citekey === citekey);
		const pool = exact.length ? exact : matches;
		if (pool.length > 1) { rows.push({ ...base, status: "ambiguous", candidates: [...pool], noNote: null }); continue; }
		if (pool.length === 1) {
			const entry = pool[0];
			const notes = notesFor(entry);
			const renamed = entry.citekey !== citekey;
			rows.push({ ...base, status: renamed ? "renamed" : "ok", entry, ...(renamed ? { currentKey: entry.citekey } : {}), noNote: notes === null ? null : notes === 0 });
			continue;
		}
		rows.push({ ...base, status: snapshot.loaded ? "unknown" : "unchecked", noNote: null });
	}
	const counts = { ok: 0, renamed: 0, ambiguous: 0, unknown: 0, unchecked: 0, noNote: 0, nocite: 0 };
	for (const row of rows) {
		counts[row.status] += 1;
		if (row.noNote === true) counts.noNote += 1;
		if (row.nocite) counts.nocite += 1;
	}
	return { rows, nociteAll: set.nociteAll, counts, snapshot };
}

/** The sentence a row shows under its key. */
export function checkRowDetail(row: CheckRow, snapshot: SnapshotState): string {
	const where = row.occurrences.length ? `${row.occurrences.length} occurrence${row.occurrences.length === 1 ? "" : "s"}` : "nocite only";
	const nocite = row.nocite && row.occurrences.length ? "; also in nocite" : "";
	const note = row.noNote === true ? "; no literature note in this vault" : "";
	switch (row.status) {
		case "ok": return `${row.entry?.title ?? ""} · ${where}${nocite}${note}`;
		case "renamed": return `Former citekey: the item is now @${row.currentKey}. Change the citation, or pin the old key in Zotero · ${where}${nocite}${note}`;
		case "ambiguous": return `${row.candidates?.length ?? 0} items carry this citekey in different libraries · ${where}${nocite}`;
		case "unknown": return snapshot.stale
			? `Not in the saved index (${formatIndexAge(snapshot.ageMinutes)} old); refresh to confirm · ${where}${nocite}`
			: `Not in the literature index; check the key or refresh the index · ${where}${nocite}`;
		case "unchecked": return `Index not loaded; refresh the index to check · ${where}${nocite}`;
	}
}

/** One-line summary for the report heading. */
export function checkSummary(report: CheckReport): string {
	const { counts } = report;
	const parts = [`${report.rows.length} cited key${report.rows.length === 1 ? "" : "s"}`];
	if (counts.unknown) parts.push(`${counts.unknown} unknown`);
	if (counts.ambiguous) parts.push(`${counts.ambiguous} ambiguous`);
	if (counts.renamed) parts.push(`${counts.renamed} former`);
	if (counts.noNote) parts.push(`${counts.noNote} without a literature note`);
	if (counts.unchecked) parts.push(`${counts.unchecked} not checked (index not loaded)`);
	if (counts.nocite) parts.push(`${counts.nocite} from nocite`);
	if (report.nociteAll) parts.push("nocite lists @* (every entry of the bibliography file; not expanded here)");
	if (report.snapshot.loaded && report.snapshot.stale) parts.push(`index ${formatIndexAge(report.snapshot.ageMinutes)} old`);
	return parts.join(" · ");
}

/** Rows that need attention first (unknown, ambiguous, former, no note, unchecked), then the rest; text order within a group. */
export function checkRowsInReportOrder(rows: readonly CheckRow[]): CheckRow[] {
	const rank = (row: CheckRow): number => row.status === "unknown" ? 0 : row.status === "ambiguous" ? 1 : row.status === "renamed" ? 2 : row.noNote === true ? 3 : row.status === "unchecked" ? 4 : 5;
	return rows.map((row, index) => ({ row, index })).sort((left, right) => rank(left.row) - rank(right.row) || left.index - right.index).map(item => item.row);
}
