/**
 * 0.6.2 installed-csl-style-picker: the CSL styles installed in Zotero, read from `<data directory>/styles/*.csl`. Read-only,
 * bounded (file count and size), regular files only (a symlinked style is skipped), and only the `<info>` block is parsed
 * with a small tolerant reader (no XML dependency). No `obsidian` import; the file system access is Node's.
 */
import { promises as fs } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { readLocalFile } from "../local-file";

export { dataDirectoryProblem } from "./rules";

/** Zotero's styles live under the data directory; the common macOS/Linux/Windows default is `~/Zotero`. */
export const DEFAULT_ZOTERO_DATA_DIRECTORY = "~/Zotero";
/** At most this many `.csl` files are read; a larger folder is listed up to the bound and says so. */
export const MAX_STYLE_FILES = 2000;
/** A style larger than this is skipped (the biggest repository styles are well under 1 MB). */
export const MAX_STYLE_BYTES = 2 * 1024 * 1024;
const ZOTERO_STYLE_PREFIX = /^https?:\/\/www\.zotero\.org\/styles\//;

export interface CslStyleInfo {
	/** The style's `<id>` as written (usually `http://www.zotero.org/styles/<name>`). */
	id: string;
	title: string;
	/** `<title-short>`, when present. */
	shortTitle?: string;
	/** `<link rel="independent-parent">` of a dependent style (no layout of its own; pandoc needs the parent file). */
	parent?: string;
	/** `default-locale` of the `<style>` element, when present. */
	defaultLocale?: string;
	/** `<category citation-format>` (`note`, `author-date`, `numeric`, …), when present; dependent styles carry it too. */
	citationFormat?: string;
	/** `class` of the `<style>` element (`note` or `in-text`); independent styles only. */
	styleClass?: string;
	/** True when the file has a `<bibliography>` layout (a dependent style has none of its own). */
	bibliography?: boolean;
}

export interface InstalledStyle extends CslStyleInfo {
	/** The value stored in settings and sent to Better BibTeX: the short name for zotero.org styles, else the full id. */
	key: string;
	/** Absolute path of the `.csl` file. */
	path: string;
	file: string;
}

export interface StyleListing {
	directory: string;
	styles: InstalledStyle[];
	/** Files skipped (symlink, too large, unreadable, no `<info>` id/title), by file name with the reason. */
	skipped: { file: string; reason: string }[];
	/** True when more than `MAX_STYLE_FILES` `.csl` files exist. */
	truncated: boolean;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/** XML text with the five named entities and numeric references decoded; unknown entities stay as written. */
export function decodeXmlText(value: string): string {
	return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]+);/g, (whole, name: string) => {
		if (name.startsWith("#")) {
			const code = name[1] === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
			return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[name] ?? whole;
	}).replace(/\s+/g, " ").trim();
}

function attribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
	const value = match ? match[1] ?? match[2] : undefined;
	return value === undefined ? undefined : decodeXmlText(value);
}

/**
 * The `<info>` facts of a CSL file: id and title are required; null when either is missing. XML comments are ignored and
 * only the first `<info>` block is read, so a malformed rest of the file never matters.
 */
export function parseCslInfo(xml: string): CslStyleInfo | null {
	const text = xml.replace(/^\uFEFF/, "").replace(/<!--[\s\S]*?-->/g, "");
	const info = /<info(?:\s[^>]*)?>([\s\S]*?)<\/info>/.exec(text);
	if (!info) return null;
	const element = (name: string): string | undefined => {
		const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(info[1]);
		return match ? decodeXmlText(match[1]) : undefined;
	};
	const id = element("id");
	const title = element("title");
	if (!id || !title || id.length > 500 || title.length > 500) return null;
	const style = /<style(?:\s[^>]*)?>/.exec(text)?.[0] ?? "";
	const defaultLocale = attribute(style, "default-locale");
	const shortTitle = element("title-short");
	let parent: string | undefined;
	for (const link of info[1].matchAll(/<link\s[^>]*>/g)) if (attribute(link[0], "rel") === "independent-parent") parent = attribute(link[0], "href");
	let citationFormat: string | undefined;
	for (const category of info[1].matchAll(/<category\s[^>]*>/g)) citationFormat ??= attribute(category[0], "citation-format");
	const styleClass = attribute(style, "class");
	const bibliography = /<bibliography[\s>]/.test(text);
	return {
		id, title, ...(shortTitle ? { shortTitle } : {}), ...(parent ? { parent } : {}), ...(defaultLocale ? { defaultLocale } : {}),
		...(citationFormat ? { citationFormat } : {}), ...(styleClass ? { styleClass } : {}), ...(bibliography ? { bibliography } : {}),
	};
}

