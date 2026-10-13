export interface CitationOccurrence {
	citekey: string;
	line: number;
	column: number;
	form: "pandoc" | "bare" | "wikilink";
}

const KEY = "[A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*[A-Za-z0-9_]|[A-Za-z0-9_]";
/** Pandoc citation keys: `@key`, `-@key`, inside brackets or bare; wikilinks `[[@key]]`/`[[@key|alias]]`. */
const CITATION = new RegExp(`\\[\\[@(${KEY})(?:[|#][^\\]]*)?\\]\\]|(^|[\\s\\[;(,\\-])-?@(${KEY})`, "g");

/** Scans Markdown text for citation keys, skipping fenced code blocks and frontmatter. */
export function scanCitations(text: string): CitationOccurrence[] {
	const lines = text.split(/\r?\n/);
	const occurrences: CitationOccurrence[] = [];
	let fenced = false;
	let frontmatter = lines[0]?.trim() === "---";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (frontmatter) { if (index > 0 && line.trim() === "---") frontmatter = false; continue; }
		if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		// Bracket depth before a column ("[" opens, "]" closes an open bracket) is a left fold over the line. Matches come in
		// increasing column order, so the fold resumes where the previous match left it instead of restarting at column 0:
		// a long line with many citations stays linear (0.6 PERF-13).
		let depth = 0;
		let folded = 0;
		CITATION.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = CITATION.exec(line)) !== null) {
			if (match[1]) { occurrences.push({ citekey: match[1], line: index, column: match.index, form: "wikilink" }); continue; }
			const prefix = match[2] ?? "";
			const column = match.index + prefix.length;
			if (column >= 2 && line[column - 1] === "[" && line[column - 2] === "[") continue;
			for (; folded < column; folded++) {
				if (line[folded] === "[") depth++;
				else if (line[folded] === "]" && depth > 0) depth--;
			}
			// Email-like tokens have a word character immediately before the @ and are excluded by the prefix class.
			const form = depth > 0 ? "pandoc" : "bare";
			occurrences.push({ citekey: match[3], line: index, column, form });
		}
	}
	return occurrences;
}

/** Unique citekeys in first-seen order. */
export function uniqueCitekeys(text: string): string[] {
	return [...new Set(scanCitations(text).map(item => item.citekey))];
}

/** Frontmatter fields whose string-array items are bare citekeys (Citation Standard `cites`, `supports`, `counters`). */
export const FRONTMATTER_BARE_KEY_FIELDS = ["cites", "supports", "counters"] as const;
/** Frontmatter fields whose strings may carry `[@key]` tokens; bare `@key` and `[[wikilinks]]` are not citations there. */
export const FRONTMATTER_TOKEN_FIELDS = ["evidenceFor", "evidenceAgainst", "sourceCallout", "hypotheses"] as const;

export type FrontmatterCitationField = (typeof FRONTMATTER_BARE_KEY_FIELDS)[number] | (typeof FRONTMATTER_TOKEN_FIELDS)[number];

export interface FrontmatterCitation {
	citekey: string;
	field: FrontmatterCitationField;
	form: "bare" | "pandoc";
}

const BARE_KEY = new RegExp(`^(?:${KEY})$`);

function stringItems(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

/**
 * Citations declared in frontmatter: bare keys in `cites`/`supports`/`counters` and `[@key]` tokens inside the strings
 * of `evidenceFor`/`evidenceAgainst`/`sourceCallout`/`hypotheses`. Fields come out in that fixed order, items in YAML
 * order, every occurrence kept. `[[wikilinks]]`, bare `@key` inside YAML values and the note's own `citekey` are ignored.
 */
export function scanFrontmatterCitations(frontmatter: Record<string, unknown>): FrontmatterCitation[] {
	const own = typeof frontmatter.citekey === "string" ? frontmatter.citekey.trim() : "";
	const found: FrontmatterCitation[] = [];
	for (const field of FRONTMATTER_BARE_KEY_FIELDS) {
		for (const item of stringItems(frontmatter[field])) {
			const citekey = item.trim();
			if (BARE_KEY.test(citekey)) found.push({ citekey, field, form: "bare" });
		}
	}
	for (const field of FRONTMATTER_TOKEN_FIELDS) {
		for (const item of stringItems(frontmatter[field])) {
			for (const occurrence of scanCitations(item)) if (occurrence.form === "pandoc") found.push({ citekey: occurrence.citekey, field, form: "pandoc" });
		}
	}
	return own ? found.filter(item => item.citekey !== own) : found;
}
