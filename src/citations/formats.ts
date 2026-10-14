/**
 * 0.6.2 named citation formats: a FIXED list of output forms with no user templates or placeholders (a template engine is
 * outside the plugin's boundaries, docs/plugin-landscape-2026-10.md). Pure: never imports `obsidian`; the host supplies
 * the literature-note link of an entry for `note-link`.
 */
import type { CitationFormatSetting, ZoteroIndexEntry } from "../types";
import { markdownLink } from "../uris";
import { authorDateLabel } from "./author-date";

export type CitationFormat = CitationFormatSetting;

/** `command` is the palette label of the format's insert command. */
export interface CitationFormatInfo { id: CitationFormat; name: string; example: string; command: string }

/** The formats, in the order the settings and the command palette list them. */
export const CITATION_FORMATS: readonly CitationFormatInfo[] = [
	{ id: "pandoc", name: "Pandoc citation", example: "[@key]", command: "Insert pandoc citation" },
	{ id: "narrative", name: "Narrative citation", example: "@key", command: "Insert narrative citation" },
	{ id: "wikilink", name: "Citekey wikilink", example: "[[@key]]", command: "Insert citekey wikilink" },
	{ id: "author-date", name: "Author-date text", example: "(Kim & Lee, 2020)", command: "Insert author-date citation text" },
	{ id: "zotero-link", name: "Markdown link to Zotero", example: "[Kim & Lee, 2020](<zotero://select/…>)", command: "Insert Zotero item link" },
	{ id: "note-link", name: "Literature note link", example: "[[Literature note|Kim & Lee, 2020]]", command: "Insert literature note link" },
];

export const CITATION_FORMAT_IDS: readonly CitationFormat[] = CITATION_FORMATS.map(format => format.id);

export function isCitationFormat(value: unknown): value is CitationFormat {
	return typeof value === "string" && (CITATION_FORMAT_IDS as readonly string[]).includes(value);
}

/**
 * The citation of `entries` (at least one) in `format`. Several entries: one pandoc cluster `[@a; @b]`, otherwise the
 * single forms joined with `; ` (author-date text in one pair of parentheses). `noteLink` returns an entry's
 * literature-note link with the given alias, or null when it has no note; `note-link` then throws with the citekeys.
 */
export function formatCitation(format: CitationFormat, entries: readonly ZoteroIndexEntry[], noteLink?: (entry: ZoteroIndexEntry, alias: string) => string | null): string {
	if (!entries.length) throw new Error("Nothing to cite.");
	switch (format) {
		case "pandoc": return `[${entries.map(entry => `@${entry.citekey}`).join("; ")}]`;
		case "narrative": return entries.map(entry => `@${entry.citekey}`).join("; ");
		case "wikilink": return entries.map(entry => `[[@${entry.citekey}]]`).join("; ");
		case "author-date": return `(${entries.map(authorDateLabel).join("; ")})`;
		case "zotero-link": return entries.map(entry => markdownLink(authorDateLabel(entry), entry.zoteroSelectURI)).join("; ");
		case "note-link": {
			const missing: string[] = [];
			const links = entries.map(entry => {
				const link = noteLink?.(entry, authorDateLabel(entry)) ?? null;
				if (!link) missing.push(`@${entry.citekey}`);
				return link ?? "";
			});
			if (missing.length) throw new Error(`No literature note in this vault for ${missing.join(", ")}. Import ${missing.length === 1 ? "it" : "them"} first.`);
			return links.join("; ");
		}
	}
}

