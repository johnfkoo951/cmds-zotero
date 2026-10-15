/**
 * 0.6.3 per-note frontmatter line patches (frontmatter-refresh, legacy-key-cleanup, merged-item-relink, adopt): the R8
 * line patch (`agent/frontmatter-patch.ts`) generalised to the literature-note keys. Only the lines of the keys being set
 * or removed change; every other byte of the note (other keys, comments, quoting, CRLF, BOM, the body) stays. A refreshed
 * key keeps its quoting style and its list layout. YAML is never re-serialised (so not FileManager.processFrontMatter, which
 * rewrites the whole block): the host verifies the patched text with its YAML parser (`verifyFrontmatterEdit`) before and
 * after writing. Pure module: no `obsidian` import.
 */
import { LEGACY_LITERATURE_KEYS, LITERATURE_IDENTITY_KEYS, type LiteratureIdentityKey } from "./agent/types";
import { doubleQuoted, hasQuotedKeyLine, keyLineIndexes, readFrontmatterBlock, serializeScalar, splitValue } from "./agent/frontmatter-patch";
import type { ZoteroIndexEntry } from "./types";
import { literatureFrontmatterValues, ownerMarker } from "./note-writer";

export type FrontmatterValue = string | boolean | readonly string[];
export interface FrontmatterEdit {
	/** Keys to replace (or, with `append`, to add when missing). */
	set?: Readonly<Record<string, FrontmatterValue>>;
	/** Keys to remove, with their continuation lines. */
	remove?: readonly string[];
	/** Add `set` keys that are missing before the closing fence (in `set` order); without it a missing key is an error. */
	append?: boolean;
	/** A note without frontmatter gets a new block at the top (adopt only). */
	create?: boolean;
}
export type EditRefusal = "no-frontmatter" | "unterminated" | "duplicate-key" | "quoted-key" | "multiline-value" | "missing-key";
export type EditOutcome =
	| { ok: true; text: string; replaced: string[]; appended: string[]; removed: string[] }
	| { ok: false; refuse: EditRefusal; key?: string; message: string };

/** Keys the opt-in refresh may rewrite: the plugin's metadata keys. Never `zoteroID` (relink does that) or `tags` (yours). */
export const REFRESH_KEYS: readonly LiteratureIdentityKey[] = LITERATURE_IDENTITY_KEYS.filter(key => key !== "zoteroID" && key !== "tags");
/**
 * Keys 0.3/0.4 wrote (derivable from `zoteroID`). Only keys this project is known to have written count: a key some other
 * convention uses (for example a `zotero_citekey` that Dataview queries read) is never removed on a guess.
 */
export const LEGACY_FRONTMATTER_KEYS: readonly string[] = [...LEGACY_LITERATURE_KEYS];

/** The line just past the value of the key at `index`: indented lines, and `- ` items when the value is empty. Blank lines inside a block count. */
function valueEnd(lines: readonly string[], index: number, emptyValue: boolean): number {
	let end = index + 1;
	for (let j = index + 1; j < lines.length; j++) {
		const line = lines[j].replace(/\r$/, "");
		if (/^[ \t]+\S/.test(line) || (emptyValue && /^-(?: |$)/.test(line))) { end = j + 1; continue; }
		if (/^[ \t]*$/.test(line)) continue;
		break;
	}
	return end;
}

/** Characters a single-quoted YAML scalar cannot hold raw: C0/C1 controls, line and paragraph separators, the byte-order mark. */
function unsafeInSingleQuotes(value: string): boolean {
	return [...value].some(char => {
		const code = char.charCodeAt(0);
		return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff;
	});
}

function quoteLike(value: string, style: string): string {
	if (style.startsWith("\"")) return doubleQuoted(value);
	if (style.startsWith("'") && !unsafeInSingleQuotes(value)) return `'${value.replace(/'/g, "''")}'`;
	return serializeScalar(value);
}

