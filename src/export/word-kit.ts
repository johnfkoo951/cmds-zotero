/**
 * 0.6.6 word-zotero-fields: the Word variant of the export kit. Pandoc runs this kit's own filter and then Better BibTeX's
 * `zotero.lua`, which turns every citation into a live Zotero field. `zotero.lua` writes no document preferences and no
 * bibliography for `.docx`, so the kit's filter adds them: Zotero's document preferences (style, locale, footnotes) as the
 * custom properties `ZOTERO_PREF_1…n`, footnotes for the citations of a note style (as pandoc's citeproc makes them), and
 * a Zotero bibliography field. Word's Zotero plugin fills all of it on the first Refresh without asking for Document
 * Preferences. The plugin never runs pandoc and never ships or downloads `zotero.lua`. Pure: no `obsidian` import.
 */
import { join, win32 } from "path";
import { KIT_DEFAULTS } from "./kit";

export const WORD_FILTER = "cmds-zotero-word.lua";
export const ZOTERO_LUA = "zotero.lua";
export const ZOTERO_LUA_URL = "https://retorque.re/zotero-better-bibtex/exporting/zotero.lua";
/** Word keeps at most 255 characters in one custom document property; Zotero joins `ZOTERO_PREF_1`, `_2`, … in order. */
export const MAX_PREF_LENGTH = 255;

export interface ZoteroDocumentInput {
	/** The style's CSL id, e.g. `http://www.zotero.org/styles/chicago-notes-bibliography`. */
	styleId: string;
	/** BCP 47 locale, e.g. `en-US`. */
	locale: string;
	/** A note style: Zotero keeps the citations in footnotes. */
	noteStyle: boolean;
	hasBibliography: boolean;
	/** Eight letters or digits; Zotero starts its own session for an unknown id. */
	sessionId: string;
}

const xmlAttribute = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Zotero's document data (data version 3, the form Zotero writes back after a Refresh). `bibliographyStyleHasBeenSet="0"`
 * lets Zotero set Word's Bibliography paragraph style from the CSL on the first Refresh.
 */
export function zoteroDocumentData(input: ZoteroDocumentInput): string {
	const prefs = ["<pref name=\"fieldType\" value=\"Field\"/>", ...(input.noteStyle ? ["<pref name=\"noteType\" value=\"1\"/>"] : [])];
	return `<data data-version="3" zotero-version="7.0"><session id="${xmlAttribute(input.sessionId)}"/>`
		+ `<style id="${xmlAttribute(input.styleId)}" locale="${xmlAttribute(input.locale)}" hasBibliography="${input.hasBibliography ? 1 : 0}" bibliographyStyleHasBeenSet="0"/>`
		+ `<prefs>${prefs.join("")}</prefs></data>`;
}

/** `text` in pieces of at most `size` UTF-16 units, never splitting a character; joined they are `text` again. */
export function preferenceChunks(text: string, size = MAX_PREF_LENGTH): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const char of text) {
		if (current.length + char.length > size) { chunks.push(current); current = ""; }
		current += char;
	}
	if (current) chunks.push(current);
	return chunks;
}

const SESSION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** An eight-character session id from random bytes (at least eight). */
export function sessionId(bytes: Uint8Array): string {
	if (bytes.length < 8) throw new Error("sessionId needs eight random bytes.");
	return Array.from(bytes.slice(0, 8), byte => SESSION_ALPHABET[byte % SESSION_ALPHABET.length]).join("");
}

/** A Lua long-bracket string literal of `value`, with a level that `value` cannot close early. */
export function luaString(value: string): string {
	let level = 0;
	const close = (): string => `]${"=".repeat(level)}]`;
	while ((value + close()).indexOf(close()) !== value.length) level++;
	// Lua drops a newline that directly follows the opening bracket; a leading newline is doubled so it survives.
	return `[${"=".repeat(level)}[${value.startsWith("\n") ? "\n" : ""}${value}${close()}`;
}

export type BibliographyPlacement = "end" | "none";

