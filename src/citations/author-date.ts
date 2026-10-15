/**
 * 0.6.2 author-date approximations of citations ("(Kim & Lee, 2020, p. 3)") for the named `author-date` format and the
 * optional reading-view / live-preview rendering. These are approximations from index fields, not CSL output: no
 * citation processor is bundled (docs/plugin-landscape-2026-10.md). Pure: never imports `obsidian`.
 */
import type { ZoteroIndexEntry } from "../types";
import { locatorText, type CitationItem } from "./cluster";

export interface JoinAuthorOptions {
	/** Joins the last two names (default `&`). */
	conjunction?: string;
	/** From this many names on, only the first is shown, followed by `et al.` (default 3). */
	etAlThreshold?: number;
}

/**
 * The author part of an author-date citation, APA-like: 1 → "Kim", 2 → "Kim & Lee", 3+ → "Kim et al.". Not covered,
 * since only index fields are available: Hangul conjunctions ("·", "와/과"), "and" in narrative citations, per-style
 * et-al thresholds (Chicago author-date: four) and same-surname disambiguation ("M. Kim", "2020a").
 */
export function joinAuthorNames(names: readonly string[], options: JoinAuthorOptions = {}): string {
	const conjunction = options.conjunction ?? "&";
	const threshold = options.etAlThreshold ?? 3;
	if (!names.length) return "";
	if (names.length >= threshold) return `${names[0]} et al.`;
	if (names.length === 1) return names[0];
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
export function authorDateParts(entry: Pick<ZoteroIndexEntry, "authors" | "metadata" | "title" | "year">): { authors: string; year: string } {
	const names = joinAuthorNames(authorSurnames(entry));
	const title = entry.title.trim().split(/\s+/).slice(0, 4).join(" ");
	return { authors: names || (title ? `“${title}”` : "Anonymous"), year: entry.year || "n.d." };
}

/** `Kim & Lee, 2020` — the parenthetical label of one entry without parentheses. */
export function authorDateLabel(entry: Pick<ZoteroIndexEntry, "authors" | "metadata" | "title" | "year">): string {
	const { authors, year } = authorDateParts(entry);
	return `${authors}, ${year}`;
}

/** `Kim & Lee (2020)` — a narrative citation. */
export function narrativeLabel(entry: Pick<ZoteroIndexEntry, "authors" | "metadata" | "title" | "year">): string {
	const { authors, year } = authorDateParts(entry);
	return `${authors} (${year})`;
}

/**
 * One cluster rendered as `(see Kim & Lee, 2020, p. 3; 2019)`: prefixes, author suppression (`-@key` → year only),
 * locators and suffixes kept. Null when a citekey does not resolve to exactly one entry, so the source text stays.
 */
export function renderCluster(items: readonly Pick<CitationItem, "citekey" | "prefix" | "suppressAuthor" | "locator" | "rest">[], lookup: (citekey: string) => ZoteroIndexEntry | null): string | null {
	const parts: string[] = [];
	for (const item of items) {
		const entry = lookup(item.citekey);
		if (!entry) return null;
		const { authors, year } = authorDateParts(entry);
		const core = item.suppressAuthor ? year : `${authors}, ${year}`;
		parts.push(`${item.prefix ? `${item.prefix} ` : ""}${core}${locatorText(item.locator)}${item.rest.replace(/\s+$/, "")}`);
	}
	return parts.length ? `(${parts.join("; ")})` : null;
}
