/**
 * Pure core of the `cites` action: classify cited keys against the index and the vault's hub/raw-source notes, read
 * and generate `## References` sections, and shape the per-file results, key summaries, diagnostics and summary.
 * Never imports `obsidian`. The host builds the hub/raw lookups once per call, classifies the union of `citedKeys()`
 * over every scanned note, then maps each note through `citesForNote()`.
 */
import type { Diagnostic, ZoteroIndex, ZoteroIndexEntry } from "../types";
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
}

/** Line span of a `## References` section (0-based, `end` exclusive) and the keys its `- [@key]` lines list. */
export interface ReferencesSpan {
	start: number;
	end: number;
	listed: string[];
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
	resolved: { citekey: string; text: string }[];
	unresolved: { citekey: string; citeStatus: CiteStatus; uncheckedReason?: UncheckedReason; hint: string }[];
	markdown: string;
}

type ScannedCitation = Omit<FileCitation, "citeStatus" | "matchedHistory" | "entryId" | "citekeyCurrent" | "hub" | "raw" | "uncheckedReason">;

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

const REFERENCES_HEADING = /^##\s+References\s*#*\s*$/i;
const SECTION_END = /^#{1,2}\s/;
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
 * Locates the first `## References` heading outside frontmatter and fenced code; the section runs to the next
 * level-1/2 heading or the end. Listed keys come from lines shaped `- [@key] ...` (first key on the line, deduplicated).
 */
export function findReferencesSection(lines: readonly string[]): ReferencesSpan | null {
	let fenced = false;
	let frontmatter = lines[0]?.trim() === "---";
	let start = -1;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (frontmatter) { if (index > 0 && line.trim() === "---") frontmatter = false; continue; }
		if (FENCE.test(line)) { fenced = !fenced; continue; }
		if (!fenced && REFERENCES_HEADING.test(line)) { start = index; break; }
	}
	if (start < 0) return null;
	let end = lines.length;
	const listed: string[] = [];
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index];
		if (FENCE.test(line)) { fenced = !fenced; continue; }
		if (fenced) continue;
		if (SECTION_END.test(line)) { end = index; break; }
		const marker = LIST_ITEM_BRACKET.exec(line);
		if (!marker) continue;
		const leading = scanCitations(line).find(item => item.form === "pandoc" && item.column === marker[0].length);
		if (leading && !listed.includes(leading.citekey)) listed.push(leading.citekey);
	}
	return { start, end, listed };
}

function sectionReport(span: ReferencesSpan | null, cited: readonly string[]): ReferencesSection {
	const listed = span?.listed ?? [];
	const listedSet = new Set(listed);
	const citedUnique = uniqueInOrder(cited);
	const citedSet = new Set(citedUnique);
	return { present: span !== null, listed, missingFromReferences: citedUnique.filter(key => !listedSet.has(key)), notCited: listed.filter(key => !citedSet.has(key)) };
}

/** Compares the `## References` section of a note against the keys it cites (first-cited order preserved). */
export function referencesSection(body: string, cited: readonly string[]): ReferencesSection {
	return sectionReport(findReferencesSection(body.split(/\r?\n/)), cited);
}

/**
 * Citation occurrences of one note in file order: frontmatter citations first, then body citations with 1-based
 * line/column. Occurrences inside the `## References` section are the bibliography, not citations, and are skipped.
 */
function scanNote(note: NoteRecord & { body: string }): { citations: ScannedCitation[]; span: ReferencesSpan | null } {
	const citations: ScannedCitation[] = [];
	for (const item of scanFrontmatterCitations(note.frontmatter ?? {})) citations.push({ citekey: item.citekey, where: "frontmatter", field: item.field, form: item.form });
	const span = findReferencesSection(note.body.split(/\r?\n/));
	for (const item of scanCitations(note.body)) {
		if (span && item.line >= span.start && item.line < span.end) continue;
		citations.push({ citekey: item.citekey, where: "body", line: item.line + 1, column: item.column + 1, form: item.form });
	}
	return { citations, span };
}

/** Distinct keys a note cites (frontmatter, then body, References section excluded) in first-cited order. */
export function citedKeys(note: NoteRecord & { body: string }): string[] {
	return uniqueInOrder(scanNote(note).citations.map(item => item.citekey));
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
export function citesForNote(note: NoteRecord & { body: string }, verdicts: ReadonlyMap<string, KeyVerdict>): FileCites {
	const { citations, span } = scanNote(note);
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

/** `## References` plus one line per distinct key in the given (first-cited) order; lines joined by `\n`, no trailing newline. */
export function referencesMarkdown(keys: readonly string[], classified: ReadonlyMap<string, KeyVerdict>, bibliography: ReadonlyMap<string, string>, hubFullCitation: ReadonlyMap<string, string>): string {
	return ["## References", ...uniqueInOrder(keys).map(key => referencesLine(key, classified.get(key), bibliography, hubFullCitation))].join("\n");
}

/** The `references` payload of the action: resolved texts, unresolved keys with hints, and the generated Markdown. */
export function referencesPayload(keys: readonly string[], classified: ReadonlyMap<string, KeyVerdict>, bibliography: ReadonlyMap<string, string>, hubFullCitation: ReadonlyMap<string, string>): ReferencesPayload {
	const resolved: ReferencesPayload["resolved"] = [];
	const unresolved: ReferencesPayload["unresolved"] = [];
	for (const citekey of uniqueInOrder(keys)) {
		const verdict = classified.get(citekey);
		const status = verdict?.citeStatus ?? "dangling";
		if (status === "resolved") resolved.push({ citekey, text: oneLine(bibliography.get(citekey) ?? "") });
		else unresolved.push({ citekey, citeStatus: status, ...(status === "unchecked" && verdict?.uncheckedReason ? { uncheckedReason: verdict.uncheckedReason } : {}), hint: hintFor(status, verdict?.uncheckedReason) });
	}
	return { resolved, unresolved, markdown: referencesMarkdown(keys, classified, bibliography, hubFullCitation) };
}
