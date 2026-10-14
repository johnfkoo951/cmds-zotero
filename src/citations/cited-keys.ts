/**
 * 0.6.2 cited-key-set-pandoc-semantics: the citation keys a note cites, the way pandoc's citeproc reads the note. Text in
 * the frontmatter, fenced code, inline code, HTML comments and Obsidian `%%` comments is not a citation; an escaped `\@`
 * and an e-mail address are not either; a suppress-author `-@key` counts; `nocite` in the frontmatter adds keys (`@*`
 * is noted, never expanded). `[[@key]]` wikilinks count as the plugin has always counted them. Pure: no `obsidian` import.
 *
 * The scanner in `scan.ts` (completion, sidebars before 0.6.2, agents) is left as it is; this module is the cited set the
 * check, the references section and the export kit use.
 */

/** Text the scanner skips, as offsets into the note (end exclusive). */
export type IgnoredKind = "frontmatter" | "fence" | "code" | "html-comment" | "obsidian-comment" | "escape";
export interface IgnoredRegion { start: number; end: number; kind: IgnoredKind }

export interface CitedOccurrence {
	citekey: string;
	/** 0-based line and UTF-16 column of the `@` (of `[[` for a wikilink). */
	line: number;
	column: number;
	/** UTF-16 column just after the key (after `]]` for a wikilink). */
	end: number;
	form: "pandoc" | "bare" | "wikilink";
	/** `-@key`: pandoc leaves the author out of the in-text citation; the key still counts. */
	suppressAuthor: boolean;
}

export interface NociteKey { citekey: string; line: number; column: number }

export interface CitedKeySet {
	/** Body citations in text order. */
	occurrences: CitedOccurrence[];
	/** `nocite` keys in frontmatter order (`@*` excluded). */
	nocite: NociteKey[];
	/** `nocite` lists `@*` (every bibliography entry); it is noted, never expanded into keys. */
	nociteAll: boolean;
	/** Distinct keys: body citations first (first-seen order), then nocite keys not cited in the body. */
	keys: string[];
}

