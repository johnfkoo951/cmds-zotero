/**
 * Pure core of the `cites` action: classify cited keys against the index and the vault's hub/raw-source notes, read
 * and generate `## References` sections, and shape the per-file results, key summaries, diagnostics and summary.
 * Never imports `obsidian`. The host builds the hub/raw lookups once per call, classifies the union of `citedKeys()`
 * over every scanned note, then maps each note through `citesForNote()`.
 */
import type { Diagnostic, ZoteroIndex, ZoteroIndexEntry } from "../types";
import { DEFAULT_REFERENCES_HEADINGS } from "../types"; // 0.5 R10
import type { CiteStatus, NoteRecord, NoteRef, UncheckedReason } from "./types";
import { scanCitations, scanFrontmatterCitations, type CitationOccurrence, type FrontmatterCitationField } from "../citations/scan";

export type CitationForm = CitationOccurrence["form"];

/** Verdict for one cited key; `hub`/`raw` are attached whenever such notes exist, whatever the status. */
export interface KeyVerdict {
	citeStatus: CiteStatus;
	entryId?: string;
	matchedHistory?: boolean;
	/** Index citekey when it differs from the cited key (resolved through `citekeyHistory`). */
	citekeyCurrent?: string;
	hub?: NoteRef;
	raw?: NoteRef;
	/** Present exactly when `citeStatus` is `unchecked`: which gate withheld the verdict. */
	uncheckedReason?: UncheckedReason;
}

/** Hub and raw-source notes by exact frontmatter `citekey`, built once per call; several notes per key → the first is used. */
export interface NoteLookups {
	hubByCitekey: ReadonlyMap<string, NoteRef | NoteRef[]>;
	rawByCitekey: ReadonlyMap<string, NoteRef | NoteRef[]>;
	/**
	 * Note paths omitted from the lookups (malformed frontmatter) or the truncation sentinel; while non-empty a key that
	 * has no hub may still have one unseen, so vault-absence verdicts (`raw-only`, `dangling`) become `unchecked`
	 * with `uncheckedReason: discovery-incomplete`. The Zotero-index verdict itself is never affected.
	 */
	skipped?: readonly string[];
}

export interface ReferencesSection {
	present: boolean;
	listed: string[];
	missingFromReferences: string[];
	notCited: string[];
	/** The heading line as written (trimmed), present exactly when `present` (0.5 R10). */
	heading?: string;
}

/** Line span of a References section (0-based, `end` exclusive), its heading line and level, and the keys its `- [@key]` lines list. */
export interface ReferencesSpan {
	start: number;
	end: number;
	listed: string[];
	heading: string;
	level: number;
}

export interface FileCitation {
	citekey: string;
	where: "body" | "frontmatter";
	field?: FrontmatterCitationField;
	/** 1-based line and column over the note text as read (frontmatter block included); body citations only. */
	line?: number;
	column?: number;
	form?: CitationForm;
	citeStatus: CiteStatus;
	matchedHistory?: boolean;
	entryId?: string;
	citekeyCurrent?: string;
	hub?: NoteRef;
	raw?: NoteRef;
	uncheckedReason?: UncheckedReason;
}

export interface FileCites {
	path: string;
	type: string | null;
	frontmatterParse: "ok" | "error";
	citations: FileCitation[];
	referencesSection: ReferencesSection;
}

export interface KeySummary {
	citekey: string;
	citeStatus: CiteStatus;
	entryId?: string;
	hub?: NoteRef;
	raw?: NoteRef;
	uncheckedReason?: UncheckedReason;
	count: number;
	files: string[];
}

export type CitesDiagnosticCode = "dangling-cite" | "cite-hub-only" | "cite-raw-only" | "cite-unchecked" | "citekey-ambiguous" | "frontmatter-parse-error";

export interface CitesDiagnostic {
	code: CitesDiagnosticCode;
	severity: Diagnostic["severity"];
	message: string;
	path: string;
	citekey?: string;
}

export interface CitesSummary {
	files: number;
	citations: number;
	resolved: number;
	hubOnly: number;
	rawOnly: number;
	dangling: number;
	ambiguous: number;
	unchecked: number;
	truncated: boolean;
}

export interface ReferencesPayload {
	/** 0.5 R10: `text` (default) or `markdown`; the structured formats use {@link StructuredReferencesPayload}. */
	format: "text" | "markdown";
	style: string;
	/** Heading reused for `markdown`: the note's own References heading when found, else `## References`. */
	heading: string;
	resolved: { citekey: string; text: string }[];
	unresolved: { citekey: string; citeStatus: CiteStatus; uncheckedReason?: UncheckedReason; hint: string }[];
	markdown: string;
	/** `text`: resolved bibliography entries separated by blank lines; `markdown`: the References block. */
	content: string;
}

