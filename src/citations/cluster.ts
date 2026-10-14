/**
 * 0.6.2 citations editor: pandoc citation clusters on one line, with prefixes, locators and suffixes
 * (`[see @key, pp. 33–35; also -@k2, ch. 1]`), the citation under a column, locator edits and merging new keys into the
 * cluster at the cursor. Pure: never imports `obsidian`; columns are UTF-16 offsets into the line, as the editor counts.
 */
import { KEY } from "./scan";

/** A pandoc locator: the label as written (`p.`, `pp.`, `chap.` …; empty when a bare number implies a page) and its value. */
export interface Locator { label: string; value: string }

export interface CitationItem {
	form: "pandoc" | "bare" | "wikilink";
	citekey: string;
	/** Text before the key inside a bracket item (`see`), trimmed; empty outside brackets. */
	prefix: string;
	/** `-@key`: the author is suppressed. */
	suppressAuthor: boolean;
	locator: Locator | null;
	/** What follows the key (or the locator) inside the item, as written, e.g. `, emphasis added` or ` and *passim*`. */
	rest: string;
	/** Item span: for a bracket item the text between `[`/`;` and `;`/`]` without surrounding spaces; for a bare citation the `-@key` plus a following ` [locator]`; for a wikilink the whole `[[@key…]]`. */
	start: number;
	end: number;
	/** The citekey itself (after `@`). */
	keyStart: number;
	keyEnd: number;
}

export interface CitationCluster {
	/** Column of `[`. */
	start: number;
	/** Column after `]`. */
	end: number;
	items: CitationItem[];
}

/**
 * Pandoc locator terms (singular and plural, abbreviated or spelled out), longest first so `pp.` wins over `p.`. The edit
 * modal offers `LOCATOR_LABELS`; parsing accepts every term here.
 */
const LOCATOR_TERMS = [
	"pages", "page", "pp.", "p.", "chapters", "chapter", "chaps.", "chap.", "ch.", "sections", "section", "secs.", "sec.", "§§", "§",
	"figures", "figure", "figs.", "fig.", "paragraphs", "paragraph", "paras.", "para.", "¶¶", "¶", "lines", "line", "ll.", "l.",
	"notes", "note", "nn.", "n.", "volumes", "volume", "vols.", "vol.", "columns", "column", "cols.", "col.", "books", "book", "bks.", "bk.",
	"parts", "part", "pts.", "pt.", "verses", "verse", "vv.", "v.", "numbers", "number", "nos.", "no.", "folios", "folio", "fols.", "fol.",
	"opus", "op.", "sub verbo", "s.v.", "s.vv.",
];

/** Labels the locator modal offers, in this order. */
export const LOCATOR_LABELS: readonly string[] = ["p.", "pp.", "chap.", "sec.", "fig.", "para."];

/** Labels that point at pages (an empty label is a page too, as in pandoc). */
const PAGE_LABELS = new Set(["", "p.", "pp.", "page", "pages"]);

/** True when the locator names pages, so a PDF page can be derived from it. */
export function isPageLocator(locator: Locator): boolean { return PAGE_LABELS.has(locator.label.toLowerCase()); }

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TERM = LOCATOR_TERMS.map(escape).join("|");
/** One locator value: a number or roman numeral (optionally with a letter), a range, and comma-separated further numbers. */
const VALUE = "[0-9]+[a-z]?|[ivxlcdmIVXLCDM]+";
const LOCATOR_VALUE = `(?:${VALUE})(?:\\s*[-–—]\\s*(?:${VALUE}))?(?:\\s*,\\s*[0-9]+[a-z]?(?:\\s*[-–—]\\s*[0-9]+[a-z]?)?)*`;
const LABELLED = new RegExp(`^\\s*,?\\s*(${TERM})\\s*(${LOCATOR_VALUE})(?![\\p{L}\\p{N}])`, "u");
const UNLABELLED = new RegExp(`^\\s*,\\s*([0-9]+(?:\\s*[-–—]\\s*[0-9]+)?(?:\\s*,\\s*[0-9]+(?:\\s*[-–—]\\s*[0-9]+)?)*)(?![\\p{L}\\p{N}])`, "u");

