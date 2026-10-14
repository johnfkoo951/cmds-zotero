import { createHash } from "crypto";
import type { Annotation, CmdsZoteroSettings, ZoteroIndexEntry } from "./types";
import { LITERATURE_IDENTITY_KEYS, type LiteratureIdentityKey } from "./agent/types";
import { colorName } from "./annotations/colors";
import { richTextMarkdown } from "./annotations/rich-text";
import { DEFAULT_ANNOTATIONS_HEADING, layoutOf } from "./layout";
import { extraFields, fieldsFor, RECORD_DATES, type FieldSpec } from "./item-fields";

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");
// 0.5 R14: the marker that proves a literature note was created by this plugin for exactly this item.
export const ownerMarker = (id: string): string => `<!-- cmds-zotero-owner:${hashText(id)} -->`;
export interface ImagePlan { source: string; path: string }
// 0.5 R5: soft/hard conflict split, detached (user-owned) blocks and per-section states.
export type SectionState = "fresh" | "unchanged" | "edited" | "detached" | "malformed" | "missing";
export interface SectionInfo {
	id: string;
	state: SectionState;
	reason: string;
	/** 1-based line of the block's opening marker in the previous note text; absent for new blocks. */
	line?: number;
	/** The body as it will be written (fresh render, or the preserved/detached text). Empty for missing/malformed. */
	body: string;
}
export interface RenderedNote {
	content: string;
	/** Hard conflicts: the note must not be written (not owned, malformed/duplicate/missing markers). */
	conflicts: string[];
	/** Soft conflicts: edited generated sections kept verbatim; the rest of the note is still rendered. */
	softConflicts: string[];
	/** IDs of `<!-- cmds-zotero:<id>:detached -->` blocks (user-owned, never re-rendered). */
	detached: string[];
	/** IDs replaced by a fresh render on request (`RenderContext.reset`). */
	reset: string[];
	sections: SectionInfo[];
	images: ImagePlan[];
}
/** 0.5 R12: a first import needs live bibliography text; the placeholder `Bibliography unavailable.` is no longer written. */
export const BIBLIOGRAPHY_REQUIRED_MESSAGE = "Zotero must be running for the first import of this item (no bibliography text is available offline).";
export interface RenderContext {
	/** Citekeys of related Zotero items that are present in the index. */
	related?: string[];
	/** 0.5 R5: managed section IDs to freeze as detached (user-owned) in this render. */
	detach?: readonly string[];
	/** 0.5 R5: edited or detached section IDs to replace with the fresh render. */
	reset?: readonly string[];
	/**
	 * HTML-to-Markdown converter for Zotero child notes (the plugin passes Obsidian's `htmlToMarkdown`). Without one, notes
	 * are flattened to escaped plain text. Either way the result is made safe for a managed block (see `noteBody`).
	 */
	noteMarkdown?: (html: string) => string;
}

export function safeVaultPath(path: string): string {
	if (!path || path.startsWith("/") || /[\\:]/.test(path) || [...path].some(c => c.charCodeAt(0) < 32) || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe vault path");
	return path;
}

/** Drops control characters except line breaks and tabs. */
function stripControl(value: string): string {
	return value.split("").filter(c => c.charCodeAt(0) >= 32 || c === "\n" || c === "\t" || c === "\r").join("");
}
/** Escapes every Markdown-significant character, including `<`/`>`, so source text can never form tags, links or markers. */
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()#!|<>~]/g, "\\$&"); }

/**
 * Plain-text fields (titles, creators, tags, bibliography prose): control-character filtering and Markdown escaping only.
 * No tag stripping and no entity decoding, so `<…>` segments such as SICI DOIs and `<B>` in titles survive (escaped).
 */
export function plainText(value: unknown): string {
	if (typeof value !== "string") return "";
	return escapeMarkdown(stripControl(value)).replace(/\n{3,}/g, "\n\n").trim();
}

/** HTML fields only (abstractNote, Zotero child notes): strips tags, decodes entities, then applies plainText escaping. */
export function textFromHTML(value: unknown): string {
	if (typeof value !== "string") return "";
	return plainText(value.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<\s*(?:br\s*\/?|\/p|\/div|\/li|\/h[1-6])\s*>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => {
			const code = n[0]?.toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
		})
		.replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[name.toLowerCase()] ?? "")));
}

/** Markdown from a converter, made safe inside a managed block under `## Zotero notes`. */
const SAFE_LINK_TARGET = /^<?(?:https?|zotero|obsidian|mailto):/i;
const SAFE_IMAGE_TARGET = /^<?https?:/i;
/** Bounds for the link scanner: label and destination lengths it inspects (keeps it linear on hostile input). */
const MAX_LABEL = 1000;
const MAX_TARGET = 2048;

/** Index of the `]` closing the label that opens at `open` (escapes skipped, nesting counted), or -1 within MAX_LABEL. */
function labelEnd(line: string, open: number): number {
	let depth = 0;
	for (let j = open; j < line.length && j - open <= MAX_LABEL; j++) {
		const c = line[j];
		if (c === "\\") { j++; continue; }
		if (c === "[") depth++;
		else if (c === "]" && --depth === 0) return j;
	}
	return -1;
}
/** Index of the `)` closing a destination that starts at `from`, or -1 within MAX_TARGET (no newline inside). */
function targetEnd(line: string, from: number): number {
	for (let j = from; j < line.length && j - from <= MAX_TARGET; j++) if (line[j] === ")") return j;
	return -1;
}

