// 0.5 R8
/**
 * Line-level frontmatter patch for `reconcile --apply`. Replaces or appends the allowed hub key lines inside the
 * leading `---` block and leaves every other byte of the note untouched (comments, quoting style, folded scalars,
 * list layout, trailing whitespace, CRLF, BOM). It never parses YAML: the caller verifies the result with its YAML
 * library before and after the write. Pure: no `obsidian` import.
 */
import { HUB_WRITABLE_KEYS } from "./types";

export type PatchKey = typeof HUB_WRITABLE_KEYS[number];
export type PatchValue = string | boolean;
export type PatchChanges = Partial<Record<PatchKey, PatchValue>>;
export type PatchRefusal = "no-frontmatter" | "key-not-patchable" | "duplicate-key" | "quoted-key" | "multiline-value" | "unterminated";
export type PatchOutcome =
	| { ok: true; text: string; replaced: PatchKey[]; appended: PatchKey[] }
	| { ok: false; refuse: PatchRefusal; key?: string; message: string };

/** The leading `---` block of a note, split so that `[open, ...yaml, ...rest].join("\n")` reproduces the source bytes. */
export interface FrontmatterBlock {
	bom: string;
	/** Line terminator of the opening fence; appended lines reuse it. */
	eol: "\n" | "\r\n";
	/** YAML lines without `\n` (a trailing `\r` stays on the line). */
	yamlLines: string[];
	/** Lines from the closing fence onwards, same convention. */
	rest: string[];
}

const KEY_SET = new Set<string>(HUB_WRITABLE_KEYS);
// Plain scalars YAML 1.1 or 1.2 parsers (Obsidian's live parser, the `yaml` package offline) would read as something
// other than the same string: booleans and nulls, numbers in every base and the sexagesimal form, and timestamps.
const RESERVED_WORDS = /^(?:true|false|yes|no|on|off|null|y|n)$/i;
const NUMBER_LIKE = /^[-+]?(?:\.?\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.inf|\.nan|0x[0-9a-f_]+|0b[01_]+|0o?[0-7_]+|\d+(?::[0-5]?\d)+(?:\.\d*)?)$/i;
const TIMESTAMP_LIKE = /^\d{4}-\d{1,2}-\d{1,2}/;
/** The first character of a plain value: an ASCII letter, digit or `_`, or a letter or number of another script. */
const PLAIN_FIRST = /^[A-Za-z0-9_\p{L}\p{N}]/u;
/** Every later character: the first set plus combining marks and `. / : @ % + ~ -`; never whitespace, quotes, `#`, `\`, commas or brackets. */
const PLAIN_REST = /^[A-Za-z0-9_\p{L}\p{N}\p{M}./:@%+~-]*$/u;
/**
 * Characters JSON leaves raw that YAML must not see raw inside a double-quoted scalar: DEL and the C1 controls (not
 * printable in YAML), U+2028/U+2029 (line breaks to YAML 1.1 parsers), the byte-order mark and the two non-characters.
 */
const YAML_UNSAFE_RAW = /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g;

/** Splits the note into its frontmatter block; `null` when it does not start with a `---` fence, `"unterminated"` when the fence never closes. */
export function readFrontmatterBlock(text: string): FrontmatterBlock | null | "unterminated" {
	const bom = text.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
	const source = text.slice(bom.length);
	if (!/^---\r?\n/.test(source)) return source === "---" || source === "---\r" ? "unterminated" : null;
	const eol = source.startsWith("---\r\n") ? "\r\n" : "\n";
	const lines = source.slice(3 + eol.length).split("\n");
	const close = lines.findIndex(line => line === "---" || line === "---\r");
	if (close < 0) return "unterminated";
	return { bom, eol, yamlLines: lines.slice(0, close), rest: lines.slice(close) };
}

/** The YAML text between the fences (without the final line break), as a YAML library would see it. */
export function frontmatterText(block: FrontmatterBlock): string {
	return block.yamlLines.join("\n").replace(/\r$/, "");
}

/**
 * True when `value` may stand unquoted after `key: ` and every YAML parser reads it back as the same string. The rule is
 * a whitelist, so anything unusual (spaces, quotes, `#`, backslashes, control or separator characters, a leading
 * indicator, a trailing colon) is quoted instead of reasoned about.
 */
function plainSafe(value: string): boolean {
	if (!PLAIN_FIRST.test(value) || !PLAIN_REST.test(value) || value.endsWith(":")) return false;
	return !RESERVED_WORDS.test(value) && !NUMBER_LIKE.test(value) && !TIMESTAMP_LIKE.test(value);
}

