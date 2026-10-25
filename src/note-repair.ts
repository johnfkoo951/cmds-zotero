/**
 * 0.6.3 rebuild-or-repair-note: turns the hard marker conflicts of an owned literature note (duplicate blocks, damaged or
 * stray markers, missing generated sections) into a well-formed note that the normal render can update. It removes only
 * plugin markers and generated text that is provably unedited (its hash matches); every other line stays, edited and
 * detached duplicates become plain text the user owns. Missing `overview`, `citation`, `metadata` and `notes` blocks are
 * put back empty in their usual order, so the render then fills them. The managed ID set is unchanged. The host previews
 * the result and backs the note up before writing. Pure module: no `obsidian` import.
 */
import { DETACHED_MARK, hashText, managedBlock, managedBlockPattern } from "./note-writer";

export interface RepairResult {
	/** The repaired note text (equal to the input when nothing needed repair). */
	text: string;
	/** One line per repair, with the line number in the original note. */
	repairs: string[];
}

/** The generated sections every literature note has, in note order. */
export const CORE_SECTIONS = ["overview", "citation", "metadata", "notes"] as const;

/** A plugin marker comment (well-formed or not); the owner marker (`cmds-zotero-owner:`) is not one. */
const ANY_MARKER = /<!-- ?\/?cmds-zotero:[^\r\n]*?(?:-->|$)/gm;

const REMOVED = "@@cmds-zotero-repair-removed-block@@";

function lineAt(text: string, offset: number): number { return text.slice(0, offset).split("\n").length; }

/**
 * Repairs the managed markers of `text`, a note carrying `owner` (the caller checks ownership first). Duplicate blocks:
 * the first block of an ID stays; a later unedited copy is removed, an edited or detached copy keeps its text without
 * markers. Stray markers (no well-formed block around them) are removed; the text around them stays. Missing core
 * sections are inserted as empty blocks, before the next core section that exists, else after the previous one, else
 * after the owner marker.
 */
export function repairManagedMarkers(text: string, owner: string): RepairResult {
	const repairs: string[] = [];
	// 1. Duplicate well-formed blocks. Offsets come from the original text, so line numbers name the note as it is.
	const seen = new Set<string>();
	let deduplicated = text.replace(managedBlockPattern(), (whole: string, id: string, mark: string, tail: string, rawBody: string, offset: number) => {
		const body = rawBody.replace(/\r\n/g, "\n");
		if (!seen.has(id)) { seen.add(id); return whole; }
		const line = lineAt(text, offset);
		if (mark !== DETACHED_MARK && hashText(body) === mark && !tail.trim()) {
			repairs.push(`Removed a second, unedited copy of ${id} (line ${line}).`);
			return REMOVED;
		}
		repairs.push(`A second copy of ${id} (line ${line}) was ${mark === DETACHED_MARK ? "detached" : "edited"}: its text is kept as your own text, without markers.`);
		return [body, tail.trim()].filter(Boolean).join("\n");
	});
	// Only the blank lines around a removed copy are joined; blank lines elsewhere stay as they are.
	deduplicated = deduplicated.replace(/(?:\r?\n)*@@cmds-zotero-repair-removed-block@@(?:\r?\n)*/g, "\n\n");
	// 2. Markers outside every well-formed block's opening and closing marker spans.
	const inside: [number, number][] = [];
	for (const match of deduplicated.matchAll(managedBlockPattern())) {
		const openEnd = match.index + `<!-- cmds-zotero:${match[1]}:${match[2]} -->`.length;
		const closeStart = match.index + match[0].lastIndexOf("<!-- /cmds-zotero:");
		inside.push([match.index, openEnd], [closeStart, match.index + match[0].length]);
	}
	const stray: { start: number; end: number; marker: string }[] = [];
	for (const match of deduplicated.matchAll(ANY_MARKER)) {
		if (inside.some(([start, end]) => match.index >= start && match.index < end)) continue;
		stray.push({ start: match.index, end: match.index + match[0].length, marker: match[0] });
	}
	let repaired = deduplicated;
	for (const { start, end, marker } of [...stray].reverse()) {
		const id = /cmds-zotero:([a-zA-Z0-9-]*)/.exec(marker)?.[1] || "an unnamed section";
		const lineStart = repaired.lastIndexOf("\n", start - 1) + 1;
		const nextBreak = repaired.indexOf("\n", end);
		const lineEnd = nextBreak < 0 ? repaired.length : nextBreak;
		const rest = repaired.slice(lineStart, start) + repaired.slice(end, lineEnd);
		// A line holding only the marker goes; otherwise only the marker text is cut out of the line.
		repaired = rest.trim() ? repaired.slice(0, start) + repaired.slice(end) : repaired.slice(0, lineStart) + repaired.slice(nextBreak < 0 ? lineEnd : lineEnd + 1);
		const original = text.indexOf(marker);
		repairs.unshift(`Removed a damaged marker of ${id}${original >= 0 ? ` (line ${lineAt(text, original)})` : ""}; the text around it is kept.`);
	}
	// 3. Missing core sections, as empty blocks the render fills.
	for (const [position, id] of CORE_SECTIONS.entries()) {
		const present = (other: string): RegExpExecArray | null => new RegExp(`<!-- cmds-zotero:${other}:(?:[a-f0-9]{64}|detached) -->`).exec(repaired);
		if (present(id)) continue;
		const empty = managedBlock(id, "");
		const later = CORE_SECTIONS.slice(position + 1).map(present).find(Boolean);
		const earlier = CORE_SECTIONS.slice(0, position).reverse().map(other => ({ other, match: present(other) })).find(found => found.match);
		if (later) {
			const at = repaired.lastIndexOf("\n", later.index - 1) + 1;
			repaired = `${repaired.slice(0, at)}${empty}\n\n${repaired.slice(at)}`;
		} else if (earlier?.match) {
			const closing = `<!-- /cmds-zotero:${earlier.other} -->`;
			const at = repaired.indexOf(closing, earlier.match.index) + closing.length;
			repaired = `${repaired.slice(0, at)}\n\n${empty}${repaired.slice(at)}`;
		} else {
			const ownerAt = repaired.indexOf(owner);
			const at = ownerAt < 0 ? repaired.length : ownerAt + owner.length;
			repaired = `${repaired.slice(0, at)}\n\n${empty}${repaired.slice(at)}`;
		}
		repairs.push(`Added the missing ${id} section; it is filled from Zotero.`);
	}
	return { text: repaired, repairs };
}