/**
 * Links keep only web, Zotero, Obsidian and mail targets (an unsafe link becomes its label); images keep only web
 * targets (a note-embedded image, which has no vault file, becomes a short placeholder). One bounded pass per line.
 */
function rewriteLinks(line: string): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const image = line[i] === "!" && line[i + 1] === "[";
		const open = image ? i + 1 : i;
		const escaped = open > 0 && line[open - 1] === "\\" && !image;
		const close = line[open] === "[" && !escaped ? labelEnd(line, open) : -1;
		const end = close >= 0 && line[close + 1] === "(" ? targetEnd(line, close + 2) : -1;
		if (end < 0) { out += line[i]; i++; continue; }
		const label = line.slice(open + 1, close);
		const target = line.slice(close + 2, end).trim();
		if (image) out += SAFE_IMAGE_TARGET.test(target) ? line.slice(i, end + 1) : `*(image in the Zotero note${label.trim() ? `: ${label.trim()}` : ""})*`;
		else out += SAFE_LINK_TARGET.test(target) ? line.slice(i, end + 1) : label;
		i = end + 1;
	}
	// Safety net for destinations the scanner did not pair with a label (label longer than MAX_LABEL): drop unsafe ones.
	let swept = "";
	let from = 0;
	for (let at = out.indexOf("](", from); at >= 0; at = out.indexOf("](", from)) {
		const stop = targetEnd(out, at + 2);
		if (stop < 0) break;
		swept += out.slice(from, at + 1) + (SAFE_LINK_TARGET.test(out.slice(at + 2, stop).trim()) ? out.slice(at + 1, stop + 1) : "");
		from = stop + 1;
	}
	return swept + out.slice(from);
}

/** Heading nesting and link/image rewrites for prose lines; fenced code is passed through untouched. */
function rewriteNoteProse(segment: string): string {
	return segment.split("\n").map(line => rewriteLinks(line)
		// Nest the note's own headings under "## Zotero notes".
		.replace(/^(#{1,6})(?=[ \t])/, hashes => "#".repeat(Math.min(6, hashes.length + 2)))
		// Autolinks with another scheme lose their angle brackets (plain text, not a link).
		.replace(/<([a-z][a-z0-9+.-]{0,31}):[^>\s]{0,2048}>/gi, (whole: string, scheme: string) => /^(?:https?|zotero|obsidian|mailto)$/i.test(scheme) ? whole : whole.slice(1, -1)))
		.join("\n");
}

/**
 * Markdown from a converter, made safe inside a managed block under `## Zotero notes`. Rewrites run first, outside fenced
 * code; comment delimiters are escaped last, across the whole text, so no earlier step can rebuild a marker.
 */
export function safeNoteMarkdown(markdown: string): string {
	const out: string[] = [];
	let fence: string | null = null;
	let prose: string[] = [];
	const flush = (): void => { if (prose.length) { out.push(rewriteNoteProse(prose.join("\n"))); prose = []; } };
	for (const line of stripControl(markdown).split("\n")) {
		const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence === null && opener) { flush(); fence = opener[0]; out.push(line); continue; }
		if (fence !== null) { out.push(line); if (opener && opener[0] === fence) fence = null; continue; }
		prose.push(line);
	}
	flush();
	return out.join("\n")
		// A converted note must never open or close a managed marker: escaped last, after every rewrite.
		.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;")
		.replace(/\n{3,}/g, "\n\n").trim();
}

/** One Zotero child note (HTML) as note-section text: structured Markdown with a converter, escaped plain text without. */
export function noteBody(html: string, convert?: (html: string) => string): string {
	if (!convert) return textFromHTML(html);
	const cleaned = html.replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<(script|style|iframe|object|embed)\b[^>]*\/?>/gi, "");
	let markdown: string;
	try { markdown = convert(cleaned); } catch { return textFromHTML(html); }
	if (typeof markdown !== "string") return textFromHTML(html);
	const safe = safeNoteMarkdown(markdown);
	// Belt and braces: converted text that still spells a managed marker is never used.
	return /<!--\s*\/?\s*cmds-zotero/i.test(safe) ? textFromHTML(html) : safe;
}

/** Zotero reading order: attachments as listed, annotations by `annotationSortIndex` (stable when it is absent). */
export function readingOrder(entry: ZoteroIndexEntry): { attachment: ZoteroIndexEntry["attachments"][number]; annotation: Annotation }[] {
	return entry.attachments.flatMap(attachment => {
		// Sort only when every annotation of the attachment has a sort index; a partial set keeps the listed order (a
		// mixed comparator would not be transitive).
		const sortable = attachment.annotations.every(annotation => annotation.sortIndex);
		const ordered = attachment.annotations.map((annotation, position) => ({ annotation, position }));
		if (sortable) ordered.sort((a, b) => a.annotation.sortIndex === b.annotation.sortIndex ? a.position - b.position : (a.annotation.sortIndex ?? "") < (b.annotation.sortIndex ?? "") ? -1 : 1);
		return ordered.map(({ annotation }) => ({ attachment, annotation }));
	});
}

