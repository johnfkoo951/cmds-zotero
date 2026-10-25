/**
 * 0.6.2 citekey problems in the editor and the renamed-citekey fix. Pure: never imports `obsidian`.
 *
 * A citekey is `unknown` when a loaded snapshot has no item carrying it, `ambiguous` when several items carry it (current
 * or former keys, across libraries), and `former` when it is only a previous key of one item. Without a loaded snapshot
 * nothing is claimed (UI negatives need a loaded snapshot), and an incomplete snapshot never marks a key `unknown`: it
 * cannot prove absence (AGENTS.md).
 */
import type { ZoteroIndexEntry } from "../types";
import { UNICODE_KEY } from "./cluster";

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

const RENAME_CITATION = new RegExp(`\\[\\[@(${UNICODE_KEY})(?:[|#][^\\]]*)?\\]\\]|(^|[\\s\\[;(,\\-])-?@(${UNICODE_KEY})`, "gu");

/**
 * Every body citation of `oldKey` in `text` (`[@old]`, `@old`, `-@old`, `[[@old]]`, including Unicode citekeys; code
 * blocks and frontmatter are skipped) and the lines with `newKey` instead. Other text, including other keys that start
 * with the old one, is untouched.
 */
export function renamePlan(text: string, oldKey: string, newKey: string): RenamePlan {
	const lines = text.split(/\r?\n/);
	const columns = new Map<number, number[]>();
	let fenced = false;
	let frontmatter = lines[0]?.trim() === "---";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (frontmatter) { if (index > 0 && line.trim() === "---") frontmatter = false; continue; }
		if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		RENAME_CITATION.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = RENAME_CITATION.exec(line)) !== null) {
			const citekey = match[1] ?? match[3];
			const prefix = match[1] ? "" : (match[2] ?? "");
			const column = match.index + prefix.length;
			if (!match[1] && column >= 2 && line[column - 1] === "[" && line[column - 2] === "[") continue;
			if (citekey !== oldKey) continue;
			const at = line.indexOf(`@${oldKey}`, column);
			if (at < 0) continue;
			const list = columns.get(index) ?? [];
			list.push(at + 1);
			columns.set(index, list);
		}
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
