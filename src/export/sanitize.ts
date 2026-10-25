/**
 * 0.6.2 export-sanitized-copy and wikilinks-to-citations-on-export: the cleaned copy of a note that the pandoc export kit
 * writes. The source note is never touched; this module only turns text into text. Pure: no `obsidian` import.
 *
 * In the copy: `%%` comments and the plugin's own markers are removed; callouts become plain blockquotes with a bold
 * title; `==highlights==` become `[text]{.mark}`; block IDs (`^id`) are dropped; `[[@key]]` and wikilinks or embeds that
 * resolve to a literature note become `[@key]`; image embeds become Markdown images; other wikilinks become their text.
 * A citation of a former citekey is written with the item's current key (the CSL-JSON carries current keys only).
 * Frontmatter, fenced code and inline code are copied as they are.
 */
import { citedKeySet, ignoredRegions } from "../citations/cited-keys";
import { locateReferencesBlock } from "../citations/references-block";

export type LinkTarget =
	| { kind: "literature"; citekey: string }
	| { kind: "image"; path: string }
	| { kind: "note"; path: string }
	| { kind: "missing" };

export interface SanitizeOptions {
	/** Resolves a wikilink path (no `#heading`, no `|alias`) from the source note. */
	resolve(linkpath: string): LinkTarget;
	/** Former citekey → the item's current citekey. */
	renamed?: ReadonlyMap<string, string>;
}

/**
 * Frontmatter keys that make a note a literature note for the plugin. The copy drops them so an exported literature note
 * is never taken for a second note of the same Zotero item; pandoc does not read them.
 */
export const IDENTITY_KEYS: readonly string[] = ["zoteroID", "zoteroSelectURI", "zotero-key", "citekey"];

/** The frontmatter block without the identity keys (each key line and its indented continuation lines). */
export function withoutIdentityKeys(frontmatter: string): { text: string; removed: number } {
	const lines = frontmatter.replace(/\r\n/g, "\n").split("\n");
	const kept: string[] = [];
	let skipping = false;
	let removed = 0;
	for (const line of lines) {
		const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
		if (key) {
			skipping = IDENTITY_KEYS.includes(key[1]);
			if (skipping) { removed++; continue; }
		} else if (skipping && (/^[ \t]/.test(line) || line === "")) continue;
		else skipping = false;
		kept.push(line);
	}
	return { text: kept.join("\n"), removed };
}

export interface SanitizeReport {
	/** Wikilinks and embeds written as `[@key]`. */
	citations: number;
	/** Former keys rewritten, with how often. */
	renamed: { from: string; to: string; count: number }[];
	/** Links that could not be resolved, written as their text (1-based line in the source note). */
	unresolved: { link: string; line: number }[];
	/** Embeds of notes (transclusions) written as the note's name; the copy does not inline other notes. */
	embedsNotInlined: { link: string; line: number }[];
	images: number;
	/** Links to notes written as plain text. */
	links: number;
	comments: number;
	markers: number;
	callouts: number;
	highlights: number;
	blockIds: number;
	/** Identity keys removed from the frontmatter. */
	identityKeys: number;
	/** The managed references section was replaced by pandoc's `::: {#refs}` placeholder. */
	referencesBlock: boolean;
}

const DROP = "\u0000";
const PLUGIN_MARKER = /^<!-- \/?cmds-zotero(?:-[a-z]+)?(?::[^\r\n]*?)? -->$/;
const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const HIGHLIGHT = /==([^=\n](?:[^\n]*?[^=\n])?)==/g;
const CALLOUT = /^((?:[ \t]*>)+)[ \t]*\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*(.*)$/;
const BLOCK_ID = /(^|[ \t])\^[A-Za-z0-9-]+[ \t]*$/;
const IMAGE = /\.(?:png|jpe?g|gif|svg|webp|bmp|avif|tiff?)$/i;

function lineAt(text: string, offset: number): number { return text.slice(0, offset).split(/\r?\n/).length; }

