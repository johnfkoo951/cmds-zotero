/**
 * 0.6.2 bibliography format: style and locale (global settings, overridden per note by pandoc's `csl` and `lang`
 * frontmatter keys), the cache key they form, the order of a copied or inserted bibliography and the clipboard HTML.
 * Pure: no `obsidian` import.
 */
import { findStyle, styleKey, type InstalledStyle } from "./csl-styles";

/** `style`: the order the CSL style produces (Better BibTeX renders the whole list); `citation`: first citation in the note; `alphabetical`: by entry text. */
export type BibliographyOrder = "style" | "citation" | "alphabetical";
export const BIBLIOGRAPHY_ORDERS: readonly BibliographyOrder[] = ["style", "citation", "alphabetical"];

export interface BibliographyFormat {
	style: string;
	/** BCP 47 locale such as `en-US` or `ko-KR`; empty: the style's default locale. */
	locale: string;
}

export interface NoteFormat extends BibliographyFormat {
	/** Where each value came from. */
	styleFrom: "note" | "settings";
	localeFrom: "note" | "settings";
	/** The note's `csl` or `lang` values that could not be used, in words. */
	problems: string[];
}

const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

/** Why a locale cannot be sent to Better BibTeX, else null; empty means the style's default locale. */
export function localeProblem(value: string): string | null {
	const text = value.trim();
	if (!text) return null;
	return LOCALE.test(text) ? null : "Enter a locale such as en-US, de-DE or ko-KR, or leave it empty for the style's default.";
}

/** A locale written loosely (`ko_kr`, `EN-us`) in canonical case, or the input when it is not a locale at all. */
export function canonicalLocale(value: string): string {
	const parts = value.trim().replace(/_/g, "-").split("-");
	if (!parts[0]) return "";
	return parts.map((part, index) => index === 0 ? part.toLowerCase() : part.length === 4 ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part.toUpperCase()).join("-");
}

/**
 * The key one rendering is cached and stored under: the style alone without a locale, so sidecar records written before
 * 0.6.2 stay valid; `style@locale` otherwise.
 */
export function formatKey(format: BibliographyFormat): string {
	return format.locale ? `${format.style}@${format.locale}` : format.style;
}

function frontmatterString(frontmatter: Record<string, unknown> | null | undefined, key: string): string | null {
	const value = frontmatter?.[key];
	if (typeof value === "string") return value.trim() || null;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim() || null;
	return null;
}

/**
 * The style a pandoc `csl` value names. A path or file name (`styles/apa.csl`, `/abs/apa.csl`) is matched to an installed
 * style by file name, else its base name is used as the style name; a zotero.org style URL becomes its short name; any
 * other value is a style id as it is.
 */
export function styleFromCsl(value: string, styles: readonly InstalledStyle[] = []): string | null {
	const text = value.trim();
	if (!text || text.length > 500 || text.includes("\0")) return null;
	if (/\.csl$/i.test(text)) {
		const file = text.split(/[\\/]/).pop() ?? "";
		const installed = styles.find(style => style.file.toLowerCase() === file.toLowerCase());
		return installed ? installed.key : file.replace(/\.csl$/i, "") || null;
	}
	const installed = findStyle(styles, text);
	return installed ? installed.key : styleKey(text);
}

/** The format for one note: frontmatter `csl` and `lang` override the settings when usable (pandoc's own keys). */
export function noteFormat(frontmatter: Record<string, unknown> | null | undefined, settings: { bibliographyStyle: string; bibliographyLocale?: string }, styles: readonly InstalledStyle[] = []): NoteFormat {
	const problems: string[] = [];
	const csl = frontmatterString(frontmatter, "csl");
	const fromNote = csl ? styleFromCsl(csl, styles) : null;
	if (csl && !fromNote) problems.push(`The note's csl value "${csl.slice(0, 80)}" is not a style.`);
	const lang = frontmatterString(frontmatter, "lang");
	const locale = lang ? canonicalLocale(lang) : "";
	const localeOk = !!lang && localeProblem(locale) === null;
	if (lang && !localeOk) problems.push(`The note's lang value "${lang.slice(0, 40)}" is not a locale such as en-US or ko-KR.`);
	return {
		style: fromNote ?? settings.bibliographyStyle,
		locale: localeOk ? locale : settings.bibliographyLocale ?? "",
		styleFrom: fromNote ? "note" : "settings",
		localeFrom: localeOk ? "note" : "settings",
		problems,
	};
}

/** Short header text: `apa`, `apa · ko-KR`, with "from note" when the note chose either. */
export function formatLabel(format: NoteFormat): string {
	const text = format.locale ? `${format.style} · ${format.locale}` : format.style;
	return format.styleFrom === "note" || format.localeFrom === "note" ? `${text} (from note)` : text;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Entries in the requested order; `style` and `citation` keep the given order (the caller already has it). */
export function orderEntries<T>(items: readonly T[], order: BibliographyOrder, text: (item: T) => string): T[] {
	if (order !== "alphabetical") return [...items];
	return items.map((item, index) => ({ item, index, key: text(item).replace(/^[\s"'“‘([]+/, "") }))
		.sort((left, right) => collator.compare(left.key, right.key) || left.index - right.index)
		.map(row => row.item);
}

/**
 * Better BibTeX's text bibliography split into entries: one entry per non-empty line (citeproc's text output writes one
 * line per entry), trimmed.
 */
export function splitTextBibliography(text: string): string[] {
	return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Clipboard HTML for plain-text entries (cached or fallback text): one escaped paragraph per entry, in a csl-bib-body. */
export function entriesHtml(entries: readonly string[]): string {
	return `<div class="csl-bib-body">${entries.map(entry => `<div class="csl-entry">${escapeHtml(entry)}</div>`).join("")}</div>`;
}

/**
 * Text placed in a note's references section: one paragraph per entry. Comment and marker syntax inside an entry is
 * neutralised so an entry can never open or close a managed block or an Obsidian comment.
 */
export function markdownEntry(entry: string): string {
	return entry.replace(/\s*\n\s*/g, " ").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;").replace(/%%/g, "%​%").trim();
}