/** Pandoc citation keys: a letter, digit or `_`, then alphanumerics, `_` and internal punctuation. */
const KEY = "[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_:.#$%&+?<>~/-]*[\\p{L}\\p{N}_])?";
const BRACED_KEY = "\\{([^{}\\n]{1,200})\\}";
/** `[[@key]]`, `[[@key|alias]]`, `[[@key#heading]]`; or `@key` / `-@key` / `@{key}` after a non-word character. */
const CITATION = new RegExp(`\\[\\[@(${KEY})(?:[|#][^\\]\\n]*)?\\]\\]|(^|[^\\p{L}\\p{N}_@\\\\])(-?)@(?:(${KEY})|${BRACED_KEY})`, "gu");
const FENCE_OPEN = /^((?:[ \t]{0,3}>)*)[ \t]{0,3}(`{3,}|~{3,})/;

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
	return starts;
}

/** End offset of the frontmatter block (after its closing line), or 0 when the note has none. */
export function frontmatterEnd(text: string): number {
	const first = /^---[ \t]*\r?\n/.exec(text);
	if (!first) return 0;
	const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
	closing.lastIndex = first[0].length;
	const match = closing.exec(text);
	return match ? match.index + match[0].length : 0;
}

/**
 * The regions pandoc does not read as prose, in text order: frontmatter, fenced code (also inside blockquotes and
 * callouts), inline code on one line, HTML comments and `%%` comments (both may span lines), and `\@` escapes.
 */
export function ignoredRegions(text: string): IgnoredRegion[] {
	const regions: IgnoredRegion[] = [];
	const front = frontmatterEnd(text);
	if (front) regions.push({ start: 0, end: front, kind: "frontmatter" });
	const starts = lineStarts(text);
	let fence: { char: string; length: number; start: number } | null = null;
	let comment: { kind: "html-comment" | "obsidian-comment"; start: number } | null = null;
	for (let line = 0; line < starts.length; line++) {
		const lineStart = starts[line];
		if (lineStart < front) continue;
		const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
		const content = text.slice(lineStart, lineEnd).replace(/\r$/, "");
		if (fence) {
			const close = FENCE_OPEN.exec(content);
			if (close && close[2][0] === fence.char && close[2].length >= fence.length && !content.slice(close[0].length).trim()) {
				regions.push({ start: fence.start, end: Math.min(text.length, lineEnd + 1), kind: "fence" });
				fence = null;
			}
			continue;
		}
		if (!comment) {
			const open = FENCE_OPEN.exec(content);
			if (open) { fence = { char: open[2][0], length: open[2].length, start: lineStart }; continue; }
		}
		let index = 0;
		while (index < content.length) {
			if (comment) {
				const closer = comment.kind === "html-comment" ? "-->" : "%%";
				const at = content.indexOf(closer, index);
				if (at < 0) { index = content.length; break; }
				regions.push({ start: comment.start, end: lineStart + at + closer.length, kind: comment.kind });
				comment = null;
				index = at + closer.length;
				continue;
			}
			const char = content[index];
			if (char === "\\" && content[index + 1] === "@") { regions.push({ start: lineStart + index, end: lineStart + index + 2, kind: "escape" }); index += 2; continue; }
			if (char === "`") {
				let run = 1;
				while (content[index + run] === "`") run++;
				const ticks = "`".repeat(run);
				let search = index + run;
				let close = -1;
				while ((search = content.indexOf(ticks, search)) >= 0) {
					if (content[search + run] !== "`" && content[search - 1] !== "`") { close = search; break; }
					search += run;
				}
				if (close < 0) { index += run; continue; }
				regions.push({ start: lineStart + index, end: lineStart + close + run, kind: "code" });
				index = close + run;
				continue;
			}
			if (content.startsWith("<!--", index)) { comment = { kind: "html-comment", start: lineStart + index }; index += 4; continue; }
			if (content.startsWith("%%", index)) { comment = { kind: "obsidian-comment", start: lineStart + index }; index += 2; continue; }
			index++;
		}
	}
	if (fence) regions.push({ start: fence.start, end: text.length, kind: "fence" });
	if (comment) regions.push({ start: comment.start, end: text.length, kind: comment.kind });
	return regions.sort((left, right) => left.start - right.start);
}

/** The text with every ignored region blanked to spaces (line breaks kept), so offsets, lines and columns are unchanged. */
export function maskIgnored(text: string, regions: readonly IgnoredRegion[] = ignoredRegions(text)): string {
	if (!regions.length) return text;
	let out = "";
	let at = 0;
	for (const region of regions) {
		if (region.start < at) continue;
		out += text.slice(at, region.start) + text.slice(region.start, region.end).replace(/[^\r\n]/g, " ");
		at = region.end;
	}
	return out + text.slice(at);
}

/** Body citations of a masked text, line by line; brackets decide `pandoc` (inside `[...]`) or `bare`. */
function scanMasked(masked: string): CitedOccurrence[] {
	const occurrences: CitedOccurrence[] = [];
	const lines = masked.split("\n");
	for (let line = 0; line < lines.length; line++) {
		const content = lines[line];
		if (!content.includes("@")) continue;
		let depth = 0;
		let folded = 0;
		CITATION.lastIndex = 0;
		for (let match = CITATION.exec(content); match; match = CITATION.exec(content)) {
			if (match[1]) { occurrences.push({ citekey: match[1], line, column: match.index, end: match.index + match[0].length, form: "wikilink", suppressAuthor: false }); continue; }
			const prefix = match[2] ?? "";
			const dash = match[3] ?? "";
			const column = match.index + prefix.length + dash.length;
			if (column >= 2 && content[column - 1] === "[" && content[column - 2] === "[") continue;
			for (; folded < column; folded++) {
				if (content[folded] === "[") depth++;
				else if (content[folded] === "]" && depth > 0) depth--;
			}
			const citekey = match[4] ?? match[5]?.trim() ?? "";
			if (!citekey) continue;
			occurrences.push({ citekey, line, column, end: match.index + match[0].length, form: depth > 0 ? "pandoc" : "bare", suppressAuthor: dash === "-" });
		}
	}
	return occurrences;
}