function display(target: string, alias: string | undefined): string {
	if (alias !== undefined && alias.trim()) return alias.trim();
	const [path, ...rest] = target.split("#");
	const name = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
	const sub = rest.filter(Boolean).map(part => part.replace(/^\^/, "")).join(" > ");
	return [name, sub].filter(Boolean).join(" > ") || target;
}

/** Prose transforms (wikilinks and highlights) of one segment outside code and comments. */
function transformProse(segment: string, offset: number, source: string, options: SanitizeOptions, report: SanitizeReport): string {
	const linked = segment.replace(WIKILINK, (whole: string, bang: string, inner: string, at: number) => {
		const [rawTarget, ...aliasParts] = inner.replace(/\\\|/g, "|").split("|");
		const alias = aliasParts.length ? aliasParts.join("|") : undefined;
		const target = rawTarget.trim();
		const line = lineAt(source, offset + at);
		const path = target.split("#")[0].trim();
		const resolved: LinkTarget = path ? options.resolve(path) : { kind: "note", path: "" };
		if (resolved.kind === "literature") { report.citations++; return `[@${resolved.citekey}]`; }
		if (target.startsWith("@")) {
			const key = target.slice(1).split("#")[0].trim();
			if (key) { report.citations++; return `[@${key}]`; }
		}
		if (bang && (resolved.kind === "image" || (resolved.kind === "missing" && IMAGE.test(path)))) {
			if (resolved.kind === "missing") { report.unresolved.push({ link: whole, line }); return display(target, alias); }
			report.images++;
			const caption = alias && !/^\d+(?:x\d+)?$/.test(alias.trim()) ? alias.trim() : "";
			return `![${caption}](<${resolved.path}>)`;
		}
		if (resolved.kind === "missing") { report.unresolved.push({ link: whole, line }); return display(target, alias); }
		if (bang && path) report.embedsNotInlined.push({ link: whole, line });
		else report.links++;
		return display(target, alias);
	});
	return linked.replace(HIGHLIGHT, (_whole: string, inner: string) => { report.highlights++; return `[${inner}]{.mark}`; });
}

function rewriteRenamed(text: string, renamed: ReadonlyMap<string, string>, report: SanitizeReport): string {
	if (!renamed.size) return text;
	const set = citedKeySet(text);
	const byLine = new Map<number, { citekey: string; line: number; column: number }[]>();
	for (const occurrence of [...set.occurrences, ...set.nocite]) {
		if (renamed.has(occurrence.citekey)) byLine.set(occurrence.line, [...(byLine.get(occurrence.line) ?? []), occurrence]);
	}
	if (!byLine.size) return text;
	const counts = new Map<string, number>();
	const lines = text.split("\n");
	for (const [line, occurrences] of byLine) {
		let content = lines[line];
		for (const occurrence of [...occurrences].sort((left, right) => right.column - left.column)) {
			const next = renamed.get(occurrence.citekey) ?? occurrence.citekey;
			const braced = content.startsWith(`@{${occurrence.citekey}}`, occurrence.column);
			const from = occurrence.column + (braced ? 2 : 1);
			if (content.slice(from, from + occurrence.citekey.length) !== occurrence.citekey) continue;
			content = `${content.slice(0, from)}${next}${content.slice(from + occurrence.citekey.length)}`;
			counts.set(occurrence.citekey, (counts.get(occurrence.citekey) ?? 0) + 1);
		}
		lines[line] = content;
	}
	for (const [from, count] of counts) report.renamed.push({ from, to: renamed.get(from) ?? from, count });
	return lines.join("\n");
}