/** Splits the text after a key into a locator and the rest; `rest` keeps its leading comma or space as written. */
export function parseLocator(suffix: string): { locator: Locator | null; rest: string } {
	const labelled = LABELLED.exec(suffix);
	if (labelled) return { locator: { label: labelled[1], value: labelled[2] }, rest: suffix.slice(labelled[0].length) };
	const bare = UNLABELLED.exec(suffix);
	if (bare) return { locator: { label: "", value: bare[1] }, rest: suffix.slice(bare[0].length) };
	return { locator: null, rest: suffix };
}

/** `, p. 33` / `, 33` / `` for no locator. */
export function locatorText(locator: Locator | null): string {
	if (!locator || !locator.value.trim()) return "";
	return locator.label ? `, ${locator.label} ${locator.value.trim()}` : `, ${locator.value.trim()}`;
}

const ITEM = new RegExp(`^(.*?)(-?)@(${KEY})(.*)$`, "su");
/** A bracket whose content has no other brackets and that is not a wikilink, an image or a Markdown link. */
const BRACKET = /\[([^[\]\n]*)\]/g;

/** Parses one bracket item (`see @key, p. 3, rest`); null when it has no citekey or the `@` is glued to a word. */
function parseItem(text: string, offset: number): CitationItem | null {
	const leading = text.length - text.trimStart().length;
	const body = text.trim();
	if (!body) return null;
	const match = ITEM.exec(body);
	if (!match) return null;
	const prefix = match[1];
	if (prefix && !/\s$/.test(prefix)) return null; // `me@example.org`, `x-@key`
	const start = offset + leading;
	const keyStart = start + prefix.length + match[2].length + 1;
	const { locator, rest } = parseLocator(match[4]);
	return { form: "pandoc", citekey: match[3], prefix: prefix.trim(), suppressAuthor: match[2] === "-", locator, rest, start, end: start + body.length, keyStart, keyEnd: keyStart + match[3].length };
}

/** Pandoc citation clusters on `line`, left to right. Every `;`-separated item must carry a citekey, as in pandoc. */
export function parseClusters(line: string): CitationCluster[] {
	const clusters: CitationCluster[] = [];
	BRACKET.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = BRACKET.exec(line)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		const before = line[start - 1];
		if (before === "[" || before === "!" || line[end] === "(" || line[end] === "]") continue;
		if (!match[1].includes("@")) continue;
		const items: CitationItem[] = [];
		let offset = start + 1;
		let valid = true;
		for (const part of match[1].split(";")) {
			const item = parseItem(part, offset);
			if (!item) { valid = false; break; }
			items.push(item);
			offset += part.length + 1;
		}
		if (valid && items.length) clusters.push({ start, end, items });
	}
	return clusters;
}

const BARE = new RegExp(`(^|[\\s(,])(-?)@(${KEY})`, "gu");
const WIKILINK = new RegExp(`\\[\\[@(${KEY})(?:[|#][^\\]]*)?\\]\\]`, "g");
const BRACKET_SUFFIX = /^ ?\[([^[\]@\n]*)\]/;