/**
 * Word facts of an installed style for Zotero's document preferences: a note style (footnotes) and whether it has a
 * bibliography. A dependent style takes both from its installed parent; without the parent its category decides and a
 * bibliography is assumed.
 */
export function wordStyleFacts(styles: readonly InstalledStyle[], style: InstalledStyle): { noteStyle: boolean; hasBibliography: boolean } {
	const independent = independentStyle(styles, style);
	const noteStyle = (independent?.styleClass ?? (style.citationFormat === "note" ? "note" : "in-text")) === "note";
	return { noteStyle, hasBibliography: independent ? independent.bibliography === true : true };
}

/** The stored style value of a CSL id: `apa` for `http://www.zotero.org/styles/apa`, the full id otherwise. */
export function styleKey(id: string): string {
	const trimmed = id.trim();
	return ZOTERO_STYLE_PREFIX.test(trimmed) ? trimmed.replace(ZOTERO_STYLE_PREFIX, "") : trimmed;
}

/** True when two style values name the same style (`apa` and `http://www.zotero.org/styles/apa`). */
export function sameStyle(left: string, right: string): boolean {
	return styleKey(left) === styleKey(right);
}

/** The installed style a stored value names, matched by id, by short name or by file name (`apa.csl`), or null. */
export function findStyle(styles: readonly InstalledStyle[], value: string): InstalledStyle | null {
	const key = styleKey(value);
	return styles.find(style => style.key === key) ?? styles.find(style => style.file.replace(/\.csl$/i, "") === key) ?? null;
}

/** The independent style whose file pandoc can use for `style`: the style itself, or its installed parent. */
export function independentStyle(styles: readonly InstalledStyle[], style: InstalledStyle): InstalledStyle | null {
	if (!style.parent) return style;
	const parent = findStyle(styles, style.parent);
	return parent && !parent.parent ? parent : null;
}

/** The absolute data directory for a setting value (`~` expanded); an empty value is the default. */
export function expandDataDirectory(value: string, home: string = homedir()): string {
	const text = value.trim() || DEFAULT_ZOTERO_DATA_DIRECTORY;
	if (text === "~") return home;
	return resolve(text.startsWith("~/") ? join(home, text.slice(2)) : text);
}

/** `${HOME}/…` for a path inside the home directory (pandoc expands it in defaults files), else the path itself. */
export function homeRelative(path: string, home: string = homedir()): string {
	const root = home.replace(/\/+$/, "");
	return root && path.startsWith(`${root}/`) ? `\${HOME}/${path.slice(root.length + 1)}` : path;
}

const looksLikeXml = (head: Uint8Array): boolean => {
	let at = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
	while (at < head.length && (head[at] === 0x20 || head[at] === 0x09 || head[at] === 0x0a || head[at] === 0x0d)) at++;
	return head[at] === 0x3c; // "<"
};

/**
 * The installed styles of `<dataDirectory>/styles`, sorted by title. A missing folder is an error with a clear message;
 * single files that cannot be used are listed in `skipped`. Symlinked files are never followed.
 */
export async function listInstalledStyles(dataDirectory: string, options: { home?: string; maxFiles?: number } = {}): Promise<StyleListing> {
	const root = expandDataDirectory(dataDirectory, options.home);
	const directory = join(root, "styles");
	let names: string[];
	try { names = (await fs.readdir(directory)).filter(name => /\.csl$/i.test(name)).sort(); }
	catch { throw new Error(`No Zotero styles folder at ${directory}. Check the Zotero data directory setting (Zotero → Settings → Advanced → Files and folders).`); }
	const max = options.maxFiles ?? MAX_STYLE_FILES;
	const truncated = names.length > max;
	const real = await fs.realpath(directory);
	const styles: InstalledStyle[] = [];
	const skipped: StyleListing["skipped"] = [];
	for (const file of names.slice(0, max)) {
		const path = join(real, basename(file));
		try {
			const stat = await fs.lstat(path);
			if (stat.isSymbolicLink()) { skipped.push({ file, reason: "symlink" }); continue; }
			if (!stat.isFile()) { skipped.push({ file, reason: "not a file" }); continue; }
			const read = await readLocalFile(path, { maxBytes: MAX_STYLE_BYTES, magic: looksLikeXml, minBytes: 16, label: "CSL style" });
			const info = parseCslInfo(new TextDecoder("utf-8").decode(read.bytes));
			if (!info) { skipped.push({ file, reason: "no style id or title" }); continue; }
			styles.push({ ...info, key: styleKey(info.id), path, file });
		} catch (error) {
			skipped.push({ file, reason: error instanceof Error ? error.message : "unreadable" });
		}
	}
	styles.sort((left, right) => left.title.localeCompare(right.title) || left.key.localeCompare(right.key));
	return { directory: real, styles, skipped, truncated };
}