const NOCITE_TOKEN = new RegExp(`@(\\*|${KEY}|${BRACED_KEY})`, "gu");

/** `nocite` keys from the raw frontmatter lines: the `nocite:` line and its indented continuation lines. */
function scanNocite(text: string, end: number): { keys: NociteKey[]; all: boolean } {
	const keys: NociteKey[] = [];
	let all = false;
	if (!end) return { keys, all };
	const lines = text.slice(0, end).split("\n");
	let inside = false;
	for (let line = 1; line < lines.length; line++) {
		const content = lines[line].replace(/\r$/, "");
		const opening = /^nocite\s*:/.exec(content);
		// A continuation line is indented (or blank inside a block scalar); the next top-level key ends the value.
		if (opening) inside = true;
		else if (inside && /^\S/.test(content)) inside = false;
		if (!inside) continue;
		const value = opening ? " ".repeat(opening[0].length) + content.slice(opening[0].length) : content;
		NOCITE_TOKEN.lastIndex = 0;
		for (let match = NOCITE_TOKEN.exec(value); match; match = NOCITE_TOKEN.exec(value)) {
			const before = match.index > 0 ? value[match.index - 1] : " ";
			if (/[\p{L}\p{N}_]/u.test(before)) continue;
			if (match[1] === "*") { all = true; continue; }
			const citekey = (match[2] ?? match[1]).trim();
			if (citekey) keys.push({ citekey, line, column: match.index });
		}
	}
	return { keys, all };
}

/** The note's cited-key set with pandoc semantics (see the module comment). */
export function citedKeySet(text: string): CitedKeySet {
	const regions = ignoredRegions(text);
	const occurrences = scanMasked(maskIgnored(text, regions));
	const nocite = scanNocite(text, frontmatterEnd(text));
	const keys = [...new Set([...occurrences.map(item => item.citekey), ...nocite.keys.map(item => item.citekey)])];
	return { occurrences, nocite: nocite.keys, nociteAll: nocite.all, keys };
}

/** Occurrences of one key, in text order. */
export function occurrencesOf(set: Pick<CitedKeySet, "occurrences">, citekey: string): CitedOccurrence[] {
	return set.occurrences.filter(item => item.citekey === citekey);
}

/**
 * The occurrence of `citekey` after (`next`) or before (`previous`) the cursor, wrapping around the note; null when the
 * key does not occur. An occurrence the cursor is on counts as the current one, so `next` moves past it.
 */
export function adjacentOccurrence(set: Pick<CitedKeySet, "occurrences">, citekey: string, cursor: { line: number; ch: number }, direction: "next" | "previous"): CitedOccurrence | null {
	const list = occurrencesOf(set, citekey);
	if (!list.length) return null;
	const before = (item: CitedOccurrence): boolean => item.line < cursor.line || (item.line === cursor.line && item.end <= cursor.ch);
	const covers = (item: CitedOccurrence): boolean => item.line === cursor.line && item.column <= cursor.ch && cursor.ch <= item.end;
	if (direction === "next") return list.find(item => !before(item) && !covers(item)) ?? list[0];
	const earlier = list.filter(item => before(item) && !covers(item));
	return earlier[earlier.length - 1] ?? list[list.length - 1];
}

/** The key of the citation under the cursor (an `@key`, `-@key`, `@{key}` or `[[@key]]` that spans the cursor), or null. */
export function citedKeyAt(set: Pick<CitedKeySet, "occurrences">, cursor: { line: number; ch: number }): string | null {
	return set.occurrences.find(item => item.line === cursor.line && item.column <= cursor.ch && cursor.ch <= item.end)?.citekey ?? null;
}