/** The new lines for `key`, in the layout of the current value (`current`: the key's lines, the key line first). */
function renderKey(key: string, value: FrontmatterValue, current: readonly string[] | null, cr: string): string[] | "multiline" {
	const first = current?.[0].replace(/\r$/, "") ?? "";
	const raw = first.slice(key.length + 1);
	const trimmed = raw.trim();
	if (typeof value === "boolean" || typeof value === "string") {
		if (current && current.length > 1) return "multiline";
		if (!current) return [`${key}: ${serializeScalar(value)}${cr}`];
		const split = splitValue(raw);
		if (split === "multiline") return "multiline";
		return [`${key}: ${typeof value === "boolean" ? serializeScalar(value) : quoteLike(value, split.scalar)}${split.comment}${cr}`];
	}
	const items = [...value];
	// A block list keeps its layout (`- a` or `  - a`); anything else becomes a flow list like new notes write.
	const list = current && current.length > 1 && !trimmed ? current.slice(1).filter(line => line.replace(/\r$/, "").trim()) : null;
	if (list && list.every(line => /^[ \t]*- /.test(line))) {
		const indent = /^([ \t]*)- /.exec(list[0])?.[1] ?? "";
		return items.length ? [`${key}:${cr}`, ...items.map(item => `${indent}- ${serializeScalar(item)}${cr}`)] : [`${key}: []${cr}`];
	}
	if (current && (current.length > 1 || (trimmed && !(trimmed.startsWith("[") && trimmed.endsWith("]"))))) return "multiline";
	return [`${key}: [${items.map(item => doubleQuoted(item)).join(",")}]${cr}`];
}

/**
 * Applies `edit` line by line. Refuses (writing nothing) when the note has no frontmatter (unless `create`), a key appears
 * twice or as a quoted key, a scalar key holds a block scalar or a nested value, or a set key is missing without `append`.
 */
export function editFrontmatterLines(text: string, edit: FrontmatterEdit): EditOutcome {
	const set = edit.set ?? {};
	const remove = edit.remove ?? [];
	let block = readFrontmatterBlock(text);
	if (block === "unterminated") return { ok: false, refuse: "unterminated", message: "The --- frontmatter block never closes." };
	let source = text;
	if (block === null) {
		if (!edit.create) return { ok: false, refuse: "no-frontmatter", message: "The note does not start with a --- frontmatter block." };
		const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
		const eol = text.includes("\r\n") ? "\r\n" : "\n";
		source = `${bom}---${eol}---${eol}${text.slice(bom.length)}`;
		block = readFrontmatterBlock(source);
		if (block === null || block === "unterminated") return { ok: false, refuse: "no-frontmatter", message: "The frontmatter block could not be created." };
	}
	const cr = block.eol === "\r\n" ? "\r" : "";
	let lines = [...block.yamlLines];
	const replaced: string[] = [];
	const appended: string[] = [];
	const removed: string[] = [];
	const locate = (key: string): { at: number; end: number } | null | EditOutcome => {
		const at = keyLineIndexes(lines, key);
		if (at.length > 1) return { ok: false, refuse: "duplicate-key", key, message: `${key} appears ${at.length} times in the frontmatter.` };
		if (hasQuotedKeyLine(lines, key)) return { ok: false, refuse: "quoted-key", key, message: `${key} is written as a quoted key; edit it by hand.` };
		if (!at.length) return null;
		const empty = !lines[at[0]].replace(/\r$/, "").slice(key.length + 1).trim();
		return { at: at[0], end: valueEnd(lines, at[0], empty) };
	};
	for (const key of remove) {
		const found = locate(key);
		if (found && "ok" in found) return found;
		if (!found) continue;
		lines = [...lines.slice(0, found.at), ...lines.slice(found.end)];
		removed.push(key);
	}
	const missing: string[] = [];
	for (const [key, value] of Object.entries(set)) {
		const found = locate(key);
		if (found && "ok" in found) return found;
		if (!found) { missing.push(key); continue; }
		const next = renderKey(key, value, lines.slice(found.at, found.end), cr);
		if (next === "multiline") return { ok: false, refuse: "multiline-value", key, message: `${key} holds a block scalar or a nested value; edit it by hand.` };
		lines = [...lines.slice(0, found.at), ...next, ...lines.slice(found.end)];
		replaced.push(key);
	}
	for (const key of missing) {
		if (!edit.append) return { ok: false, refuse: "missing-key", key, message: `${key} is not in the frontmatter.` };
		const next = renderKey(key, set[key], null, cr);
		if (next === "multiline") return { ok: false, refuse: "multiline-value", key, message: `${key} cannot be written.` };
		lines.push(...next);
		appended.push(key);
	}
	return { ok: true, text: `${block.bom}---${block.eol}${[...lines, ...block.rest].join("\n")}`, replaced, appended, removed };
}

