export interface PageText {
	/** 1-based PDF page position, the value used in zotero://open-pdf?page=N. */
	page: number;
	/** Printed page label from the PDF's page-label tree, or "" when absent. */
	pageLabel: string;
	text: string;
}

export interface QuoteMatch {
	page: number;
	pageLabel: string;
	/** 1.0 for an exact normalized substring; lower values come from the token-window fallback. */
	score: number;
	snippet: string;
	method: "exact" | "tokens";
}

const LIGATURES: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "æ": "ae", "œ": "oe" };

/** Canonical comparison form: NFC, ligatures expanded, typographic quotes/dashes folded, soft hyphens and line-break hyphenation removed, whitespace collapsed, lower-case. */
export function normalizeForMatch(value: string): string {
	return value.normalize("NFC")
		.replace(/[ﬀ-ﬄæœ]/g, c => LIGATURES[c] ?? c)
		.replace(/­/g, "")
		.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
		.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"')
		.replace(/[‐-―−]/g, "-").replace(/…/g, "...")
		.replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenize(value: string): string[] { return normalizeForMatch(value).split(" ").filter(Boolean); }

function snippetAround(text: string, index: number, length: number): string {
	const start = Math.max(0, index - 60);
	const end = Math.min(text.length, index + length + 60);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Finds the page(s) containing a quote. Exact normalized substring first; otherwise the page whose
 * sliding token window shares the most tokens with the quote, reported with a proportional score.
 */
export function locateQuote(pages: PageText[], quote: string, minScore = 0.6): QuoteMatch[] {
	const needle = normalizeForMatch(quote);
	if (needle.length < 8) throw new Error("Quote must be at least 8 characters after normalization");
	const exact: QuoteMatch[] = [];
	const normalized = pages.map(page => ({ page, text: normalizeForMatch(page.text) }));
	for (const { page, text } of normalized) {
		const index = text.indexOf(needle);
		if (index >= 0) exact.push({ page: page.page, pageLabel: page.pageLabel, score: 1, snippet: snippetAround(text, index, needle.length), method: "exact" });
	}
	if (exact.length) return exact;
	// Quotes can straddle a page break: try the join of consecutive pages before falling back to tokens.
	for (let i = 0; i + 1 < normalized.length; i++) {
		const joined = `${normalized[i].text} ${normalized[i + 1].text}`;
		const index = joined.indexOf(needle);
		if (index >= 0 && index < normalized[i].text.length) exact.push({ page: normalized[i].page.page, pageLabel: normalized[i].page.pageLabel, score: 0.95, snippet: snippetAround(joined, index, needle.length), method: "exact" });
	}
	if (exact.length) return exact;
	const want = tokenize(quote);
	const results: QuoteMatch[] = [];
	for (const { page, text } of normalized) {
		const have = text.split(" ");
		if (!have.length) continue;
		const window = Math.min(have.length, Math.max(want.length * 2, 12));
		let best = 0;
		let bestAt = 0;
		const wantSet = new Set(want);
		let count = 0;
		const counts = new Map<string, number>();
		for (let i = 0; i < have.length; i++) {
			const add = have[i];
			if (wantSet.has(add)) { const c = (counts.get(add) ?? 0) + 1; counts.set(add, c); if (c === 1) count++; }
			if (i >= window) {
				const drop = have[i - window];
				if (wantSet.has(drop)) { const c = (counts.get(drop) ?? 1) - 1; counts.set(drop, c); if (c === 0) count--; }
			}
			if (count > best) { best = count; bestAt = Math.max(0, i - window + 1); }
		}
		const score = want.length ? best / new Set(want).size : 0;
		if (score >= minScore) {
			const charIndex = have.slice(0, bestAt).join(" ").length;
			results.push({ page: page.page, pageLabel: page.pageLabel, score: Math.round(score * 100) / 100, snippet: snippetAround(text, charIndex, Math.min(text.length - charIndex, needle.length)), method: "tokens" });
		}
	}
	return results.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, 5);
}

/** Selects pages by a "1-3,7" style range string against a 1-based page count. */
export function parsePageRange(value: string | undefined, count: number): number[] {
	if (!value) return Array.from({ length: count }, (_, i) => i + 1);
	const pages = new Set<number>();
	for (const part of value.split(",")) {
		const piece = part.trim();
		const range = /^(\d+)(?:-(\d+))?$/.exec(piece);
		if (!range) throw new Error(`Invalid page range: ${piece}`);
		const start = Number(range[1]);
		const end = range[2] ? Number(range[2]) : start;
		if (start < 1 || end < start || end > count) throw new Error(`Page range ${piece} is outside 1-${count}`);
		for (let n = start; n <= end; n++) pages.add(n);
	}
	return [...pages].sort((a, b) => a - b);
}

export interface TextItem { str: string; hasEOL?: boolean; transform?: number[]; width?: number }

/** Joins pdf.js text items into lines; inserts a space only where glyph runs are visibly separated. */
export function joinTextItems(items: TextItem[]): string {
	let out = "";
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		out += item.str;
		if (item.hasEOL) { out += "\n"; continue; }
		const next = items[i + 1];
		if (!next || !item.transform || !next.transform) continue;
		const gap = next.transform[4] - (item.transform[4] + (item.width ?? 0));
		const sameLine = Math.abs(next.transform[5] - item.transform[5]) < 2;
		if (!sameLine) out += "\n";
		else if (gap > 1 && !/\s$/.test(item.str) && !/^\s/.test(next.str)) out += " ";
	}
	return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}