/** A YAML double-quoted scalar: JSON string escapes (`\\`, `\"`, `\n`, `\t`, `\uXXXX`), a subset of YAML's, plus `\uXXXX` for the characters JSON leaves raw. */
function doubleQuoted(value: string): string {
	return JSON.stringify(value).replace(YAML_UNSAFE_RAW, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Booleans bare; strings bare only when {@link plainSafe}, otherwise double-quoted so they round-trip exactly (a backslash becomes `\\`). */
export function serializeScalar(value: PatchValue): string {
	if (typeof value === "boolean") return value ? "true" : "false";
	return plainSafe(value) ? value : doubleQuoted(value);
}

function keyLineIndexes(lines: string[], key: string): number[] {
	const prefix = `${key}:`;
	const found: number[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line.startsWith(prefix)) continue;
		const next = line.charAt(prefix.length);
		if (next === "" || next === " " || next === "\t" || next === "\r") found.push(i);
	}
	return found;
}

/** A column-0 quoted spelling of `key` (`"zoteroStatus": …`, `'zoteroStatus': …`): the same key to YAML, so appending a plain line would duplicate it. */
function hasQuotedKeyLine(lines: string[], key: string): boolean {
	return lines.some(line => line.startsWith(`"${key}"`) || line.startsWith(`'${key}'`));
}

/** Index just past the closing quote of a quoted scalar starting at `start`, or -1 when it does not close on this line. */
function quotedEnd(value: string, start: number): number {
	const quote = value.charAt(start);
	for (let i = start + 1; i < value.length; i += 1) {
		const char = value.charAt(i);
		if (quote === "\"" && char === "\\") { i += 1; continue; }
		if (char !== quote) continue;
		if (quote === "'" && value.charAt(i + 1) === "'") { i += 1; continue; }
		return i + 1;
	}
	return -1;
}

/** Splits the text after `key:` into the scalar and any trailing comment (with the whitespace that introduces it). */
function splitValue(raw: string): { scalar: string; comment: string } | "multiline" {
	const leading = /^[ \t]*/.exec(raw)?.[0].length ?? 0;
	const value = raw.slice(leading);
	if (!value || value.startsWith("#")) return { scalar: "", comment: value ? ` ${value}` : "" };
	const first = value.charAt(0);
	if (first === "|" || first === ">" || first === "[" || first === "{") return "multiline";
	if (first === "\"" || first === "'") {
		const end = quotedEnd(value, 0);
		if (end < 0) return "multiline";
		const tail = value.slice(end);
		if (tail && !/^[ \t]*(?:#.*)?$/.test(tail)) return "multiline";
		return { scalar: value.slice(0, end), comment: tail.trimEnd() ? tail : "" };
	}
	const comment = /[ \t]+#/.exec(value);
	return comment ? { scalar: value.slice(0, comment.index).trimEnd(), comment: value.slice(comment.index) } : { scalar: value.trimEnd(), comment: "" };
}

function hasContinuation(lines: string[], index: number, emptyValue: boolean): boolean {
	const next = lines[index + 1];
	if (next === undefined) return false;
	const line = next.replace(/\r$/, "");
	if (/^[ \t]+[^ \t#]/.test(line)) return true;
	return emptyValue && /^- /.test(line);
}

/**
 * Replaces the single column-0 `key:` line of each change (appending missing keys before the closing fence in
 * `HUB_WRITABLE_KEYS` order) and returns the patched text. A trailing comment on a replaced line is kept. Refuses,
 * writing nothing, when the note has no frontmatter, a key appears more than once or as a quoted key, or the current
 * value is a block scalar, flow collection, unterminated quote or has an indented/list continuation. The caller still
 * parses the result and compares every key before writing it.
 */
export function patchFrontmatterBlock(text: string, changes: PatchChanges): PatchOutcome {
	for (const key of Object.keys(changes)) {
		if (!KEY_SET.has(key)) return { ok: false, refuse: "key-not-patchable", key, message: `${key} is not a hub key reconcile may write.` };
	}
	const block = readFrontmatterBlock(text);
	if (block === null) return { ok: false, refuse: "no-frontmatter", message: "The note does not start with a --- frontmatter block." };
	if (block === "unterminated") return { ok: false, refuse: "unterminated", message: "The --- frontmatter block never closes." };
	const lines = [...block.yamlLines];
	const replaced: PatchKey[] = [];
	const appended: PatchKey[] = [];
	const missing: PatchKey[] = [];
	for (const key of HUB_WRITABLE_KEYS) {
		const value = changes[key];
		if (value === undefined) continue;
		const at = keyLineIndexes(lines, key);
		if (at.length > 1) return { ok: false, refuse: "duplicate-key", key, message: `${key} appears ${at.length} times in the frontmatter.` };
		if (hasQuotedKeyLine(lines, key)) return { ok: false, refuse: "quoted-key", key, message: `${key} is written as a quoted key; it is left for a human to edit.` };
		if (!at.length) { missing.push(key); continue; }
		const index = at[0];
		const line = lines[index];
		const cr = line.endsWith("\r") ? "\r" : "";
		const split = splitValue(line.slice(key.length + 1, line.length - cr.length));
		if (split === "multiline" || hasContinuation(lines, index, split.scalar === "")) {
			return { ok: false, refuse: "multiline-value", key, message: `${key} holds a block scalar, flow collection or multi-line value.` };
		}
		lines[index] = `${key}: ${serializeScalar(value)}${split.comment}${cr}`;
		replaced.push(key);
	}
	const cr = block.eol === "\r\n" ? "\r" : "";
	for (const key of missing) {
		const value = changes[key];
		if (value === undefined) continue;
		lines.push(`${key}: ${serializeScalar(value)}${cr}`);
		appended.push(key);
	}
	return { ok: true, text: `${block.bom}---${block.eol}${[...lines, ...block.rest].join("\n")}`, replaced, appended };
}