/** Every citation on the line: bracket items, wikilinks and bare `@key` (with a following ` [p. 3]` locator), by column. */
export function citationsOnLine(line: string): CitationItem[] {
	const items: CitationItem[] = [];
	const clusters = parseClusters(line);
	for (const cluster of clusters) items.push(...cluster.items);
	const covered = (column: number): boolean => clusters.some(cluster => column >= cluster.start && column < cluster.end) || items.some(item => item.form === "wikilink" && column >= item.start && column < item.end);
	WIKILINK.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = WIKILINK.exec(line)) !== null) {
		if (covered(match.index)) continue;
		const keyStart = match.index + 3;
		items.push({ form: "wikilink", citekey: match[1], prefix: "", suppressAuthor: false, locator: null, rest: "", start: match.index, end: match.index + match[0].length, keyStart, keyEnd: keyStart + match[1].length });
	}
	BARE.lastIndex = 0;
	while ((match = BARE.exec(line)) !== null) {
		const start = match.index + match[1].length;
		if (covered(start)) continue;
		const keyStart = start + match[2].length + 1;
		const keyEnd = keyStart + match[3].length;
		const suffix = BRACKET_SUFFIX.exec(line.slice(keyEnd));
		const parsed = suffix ? parseLocator(`, ${suffix[1].trim()}`) : null;
		const withSuffix = suffix && parsed?.locator ? suffix : null;
		items.push({
			form: "bare", citekey: match[3], prefix: "", suppressAuthor: match[2] === "-", locator: withSuffix ? parsed?.locator ?? null : null,
			rest: withSuffix ? parsed?.rest ?? "" : "", start, end: withSuffix ? keyEnd + withSuffix[0].length : keyEnd, keyStart, keyEnd,
		});
	}
	return items.sort((a, b) => a.start - b.start);
}

/** The citation at `column` (inclusive of both ends) and its cluster for bracket items; null when there is none. */
export function citationAt(line: string, column: number): { item: CitationItem; cluster: CitationCluster | null } | null {
	for (const cluster of parseClusters(line)) {
		if (column < cluster.start || column > cluster.end) continue;
		const item = cluster.items.find(candidate => column >= candidate.start && column <= candidate.end)
			?? cluster.items.reduce((best, candidate) => Math.abs(candidate.start - column) < Math.abs(best.start - column) ? candidate : best);
		return { item, cluster };
	}
	const item = citationsOnLine(line).find(candidate => candidate.form !== "pandoc" && column >= candidate.start && column <= candidate.end);
	return item ? { item, cluster: null } : null;
}

/** The text of a bracket item with a new locator (null removes it); prefix, author suppression and the rest are kept. */
export function itemText(item: Pick<CitationItem, "citekey" | "prefix" | "suppressAuthor" | "rest">, locator: Locator | null): string {
	return `${item.prefix ? `${item.prefix} ` : ""}${item.suppressAuthor ? "-" : ""}@${item.citekey}${locatorText(locator)}${item.rest}`;
}

/**
 * The edit that gives the citation `item` the locator `locator` (null or an empty value removes it): the column range to
 * replace and its new text. A bare citation takes its locator in a following bracket (`@key [p. 3]`), as in pandoc. A
 * wikilink citation has no locator: null.
 */
export function locatorEdit(item: CitationItem, locator: Locator | null): { from: number; to: number; text: string } | null {
	const next = locator && locator.value.trim() ? locator : null;
	if (item.form === "wikilink") return null;
	if (item.form === "pandoc") return { from: item.start, to: item.end, text: itemText(item, next) };
	const head = `${item.suppressAuthor ? "-" : ""}@${item.citekey}`;
	if (!next) return { from: item.start, to: item.end, text: item.rest.trim() ? `${head} [${item.rest.replace(/^\s*,?\s*/, "")}]` : head };
	return { from: item.start, to: item.end, text: `${head} [${locatorText(next).replace(/^, /, "")}${item.rest}]` };
}

/** One edit to a line: replace `from`–`to` with `text`, then put the cursor at `cursor` (all columns on that line). */
export interface LineEdit { from: number; to: number; text: string; cursor: number }

/**
 * Merges `items` (bracket item texts such as `@b` or `@b, p. 3`) into the cluster the cursor is in or directly follows
 * (`[@a]|`). Items whose citekey the cluster already has are left out; null when the cursor is not at a cluster, so the
 * caller inserts a new citation instead. An edit with empty text means every key was already cited there.
 */
