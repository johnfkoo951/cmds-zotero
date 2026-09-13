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
		const bracketDepth = (offset: number): number => {
			let depth = 0;
			for (let i = 0; i < offset; i++) { if (line[i] === "[") depth++; else if (line[i] === "]" && depth > 0) depth--; }
			return depth;
		};
		CITATION.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = CITATION.exec(line)) !== null) {
			if (match[1]) { occurrences.push({ citekey: match[1], line: index, column: match.index, form: "wikilink" }); continue; }
			const prefix = match[2] ?? "";
			const column = match.index + prefix.length;
			if (line.slice(0, column).endsWith("[[")) continue;
			// Email-like tokens have a word character immediately before the @ and are excluded by the prefix class.
			const form = bracketDepth(column) > 0 ? "pandoc" : "bare";
			occurrences.push({ citekey: match[3], line: index, column, form });
		}
	}
	return occurrences;
}

/** Unique citekeys in first-seen order. */
export function uniqueCitekeys(text: string): string[] {
	return [...new Set(scanCitations(text).map(item => item.citekey))];
}