// 0.5 R10 — pandoc-ready bibliography formats (`cites --format`), sidecar naming and overwrite rules.

export type BibliographyFormat = "text" | "markdown" | "csl-json" | "bibtex" | "biblatex";
export const BIBLIOGRAPHY_FORMATS: readonly BibliographyFormat[] = ["text", "markdown", "csl-json", "bibtex", "biblatex"];
export type StructuredBibliographyFormat = Exclude<BibliographyFormat, "text" | "markdown">;
/** BBT translator labels for `item.export` (verified live 2026-09). */
export const EXPORT_TRANSLATORS: Readonly<Record<StructuredBibliographyFormat, string>> = { "csl-json": "Better CSL JSON", bibtex: "Better BibTeX", biblatex: "Better BibLaTeX" };
export const SIDECAR_EXTENSIONS: Readonly<Record<BibliographyFormat, string>> = { text: "txt", markdown: "md", "csl-json": "json", bibtex: "bib", biblatex: "bib" };
/** CSL-JSON fields removed unconditionally: private prose that pandoc never renders. `id` and `citation-key` are kept. */
export const CSL_STRIPPED_FIELDS: readonly string[] = ["abstract", "note"];
/** Plugin-owned sidecar folder (inside the private `.cmds-zotero/` directory, which the plugin keeps gitignored). */
export const BIBLIOGRAPHY_DIR = ".cmds-zotero/bibliography";
/** First line of every non-JSON sidecar; a file outside the private folder may be overwritten only when it starts with it. */
export const GENERATOR_MARKERS: Readonly<Record<Exclude<BibliographyFormat, "csl-json">, string>> = { bibtex: "% cmds-zotero bibliography", biblatex: "% cmds-zotero bibliography", markdown: "<!-- cmds-zotero bibliography -->", text: "<!-- cmds-zotero bibliography -->" };

export function isStructuredFormat(format: BibliographyFormat): format is StructuredBibliographyFormat {
	return format === "csl-json" || format === "bibtex" || format === "biblatex";
}

/** One `item.export` call per library; `citekeys` are the entries' current index keys. */
export interface BibliographyExporter { (citekeys: string[], format: StructuredBibliographyFormat, libraryID: number): Promise<string> }

export interface ExportGroup { libraryID: number; citekeys: string[] }

/** Groups entries by local library ID in first-seen order; each key once per library. */
export function groupEntriesByLibrary(entries: readonly ZoteroIndexEntry[]): ExportGroup[] {
	const groups = new Map<number, ExportGroup>();
	for (const entry of entries) {
		const group = groups.get(entry.libraryID) ?? { libraryID: entry.libraryID, citekeys: [] };
		if (!group.citekeys.includes(entry.citekey)) group.citekeys.push(entry.citekey);
		groups.set(entry.libraryID, group);
	}
	return [...groups.values()];
}

/**
 * Resolved keys grouped by library for export. A key resolved through `citekeyHistory` is exported under the entry's
 * current citekey, so pandoc would not find `[@old]` in the output: such pairs are reported in `renamed`.
 */
export function groupResolvedByLibrary(keys: readonly string[], classified: ReadonlyMap<string, KeyVerdict>, byId: ReadonlyMap<string, ZoteroIndexEntry>): { groups: ExportGroup[]; renamed: { cited: string; current: string }[] } {
	const entries: ZoteroIndexEntry[] = [];
	const renamed: { cited: string; current: string }[] = [];
	for (const key of uniqueInOrder(keys)) {
		const verdict = classified.get(key);
		const entry = verdict?.citeStatus === "resolved" && verdict.entryId ? byId.get(verdict.entryId) : undefined;
		if (!entry) continue;
		entries.push(entry);
		if (entry.citekey !== key) renamed.push({ cited: key, current: entry.citekey });
	}
	return { groups: groupEntriesByLibrary(entries), renamed };
}

export interface StructuredExport {
	content: string;
	/** Citekeys (CSL `id` / BibTeX entry keys) present in the merged output, in output order. */
	exported: string[];
	/** CSL-JSON only: the fields of {@link CSL_STRIPPED_FIELDS} that were actually removed from at least one item. */
	stripped: string[];
}

const BIBTEX_ENTRY = /^\s*@[A-Za-z]+\s*\{\s*([^,\s}]+)\s*,/gm;

/** Entry keys of a BibTeX/BibLaTeX text in order (`@type{key,`); `@comment`/`@preamble` blocks carry no key and are skipped. */
export function bibtexKeys(text: string): string[] {
	return uniqueInOrder([...text.matchAll(BIBTEX_ENTRY)].map(match => match[1]));
}

