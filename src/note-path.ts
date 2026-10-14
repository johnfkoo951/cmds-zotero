/**
 * 0.6.3 filename-folder-pattern: where a new literature note goes. The filename and the subfolder below the output folder
 * come from a FIXED token set (`NOTE_PATH_TOKENS`); there is no template engine, no expressions and no filters. Every
 * token value is sanitised for file names and bounded in length. The defaults (`@{citekey}`, no subfolder) reproduce the
 * 0.6.1 path `<outputFolder>/@<citekey>.md` exactly. Existing notes never move: the path only applies to a note that is
 * created. Pure module: no `obsidian` import.
 */
import type { ZoteroIndexEntry } from "./types";
import { creatorNames, safeVaultPath } from "./note-writer";

export const NOTE_PATH_TOKENS = ["citekey", "title", "shortTitle", "year", "firstAuthor", "itemType", "collection"] as const;
export type NotePathToken = typeof NOTE_PATH_TOKENS[number];

export const DEFAULT_FILENAME_PATTERN = "@{citekey}";
export const DEFAULT_FOLDER_PATTERN = "";
/** Longest file name (without `.md`) and longest folder segment written, in characters. */
export const MAX_FILENAME_LENGTH = 120;
export const MAX_SEGMENT_LENGTH = 60;
/** Folder segments a pattern may produce (deeper collection paths are cut). */
export const MAX_FOLDER_DEPTH = 4;

const TOKEN = /\{([A-Za-z]+)\}/g;
/** Characters no file name may carry here: path separators, the Windows set, Obsidian's link characters, and controls. */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g;

/** The message for a pattern that cannot be used, or null. `folder`: the subfolder pattern (may be empty; `/` separates segments). */
export function notePatternProblem(pattern: string, folder = false): string | null {
	const value = pattern.trim();
	if (!value) return folder ? null : "Enter a file name pattern, for example @{citekey}.";
	if ([...value].some(char => char.charCodeAt(0) < 32)) return "Control characters are not allowed.";
	const unknown = [...value.matchAll(TOKEN)].map(match => match[1]).filter(token => !(NOTE_PATH_TOKENS as readonly string[]).includes(token));
	if (unknown.length) return `Unknown token {${unknown[0]}}. Use ${NOTE_PATH_TOKENS.map(token => `{${token}}`).join(", ")}.`;
	const literal = value.replace(TOKEN, "");
	if (/[{}]/.test(literal)) return "Braces may only surround a token name.";
	if (!folder) {
		if (literal.includes("/")) return "The file name pattern cannot contain /; use the folder pattern for subfolders.";
		if (!/\{[A-Za-z]+\}/.test(value)) return "Use at least one token, for example {citekey}, so notes get different names.";
	} else if (value.startsWith("/") || value.split("/").some(part => part.trim() === "" || part.trim() === "." || part.trim() === "..")) {
		return "Use folder names separated by /, without empty, . or .. segments.";
	}
	if (/[\\:*?"<>|#^[\]]/.test(literal)) return "Remove characters that cannot be used in file names: \\ : * ? \" < > | # ^ [ ]";
	return null;
}

/** File-name-safe text: unsafe characters become spaces, whitespace collapses, leading/trailing dots and spaces go, length is bounded. */
export function sanitizeSegment(value: string, max: number): string {
	let text = [...value.normalize("NFC")].filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("")
		.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
	if ([...text].length > max) text = [...text].slice(0, max).join("").trim();
	return text.replace(/^[.\s]+|[.\s]+$/g, "");
}

/** The family name of the first author (any creator when there is no author), else the index's first author. */
function firstAuthor(entry: ZoteroIndexEntry): string {
	const creators = creatorNames(entry);
	const name = creators.find(creator => creator.role === "author")?.name ?? creators[0]?.name ?? entry.authors[0] ?? "";
	return name.split(",")[0].trim();
}

/** One token's raw value. `{collection}` is the alphabetically first collection path (deterministic), `Parent/Child`. */
export function tokenValue(entry: ZoteroIndexEntry, token: NotePathToken): string {
	const meta = (field: string): string => typeof entry.metadata[field] === "string" ? entry.metadata[field] : "";
	switch (token) {
		case "citekey": return entry.citekey;
		case "title": return entry.title.replace(/<[^>]*>/g, "");
		case "shortTitle": return (meta("shortTitle") || entry.title).replace(/<[^>]*>/g, "");
		case "year": return entry.year;
		case "firstAuthor": return firstAuthor(entry);
		case "itemType": return meta("itemType");
		case "collection": return [...entry.collections].sort((a, b) => a.localeCompare(b))[0] ?? "";
	}
}

function expand(pattern: string, entry: ZoteroIndexEntry, value: (token: NotePathToken) => string): string {
	return pattern.replace(TOKEN, (_whole, name: string) => (NOTE_PATH_TOKENS as readonly string[]).includes(name) ? value(name as NotePathToken) : "");
}

/** The file name (without `.md`) a pattern gives; an empty result falls back to the default `@<citekey>`. */
export function noteFilename(entry: ZoteroIndexEntry, pattern: string): string {
	const name = sanitizeSegment(expand(pattern.trim() || DEFAULT_FILENAME_PATTERN, entry, token => tokenValue(entry, token).replace(/\//g, " - ")), MAX_FILENAME_LENGTH);
	return name || sanitizeSegment(`@${entry.citekey}`, MAX_FILENAME_LENGTH);
}

/** The subfolder segments a folder pattern gives; a `{collection}` path keeps its levels. Empty segments are dropped. */
export function noteSubfolders(entry: ZoteroIndexEntry, pattern: string): string[] {
	if (!pattern.trim()) return [];
	// A pattern level that is exactly `{collection}` takes the collection's levels; inside other text its `/` reads ` - `.
	const segments = pattern.trim().split("/").flatMap(level => level.trim() === "{collection}"
		? tokenValue(entry, "collection").split("/")
		: [expand(level, entry, token => tokenValue(entry, token).replace(/\//g, " - "))]);
	return segments.map(segment => sanitizeSegment(segment, MAX_SEGMENT_LENGTH)).filter(Boolean).slice(0, MAX_FOLDER_DEPTH);
}

/**
 * The vault path of a new literature note: `<outputFolder>/<subfolders>/<filename>.md`. With the default patterns this is
 * `<outputFolder>/@<citekey>.md`, as 0.6.1 wrote it. Throws "Unsafe vault path" for a path the vault cannot hold.
 */
export function newNotePath(entry: ZoteroIndexEntry, settings: { outputFolder: string; noteFilenamePattern?: string; noteFolderPattern?: string }): string {
	const filenamePattern = settings.noteFilenamePattern ?? DEFAULT_FILENAME_PATTERN;
	const folderPattern = settings.noteFolderPattern ?? DEFAULT_FOLDER_PATTERN;
	if (filenamePattern.trim() === DEFAULT_FILENAME_PATTERN && !folderPattern.trim()) return safeVaultPath(`${settings.outputFolder}/@${entry.citekey}.md`);
	return safeVaultPath([settings.outputFolder, ...noteSubfolders(entry, folderPattern), `${noteFilename(entry, filenamePattern)}.md`].join("/"));
}