/** Single-line text for callout titles and inline fields. */
function inline(value: unknown): string { return plainText(value).replace(/\s*\n\s*/g, " "); }
/**
 * 0.6.1 RICH-TEXT: single-line text with Zotero's rich-text whitelist (`<i>`, `<b>`, `<sup>`, `<sub>`, spans, `<br>`) as
 * Markdown; every other character is escaped exactly as `inline` escapes it. `italic`: the caller wraps the result in `*…*`.
 * Titles, annotation text and comments use it; DOIs, URLs, citekeys and tags never do.
 */
export function richInline(value: unknown, italic = false): string {
	if (typeof value !== "string") return "";
	return richTextMarkdown(stripControl(value), escapeMarkdown, { italic }).replace(/\n{3,}/g, "\n\n").trim().replace(/\s*\n\s*/g, " ");
}

/**
 * Strict DOI: no whitespace and none of the characters that would form Markdown links, emphasis, code or table cells
 * (`[ ] * | \``); `<`/`>` stay allowed for SICI DOIs (`<273::AID>`) but `<` may not start an HTML tag (`<a`, `</`, `<!`).
 */
const DOI_PATTERN = /^10\.\d{4,9}\/(?!.*<[A-Za-z/!])[^\s`*|[\]]+$/;
/** Absolute http(s) URL without whitespace or angle brackets: safe as a bare Obsidian autolink and Dataview value. */
const URL_PATTERN = /^https?:\/\/[^\s<>]+$/;
const CITEKEY_PATTERN = /^[A-Za-z0-9_:.+/-]+$/;
/** DOI resolver hosts, or a path carrying a DOI prefix: the only URLs BBT is known to double-encode. */
const DOI_URL_PATTERN = /^https?:\/\/(?:dx\.)?doi\.org\/|\/10\.\d{4,9}\//i;

/**
 * BBT returns some DOI URLs double-encoded (`%2528` for `(`). Decodes `%25XX` only for DOI URLs (doi.org host or a
 * DOI-prefixed path) and only when the result is still a valid URL; other URLs keep a literal `%25` untouched.
 */
export function decodeDoubleEncodedURL(url: string): string {
	if (!DOI_URL_PATTERN.test(url) || !/%25[0-9A-Fa-f]{2}/.test(url)) return url;
	const decoded = url.replace(/%25([0-9A-Fa-f]{2})/g, "%$1");
	return URL_PATTERN.test(decoded) ? decoded : url;
}
/** Emits a DOI verbatim when it is a strict DOI so `_`, `(`, `<` and `>` are not escaped; otherwise single-line escaped text. */
export function safeDOI(value: unknown): string {
	const raw = typeof value === "string" ? stripControl(value).trim() : "";
	return DOI_PATTERN.test(raw) ? raw : inline(raw);
}
/** Emits an absolute http(s) URL verbatim (percent-encoding such as `%20` intact); otherwise single-line escaped text. */
export function safeURL(value: unknown): string {
	const raw = typeof value === "string" ? decodeDoubleEncodedURL(stripControl(value).trim()) : "";
	return URL_PATTERN.test(raw) ? raw : inline(raw);
}
function safeCitekey(value: string): string { return CITEKEY_PATTERN.test(value) ? value : plainText(value); }

/** Bibliography text from BBT (contentType text): prose is escaped, `https?://` tokens become `<url>` autolinks with minimal percent-encoding. */
export function bibliographyText(value: unknown): string {
	if (typeof value !== "string") return "";
	const parts = stripControl(value).split(/(https?:\/\/\S+)/);
	return parts.map((part, index) => {
		if (index % 2 === 0) return escapeMarkdown(part);
		const [url, trailing] = splitTrailingPunctuation(part);
		const encoded = decodeDoubleEncodedURL(url).replace(/[<> ]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
		return `<${encoded}>${escapeMarkdown(trailing)}`;
	}).join("").replace(/\n{3,}/g, "\n\n").trim();
}
/** Peels sentence punctuation and unbalanced closing brackets (`(https://x.y/z).`) off the end of a URL token. */
function splitTrailingPunctuation(token: string): [string, string] {
	const count = (text: string, char: string): number => text.split(char).length - 1;
	let url = token;
	for (;;) {
		const next = url.replace(/[.,;:]+$/, "");
		const last = next.slice(-1);
		const unbalanced = (last === ")" && count(next, ")") > count(next, "(")) || (last === "]" && count(next, "]") > count(next, "["));
		const trimmed = unbalanced ? next.slice(0, -1) : next;
		if (trimmed === url) return [url, token.slice(url.length)];
		url = trimmed;
	}
}

/**
 * Obsidian tag slug: trim, whitespace to `-`, drop characters outside letters/numbers/`_`/`/`/`-`, collapse repeated `/`
 * and trim leading/trailing `/` and `-` (no empty nested-tag segments); empty and all-numeric slugs are invalid.
 */
export function normalizeTag(tag: string): string | null {
	const slug = tag.trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, "").replace(/\/+/g, "/").replace(/^[/-]+|[/-]+$/g, "");
	return !slug || /^\p{N}+$/u.test(slug) ? null : slug;
}
export function normalizedTags(tags: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const tag of tags) {
		const slug = normalizeTag(tag);
		if (!slug || seen.has(slug.toLowerCase())) continue;
		seen.add(slug.toLowerCase());
		result.push(slug);
	}
	return result;
}

/**
 * Maps Markdown and wiki link targets to their basename so Obsidian's automatic link updates (moved image folder,
 * renamed note) do not read as user edits. Used for hash comparison only; stored hashes stay raw.
 */
export function normalizeLinkTargets(body: string): string {
	const basename = (target: string): string => {
		const bare = target.trim().replace(/^<(.*)>$/s, "$1");
		let decoded = bare;
		try { decoded = decodeURIComponent(bare); } catch { /* keep the raw target */ }
		return decoded.split("/").pop() ?? "";
	};
	// Markdown targets may carry one level of balanced parentheses (`84. References (Zotero)/images/…`): encodeURIComponent
	// leaves `(`/`)` unencoded, so the matcher must not stop at the first `)`.
	return body
		.replace(/(!?\[[^\]\n]*\]\()((?:[^()\n]|\([^()\n]*\))*)(\))/g, (_, open: string, target: string, close: string) => `${open}${basename(target)}${close}`)
		.replace(/(!?\[\[)([^\]|#\n]*)([^\]\n]*\]\])/g, (_, open: string, target: string, rest: string) => `${open}${basename(target)}${rest}`);
}
/**
 * A section is unedited when its raw hash matches (the stored hash is always the raw hash), or, failing that, when its
 * link-target-normalized form equals the normalized fresh render — i.e. only link targets differ, which is what Obsidian's
 * automatic link updates produce. Replacing such a body with the fresh render changes link targets only, never user text.
 */
function sectionUnedited(body: string, hash: string, fresh: string | undefined): boolean {
	if (hashText(body) === hash) return true;
	return fresh !== undefined && normalizeLinkTargets(body) === normalizeLinkTargets(fresh);
}
/** Blockquote every line so multi-line text stays inside a callout. */
function quoted(body: string): string { return body.split("\n").map(line => `> ${line}`.trimEnd()).join("\n"); }

function block(id: string, body: string): string {
	return `<!-- cmds-zotero:${id}:${hashText(body)} -->\n${body}\n<!-- /cmds-zotero:${id} -->`;
}
// 0.5 R5: marker grammar. Opening `<!-- cmds-zotero:<id>:<sha256|detached> -->` may carry a same-line tail (text pasted
// after the marker) which is moved below the block on repair; trailing spaces/tabs before the closing marker and an
// indented closing marker are tolerated. A `detached` mark freezes the block as user-owned.
export const DETACHED_MARK = "detached";
const MANAGED_BLOCK = /<!-- cmds-zotero:([a-zA-Z0-9-]+):([a-f0-9]{64}|detached) -->([^\n]*)\n([\s\S]*?)[ \t]*\n[ \t]*<!-- \/cmds-zotero:\1 -->/g;
const MARKER = /<!-- (\/?)cmds-zotero:([a-zA-Z0-9-]+)/g;
function detachedBlock(id: string, body: string): string {
	return `<!-- cmds-zotero:${id}:${DETACHED_MARK} -->\n${body}\n<!-- /cmds-zotero:${id} -->`;
}
function storedBlock(id: string, mark: string, body: string): string {
	return `<!-- cmds-zotero:${id}:${mark} -->\n${body}\n<!-- /cmds-zotero:${id} -->`;
}
/** A non-blank tail after the opening marker is re-emitted on its own line right after the closing marker. */
function withTail(rendered: string, tail: string): string {
	const text = tail.trim();
	return text ? `${rendered}\n${text}` : rendered;
}
/** Freezes the listed managed blocks as detached (`<!-- cmds-zotero:<id>:detached -->`); other text is untouched. Idempotent. */
export function detachSections(text: string, ids: Iterable<string>): string {
	const wanted = new Set(ids);
	return text.replace(MANAGED_BLOCK, (whole: string, id: string, _mark: string, tail: string, body: string) => wanted.has(id) ? withTail(detachedBlock(id, body), tail) : whole);
}
/** Replaces the listed managed or detached blocks with fresh bodies (missing bodies leave the block untouched). */
export function resetSections(text: string, ids: Iterable<string>, bodies: ReadonlyMap<string, string>): string {
	const wanted = new Set(ids);
	return text.replace(MANAGED_BLOCK, (whole: string, id: string, _mark: string, tail: string) => {
		const fresh = bodies.get(id);
		return wanted.has(id) && fresh !== undefined ? withTail(block(id, fresh), tail) : whole;
	});
}
/**
 * New annotation blocks go after the last existing `annotation-*` closing marker, else after the `## Annotations` heading,
 * else at the end of the file — never after user prose written below the annotation list.
 */
const ANNOTATION_OPENING = /<!-- cmds-zotero:(annotation-[A-Za-z0-9]{1,32}-[A-Za-z0-9]{1,32}):(?:[a-f0-9]{64}|detached) -->/g;
/**
 * New annotation blocks in Zotero's reading order: each goes right before the first existing annotation block that Zotero
 * orders after it (detached blocks included); a block with no later neighbour is appended as before. `order` lists every
 * annotation section ID in reading order; `blocks` arrive in that order.
 */
function spliceAnnotationsInOrder(content: string, blocks: { id: string; text: string }[], order: readonly string[], heading: string): string {
	const rank = new Map(order.map((id, position) => [id, position]));
	let result = content;
	for (const block of blocks) {
		const position = rank.get(block.id);
		let before: number | null = null;
		if (position !== undefined) for (const match of result.matchAll(ANNOTATION_OPENING)) {
			const other = rank.get(match[1]);
			// Insert at the start of the marker's line, so text a user wrote before the marker on that line stays intact; if a
			// closing marker shares that line, insert right at the opening marker instead (never inside the previous block).
			if (other !== undefined && other > position) {
				const lineStart = result.lastIndexOf("\n", match.index - 1) + 1;
				before = /<!--\s*\/cmds-zotero:/.test(result.slice(lineStart, match.index)) ? match.index : lineStart;
				break;
			}
		}
		result = before === null ? spliceAnnotations(result, [block.text], heading) : `${result.slice(0, before)}${block.text}\n\n${result.slice(before)}`;
	}
	return result;
}
/** The `## <heading>` line new annotation blocks go under: the configured heading (0.6.1 R17), else `## Annotations`. */
function annotationsHeadingLine(content: string, heading: string): RegExpExecArray | null {
	const line = (text: string): RegExp => new RegExp(`^## ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \t]*$`, "m");
	return line(heading).exec(content) ?? (heading === DEFAULT_ANNOTATIONS_HEADING ? null : line(DEFAULT_ANNOTATIONS_HEADING).exec(content));
}
function spliceAnnotations(content: string, blocks: string[], heading: string): string {
	const joined = blocks.join("\n\n");
	let at = -1;
	for (const match of content.matchAll(/<!-- \/cmds-zotero:annotation-[A-Za-z0-9-]+ -->/g)) at = match.index + match[0].length;
	if (at < 0) {
		const found = annotationsHeadingLine(content, heading);
		if (found) at = found.index + found[0].length;
	}
	if (at < 0) return `${content.replace(/\n*$/, "\n")}\n${joined}\n`;
	return `${content.slice(0, at)}\n\n${joined}${content.slice(at).replace(/^\n*(?=[^\n])/, "\n\n").replace(/^\n*$/, "\n")}`;
}
function encodedPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function key(value: string): string {
	if (!/^[A-Za-z0-9]+$/.test(value)) throw new Error("Invalid Zotero item or annotation key");
	return value;
}
function fileURI(path: string): string {
	return `file://${path.split(/[\\/]/).map(segment => encodeURIComponent(segment)).join("/")}`;
}
function metadataText(entry: ZoteroIndexEntry, field: string): string {
	const value = entry.metadata[field];
	return typeof value === "string" || typeof value === "number" ? inline(String(value)) : "";
}

export interface CreatorName { role: string; name: string }
export function creatorNames(entry: ZoteroIndexEntry): CreatorName[] {
	const creators: unknown[] = Array.isArray(entry.metadata.creators) ? entry.metadata.creators : [];
	return creators.flatMap(value => {
		if (!value || typeof value !== "object") return [];
		const creator = value as Record<string, unknown>;
		const role = typeof creator.creatorType === "string" && creator.creatorType ? creator.creatorType : "author";
		const name = typeof creator.name === "string" && creator.name ? creator.name : [creator.lastName, creator.firstName].filter((v): v is string => typeof v === "string" && !!v).join(", ");
		return name ? [{ role, name }] : [];
	});
}

export function filteredTags(tags: string[], settings: CmdsZoteroSettings): string[] {
	const excluded = new Set(settings.excludedTags.map(tag => tag.toLowerCase()));
	return tags.filter(tag => tag.trim() && !excluded.has(tag.trim().toLowerCase()));
}

export function annotationURI(a: Annotation, entry: ZoteroIndexEntry): string {
	const scope = entry.libraryType === "group" ? `groups/${entry.groupID}` : "library";
	if (entry.libraryType === "group" && (!entry.groupID || !Number.isSafeInteger(entry.groupID))) throw new Error("Missing verified group ID");
	const page = Number.isSafeInteger(a.page) && a.page > 0 ? a.page : 1;
	return `zotero://open-pdf/${scope}/items/${key(a.attachmentKey)}?page=${page}&annotation=${encodeURIComponent(key(a.key))}`;
}

/** Renders one annotation as CMDS callout Markdown; reused by the import and the annotation sidebar. */
export function annotationBody(a: Annotation, image: string | undefined, entry: ZoteroIndexEntry, settings: CmdsZoteroSettings): string {
	const uri = annotationURI(a, entry);
	const page = Number.isSafeInteger(a.page) && a.page > 0 ? a.page : 1;
	// Zotero page labels can be placeholders such as "-"; fall back to the PDF page position unless the label carries a letter or digit.
	const label = inline(/[\p{L}\p{N}]/u.test(a.pageLabel) ? a.pageLabel : String(page));
	const color = colorName(a.color);
	const link = `[p. ${label}](${uri})`;
	const comment = a.comment ? `**Comment**: *${richInline(a.comment, true)}*` : "";
	const tags = a.tags.length ? `Tags: ${a.tags.map(inline).join(", ")}` : "";
	const type = (a.type || "highlight").toLowerCase();
	if (image) {
		const title = `[!Image] ${color ? `${color} · ` : ""}p. ${label}`;
		return quoted([title, `![Annotation image](${encodedPath(image)}) ${link}`, comment, tags].filter(Boolean).join("\n"));
	}
	if (type === "ink") {
		// A freehand drawing has no text and BBT renders no image for it: name it and link to it.
		return quoted([`[!Note] ink · ${color ? `${color} · ` : ""}p. ${label}`, `${richInline(a.comment) || "*Drawing; open it in Zotero.*"} ${link}`, tags].filter(Boolean).join("\n"));
	}
	if (type === "note" || (!a.text && a.comment)) {
		const body = richInline(a.comment) || "*(empty note)*";
		return quoted([`[!Note] p. ${label}`, `${body} ${link}`, tags].filter(Boolean).join("\n"));
	}
	if (color && settings.headingHighlightColor !== "none" && color === settings.headingHighlightColor && a.text) {
		return [`##### ${richInline(a.text)} ${link}`, comment, tags].filter(Boolean).join("\n\n");
	}
	const text = richInline(a.text);
	const marked = color ? `<mark class="cmds-zotero-hl-${color}">${text}</mark>` : text;
	const title = `[!Highlight] ${color ? `${color} · ` : ""}${type === "underline" ? "underline · " : ""}p. ${label}`;
	return quoted([title, `${marked} (${link})`, comment, tags].filter(Boolean).join("\n"));
}


/** Frontmatter is initialized once; existing YAML remains entirely user-owned. */
export function renderLiterature(entry: ZoteroIndexEntry, bibliography: string, settings: CmdsZoteroSettings, previous: string | null, imageHashes: ReadonlyMap<string, string> = new Map(), context: RenderContext = {}): RenderedNote {
	const owner = ownerMarker(entry.id);
	const conflicts: string[] = [];
	const softConflicts: string[] = [];
	const detached: string[] = [];
	const reset: string[] = [];
	const report: SectionInfo[] = [];
	const images: ImagePlan[] = [];
	if (previous !== null && !previous.includes(owner)) return { content: previous, conflicts: ["Existing note is not owned by this Zotero item"], softConflicts, detached, reset, sections: report, images };
	const creators = creatorNames(entry);
	const authors = creators.filter(c => c.role === "author").map(c => c.name);
	const authorList = authors.length ? authors : creators.length ? creators.map(c => c.name) : entry.authors;
	const tags = filteredTags(entry.tags, settings);
	const itemType = metadataText(entry, "itemType");
	const journal = itemType === "journalArticle" ? metadataText(entry, "publicationTitle") : itemType === "preprint" ? metadataText(entry, "repository") : "";
	const related = (context.related ?? []).filter(citekey => /^[A-Za-z0-9_:.+/-]+$/.test(citekey));
	const sections = new Map<string, string>();
	// 0.6.1 R17: a switched-off part renders as an empty body; the block, its ID and its markers stay.
	const layout = layoutOf(settings);
	const callout = layout.callouts;

	const abstract = layout.abstract ? textFromHTML(entry.metadata.abstractNote) : "";
	sections.set("overview", [`# ${richInline(entry.title)}`, abstract ? quoted(`[!${callout.abstract}]\nabstract:: ${abstract}`) : ""].filter(Boolean).join("\n\n"));
	// 0.5 R12: without bibliography text an owned note keeps its `citation` section byte-identical (the section is simply
	// not re-rendered); a new note is refused rather than written with a placeholder.
	const citation = layout.citation ? bibliographyText(bibliography) : "";
	if (!layout.citation) sections.set("citation", "");
	else if (citation) sections.set("citation", quoted(`[!${callout.cite}]\n${citation}`));
	else if (previous === null) throw new Error(BIBLIOGRAPHY_REQUIRED_MESSAGE);

	const fields: [string, string][] = [];
	for (const creator of creators) fields.push([creator.role.charAt(0).toUpperCase() + creator.role.slice(1), inline(creator.name)]);
	if (!creators.length) for (const name of entry.authors) fields.push(["Author", inline(name)]);
	fields.push(["Title", richInline(entry.title)], ["Year", inline(entry.year)], ["Citekey", `@${safeCitekey(entry.citekey)}`]);
	if (tags.length) fields.push(["Tags", tags.map(inline).join(", ")]);
	if (itemType) fields.push(["itemType", itemType]);
	// 0.6.1: with "Fields by item type" the fields follow the item type (item-fields.ts); off, the 0.6.0 fixed list.
	const fieldValue = (spec: FieldSpec): string => {
		const value = spec.kind === "doi" ? safeDOI(entry.metadata[spec.field]) : metadataText(entry, spec.field);
		return value && spec.kind === "italic" ? `*${value}*` : value;
	};
	const pushSpecs = (specs: readonly FieldSpec[]): void => { for (const spec of specs) { const value = fieldValue(spec); if (value) fields.push([spec.label, value]); } };
	if (layout.itemTypeFields) pushSpecs(fieldsFor(itemType));
	else {
		if (journal) fields.push(["Journal", `*${journal}*`]);
		for (const [label, field] of [["Volume", "volume"], ["Issue", "issue"], ["Publisher", "publisher"], ["Location", "place"], ["Pages", "pages"], ["DOI", "DOI"], ["ISBN", "ISBN"]] as const) {
			const value = field === "DOI" ? safeDOI(entry.metadata[field]) : metadataText(entry, field);
			if (value) fields.push([label, value]);
		}
		if (itemType === "bookSection" && metadataText(entry, "publicationTitle")) fields.push(["Book", metadataText(entry, "publicationTitle")]);
	}
	if (entry.url) fields.push(["URL", safeURL(entry.url)]);
	if (entry.collections.length) fields.push(["Collections", entry.collections.map(inline).join("; ")]);
	if (layout.itemTypeFields) {
		for (const [label, value] of extraFields(entry.metadata.extra)) {
			const name = inline(label);
			if (name && inline(value) && !fields.some(([other]) => other.toLowerCase() === name.toLowerCase())) fields.push([name, inline(value)]);
		}
		pushSpecs(RECORD_DATES);
	}
	// Always present so the metadata hash does not flip merely because relations appear; the `[!Synth]` `Related::` line stays user-owned.
	fields.push(["Zotero related", related.map(citekey => `[[@${citekey}]]`).join(", ")]);
	const links = [`[Open in Zotero](${entry.zoteroSelectURI})`, ...entry.attachments.filter(a => a.path).map(a => `[${inline(a.title) || "Attachment"}](${fileURI(a.path ?? "")})`)];
	sections.set("metadata", [
		layout.metadata ? quoted(`[!${callout.metadata}]\n${fields.map(([label, value]) => `**${label}**:: ${value}`).join("\n")}`) : "",
		layout.links ? quoted(`[!${callout.links}]\n${links.join(" · ")}`) : "",
	].filter(Boolean).join("\n\n"));

	const notes: unknown[] = Array.isArray(entry.metadata.notes) ? entry.metadata.notes : [];
	const noteText = notes.map(n => {
		const html: unknown = typeof n === "string" ? n : n && typeof n === "object" && "note" in n ? (n as Record<string, unknown>).note : "";
		return typeof html === "string" ? noteBody(html, context.noteMarkdown) : "";
	}).filter(Boolean).join("\n\n---\n\n");
	sections.set("notes", layout.zoteroNotes ? `## Zotero notes\n\n${noteText || "*No Zotero notes.*"}` : "");

	const seen = new Set<string>();
	for (const { attachment, annotation: a } of readingOrder(entry)) {
		const id = `annotation-${key(attachment.key)}-${key(a.key)}`;
		if (a.attachmentKey !== attachment.key) throw new Error("Annotation attachment identity mismatch");
		if (seen.has(id)) continue;
		seen.add(id);
		let image: string | undefined;
		if (a.imagePath) {
			const extension = /\.(png|jpe?g|gif|webp)$/i.exec(a.imagePath)?.[1]?.toLowerCase();
			if (!extension) throw new Error("Unsupported annotation image extension");
			const digest = imageHashes.get(a.imagePath);
			if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Validated image content hash required before rendering");
			const library = entry.libraryType === "group" ? entry.groupID : entry.libraryID;
			if (library === undefined || !Number.isSafeInteger(library) || library < 0) throw new Error("Verified image library identity required");
			image = safeVaultPath(`${settings.imageFolder}/${entry.libraryType}-${library}-${key(attachment.key)}-${key(a.key)}-${digest}.${extension}`);
			images.push({ source: a.imagePath, path: image });
		}
		sections.set(id, annotationBody(a, image, entry, settings));
	}

	if (previous === null) {
		// 0.5 R14: exactly `type` plus LITERATURE_IDENTITY_KEYS, in that order; library scope lives in `zoteroSelectURI`.
		// `tags` mirrors Obsidian-valid slugs; `zotero_tags` and the `**Tags**::` field keep the raw Zotero tags.
		const values: Record<LiteratureIdentityKey, unknown> = {
			zoteroID: entry.id, zoteroSelectURI: entry.zoteroSelectURI, "zotero-key": entry.itemKey,
			citekey: entry.citekey, doi: entry.doi, title: entry.title, authors: authorList, year: entry.year, tags: normalizedTags(["zotero", ...tags]),
			zotero_title: entry.title, zotero_author: authorList, zotero_year: entry.year, zotero_journal: journal, zotero_doi: entry.doi, zotero_url: entry.url, zotero_tags: tags,
		};
		const yaml: [string, unknown][] = [["type", "zotero"], ...LITERATURE_IDENTITY_KEYS.map((k): [string, unknown] => [k, values[k]])];
		// JSON scalars and flow sequences are valid YAML and keep quoting unambiguous.
		const frontmatter = yaml.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
		const intro = ["overview", "citation"].map(id => block(id, sections.get(id) ?? "")).join("\n\n");
		// The Synthesis scaffold is user-owned from the start: written once, never managed.
		const synthesis = layout.synthesis ? `## Synthesis\n\n${quoted([`[!${callout.synthesis}]`, ...layout.synthesisLines].join("\n"))}` : "";
		const details = ["metadata", "notes"].map(id => block(id, sections.get(id) ?? "")).join("\n\n");
		const annotations = [...sections].filter(([id]) => id.startsWith("annotation-")).map(([id, body]) => block(id, body)).join("\n\n");
		for (const [id, body] of sections) report.push({ id, state: "fresh", reason: "new note", body });
		const body = [owner, intro, synthesis, details, "## Notes", `## ${layout.annotationsHeading}`].filter(Boolean).join("\n\n");
		return { content: `---\n${frontmatter}\n---\n\n${body}\n\n${annotations}\n`, conflicts, softConflicts, detached, reset, sections: report, images };
	}
	// 0.5 R5: per-block states; edited blocks are soft conflicts (kept verbatim, note still written), detached blocks are
	// user-owned and never re-rendered, malformed/duplicate/missing markers stay hard.
	const matched = new Set<string>();
	const detachWanted = new Set(context.detach ?? []);
	const resetWanted = new Set(context.reset ?? []);
	const consumed = new Set<number>();
	const lineOf = (offset: number): number => previous.slice(0, offset).split("\n").length;
	let content = previous.replace(MANAGED_BLOCK, (whole: string, id: string, mark: string, tail: string, body: string, offset: number) => {
		const line = lineOf(offset);
		consumed.add(offset);
		consumed.add(offset + whole.lastIndexOf("<!-- /cmds-zotero:"));
		const repaired = tail.trim() ? "; text after the opening marker was moved below the block" : "";
		if (matched.has(id)) {
			conflicts.push(`Duplicate managed section: ${id} (line ${line})`);
			report.push({ id, state: "malformed", reason: "duplicate managed section", line, body: "" });
			return whole;
		}
		matched.add(id);
		const fresh = sections.get(id);
		if (detachWanted.has(id) || (mark === DETACHED_MARK && !resetWanted.has(id))) {
			detached.push(id);
			report.push({ id, state: "detached", reason: `${mark === DETACHED_MARK ? "detached" : "detaching"}: user-owned, never updated${repaired}`, line, body });
			return withTail(detachedBlock(id, body), tail);
		}
		const edited = mark === DETACHED_MARK || !sectionUnedited(body, mark, fresh);
		if (edited && resetWanted.has(id) && fresh !== undefined) {
			reset.push(id);
			report.push({ id, state: "fresh", reason: `reset from Zotero${repaired}`, line, body: fresh });
			return withTail(block(id, fresh), tail);
		}
		if (mark === DETACHED_MARK) {
			detached.push(id);
			report.push({ id, state: "detached", reason: `cannot reset: no longer in Zotero${repaired}`, line, body });
			return withTail(detachedBlock(id, body), tail);
		}
		if (edited) {
			softConflicts.push(`Edited generated section preserved: ${id}`);
			report.push({ id, state: "edited", reason: `edited in the vault: preserved (detach to keep yours, reset to refresh)${repaired}`, line, body });
			return withTail(storedBlock(id, mark, body), tail);
		}
		if (fresh === undefined) {
			report.push({ id, state: "unchanged", reason: `no longer in Zotero: kept${repaired}`, line, body });
			return withTail(storedBlock(id, mark, body), tail);
		}
		report.push({ id, state: "unchanged", reason: `not edited: refreshed from Zotero${repaired}`, line, body: fresh });
		return withTail(block(id, fresh), tail);
	});
	// Markers outside any well-formed block (missing or damaged closing marker, no hash, stray duplicate) are reported per
	// ID with a line number; a generated section is never duplicated because of them.
	const malformed = new Set<string>();
	let strayCount = 0;
	for (const marker of previous.matchAll(MARKER)) {
		strayCount++;
		if (consumed.has(marker.index)) continue;
		const id = marker[2];
		if (malformed.has(id)) continue;
		malformed.add(id);
		const line = lineOf(marker.index);
		conflicts.push(`Malformed managed markers for ${id} (line ${line})`);
		if (!matched.has(id)) report.push({ id, state: "malformed", reason: "marker without a well-formed block", line, body: "" });
	}
	const rawCount = (previous.match(/<!-- \/?cmds-zotero:/g) ?? []).length;
	if (rawCount !== strayCount) conflicts.push("Malformed managed markers without a section ID");
	const additions: { id: string; text: string }[] = [];
	for (const [id, body] of sections) if (!matched.has(id) && !malformed.has(id)) {
		if (id.startsWith("annotation-") && !previous.includes(`cmds-zotero:${id}:`)) {
			additions.push({ id, text: block(id, body) });
			report.push({ id, state: "fresh", reason: "new annotation", body });
		} else {
			conflicts.push(`Missing managed section: ${id}`);
			report.push({ id, state: "missing", reason: "managed block not found", body: "" });
		}
	}
	if (additions.length) content = spliceAnnotationsInOrder(content, additions, [...sections.keys()].filter(id => id.startsWith("annotation-")), layout.annotationsHeading);
	return { content, conflicts, softConflicts, detached, reset, sections: report, images };
}
