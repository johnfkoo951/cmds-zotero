/**
 * 0.6.2 author-date approximations of citations ("(Kim & Lee, 2020, p. 3)") for the named `author-date` format and the
 * optional reading-view / live-preview rendering. These are approximations from index fields, not CSL output: no
 * citation processor is bundled (docs/plugin-landscape-2026-10.md). Pure: never imports `obsidian`.
 */
import type { ZoteroIndexEntry } from "../types";
import { locatorText, type CitationItem } from "./cluster";

export interface JoinAuthorOptions {
	/** Joins the last two names (default `&`, or `and` when `narrative` is true). */
	conjunction?: string;
	/** From this many names on, only the first is shown, followed by `et al.` / `외` (default 3). */
	etAlThreshold?: number;
	/** BCP 47 locale (e.g. `ko`, `ko-KR`). */
	locale?: string;
	/** Narrative citation (`Kim and Lee (2020)` / `김과 이 (2020)` vs `Kim & Lee, 2020` / `김·이, 2020`). */
	narrative?: boolean;
}

/** True when `name` consists entirely of precomposed Hangul syllables (`가`–`힣`). */
export function isHangulName(name: string): boolean {
	return /^[가-힣]+$/.test(name.trim());
}

/** Korean comitative particle (`와` after a vowel, `과` after a final consonant / batchim) for the last Hangul syllable of `word`. */
export function hangulParticle(word: string): "와" | "과" {
	const trimmed = word.trim();
	for (let index = trimmed.length - 1; index >= 0; index--) {
		const code = trimmed.charCodeAt(index);
		if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0 ? "과" : "와";
	}
	return "와";
}

/**
 * The author part of an author-date citation, APA-like: 1 → "Kim", 2 → "Kim & Lee" ("Kim and Lee" in narrative;
 * "김·이" / "김과 이" for Hangul or `ko` locale), 3+ → "Kim et al." ("김 외" for Hangul or `ko` locale).
 */
export function joinAuthorNames(names: readonly string[], options: JoinAuthorOptions = {}): string {
	const opts = options && typeof options === "object" ? options : {};
	const threshold = opts.etAlThreshold ?? 3;
	if (!names.length) return "";
	const korean = opts.conjunction === undefined && (/^ko\b/i.test(opts.locale ?? "") || names.every(isHangulName));
	if (names.length >= threshold) return korean ? `${names[0]} 외` : `${names[0]} et al.`;
	if (names.length === 1) return names[0];
	if (korean) {
		if (names.length === 2) return opts.narrative ? `${names[0]}${hangulParticle(names[0])} ${names[1]}` : `${names[0]}·${names[1]}`;
		return opts.narrative
			? `${names.slice(0, -1).join(", ")}${hangulParticle(names[names.length - 2])} ${names[names.length - 1]}`
			: names.join("·");
	}
	const conjunction = opts.conjunction ?? (opts.narrative ? "and" : "&");
	return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}

interface Creator { firstName?: unknown; lastName?: unknown; name?: unknown; creatorType?: unknown }

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/**
 * The surnames of an entry's authors, in order: Zotero's `lastName` (or the single-field `name`) of the creators typed
 * `author`, else of all creators (editors of an edited volume); without creator metadata, the last word of each indexed
 * author name ("Ann Smith" → "Smith", "Smith, Ann" → "Smith"), a name without spaces (김민지) as it is.
 */
export function authorSurnames(entry: Pick<ZoteroIndexEntry, "authors" | "metadata">): string[] {
	const creators = Array.isArray(entry.metadata?.creators) ? (entry.metadata.creators as unknown[]).filter((creator): creator is Creator => !!creator && typeof creator === "object") : [];
	const authors = creators.filter(creator => text(creator.creatorType) === "author" || !text(creator.creatorType));
	const chosen = (authors.length ? authors : creators).map(creator => text(creator.lastName) || text(creator.name)).filter(Boolean);
	if (chosen.length) return chosen;
	return entry.authors.map(name => {
		const trimmed = name.trim();
		if (trimmed.includes(",")) return trimmed.slice(0, trimmed.indexOf(",")).trim();
		const words = trimmed.split(/\s+/);
		return words[words.length - 1] ?? trimmed;
	}).filter(Boolean);
}

/** `Kim & Lee` (or a short title when the entry has no authors) and the year (`n.d.` when unknown). */
export function authorDateParts(entry: Pick<ZoteroIndexEntry, "authors" | "metadata" | "title" | "year">, options?: JoinAuthorOptions): { authors: string; year: string } {
	const names = joinAuthorNames(authorSurnames(entry), options);
	const title = entry.title.trim().split(/\s+/).slice(0, 4).join(" ");
	return { authors: names || (title ? `“${title}”` : "Anonymous"), year: entry.year || "n.d." };
}

/** `Kim & Lee, 2020` — the parenthetical label of one entry without parentheses. */
export function authorDateLabel(entry: Pick<ZoteroIndexEntry, "authors" | "metadata" | "title" | "year">, options?: JoinAuthorOptions): string;
export function authorDateLabel(entry: Pick<ZoteroIndexEntry, "authors" | "metadata" | "title" | "year">, index: number, array: readonly unknown[]): string;
export function authorDateLabel(entry: Pick<ZoteroIndexEntry, "authors" | "metadata" | "title" | "year">, options?: JoinAuthorOptions | number): string {
	const { authors, year } = authorDateParts(entry, typeof options === "object" ? options : undefined);
	return `${authors}, ${year}`;
}

/** `Kim and Lee (2020)` / `김과 이 (2020)` — a narrative citation. */
export function narrativeLabel(entry: Pick<ZoteroIndexEntry, "authors" | "metadata" | "title" | "year">, options?: JoinAuthorOptions): string {
	const { authors, year } = authorDateParts(entry, { ...(options && typeof options === "object" ? options : {}), narrative: true });
	return `${authors} (${year})`;
}

/**
 * One cluster rendered as `(see Kim & Lee, 2020, p. 3; 2019)`: prefixes, author suppression (`-@key` → year only),
 * locators and suffixes kept. Null when a citekey does not resolve to exactly one entry, so the source text stays.
 */
export function renderCluster(items: readonly Pick<CitationItem, "citekey" | "prefix" | "suppressAuthor" | "locator" | "rest">[], lookup: (citekey: string) => ZoteroIndexEntry | null, options?: JoinAuthorOptions): string | null {
	const parts: string[] = [];
	for (const item of items) {
		const entry = lookup(item.citekey);
		if (!entry) return null;
		const { authors, year } = authorDateParts(entry, options);
		const core = item.suppressAuthor ? year : `${authors}, ${year}`;
		parts.push(`${item.prefix ? `${item.prefix} ` : ""}${core}${locatorText(item.locator)}${item.rest.replace(/\s+$/, "")}`);
	}
	return parts.length ? `(${parts.join("; ")})` : null;
}