/** The cleaned copy and what was changed. */
export function sanitizeForExport(source: string, options: SanitizeOptions): { text: string; report: SanitizeReport } {
	const report: SanitizeReport = { citations: 0, renamed: [], unresolved: [], embedsNotInlined: [], images: 0, links: 0, comments: 0, markers: 0, callouts: 0, highlights: 0, blockIds: 0, identityKeys: 0, referencesBlock: false };
	let text = source.replace(/\r\n/g, "\n");
	const block = locateReferencesBlock(text);
	if (block.kind === "found") {
		text = `${text.slice(0, block.start)}::: {#refs}\n:::${text.slice(block.end)}`;
		report.referencesBlock = true;
	}
	// Pass 1: comments and markers out, prose transforms in; code and frontmatter copied verbatim.
	const regions = ignoredRegions(text);
	let out = "";
	let at = 0;
	for (const region of [...regions, { start: text.length, end: text.length, kind: "end" as const }]) {
		if (region.start < at) continue;
		out += transformProse(text.slice(at, region.start), at, text, options, report);
		const raw = text.slice(region.start, region.end);
		if (region.kind === "frontmatter") { const stripped = withoutIdentityKeys(raw); out += stripped.text; report.identityKeys += stripped.removed; }
		else if (region.kind === "obsidian-comment") { out += DROP; report.comments++; }
		else if (region.kind === "html-comment" && PLUGIN_MARKER.test(raw.trim())) { out += DROP; report.markers++; }
		else out += raw;
		at = region.end;
	}
	// Pass 2, line by line outside fences: drop lines that held only removed text, callout titles, block IDs.
	const fences = ignoredRegions(out).filter(region => region.kind === "fence" || region.kind === "frontmatter");
	const lines = out.split("\n");
	const kept: string[] = [];
	let offset = 0;
	for (const raw of lines) {
		const start = offset;
		offset += raw.length + 1;
		if (fences.some(region => start >= region.start && start < region.end)) { kept.push(raw); continue; }
		const line = raw.includes(DROP) ? raw.split(DROP).join("") : raw;
		if (line !== raw && !line.trim()) continue;
		const callout = CALLOUT.exec(line);
		if (callout) {
			const title = callout[3].trim() || callout[2].charAt(0).toUpperCase() + callout[2].slice(1).toLowerCase();
			kept.push(`${callout[1].replace(/[ \t]+/g, "")} **${title}**`);
			report.callouts++;
			continue;
		}
		if (BLOCK_ID.test(line) && !/^\s*\|/.test(line)) {
			const stripped = line.replace(BLOCK_ID, "");
			report.blockIds++;
			if (!stripped.trim()) continue;
			kept.push(stripped);
			continue;
		}
		kept.push(line);
	}
	const cleaned = rewriteRenamed(kept.join("\n"), options.renamed ?? new Map(), report);
	return { text: cleaned, report };
}

/** Plain-text lines of the report for the export summary. */
export function sanitizeSummary(report: SanitizeReport): string[] {
	const lines: string[] = [];
	const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
	if (report.citations) lines.push(`${count(report.citations, "link")} to literature written as [@citekey].`);
	for (const item of report.renamed) lines.push(`@${item.from} (a former citekey) written as @${item.to} ${count(item.count, "time")}.`);
	if (report.images) lines.push(`${count(report.images, "image embed")} written as Markdown images.`);
	if (report.links) lines.push(`${count(report.links, "link")} to notes written as plain text.`);
	if (report.callouts) lines.push(`${count(report.callouts, "callout")} written as blockquotes.`);
	if (report.highlights) lines.push(`${count(report.highlights, "highlight")} written as [text]{.mark}.`);
	if (report.comments) lines.push(`${count(report.comments, "%% comment")} removed.`);
	if (report.markers) lines.push(`${count(report.markers, "CMDS Zotero marker")} removed.`);
	if (report.blockIds) lines.push(`${count(report.blockIds, "block ID")} removed.`);
	if (report.identityKeys) lines.push(`${count(report.identityKeys, "literature-note identity key")} removed from the frontmatter.`);
	if (report.referencesBlock) lines.push("The managed references section was replaced by ::: {#refs} so pandoc writes the bibliography there.");
	for (const item of report.embedsNotInlined) lines.push(`Line ${item.line}: ${item.link} embeds a note; only its name is in the copy.`);
	for (const item of report.unresolved) lines.push(`Line ${item.line}: ${item.link} could not be resolved; written as its text.`);
	return lines;
}
