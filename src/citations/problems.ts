/**
 * 0.6.2 citekey problems in the editor and the renamed-citekey fix. Pure: never imports `obsidian`.
 *
 * A citekey is `unknown` when a loaded snapshot has no item carrying it, `ambiguous` when several items carry it (current
 * or former keys, across libraries), and `former` when it is only a previous key of one item. Without a loaded snapshot
 * nothing is claimed (UI negatives need a loaded snapshot), and an incomplete snapshot never marks a key `unknown`: it
 * cannot prove absence (AGENTS.md).
 */
import type { ZoteroIndexEntry } from "../types";
import { scanCitations } from "./scan";

export type CitekeyProblem = "unknown" | "ambiguous" | "former";

export interface CitekeyLookup { entriesWithCitekey(citekey: string): readonly ZoteroIndexEntry[] }

export function citekeyProblem(citekey: string, lookup: CitekeyLookup, loaded: boolean, complete = true): CitekeyProblem | null {
	if (!loaded) return null;
	const matches = lookup.entriesWithCitekey(citekey);
	if (!matches.length) return complete ? "unknown" : null;
	if (matches.length > 1) return "ambiguous";
	return matches[0].citekey === citekey ? null : "former";
}

/** Short explanations for the mark's tooltip and the hover card. */
export function problemText(problem: CitekeyProblem, citekey: string, matches: readonly ZoteroIndexEntry[] = []): string {
	if (problem === "unknown") return `@${citekey} is not in the literature index.`;
	if (problem === "ambiguous") return `@${citekey} is carried by ${matches.length} items; choose one when you open it.`;
	return `@${citekey} is a former citekey of @${matches[0]?.citekey ?? "?"}; Fix renamed citekey replaces it in this note.`;
}

/** One citation of the old key and its line before and after the fix (0-based line). */
export interface RenameLine { line: number; before: string; after: string; count: number }

export interface RenamePlan { oldKey: string; newKey: string; lines: RenameLine[]; count: number }

/**
 * Every body citation of `oldKey` in `text` (`[@old]`, `@old`, `-@old`, `[[@old]]`, the forms `scanCitations` finds; code
 * blocks and frontmatter are skipped) and the lines with `newKey` instead. Other text, including other keys that start
 * with the old one, is untouched.
 */
export function renamePlan(text: string, oldKey: string, newKey: string): RenamePlan {
	const lines = text.split(/\r?\n/);
	const columns = new Map<number, number[]>();
	for (const occurrence of scanCitations(text)) {
		if (occurrence.citekey !== oldKey) continue;
		const line = lines[occurrence.line];
		const at = line.indexOf(`@${oldKey}`, occurrence.column);
		if (at < 0) continue;
		const list = columns.get(occurrence.line) ?? [];
		list.push(at + 1);
		columns.set(occurrence.line, list);
	}
	const planned: RenameLine[] = [];
	let count = 0;
	for (const [line, starts] of [...columns].sort((a, b) => a[0] - b[0])) {
		const before = lines[line];
		let after = before;
		for (const start of [...starts].sort((a, b) => b - a)) after = after.slice(0, start) + newKey + after.slice(start + oldKey.length);
		planned.push({ line, before, after, count: starts.length });
		count += starts.length;
	}
	return { oldKey, newKey, lines: planned, count };
}

/** `text` with the planned lines replaced; throws when a planned line no longer reads as it did (the note changed). */
export function applyRenamePlan(text: string, plan: RenamePlan): string {
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	for (const row of plan.lines) {
		if (lines[row.line] !== row.before) throw new Error("The note changed since the preview. Run the command again.");
		lines[row.line] = row.after;
	}
	return lines.join(newline);
}