export function mergeIntoCluster(line: string, column: number, items: readonly string[]): LineEdit | null {
	const cluster = parseClusters(line).find(candidate => column > candidate.start && column <= candidate.end);
	if (!cluster) return null;
	const present = new Set(cluster.items.map(item => item.citekey));
	const added: string[] = [];
	for (const text of items) {
		const parsed = parseItem(text, 0);
		if (!parsed || present.has(parsed.citekey)) continue;
		present.add(parsed.citekey);
		added.push(text.trim());
	}
	const at = cluster.end - 1;
	const text = added.map(item => `; ${item}`).join("");
	return { from: at, to: at, text, cursor: at + text.length + 1 };
}

/** The bracket items of a pandoc citation text that is exactly one cluster (`[@a; @b, p. 3]`), else null. */
export function clusterItems(text: string): string[] | null {
	const trimmed = text.trim();
	const clusters = parseClusters(trimmed);
	if (clusters.length !== 1 || clusters[0].start !== 0 || clusters[0].end !== trimmed.length) return null;
	return clusters[0].items.map(item => trimmed.slice(item.start, item.end));
}

/**
 * How accepting `citekey` in the `[@` suggester edits the line. `start` is the column of `@`, `end` the cursor. `default`
 * keeps the 0.6.1 insertions; typing `[@` right after a cluster (`[@a][@b`) adds `; @b` to that cluster instead.
 * `narrative` inserts `@key` without brackets (a fresh `[` is dropped); inside a cluster it behaves like `default`.
 */
export function acceptEdit(line: string, start: number, end: number, citekey: string, variant: "default" | "narrative"): LineEdit {
	const before = line.slice(0, start);
	const after = line.slice(end);
	const key = `@${citekey}`;
	if (before.endsWith("[[")) {
		const closer = after.startsWith("]]") ? "" : "]]";
		return { from: start, to: end, text: key + closer, cursor: start + key.length + closer.length };
	}
	if (before.endsWith("[")) {
		const bracket = start - 1;
		const previous = parseClusters(line.slice(0, bracket)).find(cluster => cluster.end === bracket);
		if (previous) {
			// `[@a][@b|]` or `[@a][@b|`: the new key joins the cluster before it.
			const to = after.startsWith("]") ? end + 1 : end;
			const present = previous.items.some(item => item.citekey === citekey);
			const text = present ? "]" : `; ${key}]`;
			return { from: bracket - 1, to, text, cursor: bracket - 1 + text.length };
		}
		if (variant === "narrative") {
			const to = after.startsWith("]") ? end + 1 : end;
			return { from: bracket, to, text: key, cursor: bracket + key.length };
		}
		const closer = after.startsWith("]") ? "" : "]";
		return { from: start, to: end, text: key + closer, cursor: start + key.length + closer.length };
	}
	if (/[[;]\s*-?$/.test(before)) return { from: start, to: end, text: key, cursor: start + key.length };
	const text = variant === "narrative" ? key : `[${key}]`;
	return { from: start, to: end, text, cursor: start + text.length };
}

/** The range the `[@` suggester replaces for a whole-link insertion: the opening `[`/`[[` and an auto-closed `]`/`]]` included. */
export function bracketSpan(line: string, start: number, end: number): { from: number; to: number } | null {
	const before = line.slice(0, start);
	const after = line.slice(end);
	if (/;\s*-?$/.test(before) || /\[\s*-$/.test(before)) return null; // inside a cluster or after `[-`: no whole link fits
	if (before.endsWith("[[")) return { from: start - 2, to: end + (after.startsWith("]]") ? 2 : 0) };
	if (before.endsWith("[")) return parseClusters(line.slice(0, start - 1)).some(cluster => cluster.end === start - 1) ? null : { from: start - 1, to: end + (after.startsWith("]") ? 1 : 0) };
	return { from: start, to: end };
}