/**
 * Merges the per-library export outputs: CSL-JSON arrays into one array with `abstract`/`note` removed (a non-array
 * payload throws), BibTeX/BibLaTeX texts concatenated with one blank line. The CSL-JSON output stays a plain array so
 * pandoc can read it.
 */
export function mergeExports(format: StructuredBibliographyFormat, outputs: readonly string[]): StructuredExport {
	if (format !== "csl-json") {
		const content = outputs.map(text => text.trim()).filter(Boolean).join("\n\n");
		return { content: content ? `${content}\n` : "", exported: bibtexKeys(content), stripped: [] };
	}
	const items: Record<string, unknown>[] = [];
	const stripped = new Set<string>();
	for (const output of outputs) {
		if (!output.trim()) continue;
		const parsed: unknown = JSON.parse(output);
		if (!Array.isArray(parsed)) throw new Error("BBT CSL JSON export must be an array");
		for (const item of parsed) {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("BBT CSL JSON export contains a non-object item");
			const copy = { ...item as Record<string, unknown> };
			for (const field of CSL_STRIPPED_FIELDS) if (field in copy) { delete copy[field]; stripped.add(field); }
			items.push(copy);
		}
	}
	const exported = uniqueInOrder(items.map(item => typeof item.id === "string" ? item.id : typeof item.id === "number" ? String(item.id) : "").filter(Boolean));
	return { content: `${JSON.stringify(items, null, 2)}\n`, exported, stripped: CSL_STRIPPED_FIELDS.filter(field => stripped.has(field)) };
}

export interface StructuredReferencesPayload {
	format: StructuredBibliographyFormat;
	heading: string;
	/** Null when the export was unavailable (`referencesReason` says why). */
	content: string | null;
	exported: string[];
	/** Every cited key with no entry in the export: non-resolved verdicts, plus resolved keys the export omitted. */
	unresolved: ReferencesPayload["unresolved"];
	renamed?: { cited: string; current: string }[];
	stripped?: string[];
}