/** Structural equality of parsed YAML values (key order ignored). */
function same(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
	if (a && b && typeof a === "object" && typeof b === "object") {
		const ka = Object.keys(a).sort();
		const kb = Object.keys(b).sort();
		return same(ka, kb) && ka.every(key => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
	}
	if (a instanceof Date || b instanceof Date) return String(a) === String(b);
	return a === b;
}

/** The YAML between the fences (null without frontmatter) and the body after the closing fence. */
export function frontmatterAndBody(text: string): { yaml: string | null; body: string } { return split(text); }

function split(text: string): { yaml: string | null; body: string } {
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(source);
	return { yaml: match ? match[1] ?? "" : null, body: match ? source.slice(match[0].length) : source };
}

/**
 * The problem with a patched note, or null: its YAML must parse to a mapping, every key the edit does not touch must
 * parse to the same value as before, set keys to their new values and removed keys must be gone. The body must equal
 * `body` (default: the body before the edit).
 */
export function verifyFrontmatterEdit(before: string, after: string, edit: FrontmatterEdit, parseYaml: (yaml: string) => unknown, body?: string): string | null {
	const parse = (yaml: string | null): Record<string, unknown> | null | "error" => {
		if (yaml === null || !yaml.trim()) return {};
		try {
			const value = parseYaml(yaml);
			return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : value === null || value === undefined ? {} : "error";
		} catch { return "error"; }
	};
	const old = split(before);
	const next = split(after);
	const oldYaml = parse(old.yaml);
	const newYaml = parse(next.yaml);
	if (newYaml === "error" || newYaml === null) return "The patched frontmatter does not parse.";
	if (oldYaml === "error" || oldYaml === null) return "The frontmatter did not parse before the patch.";
	if (next.body !== (body ?? old.body)) return "The patch changed the note body.";
	const set = edit.set ?? {};
	const remove = new Set(edit.remove ?? []);
	for (const key of new Set([...Object.keys(oldYaml), ...Object.keys(newYaml)])) {
		if (key in set) {
			const expected = set[key];
			if (!same(newYaml[key], typeof expected === "string" || typeof expected === "boolean" ? expected : [...expected])) return `${key} does not read back as the new value.`;
		} else if (remove.has(key)) {
			if (key in newYaml) return `${key} is still in the frontmatter.`;
		} else if (!same(oldYaml[key], newYaml[key])) return `${key} changed although the patch does not touch it.`;
	}
	return null;
}

/** Loose comparison for planning: a stored `2021` and `"2021"` are the same year; lists compare item by item as text. */
function differs(current: unknown, value: string | readonly string[]): boolean {
	if (Array.isArray(value)) return !Array.isArray(current) || current.length !== value.length || current.some((item, i) => String(item) !== value[i]);
	if (current === null || current === undefined) return value !== "";
	return (typeof current === "string" ? current : typeof current === "number" || typeof current === "boolean" ? String(current) : JSON.stringify(current)) !== value;
}

/**
 * 0.6.3 frontmatter-refresh: the plugin metadata keys (`REFRESH_KEYS`) present in the note whose value differs from
 * Zotero now. Missing keys are not added (a key you removed stays removed); `zoteroID` and `tags` are never touched.
 */
export function frontmatterRefreshChanges(frontmatter: Record<string, unknown>, entry: ZoteroIndexEntry, settings: { excludedTags: string[] }): Record<string, string | string[]> {
	const values = literatureFrontmatterValues(entry, settings);
	const changes: Record<string, string | string[]> = {};
	for (const key of REFRESH_KEYS) if (key in frontmatter && differs(frontmatter[key], values[key])) changes[key] = values[key];
	return changes;
}

/** 0.6.3 legacy-key-cleanup: the legacy keys a note carries, in `LEGACY_FRONTMATTER_KEYS` order. */
export function legacyKeysIn(frontmatter: Record<string, unknown> | null | undefined): string[] {
	return frontmatter ? LEGACY_FRONTMATTER_KEYS.filter(key => key in frontmatter) : [];
}

/**
 * 0.6.3 merged-item-relink: the edit that points a note at `survivor`: `zoteroID`, `zoteroSelectURI` and `zotero-key`
 * (each only when present; `zoteroID` always), `citekey` when present and different, and the removal of legacy keys,
 * which name the merged-away item. The owner marker in the body is swapped by `relinkBody`.
 */
export function relinkEdit(frontmatter: Record<string, unknown>, survivor: ZoteroIndexEntry): FrontmatterEdit {
	const set: Record<string, string> = { zoteroID: survivor.id };
	if ("zoteroSelectURI" in frontmatter) set.zoteroSelectURI = survivor.zoteroSelectURI;
	if ("zotero-key" in frontmatter) set["zotero-key"] = survivor.itemKey;
	if ("citekey" in frontmatter && frontmatter.citekey !== survivor.citekey) set.citekey = survivor.citekey;
	return { set, remove: legacyKeysIn(frontmatter) };
}

/** The note text with the old item's owner marker replaced by the survivor's; unchanged when the marker is not there once. */
export function relinkBody(text: string, oldId: string, newId: string): string {
	const old = ownerMarker(oldId);
	const first = text.indexOf(old);
	if (first < 0 || text.indexOf(old, first + 1) >= 0) return text;
	return text.slice(0, first) + ownerMarker(newId) + text.slice(first + old.length);
}

/**
 * 0.6.3 merged-item-relink: the items a note whose `zoteroID` is no longer in the index may now belong to, by its citekey
 * (current or former key of an item, from the frontmatter or an `@citekey` file name) and its DOI. Absence is proved only
 * by a complete index: `incomplete` otherwise. Several candidates are returned for a chooser, never narrowed to the first.
 */
export function mergedItemCandidates(note: { basename: string; frontmatter: Record<string, unknown> }, index: { complete: boolean; entries: readonly ZoteroIndexEntry[] }):
	| { status: "no-identity" } | { status: "linked"; entry: ZoteroIndexEntry } | { status: "incomplete" } | { status: "merged"; oldId: string; candidates: ZoteroIndexEntry[]; evidence: string[] } {
	const id = note.frontmatter.zoteroID;
	if (typeof id !== "string" || !id) return { status: "no-identity" };
	const linked = index.entries.find(entry => entry.id === id);
	if (linked) return { status: "linked", entry: linked };
	if (!index.complete) return { status: "incomplete" };
	const keys = new Set<string>();
	for (const value of [note.frontmatter.citekey, note.basename.startsWith("@") ? note.basename.slice(1) : undefined]) if (typeof value === "string" && value.trim()) keys.add(value.trim());
	const dois = new Set<string>();
	for (const value of [note.frontmatter.doi, note.frontmatter.zotero_doi, note.frontmatter.DOI]) if (typeof value === "string" && value.trim()) dois.add(value.trim().toLowerCase());
	const evidence: string[] = [];
	const found = new Map<string, ZoteroIndexEntry>();
	for (const entry of index.entries) {
		const byKey = [entry.citekey, ...entry.citekeyHistory].find(key => keys.has(key));
		const byDoi = entry.doi && dois.has(entry.doi.trim().toLowerCase());
		if (!byKey && !byDoi) continue;
		found.set(entry.id, entry);
		evidence.push(`${entry.id}: ${byKey ? `citekey @${byKey}` : ""}${byKey && byDoi ? ", " : ""}${byDoi ? `DOI ${entry.doi}` : ""}`);
	}
	return { status: "merged", oldId: id, candidates: [...found.values()], evidence };
}