/**
 * Where Word's bibliography goes when the copy has no `::: {#refs}` place, i.e. the note has no references section.
 * "end": a heading and a Zotero bibliography field after the last paragraph.
 * "none": no field; the author adds one in Word with Zotero → Add/Edit Bibliography.
 * Decided 2026-10-29: the reference list is made in Word, so a note without a references section still gets one, at the
 * end; a style without a bibliography gets none.
 */
export function bibliographyWithoutReferencesSection(style: { noteStyle: boolean; hasBibliography: boolean }): BibliographyPlacement {
	return style.hasBibliography ? "end" : "none";
}

/** True when the cleaned copy has pandoc's bibliography place, `::: {#refs}` (written for the managed references section). */
export function hasRefsPlace(markdown: string): boolean {
	return /^:{3,}[ \t]*\{[ \t]*#refs[ \t}]/m.test(markdown);
}

export interface WordFilterInput {
	generator: string;
	/** `zoteroDocumentData` in pieces of `preferenceChunks`. */
	prefs: readonly string[];
	noteStyle: boolean;
	hasBibliography: boolean;
	/** Used only when the copy has no `::: {#refs}`. */
	withoutRefs: BibliographyPlacement;
	/** The heading put above a bibliography added at the end (`withoutRefs` "end"); empty for none. */
	heading: string;
}

/**
 * The kit's Lua filter, run before `zotero.lua`. Its CONFIG table is the only part that differs between kits. Citations
 * already in a footnote stay where they are; a citation in the text of a note style becomes a footnote after the
 * punctuation that follows it (the space before it goes), the way pandoc's citeproc places notes. An author-in-text
 * citation (`@key` without brackets) stays in the text.
 */
export function wordFilterLua(input: WordFilterInput): string {
	const config = [
		"local CONFIG = {",
		`  prefs = { ${input.prefs.map(luaString).join(", ")} },`,
		`  note_style = ${input.noteStyle},`,
		`  has_bibliography = ${input.hasBibliography},`,
		`  bibliography_without_refs = ${luaString(input.withoutRefs)},`,
		`  heading = ${luaString(input.heading)},`,
		"}",
	];
	return `-- Written by ${input.generator}. Runs before Better BibTeX's zotero.lua (see ${KIT_DEFAULTS} in this folder).
-- Adds what zotero.lua leaves out for .docx: Zotero's document preferences, footnotes for a note style, the bibliography.
${config.join("\n")}

local function document_preferences(meta)
  for index, chunk in ipairs(CONFIG.prefs) do meta['ZOTERO_PREF_' .. index] = pandoc.MetaString(chunk) end
  return meta
end

local BIBLIOGRAPHY_FIELD = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
  .. '<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY </w:instrText></w:r>'
  .. '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
  .. '<w:r><w:rPr><w:noProof/></w:rPr><w:t>{Bibliography: press Refresh in the Zotero tab}</w:t></w:r>'
  .. '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

local PUNCTUATION = '^[%.,;:!?]+'

local function footnoted(inlines)
  local out = pandoc.List()
  local at = 1
  while at <= #inlines do
    local node = inlines[at]
    if node.t == 'Cite' and node.citations[1].mode ~= 'AuthorInText' then
      if #out > 0 and (out[#out].t == 'Space' or out[#out].t == 'SoftBreak') then out:remove(#out) end
      local note = pandoc.Note({ pandoc.Para({ node }) })
      local after = inlines[at + 1]
      local punctuation = after and after.t == 'Str' and after.text:match(PUNCTUATION)
      if punctuation then
        out:insert(pandoc.Str(punctuation))
        out:insert(note)
        local rest = after.text:sub(#punctuation + 1)
        if rest ~= '' then out:insert(pandoc.Str(rest)) end
        at = at + 2
      else
        out:insert(note)
        at = at + 1
      end
    else
      out:insert(node)
      at = at + 1
    end
  end
  return out
end

local refs_seen = false

local function refs_place(div)
  if div.identifier ~= 'refs' then return nil end
  refs_seen = true
  if not CONFIG.has_bibliography then return {} end
  return pandoc.RawBlock('openxml', BIBLIOGRAPHY_FIELD)
end

local function bibliography_at_end(doc)
  if refs_seen or not CONFIG.has_bibliography or CONFIG.bibliography_without_refs ~= 'end' then return nil end
  if CONFIG.heading ~= '' then doc.blocks:insert(pandoc.Header(2, CONFIG.heading)) end
  doc.blocks:insert(pandoc.RawBlock('openxml', BIBLIOGRAPHY_FIELD))
  return doc
end

local filters = { { Meta = document_preferences } }
if CONFIG.note_style then
  table.insert(filters, { traverse = 'topdown', Note = function(note) return note, false end, Inlines = footnoted })
end
table.insert(filters, { Div = refs_place })
table.insert(filters, { Pandoc = bibliography_at_end })
return filters
`;
}

/** A YAML scalar: JSON's double-quoted form is valid YAML and escapes everything that needs it. */
const scalar = (value: string): string => JSON.stringify(value);

export interface WordDefaultsInput {
	input: string;
	output: string;
	/** The style's short name or id, passed to `zotero.lua` (it reads `zotero.csl-style`). */
	style: string;
	lang?: string;
	vaultRoot: string;
	noteFolder: string;
	generator: string;
}

/**
 * The pandoc defaults file of a Word kit. No citeproc and no bibliography file: Zotero supplies the items while pandoc
 * runs. `zotero.lua` is named without a folder, so pandoc looks in the working directory and then in the `filters`
 * folder of its user data directory.
 */
export function wordDefaultsYaml(input: WordDefaultsInput): string {
	const resource = [input.vaultRoot, ...(input.noteFolder ? [`${input.vaultRoot}/${input.noteFolder}`] : []), "${.}"];
	const lines = [
		`# Written by ${input.generator}. Run while Zotero is open: pandoc --defaults <this file>`,
		"# Citations become live Zotero fields (Better BibTeX zotero.lua); in Word press Refresh in the Zotero tab once.",
		"# ${.} is the folder of this file; pandoc 2.17 or later is needed.",
		"from: markdown",
		"to: docx",
		`input-files:\n  - ${scalar(`\${.}/${input.input}`)}`,
		`output-file: ${scalar(`\${.}/${input.output}`)}`,
		`filters:\n  - ${scalar(`\${.}/${WORD_FILTER}`)}\n  - ${scalar(ZOTERO_LUA)}`,
		`resource-path:\n${resource.map(path => `  - ${scalar(path)}`).join("\n")}`,
		"metadata:",
		"  zotero:",
		`    csl-style: ${scalar(input.style)}`,
		"    author-in-text: true",
		...(input.lang ? [`  lang: ${scalar(input.lang)}`] : []),
	];
	return `${lines.join("\n")}\n`;
}

/**
 * Where pandoc finds a filter named without a folder: the `filters` folder of its user data directory, which is
 * `%APPDATA%\\pandoc` on Windows and `$XDG_DATA_HOME/pandoc` (or `~/.local/share/pandoc`) and the older `~/.pandoc` elsewhere.
 */
export function zoteroLuaLocations(home: string, env: { XDG_DATA_HOME?: string; APPDATA?: string } = {}, platform = "darwin"): string[] {
	if (platform === "win32") return [win32.join(env.APPDATA?.trim() || win32.join(home, "AppData", "Roaming"), "pandoc", "filters", ZOTERO_LUA)];
	const xdg = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
	return [join(xdg, "pandoc", "filters", ZOTERO_LUA), join(home, ".pandoc", "filters", ZOTERO_LUA)];
}

/** The one-line install of `zotero.lua` into pandoc's filters folder, shown when none was found (PowerShell on Windows). */
export function zoteroLuaInstallCommand(platform = "darwin"): string {
	if (platform === "win32") return `New-Item -ItemType Directory -Force "$env:APPDATA\\pandoc\\filters" | Out-Null; Invoke-WebRequest -Uri ${ZOTERO_LUA_URL} -OutFile "$env:APPDATA\\pandoc\\filters\\${ZOTERO_LUA}"`;
	return `mkdir -p ~/.local/share/pandoc/filters && curl -fsSL -o ~/.local/share/pandoc/filters/${ZOTERO_LUA} ${ZOTERO_LUA_URL}`;
}
