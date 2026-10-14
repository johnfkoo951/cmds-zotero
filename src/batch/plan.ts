/**
 * 0.6.3 batch-dry-run-review: what a literature-note batch (import by scope, update all, adopt) would do to each note,
 * worked out before anything is read from Zotero or written: create / update / adopt, or skip with a reason. The review
 * list shows these rows with a per-row include box; only included rows run. Also the "changed since" filter
 * (update-changed-since) and the Better Notes guard (better-notes-guard). Pure: no `obsidian` import.
 */
import type { ZoteroIndexEntry } from "../types";
import { localDay } from "../recent/recent-reads";

export type PlannedAction = "create" | "update" | "adopt" | "skip";
export interface ReviewRow<T = unknown> {
	/** Stable row key (entry id or note path). */
	key: string;
	label: string;
	/** The note path the action writes, or the reason's subject. */
	detail: string;
	action: PlannedAction;
	reason: string;
	/** Ticked in the review; a skip row is never included. */
	include: boolean;
	item: T;
}

/** A row; skips are never included, other rows follow `include` (default true). */
export function reviewRow<T>(key: string, label: string, detail: string, action: PlannedAction, reason: string, item: T, include = true): ReviewRow<T> {
	return { key, label, detail, action, reason, include: action !== "skip" && include, item };
}

/** "3 to create · 1 to update · 2 skipped" for the review header and the reports. */
export function planSummary(rows: readonly Pick<ReviewRow, "action" | "include">[]): string {
	const count = (action: PlannedAction): number => rows.filter(row => row.action === action && (action === "skip" || row.include)).length;
	const excluded = rows.filter(row => row.action !== "skip" && !row.include).length;
	const parts = [["create", "to create"], ["update", "to update"], ["adopt", "to adopt"]] as const;
	return [...parts.filter(([action]) => count(action)).map(([action, text]) => `${count(action)} ${text}`), ...(count("skip") ? [`${count("skip")} skipped`] : []), ...(excluded ? [`${excluded} left out`] : [])].join(" · ") || "Nothing to do";
}

/** The rows that run: included and not skipped, in list order. */
export function includedRows<T>(rows: readonly ReviewRow<T>[]): ReviewRow<T>[] { return rows.filter(row => row.include && row.action !== "skip"); }

/**
 * A Zotero/Better BibTeX date (`2024-03-05T10:20:30Z`, `2024-03-05 10:20:30`, `2024-03-05`) in epoch milliseconds; a time
 * without a zone is UTC, as Zotero stores it. Null for anything else.
 */
export function zoteroTime(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
	if (!match) return null;
	const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4] ?? "00"}:${match[5] ?? "00"}:${match[6] ?? "00"}${match[7] ? (match[7] === "Z" ? "Z" : match[7].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")) : "Z"}`;
	const time = Date.parse(iso);
	return Number.isFinite(time) ? time : null;
}

/** The latest change Zotero recorded for the item: its `dateModified` and its annotations' `dateModified`. Null when none is readable. */
export function lastZoteroChange(entry: ZoteroIndexEntry): number | null {
	const times = [zoteroTime(entry.metadata.dateModified), ...entry.attachments.flatMap(attachment => [...attachment.annotations, ...attachment.readerAnnotations ?? []].map(annotation => zoteroTime(annotation.dateModified)))].filter((time): time is number => time !== null);
	return times.length ? Math.max(...times) : null;
}

/** 0.6.3 update-changed-since: which notes an update considers. `note`: since each note's last write (its file time). */
export type ChangedSince = { kind: "any" } | { kind: "note" } | { kind: "date"; time: number };

/**
 * Null when the item may have changed since `since` (the note is updated), else the skip reason. An item without a readable
 * change date is never skipped: the index cannot prove it unchanged.
 */
export function unchangedReason(entry: ZoteroIndexEntry, since: ChangedSince, noteTime: number | null): string | null {
	if (since.kind === "any") return null;
	const cutoff = since.kind === "date" ? since.time : noteTime;
	if (cutoff === null) return null;
	const changed = lastZoteroChange(entry);
	if (changed === null || changed > cutoff) return null;
	return since.kind === "note" ? "no change in Zotero since the note was last written" : `no change in Zotero since ${localDay(new Date(cutoff))}`;
}

/** A `YYYY-MM-DD` day (local midnight) in epoch milliseconds, or null. */
export function localDayStart(day: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
	if (!match) return null;
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date.getTime() : null;
}