/** Sidecar file stem from the target: note basename (`.md` stripped), the last folder segment, or `vault` for the root. */
export function sidecarSlug(targetPath: string, isFile: boolean): string {
	const clean = targetPath.replace(/^\/+|\/+$/g, "");
	const last = clean.split("/").pop() ?? "";
	const stem = (isFile ? last.replace(/\.md$/i, "") : last).trim();
	const slug = stem.replace(/[\\/:*?"<>|]+/g, "").replace(/\p{Cc}+/gu, "").replace(/\s+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
	return slug || "vault";
}

export function defaultSidecarPath(targetPath: string, isFile: boolean, format: BibliographyFormat): string {
	return `${BIBLIOGRAPHY_DIR}/${sidecarSlug(targetPath, isFile)}.${SIDECAR_EXTENSIONS[format]}`;
}

/** Normalizes an explicit `--out` path; throws for anything a vault reader could not keep inside the vault. */
export function validateSidecarPath(out: string): string {
	const value = out.trim().replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/+$/, "");
	if (!value || value.includes("\\") || value.includes("\0") || /^[a-z]+:/i.test(value)) throw new Error(`Sidecar path must be vault-relative: ${out}`);
	if (value.split("/").some(part => part === ".." || part === "." || part === "")) throw new Error(`Sidecar path must not traverse or contain empty segments: ${out}`);
	return value;
}

export function isPluginOwnedPath(path: string): boolean {
	return path === BIBLIOGRAPHY_DIR || path.startsWith(`${BIBLIOGRAPHY_DIR}/`);
}

/** Sidecar bytes: the generator marker line first for every non-JSON format (CSL-JSON must stay a plain array). */
export function sidecarContent(format: BibliographyFormat, content: string): string {
	if (format === "csl-json") return content;
	return `${GENERATOR_MARKERS[format]}\n${content}${content.endsWith("\n") || !content ? "" : "\n"}`;
}

function startsWithMarker(existing: string, format: Exclude<BibliographyFormat, "csl-json">): boolean {
	const first = existing.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
	return first.trim() === GENERATOR_MARKERS[format];
}

/**
 * Overwrite rule. Inside `.cmds-zotero/bibliography/` the plugin owns the file. Elsewhere the file must be absent or
 * start with the generator marker; CSL-JSON carries no marker, so an existing JSON file needs `force`. A Markdown note
 * (`.md`) that lacks the marker is never overwritten, not even with `force`.
 */
export function sidecarWriteDecision(path: string, format: BibliographyFormat, existing: string | null, force: boolean): { ok: true } | { ok: false; message: string } {
	if (isPluginOwnedPath(path) || existing === null) return { ok: true };
	const marked = format !== "csl-json" && startsWithMarker(existing, format);
	if (marked) return { ok: true };
	if (/\.md$/i.test(path)) return { ok: false, message: `Refusing to overwrite the note ${path}: it was not written by cmds-zotero (no generator marker) and notes are never replaced, even with --force.` };
	if (force) return { ok: true };
	const how = format === "csl-json" ? "CSL-JSON carries no generator marker, so pass --force to replace it" : "it does not start with the generator marker; pass --force to replace it";
	return { ok: false, message: `Refusing to overwrite ${path}: ${how}, or write under ${BIBLIOGRAPHY_DIR}/ (the default).` };
}

export type ScannedCitation = Omit<FileCitation, "citeStatus" | "matchedHistory" | "entryId" | "citekeyCurrent" | "hub" | "raw" | "uncheckedReason">;

/** Verdicts the stale-index gate withholds: each says "not in the index", which a fresh index could overturn. */
const NEGATIVE_STATUSES: ReadonlySet<CiteStatus> = new Set<CiteStatus>(["raw-only", "dangling"]);

const DIAGNOSTIC_CODES: Readonly<Record<Exclude<CiteStatus, "resolved">, CitesDiagnosticCode>> = {
	"hub-only": "cite-hub-only",
	"raw-only": "cite-raw-only",
	dangling: "dangling-cite",
	ambiguous: "citekey-ambiguous",
	unchecked: "cite-unchecked",
};

const DIAGNOSTIC_SEVERITIES: Readonly<Record<Exclude<CiteStatus, "resolved">, Diagnostic["severity"]>> = {
	"hub-only": "info",
	"raw-only": "warning",
	dangling: "error",
	ambiguous: "error",
	unchecked: "warning",
};

const HINTS: Readonly<Record<Exclude<CiteStatus, "resolved" | "unchecked">, string>> = {
	"hub-only": "Provisional: register the item in Zotero and pin the citekey; the hub's full citation is used meanwhile",
	"raw-only": "Raw source only: create a hub or register the item in Zotero",
	dangling: "No Zotero item, hub or raw source note carries this citekey; check the spelling or register the item",
	ambiguous: "Several Zotero items carry this citekey; pin one with a Citation Key line in Extra",
};

/** `unchecked` hints name the gate that withheld the verdict; `--allow-stale` is offered only for the stale gate. */
const UNCHECKED_HINTS: Readonly<Record<UncheckedReason, string>> = {
	"stale-index": "Index stale: run refresh or pass --allow-stale to see the index verdict",
	"discovery-incomplete": "Vault discovery incomplete: notes with malformed frontmatter (or a truncated scan) were not classified, so a hub or raw source may exist unseen; repair the reported notes (--allow-stale does not apply)",
};

/** Short cause for `unchecked` in References lines and diagnostics. */
const UNCHECKED_CAUSES: Readonly<Record<UncheckedReason, string>> = {
	"stale-index": "index stale",
	"discovery-incomplete": "vault discovery incomplete",
};

function hintFor(status: Exclude<CiteStatus, "resolved">, reason: UncheckedReason | undefined): string {
	return status === "unchecked" ? UNCHECKED_HINTS[reason ?? "stale-index"] : HINTS[status];
}

function uncheckedCause(reason: UncheckedReason | undefined): string {
	return UNCHECKED_CAUSES[reason ?? "stale-index"];
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * 0.5 R10: `##`–`######` followed by one configured title (case-insensitive; whitespace inside a title is optional, so
 * "참고 문헌" also matches "참고문헌"), an optional short parenthesised qualifier and optional closing hashes.
 */
export function referencesHeadingPattern(headings: readonly string[] = DEFAULT_REFERENCES_HEADINGS): RegExp {
	const titles = uniqueInOrder(headings.map(title => title.trim()).filter(Boolean)).map(title => escapeRegex(title).replace(/\s+/g, "\\s*"));
	const alternatives = titles.length ? titles.join("|") : escapeRegex("References");
	return new RegExp(`^(#{2,6})\\s+(?:${alternatives})(?:\\s*\\([^)]{0,40}\\))?\\s*#*\\s*$`, "iu");
}
const LIST_ITEM_BRACKET = /^\s*[-*+]\s+\[/;
const FENCE = /^\s*(```|~~~)/;
const FULL_CITATION_LINE = /^\s*[-*+]\s+\*\*Full citation\*\*\s*:\s*(.*)$/im;
const PLACEHOLDER = /^\{.*\}$/s;

function uniqueInOrder(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function refs(value: NoteRef | NoteRef[] | undefined): NoteRef[] {
	return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function uniqueEntries(...groups: readonly ZoteroIndexEntry[][]): ZoteroIndexEntry[] {
	const byId = new Map<string, ZoteroIndexEntry>();
	for (const group of groups) for (const entry of group) if (!byId.has(entry.id)) byId.set(entry.id, entry);
	return [...byId.values()];
}

function pushTo(map: Map<string, ZoteroIndexEntry[]>, key: string, entry: ZoteroIndexEntry): void {
	const list = map.get(key);
	if (list) list.push(entry); else map.set(key, [entry]);
}

/**
 * Exact-citekey hits take precedence over history hits (resolution order `citekey` → `citekeyHistory`). Hub/raw evidence
 * is attached before any gate: a positive hub match is `hub-only` even while discovery is incomplete (the hub exists),
 * whereas "no hub" is only trustworthy when every note was classified, so `raw-only`/`dangling` become `unchecked`
 * with `uncheckedReason: discovery-incomplete` while `lookups.skipped` is non-empty.
 */
function classifyKey(key: string, byCitekey: ReadonlyMap<string, ZoteroIndexEntry[]>, byHistory: ReadonlyMap<string, ZoteroIndexEntry[]>, lookups: NoteLookups): KeyVerdict {
	const hubs = refs(lookups.hubByCitekey.get(key));
	const raws = refs(lookups.rawByCitekey.get(key));
	if (hubs.length > 1 || raws.length > 1) return { citeStatus: "ambiguous" };
	const hub = hubs[0];
	const raw = raws[0];
	const notes: Pick<KeyVerdict, "hub" | "raw"> = { ...(hub ? { hub } : {}), ...(raw ? { raw } : {}) };
	const exact = byCitekey.get(key) ?? [];
	const history = byHistory.get(key) ?? [];
	const entries = uniqueEntries(exact, history);
	if (entries.length > 1) return { citeStatus: "ambiguous", ...notes };
	if (entries.length === 1) {
		const entry = entries[0];
		const matchedHistory = !exact.some(candidate => candidate.id === entry.id);
		return { citeStatus: "resolved", entryId: entry.id, matchedHistory, ...(matchedHistory ? { citekeyCurrent: entry.citekey } : {}), ...notes };
	}
	if (hub) return { citeStatus: "hub-only", ...notes };
	if (lookups.skipped?.length) return { citeStatus: "unchecked", ...notes, uncheckedReason: "discovery-incomplete" };
	if (raw) return { citeStatus: "raw-only", raw };
	return { citeStatus: "dangling" };
}

/**
 * Classifies each distinct key: `resolved` through the index citekey or `citekeyHistory` (several entries → `ambiguous`),
 * else `hub-only` / `raw-only` / `dangling` from the vault lookups. When the index is stale and `allowStale` is false,
 * every negative verdict becomes `unchecked` with `uncheckedReason: stale-index` (hub/raw refs are kept so the caller
 * can still point at the notes). A verdict already withheld for incomplete discovery keeps that reason: `--allow-stale`
 * would not make it checkable, so the hint must not suggest it.
 */
export function classifyKeys(keys: readonly string[], index: ZoteroIndex, lookups: NoteLookups, stale: boolean, allowStale: boolean): Map<string, KeyVerdict> {
	const byCitekey = new Map<string, ZoteroIndexEntry[]>();
	const byHistory = new Map<string, ZoteroIndexEntry[]>();
	for (const entry of index.entries) {
		pushTo(byCitekey, entry.citekey, entry);
		for (const previous of new Set(entry.citekeyHistory)) if (previous !== entry.citekey) pushTo(byHistory, previous, entry);
	}
	const withhold = stale && !allowStale;
	const verdicts = new Map<string, KeyVerdict>();
	for (const key of uniqueInOrder(keys)) {
		const verdict = classifyKey(key, byCitekey, byHistory, lookups);
		verdicts.set(key, withhold && NEGATIVE_STATUSES.has(verdict.citeStatus) ? { ...verdict, citeStatus: "unchecked", uncheckedReason: "stale-index" } : verdict);
	}
	return verdicts;
}

/**
 * Locates the first References heading (see {@link referencesHeadingPattern}) outside frontmatter and fenced code; the
 * section runs to the next heading of the same or a higher level, or the end. Listed keys come from lines shaped
 * `- [@key] ...` (first key on the line, deduplicated).
 */
export function findReferencesSection(lines: readonly string[], headings: readonly string[] = DEFAULT_REFERENCES_HEADINGS): ReferencesSpan | null {
	const pattern = referencesHeadingPattern(headings);
	let fenced = false;
	let frontmatter = lines[0]?.trim() === "---";
	let start = -1;
	let level = 2;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (frontmatter) { if (index > 0 && line.trim() === "---") frontmatter = false; continue; }
		if (FENCE.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		const match = pattern.exec(line);
		if (match) { start = index; level = match[1].length; break; }
	}
	if (start < 0) return null;
	const sectionEnd = new RegExp(`^#{1,${level}}\\s`);
	let end = lines.length;
	const listed: string[] = [];
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index];
		if (FENCE.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		if (sectionEnd.test(line)) { end = index; break; }
		const marker = LIST_ITEM_BRACKET.exec(line);
		if (!marker) continue;
		const leading = scanCitations(line).find(item => item.form === "pandoc" && item.column === marker[0].length);
		if (leading && !listed.includes(leading.citekey)) listed.push(leading.citekey);
	}
	return { start, end, listed, heading: lines[start].trim(), level };
}

function sectionReport(span: ReferencesSpan | null, cited: readonly string[]): ReferencesSection {
	const listed = span?.listed ?? [];
	const listedSet = new Set(listed);
	const citedUnique = uniqueInOrder(cited);
	const citedSet = new Set(citedUnique);
	return { present: span !== null, listed, missingFromReferences: citedUnique.filter(key => !listedSet.has(key)), notCited: listed.filter(key => !citedSet.has(key)), ...(span ? { heading: span.heading } : {}) };
}

/** Compares the References section of a note against the keys it cites (first-cited order preserved). */
export function referencesSection(body: string, cited: readonly string[], headings: readonly string[] = DEFAULT_REFERENCES_HEADINGS): ReferencesSection {
	return sectionReport(findReferencesSection(body.split(/\r?\n/), headings), cited);
}

/**
 * Citation occurrences of one note in file order: frontmatter citations first, then body citations with 1-based
 * line/column. Occurrences inside the `## References` section are the bibliography, not citations, and are skipped.
 */
export function scanNote(note: NoteRecord & { body: string }, headings: readonly string[]): { citations: ScannedCitation[]; span: ReferencesSpan | null } {
	const citations: ScannedCitation[] = [];
	for (const item of scanFrontmatterCitations(note.frontmatter ?? {})) citations.push({ citekey: item.citekey, where: "frontmatter", field: item.field, form: item.form });
	const span = findReferencesSection(note.body.split(/\r?\n/), headings);
	for (const item of scanCitations(note.body)) {
		if (span && item.line >= span.start && item.line < span.end) continue;
		citations.push({ citekey: item.citekey, where: "body", line: item.line + 1, column: item.column + 1, form: item.form });
	}
	return { citations, span };
}

/** Distinct keys a note cites (frontmatter, then body, References section excluded) in first-cited order. */
export function citedKeys(note: NoteRecord & { body: string }, headings: readonly string[] = DEFAULT_REFERENCES_HEADINGS): string[] {
	return uniqueInOrder(scanNote(note, headings).citations.map(item => item.citekey));
}

/** Copies a verdict in the fixed output order, dropping undefined keys so JSON stays free of nulls. */
function verdictFields(verdict: KeyVerdict): KeyVerdict {
	const fields: KeyVerdict = { citeStatus: verdict.citeStatus };
	if (verdict.matchedHistory !== undefined) fields.matchedHistory = verdict.matchedHistory;
	if (verdict.entryId !== undefined) fields.entryId = verdict.entryId;
	if (verdict.citekeyCurrent !== undefined) fields.citekeyCurrent = verdict.citekeyCurrent;
	if (verdict.hub) fields.hub = verdict.hub;
	if (verdict.raw) fields.raw = verdict.raw;
	if (verdict.uncheckedReason !== undefined) fields.uncheckedReason = verdict.uncheckedReason;
	return fields;
}

/**
 * Per-file shape of the `cites` action. `verdicts` must cover every key of `citedKeys(note)`; a missing key is an
 * integration error and throws. `note.body` is the note text as read (frontmatter block included).
 */
export function citesForNote(note: NoteRecord & { body: string }, verdicts: ReadonlyMap<string, KeyVerdict>, headings: readonly string[] = DEFAULT_REFERENCES_HEADINGS): FileCites {
	const { citations, span } = scanNote(note, headings);
	const type = note.frontmatter && typeof note.frontmatter.type === "string" ? note.frontmatter.type : null;
	const shaped = citations.map((item): FileCitation => {
		const verdict = verdicts.get(item.citekey);
		if (!verdict) throw new Error(`Citekey ${item.citekey} was not classified before shaping ${note.path}`);
		return { ...item, ...verdictFields(verdict) };
	});
	return { path: note.path, type, frontmatterParse: note.frontmatterParse, citations: shaped, referencesSection: sectionReport(span, citations.map(item => item.citekey)) };
}

/** Per-key aggregate over all files in first-cited order: occurrence count and the distinct files citing the key. */
export function keysForFiles(files: readonly FileCites[]): KeySummary[] {
	const keys = new Map<string, KeySummary>();
	for (const file of files) {
		for (const citation of file.citations) {
			const existing = keys.get(citation.citekey);
			if (existing) {
				existing.count++;
				if (!existing.files.includes(file.path)) existing.files.push(file.path);
				continue;
			}
			keys.set(citation.citekey, {
				citekey: citation.citekey,
				citeStatus: citation.citeStatus,
				...(citation.entryId !== undefined ? { entryId: citation.entryId } : {}),
				...(citation.hub ? { hub: citation.hub } : {}),
				...(citation.raw ? { raw: citation.raw } : {}),
				...(citation.uncheckedReason !== undefined ? { uncheckedReason: citation.uncheckedReason } : {}),
				count: 1,
				files: [file.path],
			});
		}
	}
	return [...keys.values()];
}

function occurrenceSuffix(count: number): string {
	return count === 1 ? "" : ` (${count} occurrences)`;
}

function diagnosticMessage(status: Exclude<CiteStatus, "resolved">, citekey: string, count: number, reason: UncheckedReason | undefined): string {
	const suffix = occurrenceSuffix(count);
	switch (status) {
		case "dangling": return `@${citekey} is not in the Zotero index and has no hub or raw source note${suffix}`;
		case "hub-only": return `@${citekey} has a hub note but no Zotero item; References will use the hub's full citation (provisional)${suffix}`;
		case "raw-only": return `@${citekey} has only a raw source note; no hub or Zotero item${suffix}`;
		case "ambiguous": return `@${citekey} matches several Zotero items; pin one citekey${suffix}`;
		case "unchecked": return (reason ?? "stale-index") === "discovery-incomplete"
			? `@${citekey} could not be checked because vault discovery was incomplete (notes with malformed frontmatter or a truncated scan); a hub or raw source may exist unseen — repair the reported notes; --allow-stale does not apply${suffix}`
			: `@${citekey} could not be checked because the index is stale; refresh or pass --allow-stale${suffix}`;
	}
}

/** One diagnostic per (file, key) pair for every non-resolved status, plus a warning per unparsable frontmatter. */
export function citesDiagnostics(files: readonly FileCites[]): CitesDiagnostic[] {
	const diagnostics: CitesDiagnostic[] = [];
	for (const file of files) {
		if (file.frontmatterParse === "error") diagnostics.push({ code: "frontmatter-parse-error", severity: "warning", message: "Frontmatter could not be parsed; frontmatter citations were not scanned", path: file.path });
		const counts = new Map<string, { status: CiteStatus; reason: UncheckedReason | undefined; count: number }>();
		for (const citation of file.citations) {
			const seen = counts.get(citation.citekey);
			if (seen) seen.count++; else counts.set(citation.citekey, { status: citation.citeStatus, reason: citation.uncheckedReason, count: 1 });
		}
		for (const [citekey, { status, reason, count }] of counts) {
			if (status === "resolved") continue;
			diagnostics.push({ code: DIAGNOSTIC_CODES[status], severity: DIAGNOSTIC_SEVERITIES[status], message: diagnosticMessage(status, citekey, count, reason), path: file.path, citekey });
		}
	}
	return diagnostics;
}

/** Counts are over citation occurrences, so the per-status counts sum to `citations`. */
export function summarize(files: readonly FileCites[], truncated = false): CitesSummary {
	const summary: CitesSummary = { files: files.length, citations: 0, resolved: 0, hubOnly: 0, rawOnly: 0, dangling: 0, ambiguous: 0, unchecked: 0, truncated };
	for (const file of files) {
		for (const citation of file.citations) {
			summary.citations++;
			switch (citation.citeStatus) {
				case "resolved": summary.resolved++; break;
				case "hub-only": summary.hubOnly++; break;
				case "raw-only": summary.rawOnly++; break;
				case "dangling": summary.dangling++; break;
				case "ambiguous": summary.ambiguous++; break;
				case "unchecked": summary.unchecked++; break;
			}
		}
	}
	return summary;
}

/** The hub's S01 `- **Full citation**: <text>` value; null when absent, empty, or still the `{...}` template placeholder. */
export function hubFullCitationLine(text: string): string | null {
	const value = FULL_CITATION_LINE.exec(text)?.[1]?.trim() ?? "";
	return value && !PLACEHOLDER.test(value) ? value : null;
}

function oneLine(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** One `- [@key] ...` line: BBT text when resolved, the hub's full citation `(provisional)` (pointer form `[[hub]]` when the hub has none), `(raw source only: [[raw]])`, or `(unresolved)`. */
export function referencesLine(citekey: string, verdict: KeyVerdict | undefined, bibliography: ReadonlyMap<string, string>, hubFullCitation: ReadonlyMap<string, string>): string {
	const prefix = `- [@${citekey}]`;
	switch (verdict?.citeStatus) {
		case "resolved": {
			const text = oneLine(bibliography.get(citekey) ?? "");
			return text ? `${prefix} ${text}` : `${prefix} (bibliography unavailable)`;
		}
		case "hub-only": {
			const text = oneLine(hubFullCitation.get(citekey) ?? "");
			if (text) return `${prefix} ${text} (provisional)`;
			return verdict.hub ? `${prefix} [[${verdict.hub.basename}]] (provisional)` : `${prefix} (provisional)`;
		}
		case "raw-only": return verdict.raw ? `${prefix} (raw source only: [[${verdict.raw.basename}]])` : `${prefix} (raw source only)`;
		case "ambiguous": return `${prefix} (ambiguous: several Zotero items)`;
		case "unchecked": return `${prefix} (unchecked: ${uncheckedCause(verdict.uncheckedReason)})`;
		default: return `${prefix} (unresolved)`;
	}
}

export const DEFAULT_REFERENCES_HEADING = "## References";

/** The heading (default `## References`) plus one line per distinct key in the given (first-cited) order; lines joined by `\n`, no trailing newline. */
export function referencesMarkdown(keys: readonly string[], classified: ReadonlyMap<string, KeyVerdict>, bibliography: ReadonlyMap<string, string>, hubFullCitation: ReadonlyMap<string, string>, heading = DEFAULT_REFERENCES_HEADING): string {
	return [heading, ...uniqueInOrder(keys).map(key => referencesLine(key, classified.get(key), bibliography, hubFullCitation))].join("\n");
}

function unresolvedEntry(citekey: string, verdict: KeyVerdict | undefined): ReferencesPayload["unresolved"][number] {
	const status = verdict?.citeStatus ?? "dangling";
	if (status === "resolved") return { citekey, citeStatus: status, hint: "Resolved in the index but absent from the BBT export; refresh the index or check the item in Zotero" };
	return { citekey, citeStatus: status, ...(status === "unchecked" && verdict?.uncheckedReason ? { uncheckedReason: verdict.uncheckedReason } : {}), hint: hintFor(status, verdict?.uncheckedReason) };
}

/** The `references` payload for `text`/`markdown`: resolved texts, unresolved keys with hints, the References block and `content`. */
export function referencesPayload(keys: readonly string[], classified: ReadonlyMap<string, KeyVerdict>, bibliography: ReadonlyMap<string, string>, hubFullCitation: ReadonlyMap<string, string>, options: { format?: "text" | "markdown"; heading?: string; style?: string } = {}): ReferencesPayload {
	const format = options.format ?? "text";
	const heading = options.heading ?? DEFAULT_REFERENCES_HEADING;
	const resolved: ReferencesPayload["resolved"] = [];
	const unresolved: ReferencesPayload["unresolved"] = [];
	for (const citekey of uniqueInOrder(keys)) {
		const verdict = classified.get(citekey);
		if (verdict?.citeStatus === "resolved") resolved.push({ citekey, text: oneLine(bibliography.get(citekey) ?? "") });
		else unresolved.push(unresolvedEntry(citekey, verdict));
	}
	const markdown = referencesMarkdown(keys, classified, bibliography, hubFullCitation, heading);
	const content = format === "markdown" ? markdown : resolved.map(item => item.text).filter(Boolean).join("\n\n");
	return { format, style: options.style ?? "", heading, resolved, unresolved, markdown, content };
}

/** The `references` payload for `csl-json`/`bibtex`/`biblatex`; `merged` is null when the export was unavailable. */
export function structuredReferencesPayload(keys: readonly string[], classified: ReadonlyMap<string, KeyVerdict>, format: StructuredBibliographyFormat, heading: string, merged: StructuredExport | null, renamed: readonly { cited: string; current: string }[]): StructuredReferencesPayload {
	const exported = new Set(merged?.exported ?? []);
	const currentOf = new Map(renamed.map(pair => [pair.cited, pair.current]));
	const unresolved: ReferencesPayload["unresolved"] = [];
	for (const citekey of uniqueInOrder(keys)) {
		const verdict = classified.get(citekey);
		if (verdict?.citeStatus === "resolved" && merged && exported.has(currentOf.get(citekey) ?? citekey)) continue;
		unresolved.push(verdict?.citeStatus === "resolved" && !merged ? { citekey, citeStatus: "resolved", hint: "Structured bibliography export needs the live host and Better BibTeX (item.export)" } : unresolvedEntry(citekey, verdict));
	}
	return { format, heading, content: merged?.content ?? null, exported: merged?.exported ?? [], unresolved, ...(renamed.length ? { renamed: [...renamed] } : {}), ...(merged && format === "csl-json" ? { stripped: merged.stripped } : {}) };
}
