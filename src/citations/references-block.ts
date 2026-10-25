/**
 * 0.6.2 managed-references-section: an opt-in, plugin-owned references block at the end of any note, in its own marker
 * namespace so it never collides with a literature note's managed section IDs:
 *
 *   <!-- cmds-zotero-references:<sha256 of the body> -->
 *   …entries…
 *   <!-- /cmds-zotero-references -->
 *
 * Semantics follow the literature-note marker grammar: an unedited block (body hash matches) is replaced; an edited block
 * is a soft conflict and kept verbatim; `<!-- cmds-zotero-references:detached -->` freezes it as yours (never
 * re-rendered); an unclosed, stray or duplicate marker is a hard conflict reported with its line. A new block is appended
 * at the end of the note under a heading; nothing is ever inserted inside prose. Pure: no `obsidian` import.
 */
import { createHash } from "crypto";

export const REFERENCES_DETACHED = "detached";
const OPENING = /<!-- cmds-zotero-references:([a-f0-9]{64}|detached) -->/g;
const CLOSING = /<!-- \/cmds-zotero-references -->/g;
const ANY_MARKER = /<!-- \/?cmds-zotero-references(?::[^\r\n]*?)? -->/g;

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

export function referencesBlock(body: string): string {
	const normalized = body.replace(/\r\n/g, "\n");
	return `<!-- cmds-zotero-references:${hash(normalized)} -->\n${normalized}\n<!-- /cmds-zotero-references -->`;
}

export type BlockLocation =
	| { kind: "none" }
	| { kind: "found"; start: number; end: number; mark: string; body: string; line: number }
	| { kind: "conflict"; message: string; line: number };

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split(/\r?\n/).length - 1;

/** The one references block of a note, or why it cannot be used (duplicate, unclosed or stray marker). */
export function locateReferencesBlock(text: string): BlockLocation {
	const markers = [...text.matchAll(ANY_MARKER)];
	if (!markers.length) return { kind: "none" };
	const openings = [...text.matchAll(OPENING)];
	const closings = [...text.matchAll(CLOSING)];
	if (openings.length > 1) return { kind: "conflict", message: "The note has more than one references block; keep one and delete the other markers.", line: lineOf(text, openings[1].index) };
	if (closings.length > 1) return { kind: "conflict", message: "The note has more than one closing references marker.", line: lineOf(text, closings[1].index) };
	if (markers.length !== openings.length + closings.length) {
		const odd = markers.find(marker => !/^<!-- cmds-zotero-references:(?:[a-f0-9]{64}|detached) -->$/.test(marker[0]) && marker[0] !== "<!-- /cmds-zotero-references -->");
		return { kind: "conflict", message: "A references marker is damaged (its hash is not readable).", line: lineOf(text, odd?.index ?? markers[0].index) };
	}
	const opening = openings[0];
	const closing = closings[0];
	if (!opening) return { kind: "conflict", message: "A closing references marker has no opening marker.", line: lineOf(text, closing.index) };
	if (!closing || closing.index < opening.index) return { kind: "conflict", message: "The references block is not closed (the closing marker is missing or comes first).", line: lineOf(text, opening.index) };
	const after = opening.index + opening[0].length;
	const inner = text.slice(after, closing.index);
	const leadingBreak = /^\r?\n/.exec(inner);
	if (!leadingBreak) return { kind: "conflict", message: "Text follows the opening references marker on its line; move it below the block.", line: lineOf(text, opening.index) };
	const body = inner.slice(leadingBreak[0].length).replace(/[ \t]*\r?\n[ \t]*$/, "").replace(/\r\n/g, "\n");
	return { kind: "found", start: opening.index, end: closing.index + closing[0].length, mark: opening[1], body, line: lineOf(text, opening.index) };
}

export type ReferencesPlan =
	| { kind: "insert"; text: string; line: number }
	| { kind: "update"; text: string; line: number }
	| { kind: "unchanged"; line: number }
	| { kind: "edited"; line: number }
	| { kind: "detached"; line: number }
	| { kind: "conflict"; message: string; line: number };

/**
 * What "Insert/update references section" does with `text`: append a new block (under `## heading`) at the end, replace
 * an unedited block in place, or leave the note alone (unchanged, edited, detached, conflict).
 */
export function planReferencesSection(text: string, body: string, heading: string): ReferencesPlan {
	const normalizedBody = body.replace(/\r\n/g, "\n");
	const found = locateReferencesBlock(text);
	if (found.kind === "conflict") return found;
	if (found.kind === "none") {
		const base = text.replace(/\s*$/, "");
		const title = heading.trim() || "References";
		const prefix = base ? `${base}\n\n` : "";
		const next = `${prefix}## ${title}\n\n${referencesBlock(normalizedBody)}\n`;
		return { kind: "insert", text: next, line: lineOf(next, next.lastIndexOf("<!-- cmds-zotero-references:")) };
	}
	if (found.mark === REFERENCES_DETACHED) return { kind: "detached", line: found.line };
	if (hash(found.body) !== found.mark) return { kind: "edited", line: found.line };
	if (found.body === normalizedBody) return { kind: "unchanged", line: found.line };
	return { kind: "update", text: `${text.slice(0, found.start)}${referencesBlock(normalizedBody)}${text.slice(found.end)}`, line: found.line };
}

/** The note with its references block (markers and body) blanked to spaces, so citations inside it are never counted. */
export function withoutReferencesBlock(text: string): string {
	const found = locateReferencesBlock(text);
	if (found.kind !== "found") return text;
	return text.slice(0, found.start) + text.slice(found.start, found.end).replace(/[^\r\n]/g, " ") + text.slice(found.end);
}

/** The block body: entries as paragraphs; a list of keys that could not be rendered is not part of it. */
export function referencesBody(entries: readonly string[]): string {
	return entries.join("\n\n");
}
