/**
 * 0.6.2 pandoc-export-kit: the files of an export kit and the rules for writing them. The kit is something the person
 * runs: a cleaned copy of the note, the cited sources as CSL-JSON, a pandoc defaults file and the command line. The
 * plugin never runs pandoc. Pure: no `obsidian` import.
 *
 * Paths inside the defaults file are relative to the defaults file (`${.}`, pandoc 2.17+) or the home directory
 * (`${HOME}`), so the kit names no absolute vault path and works from any working directory.
 */
import { createHash } from "crypto";

export const KIT_MANIFEST = "cmds-zotero-export.json";
export const KIT_BIBLIOGRAPHY = "references.json";
export const KIT_DEFAULTS = "defaults.yaml";
/** 0.6.6: the filter run after citeproc that keeps the citeproc settings out of the `.docx` document properties. */
export const KIT_DOCX_FILTER = "cmds-zotero-docx.lua";

export interface KitManifest {
	version: 1;
	/** Vault-relative path of the source note. */
	source: string;
	createdAt: string;
	/** File name → sha256 of the content the plugin wrote. */
	files: Record<string, string>;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A note's base name made safe as a folder and file name (no path separators, control characters or leading dots). */
export function kitName(basename: string): string {
	const safe = [...basename].map(char => char.charCodeAt(0) < 0x20 || "\\/:*?\"<>|".includes(char) ? "-" : char).join("");
	const name = safe.replace(/^\.+/, "").trim().slice(0, 120);
	return name || "note";
}

/** `<root>/<name>`, or `<root>/<name> <n>` for the n-th fresh folder (n ≥ 2). */
export function kitFolder(root: string, name: string, attempt = 1): string {
	const base = root.replace(/\/+$/, "");
	return `${base}/${name}${attempt > 1 ? ` ${attempt}` : ""}`;
}

export function parseManifest(text: string | null): KitManifest | null {
	if (!text) return null;
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== "object") return null;
		const record = value as Record<string, unknown>;
		if (record.version !== 1 || typeof record.source !== "string" || typeof record.createdAt !== "string" || !record.files || typeof record.files !== "object") return null;
		const files: Record<string, string> = {};
		for (const [name, digest] of Object.entries(record.files as Record<string, unknown>)) {
			if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || name.includes("/") || name.includes("\\")) return null;
			files[name] = digest;
		}
		return { version: 1, source: record.source, createdAt: record.createdAt, files };
	} catch { return null; }
}

export function manifestText(manifest: KitManifest): string {
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

export type KitDecision =
	| { kind: "write" }
	| { kind: "replace" }
	| { kind: "changed"; files: string[] }
	| { kind: "foreign"; files: string[] };

/**
 * Whether a kit may be written into a folder. `existing` maps each kit file name to its current content (null: absent).
 * An empty folder (no kit files) is written; a folder whose kit files all still match the manifest is replaced (it is the
 * plugin's own unchanged export); a changed or missing manifest file, or kit-named files without a manifest, refuse.
 */
export function kitDecision(manifest: string | null, existing: ReadonlyMap<string, string | null>): KitDecision {
	const present = [...existing].filter(([, content]) => content !== null).map(([name]) => name);
	if (manifest === null && !present.length) return { kind: "write" };
	const parsed = parseManifest(manifest);
	if (!parsed) return { kind: "foreign", files: present.length ? present : [KIT_MANIFEST] };
	const changed: string[] = [];
	for (const [name, digest] of Object.entries(parsed.files)) {
		const content = existing.get(name);
		if (content === undefined) continue;
		if (content === null || sha256(content) !== digest) changed.push(name);
	}
	for (const name of present) if (!(name in parsed.files)) changed.push(name);
	return changed.length ? { kind: "changed", files: changed } : { kind: "replace" };
}

/** A YAML scalar: JSON's double-quoted form is valid YAML and escapes everything that needs it. */
const scalar = (value: string): string => JSON.stringify(value);

export interface DefaultsInput {
	/** File name of the cleaned copy inside the kit folder. */
	input: string;
	/** File name pandoc writes, inside the kit folder. */
	output: string;
	/** CSL file: `${HOME}/…`, `${.}/…` or an absolute path; omitted when no file is known. */
	csl?: string;
	lang?: string;
	/** `${.}`-relative path from the kit folder to the vault root, e.g. `${.}/../..`. */
	vaultRoot: string;
	/** Vault-relative folder of the source note ("" for the vault root). */
	noteFolder: string;
	generator: string;
}

/** The pandoc defaults file of a kit. */
export function defaultsYaml(input: DefaultsInput): string {
	const resource = [input.vaultRoot, ...(input.noteFolder ? [`${input.vaultRoot}/${input.noteFolder}`] : []), "${.}"];
	const lines = [
		`# Written by ${input.generator}. Run: pandoc --defaults <this file>`,
		"# ${.} is the folder of this file; pandoc 2.17 or later is needed.",
		"from: markdown",
		"to: docx",
		`input-files:\n  - ${scalar(`\${.}/${input.input}`)}`,
		`output-file: ${scalar(`\${.}/${input.output}`)}`,
		`filters:\n  - citeproc\n  - ${scalar(`\${.}/${KIT_DOCX_FILTER}`)}`,
		`bibliography:\n  - ${scalar(`\${.}/${KIT_BIBLIOGRAPHY}`)}`,
		...(input.csl ? [`csl: ${scalar(input.csl)}`] : ["# csl: no installed CSL file was found for the style; pandoc uses its default (Chicago author-date)."]),
		`resource-path:\n${resource.map(path => `  - ${scalar(path)}`).join("\n")}`,
		"metadata:",
		"  link-citations: true",
		...(input.lang ? [`  lang: ${scalar(input.lang)}`] : []),
	];
	return `${lines.join("\n")}\n`;
}

/**
 * 0.6.6: the kit's filter, run after citeproc. Pandoc stores metadata a `.docx` has no slot for as custom document
 * properties, and the citeproc settings hold paths on this computer (the CSL file under the home folder, the kit folder),
 * so once citeproc has used them they are removed.
 */
export function docxFilterLua(generator: string): string {
	return `-- Written by ${generator}. Runs after citeproc (see ${KIT_DEFAULTS} in this folder).
-- Removes the citeproc settings, which hold paths on this computer, so the .docx does not keep them as document properties.
local CITEPROC_SETTINGS = { 'bibliography', 'csl', 'citation-abbreviations', 'link-citations', 'link-bibliography',
  'reference-section-title', 'suppress-bibliography', 'notes-after-punctuation', 'nocite', 'references' }

function Meta(meta)
  for _, key in ipairs(CITEPROC_SETTINGS) do meta[key] = nil end
  return meta
end
`;
}

/** `${.}/..` repeated once per segment of the kit folder: the vault root seen from the kit folder. */
export function vaultRootFrom(folder: string): string {
	const depth = folder.split("/").filter(Boolean).length;
	return ["${.}", ...Array.from({ length: depth }, () => "..")].join("/");
}

/** POSIX shell quoting for the command line. */
export function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The command the person runs (copied to the clipboard): `pandoc --defaults <absolute path of defaults.yaml>`, quoted for
 * a POSIX shell, or with double quotes for PowerShell and cmd on Windows.
 */
export function pandocCommand(defaultsPath: string, platform = "darwin"): string {
	if (platform === "win32") return `pandoc --defaults "${defaultsPath.replace(/\//g, "\\")}"`;
	return `pandoc --defaults ${shellQuote(defaultsPath)}`;
}
