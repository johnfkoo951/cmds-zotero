/**
 * Action orchestration shared by the live host (IngestAPI inside Obsidian) and the offline host (scripts/ingest-core.mjs).
 * Pure with respect to the environment: everything the host knows (index, vault notes, connection, bibliography access,
 * PDF caches) is injected through {@link ActionHost}. Never imports `obsidian`.
 */
import type { CmdsZoteroSettings, Diagnostic, ZoteroIndex, ZoteroIndexEntry } from "../types";
import type { ConnectionInfo, Envelope, FailureReason, IndexView, NoteRecord, NoteRef, RankedItem, ResolveOutcome, ScanReport, Selector, VaultNotes, VaultReader } from "./types";
import type { ReconcileScanReport, ScanSkip, YamlCodec } from "./types"; // 0.5 R8
import { HUB_IDENTITY_KEYS, noteRef } from "./types";
import { buildEnvelope, infoWarnings, staleGate } from "./connection";
import { resolveIndex, selectorKind } from "./resolve";
import { buildNoteIndexes, classifyNotes, noteKind } from "./note-classify";
import { citekeyShape, emitDoi, entryArxiv, normalizeArxiv, normalizeDoi } from "./search";
import { callout, identityFrontmatter, pickPdf, s01Lines, yamlFragment } from "./identity-fields";
import { buildNoteLookup, checkCitekey } from "./citekey-check";
import { citedKeys, citesDiagnostics, citesForNote, classifyKeys, hubFullCitationLine, keysForFiles, referencesPayload, summarize } from "./cites-core";
import type { NoteLookups } from "./cites-core";
// 0.5 R10
import { BIBLIOGRAPHY_FORMATS, DEFAULT_REFERENCES_HEADING, defaultSidecarPath, groupResolvedByLibrary, isStructuredFormat, mergeExports, sidecarContent, sidecarWriteDecision, structuredReferencesPayload, validateSidecarPath } from "./cites-core";
import type { BibliographyExporter, BibliographyFormat, ReferencesPayload, StructuredExport, StructuredReferencesPayload } from "./cites-core";
import { inFolders, reconcileNotes } from "./reconcile-core";
import type { ReconcileResult } from "./reconcile-core";
import { findNote } from "./note-lookup";
import { diagnostic } from "../diagnostics";
import type { AgentDiagnostic } from "../diagnostics";
import { cachePrefix, parseCacheName, pickNewest, validateCache, verifyCache, PDF_TEXT_CACHE_DIR } from "../pdf/cache";
import type { PdfTextCache } from "../pdf/cache";
import type { ExtractResult } from "../pdf/extract";
import { extractQuoteCallouts, locateBatch } from "../pdf/locate";
import type { LocateRequest } from "../pdf/locate";
import { createHash } from "node:crypto";
import { bbtErrorPayload } from "../api/transport";
import { IndexRefusalError } from "../index-service";
import { textLayerReport, textLayerWarning } from "../pdf/text-layer";
import { describeNoteStatus, describeSendOutcome, localDay, needsSending, readLabel, type ImportNoteResult, type RecentReport } from "../recent/recent-reads";

export { findNote };

export const MAX_CITES_FILES = 2000;

export interface BibliographyProvider {
	/** Rendered bibliography text or null when the style failed; throws when BBT is unreachable. */
	(entry: ZoteroIndexEntry, style: string): Promise<string | null>;
}

export interface PdfCacheReader {
	list(dir: string): Promise<string[]>;
	read(path: string): Promise<string | null>;
	statLocal(absolutePath: string): Promise<{ size: number; mtimeMs: number } | null>;
	/**
	 * sha256 of a vault-relative PDF (`--file` targets); null when absent or outside the vault. A present file refused for
	 * its size or content throws a `LocalFileError` (`too-large` / `bad-magic`) so the host can report the precise reason.
	 */
	fileHash(vaultRelativePath: string): Promise<{ sha256: string; absolutePath: string } | null>;
}

export type AgentAction = "connection" | "info" | "refresh" | "resolve" | "identity" | "cites" | "reconcile" | "diagnostics" | "pdf-text" | "locate" | "recent" | "import";
export const AGENT_ACTIONS: readonly AgentAction[] = ["connection", "info", "refresh", "resolve", "identity", "cites", "reconcile", "diagnostics", "pdf-text", "locate", "recent", "import"];
export const ACTION_API_VERSION: Readonly<Record<AgentAction, 1 | 2>> = {
	connection: 1, info: 2, refresh: 1, resolve: 1, identity: 2, cites: 2, reconcile: 2, diagnostics: 1, "pdf-text": 2, locate: 2, recent: 2, import: 2
};

export interface ActionHost {
	vault: string;
	now: Date;
	connection: ConnectionInfo;
	settings: CmdsZoteroSettings;
	indexView: IndexView | null;
	/** Why the index is unusable, when `indexView` is null. */
	indexFailure: { reason: FailureReason; message: string } | null;
	reader: VaultReader;
	bibliography: BibliographyProvider | null;
	bibliographyReason: "bbt-unreachable" | "offline" | "disabled" | null;
	vaultLinks(entry: ZoteroIndexEntry, index: ZoteroIndex): Promise<{ links: { vault: string; path: string; uri: string }[]; warnings: string[] }>;
	pdfCache: PdfCacheReader;
	/** Vault-relative PDF paths (at least those under `80. References/Attachments/`). */
	vaultPdfPaths(): Promise<string[]>;
	refresh?: (request: RefreshRequest) => Promise<{ host: ActionHost; refreshed: boolean; reason: "forced" | "stale" | "fresh"; ageMinutesBefore: number | null }>;
	extractPdf?: (target: LocateTarget, request: PdfTextRequest) => Promise<ExtractResult>;
	applyReconcile?: (result: ReconcileResult, request: ReconcileRequest) => Promise<unknown>;
	// 0.5 R10: live host only. `exportBibliography` runs one BBT `item.export` per library; `sidecar` reads/writes the bibliography file.
	exportBibliography?: BibliographyExporter;
	sidecar?: SidecarStore;
	/** Live host only: Zotero's reading history with each paper's literature-note state (Zotero must be running). */
	recentReads?: (days: number) => Promise<RecentReport[]>;
	/** Live host only: the literature-note import the plugin UI uses; writes only when `request.apply` is true. */
	importNote?: (request: ImportRequest) => Promise<ImportNoteResult>;
	/** 0.5 R8: YAML codec for the informational `yamlNormalisable` flag on reconcile rows; absent hosts omit the flag. */
	yaml?: YamlCodec;
}

/** 0.5 R10: vault-relative sidecar access; `read` returns null when absent, `write` ensures the private ignore file and folders and returns the byte count. */
export interface SidecarStore {
	read(path: string): Promise<string | null>;
	write(path: string, content: string): Promise<number>;
}

export interface CommonRequest { allowStale?: boolean }
export interface ResolveRequest extends Selector, CommonRequest { refresh?: boolean }
export interface IdentityRequest extends ResolveRequest { rawSource?: string; attachment?: string; style?: string; noBibliography?: boolean }
export interface CitesRequest extends CommonRequest { path: string; recursive?: boolean; bibliography?: boolean; style?: string; strict?: boolean; /** 0.5 R10 */ format?: BibliographyFormat; out?: string | true; force?: boolean }
export interface ReconcileRequest extends CommonRequest { folders?: string[]; apply?: boolean; strict?: boolean }
export interface LocateRequestArgs { path?: string; citekey?: string; itemKey?: string; libraryID?: number; file?: string; quote?: string; attachment?: string }
export interface RefreshRequest { ifOlderThanMinutes?: number }
export interface PdfTextRequest { citekey?: string; itemKey?: string; libraryID?: number; file?: string; attachment?: string; pages?: string; force?: boolean }
export interface RecentRequest { days?: number }
export interface ImportRequest { citekey?: string; itemKey?: string; libraryID?: number; apply?: boolean; allowStale?: boolean }
export type ActionRequest = ResolveRequest | IdentityRequest | CitesRequest | ReconcileRequest | LocateRequestArgs | RefreshRequest | PdfTextRequest | RecentRequest | ImportRequest | CommonRequest | Record<string, never>;

type Payload = Envelope & Record<string, unknown>;

function envelope(host: ActionHost, action: string, apiVersion: 1 | 2, failure?: { reason: FailureReason; message: string }): Envelope {
	return buildEnvelope(action, host.vault, apiVersion, host.connection, host.now, failure);
}

function requireIndex(host: ActionHost, action: string, apiVersion: 1 | 2): { view: IndexView } | { failure: Payload } {
	if (host.indexView) return { view: host.indexView };
	const failure = host.indexFailure ?? { reason: "index-missing" as const, message: "No validated Zotero index is available; refresh the index with Obsidian open." };
	return { failure: { ...envelope(host, action, apiVersion, failure), ...(apiVersion === 1 ? { status: "unavailable", message: failure.message } : {}) } };
}

function selectorOf(request: Selector): Selector {
	const selector: Selector = {};
	for (const key of ["citekey", "itemKey", "libraryID", "doi", "arxiv", "title", "year", "author", "query"] as const) {
		const value = request[key];
		if (value !== undefined && value !== null && value !== "") (selector as Record<string, unknown>)[key] = value;
	}
	return selector;
}

function hintsOf(selector: Selector, entry: ZoteroIndexEntry | null): { doi?: string; arxiv?: string; citekey?: string } {
	const doi = normalizeDoi(selector.doi ?? entry?.doi ?? "");
	const arxiv = (selector.arxiv ? normalizeArxiv(selector.arxiv) : "") || (entry ? entryArxiv(entry) : "");
	return { ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}), ...(selector.citekey ? { citekey: selector.citekey } : {}) };
}

function evidenceOf(entry: ZoteroIndexEntry): unknown[] {
	return entry.attachments.flatMap(attachment => attachment.annotations.map(annotation => ({ annotationKey: annotation.key, attachmentKey: attachment.key, page: annotation.page, pageLabel: annotation.pageLabel, uri: annotation.uri })));
}

function reducedItem(entry: ZoteroIndexEntry): Record<string, unknown> {
	return { id: entry.id, itemKey: entry.itemKey, libraryID: entry.libraryID, libraryType: entry.libraryType, ...(entry.groupID === undefined ? {} : { groupID: entry.groupID }), citekey: entry.citekey, citekeyHistory: entry.citekeyHistory, title: entry.title, authors: entry.authors, year: entry.year, doi: emitDoi(entry.doi), zoteroSelectURI: entry.zoteroSelectURI };
}

interface Resolved {
	outcome: ResolveOutcome;
	view: IndexView;
	notes: NoteRecord[];
	vaultNotes: VaultNotes;
	/** The stale gate withheld a not-found index verdict (`reason: stale-index`). */
	withheld: boolean;
	scan: ScanReport;
	/** Failure to report in the envelope: the stale gate first, else truncated discovery; null when the payload is usable. */
	failure: { reason: FailureReason; message: string } | null;
}

function scanOf(host: ActionHost): ScanReport {
	const scan = host.reader.scanWarnings?.() ?? { skipped: [], truncated: false };
	return { skipped: [...scan.skipped], truncated: scan.truncated };
}

/**
 * Truncated discovery means notes may be missing entirely, so hub/raw classification cannot be trusted; the message
 * names the omission and never offers `--allow-stale`, which addresses index age only.
 */
function discoveryFailure(scan: ScanReport): { reason: FailureReason; message: string } {
	const shown = scan.skipped.slice(0, 10);
	const paths = shown.length ? ` Skipped notes (first ${shown.length} of ${scan.skipped.length}): ${shown.join(", ")}.` : "";
	return { reason: "discovery-incomplete", message: `Vault discovery was truncated at the note limit and ${scan.skipped.length} notes were skipped; hub and raw-source notes may be missing from vaultNotes, so the vault classification is incomplete. The Zotero-index verdict stands.${paths}` };
}

/**
 * Shared first half of resolve/identity: selector validation, index lookup, stale gate, vault note classification.
 * Only the stale gate withholds a not-found index verdict. Vault-discovery incompleteness (skipped or truncated notes)
 * affects hub/raw classification, so it is reported in `scan` and `vaultNotes.warnings`, never as `stale-index`.
 */
async function resolveCore(host: ActionHost, selector: Selector, allowStale: boolean, view: IndexView): Promise<Resolved> {
	const check = selectorKind(selector);
	if (check.error || !check.kind) throw new Error(check.error ?? "Provide exactly one selector.");
	const outcome = resolveIndex(view.index, selector);
	const notes = await host.reader.listNotes();
	const scan = scanOf(host);
	const withheld = outcome.status === "not-found" && staleGate(host.connection, allowStale);
	const vaultNotes = classifyNotes(host.vault, notes, outcome.entry, hintsOf(selector, outcome.entry), view.index, { outputFolder: host.settings.outputFolder });
	if (scan.truncated || scan.skipped.length > 0) vaultNotes.warnings.push(`Vault discovery incomplete: ${scan.skipped.length} skipped; truncated ${scan.truncated}. Hub/raw classification may be incomplete; the Zotero-index verdict is unaffected.`);
	const failure = withheld
		? { reason: "stale-index" as const, message: `The index is ${view.ageMinutes} minutes old; a not-found verdict was withheld. Refresh the index or pass --allow-stale.` }
		: scan.truncated ? discoveryFailure(scan) : null;
	return { outcome, view, notes, vaultNotes, withheld, scan, failure };
}

function rankedOf(outcome: ResolveOutcome): RankedItem[] { return outcome.ranked; }

export async function resolveAction(host: ActionHost, request: ResolveRequest): Promise<Payload> {
	const index = requireIndex(host, "resolve", 1);
	if ("failure" in index) return index.failure;
	const selector = selectorOf(request);
	const { outcome, view, vaultNotes, withheld, scan, failure } = await resolveCore(host, selector, request.allowStale === true, index.view);
	const entry = outcome.entry;
	const base = { ...envelope(host, "resolve", 1, failure ?? undefined) };
	return {
		...base,
		status: withheld ? "unavailable" : outcome.status,
		...(withheld ? { indexAnswer: outcome.status } : {}),
		...(outcome.message ? { message: outcome.message } : {}),
		...(entry ? { entry, matchedHistory: outcome.matchedHistory, evidence: evidenceOf(entry), vaultLinks: await host.vaultLinks(entry, view.index) } : {}),
		...(outcome.status === "ambiguous" ? { candidates: outcome.candidates } : {}),
		generatedAt: view.index.generatedAt,
		query: outcome.query,
		matchedBy: outcome.matchedBy,
		ranked: rankedOf(outcome),
		vaultNotes,
		scan,
		citekeyShape: entry ? citekeyShape(entry.citekey) : null,
		pinnedGuess: entry ? citekeyShape(entry.citekey) === "vault" : null,
	};
}

export async function identityAction(host: ActionHost, request: IdentityRequest): Promise<Payload> {
	const index = requireIndex(host, "identity", 2);
	if ("failure" in index) return index.failure;
	const selector = selectorOf(request);
	// `--citekey` beside another selector names the vault key without taking part in the lookup.
	const lookupSelector: Selector = { ...selector };
	if (selector.citekey && (selector.doi || selector.arxiv || selector.title || selector.query || selector.itemKey)) delete lookupSelector.citekey;
	const { outcome, view, notes, vaultNotes, withheld, scan, failure } = await resolveCore(host, lookupSelector, request.allowStale === true, index.view);
	const entry = outcome.entry;
	const requestedCitekey = request.citekey ?? null;
	const frontmatter = identityFrontmatter({ requestedCitekey, outcome, stale: withheld, now: host.now, emittedDoi: emitDoi(request.doi ?? entry?.doi ?? "") });
	const citekeyCurrent = entry?.citekey ?? null;
	const pdf = pickPdf(entry ?? emptyEntry(), request.attachment);
	const style = request.style ?? host.settings.bibliographyStyle;
	let bibliography: { style: string; text: string } | null = null;
	let bibliographyReason: string | undefined = request.noBibliography ? "disabled" : host.bibliographyReason ?? undefined;
	let bbtError: ReturnType<typeof bbtErrorPayload> = null; // 0.5 R4
	if (!request.noBibliography && entry && host.bibliography) {
		try {
			const text = await host.bibliography(entry, style);
			if (text) bibliography = { style, text }; else bibliographyReason = "style-error";
		} catch (error) { bibliographyReason = "bbt-unreachable"; bbtError = bbtErrorPayload(error); }
	}
	const unavailableReason = withheld ? "stale-index" : outcome.status === "unavailable" ? outcome.message : undefined;
	const s01 = s01Lines({ frontmatter, citekeyCurrent, bibliography: bibliography?.text ?? null, pdf, rawSource: request.rawSource ?? null, rawNotes: vaultNotes.raw, candidateCount: outcome.status === "ambiguous" ? outcome.candidates.length : undefined, unavailableReason });
	const lookup = buildNoteLookup(host.vault, notes);
	const hints = hintsOf(selector, entry);
	const keyToCheck = frontmatter.citekey || entry?.citekey || "";
	const citekeyCheck = keyToCheck ? checkCitekey(keyToCheck, view.index, lookup, { doi: hints.doi, arxiv: hints.arxiv, ownId: entry?.id, ownPaths: vaultNotes.hub ? [vaultNotes.hub.path] : [] }) : null;
	const status = frontmatter.zoteroStatus;
	return {
		...envelope(host, "identity", 2, failure ?? undefined),
		status: withheld ? "unavailable" : outcome.status,
		...(withheld ? { indexAnswer: outcome.status } : {}),
		matchedBy: outcome.matchedBy,
		query: outcome.query,
		item: entry ? reducedItem(entry) : null,
		citekeyCurrent,
		ranked: rankedOf(outcome),
		vaultNotes,
		scan,
		frontmatter,
		yaml: yamlFragment(frontmatter),
		s01,
		callout: callout(status, frontmatter.citekey ?? "", frontmatter.zoteroCheckedAt, citekeyCheck?.pinInstruction ?? null, { citekeyCurrent, candidateCount: outcome.status === "ambiguous" ? outcome.candidates.length : undefined, unavailableReason }),
		bibliography,
		...(bibliographyReason && !bibliography ? { bibliographyReason } : {}),
		...(bibliographyReason && !bibliography && bbtError ? { bbtError } : {}),
		pdf,
		citekeyCheck,
		identityKeys: [...HUB_IDENTITY_KEYS],
		generatedAt: view.index.generatedAt,
	};
}

function emptyEntry(): ZoteroIndexEntry {
	return { id: "0:AAAAAAAA", libraryID: 1, libraryType: "user", itemKey: "AAAAAAAA", citekey: "", citekeyHistory: [], title: "", authors: [], year: "", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "", attachments: [], attachmentStatus: "unavailable", contentHash: "", metadata: {} };
}

function toRefMaps(indexes: ReturnType<typeof buildNoteIndexes>, vault: string): NoteLookups & { hubByDoi: Map<string, NoteRef[]>; rawByDoi: Map<string, NoteRef[]> } {
	// 0.5 R15: one canonical obsidian://open builder for every NoteRef.
	const convert = (source: Map<string, NoteRecord[]>): Map<string, NoteRef[]> => new Map([...source].map(([key, records]) => [key, records.map(record => noteRef(vault, record.path))]));
	return { hubByCitekey: convert(indexes.hubByCitekey), rawByCitekey: convert(indexes.rawByCitekey), hubByDoi: convert(indexes.hubByDoi), rawByDoi: convert(indexes.rawByDoi), skipped: indexes.skipped };
}

/**
 * A path no vault reader could resolve inside the vault: scheme-prefixed, traversing, or carrying `\` / NUL. Call it with
 * the slash-trimmed path: a leading `/` is vault-root-relative for every `--path` action (cites has always read it so).
 */
function outsideVault(path: string): boolean {
	return /^[a-z]+:/i.test(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === "..");
}

// 0.5 R13/F13: callers that already listed the vault pass `listed` so one request never scans it twice.
async function notesUnder(host: ActionHost, path: string, recursive: boolean, listed?: NoteRecord[]): Promise<{ notes: NoteRecord[]; truncated: boolean; isFile: boolean }> {
	const clean = path.replace(/^\/+|\/+$/g, "");
	const all = listed ?? await host.reader.listNotes();
	const exact = findNote(all, clean);
	if (exact) return { notes: [exact], truncated: false, isFile: true };
	const prefix = clean ? `${clean}/` : "";
	const inside = all.filter(note => note.path.startsWith(prefix) && (recursive || !note.path.slice(prefix.length).includes("/")));
	return { notes: inside.slice(0, MAX_CITES_FILES), truncated: inside.length > MAX_CITES_FILES, isFile: false };
}

export async function citesAction(host: ActionHost, request: CitesRequest): Promise<Payload> {
	const index = requireIndex(host, "cites", 2);
	if ("failure" in index) return index.failure;
	const view = index.view;
	const forcedEvidenceGate = host.connection.index.complete !== true || host.connection.index.stale === null;
	const stale = forcedEvidenceGate || host.connection.index.stale === true;
	const allowStaleNegative = request.allowStale === true && !forcedEvidenceGate;
	const all = await host.reader.listNotes();
	const { notes: targets, truncated, isFile } = await notesUnder(host, request.path, request.recursive === true, all);
	if (!targets.length && !isFile) return { ...envelope(host, "cites", 2, { reason: "path-outside-vault", message: `No Markdown notes found at ${request.path}.` }) };
	const indexes = buildNoteIndexes(all);
	const lookups = toRefMaps(indexes, host.vault);
	const scan = scanOf(host);
	lookups.skipped = [...new Set([...(lookups.skipped ?? []), ...scan.skipped, ...(scan.truncated ? ["<vault-scan-truncated>"] : [])])];
	const headings = host.settings.referencesHeadings; // 0.5 R10
	const withBodies: (NoteRecord & { body: string })[] = [];
	for (const note of targets) withBodies.push({ ...note, body: await host.reader.readNote(note.path) });
	const allKeys = [...new Set(withBodies.flatMap(note => citedKeys(note, headings)))];
	const verdicts = classifyKeys(allKeys, view.index, lookups, stale, allowStaleNegative);
	const files = withBodies.map(note => citesForNote(note, verdicts, headings));
	const keys = keysForFiles(files);
	let references: ReferencesPayload | StructuredReferencesPayload | null = null;
	let referencesReason: string | undefined;
	let bbtError: ReturnType<typeof bbtErrorPayload> = null; // 0.5 R4
	// 0.5 R10: the found heading is reused for markdown output (first note with a References section wins).
	const heading = files.find(file => file.referencesSection.heading)?.referencesSection.heading ?? DEFAULT_REFERENCES_HEADING;
	const format: BibliographyFormat = request.format ?? "text";
	if (request.bibliography && isStructuredFormat(format)) {
		const byId = new Map(view.index.entries.map(entry => [entry.id, entry]));
		const { groups, renamed } = groupResolvedByLibrary(allKeys, verdicts, byId);
		let merged: StructuredExport | null = null;
		if (!host.exportBibliography) referencesReason = host.bibliographyReason ?? "offline";
		else {
			const outputs: string[] = [];
			try {
				// One RPC per library; a typed fault stops the loop (never N timeouts).
				for (const group of groups) outputs.push(await host.exportBibliography(group.citekeys, format, group.libraryID));
				merged = mergeExports(format, outputs);
			} catch (error) {
				referencesReason = "bbt-unreachable";
				bbtError = bbtErrorPayload(error);
				if (!bbtError) referencesReason = "export-invalid";
			}
		}
		references = structuredReferencesPayload(allKeys, verdicts, format, heading, merged, renamed);
	} else if (request.bibliography && !isStructuredFormat(format)) {
		const bibliography = new Map<string, string>();
		const hubFull = new Map<string, string>();
		const style = request.style ?? host.settings.bibliographyStyle;
		const byId = new Map(view.index.entries.map(entry => [entry.id, entry]));
		// 0.5 R4: after a typed unreachable/timeout/404 fault, BBT is not asked again for the remaining keys (one mapped failure, not N timeouts).
		let bbtDown = false;
		for (const key of allKeys) {
			const verdict = verdicts.get(key);
			if (!verdict) continue;
			if (verdict.citeStatus === "resolved" && verdict.entryId && host.bibliography && !bbtDown) {
				const entry = byId.get(verdict.entryId);
				if (entry) {
					try { const text = await host.bibliography(entry, style); if (text) bibliography.set(key, text); }
					catch (error) {
						referencesReason = "bbt-unreachable";
						bbtError = bbtErrorPayload(error) ?? bbtError;
						if (bbtError && ["connection-refused", "timeout", "http-404"].includes(bbtError.reason)) bbtDown = true;
					}
				}
			} else if (verdict.citeStatus === "resolved" && !host.bibliography) referencesReason = host.bibliographyReason ?? "offline";
			if (verdict.hub) { const line = hubFullCitationLine(await host.reader.readNote(verdict.hub.path)); if (line) hubFull.set(key, line); }
		}
		references = referencesPayload(allKeys, verdicts, bibliography, hubFull, { format, heading, style });
	}
	const diagnostics = citesDiagnostics(files);
	const payload: Payload = { ...envelope(host, "cites", 2), files, keys, references, ...(referencesReason ? { referencesReason } : {}), ...(referencesReason && bbtError ? { bbtError } : {}), summary: summarize(files, truncated || scan.truncated), scan: { skipped: lookups.skipped ?? [], truncated: scan.truncated }, diagnostics };
	if (request.out === undefined) return payload;
	// 0.5 R10: sidecar write. Default path is plugin-owned; an explicit path is validated, then guarded by the overwrite rule.
	let outPath: string;
	try { outPath = request.out === true ? defaultSidecarPath(request.path, isFile, format) : validateSidecarPath(request.out); }
	catch (error) { return { ...payload, ...envelope(host, "cites", 2, { reason: "path-outside-vault", message: error instanceof Error ? error.message : "Invalid sidecar path." }), out: { path: String(request.out), written: false } }; }
	if (!request.bibliography) return { ...payload, ...envelope(host, "cites", 2, { reason: "invalid-request", message: "--out needs --bibliography." }), out: { path: outPath, written: false } };
	if (!host.sidecar) return { ...payload, ...envelope(host, "cites", 2, { reason: "requires-obsidian", message: "Writing a bibliography sidecar requires the live Obsidian host." }), out: { path: outPath, written: false } };
	const content = references?.content ?? null;
	if (content === null) return { ...payload, ...envelope(host, "cites", 2, { reason: referencesReason === "bbt-unreachable" ? "bbt-unreachable" : "invalid-request", message: `No bibliography content to write (${referencesReason ?? "unavailable"}).` }), out: { path: outPath, written: false } };
	const decision = sidecarWriteDecision(outPath, format, await host.sidecar.read(outPath), request.force === true);
	if (!decision.ok) return { ...payload, ...envelope(host, "cites", 2, { reason: "invalid-request", message: decision.message }), out: { path: outPath, written: false } };
	const bytes = await host.sidecar.write(outPath, sidecarContent(format, content));
	return { ...payload, out: { path: outPath, written: true, bytes } };
}

// 0.5 R8
/**
 * The reconcile scan report: every skipped path classified. A reader without `skippedDetail` is classified from the
 * listing (rows whose frontmatter failed to parse are parse errors; any other skipped path counts as unreadable).
 */
function reconcileScanOf(host: ActionHost, listed: NoteRecord[]): ReconcileScanReport {
	const scan = host.reader.scanWarnings?.() ?? { skipped: [], truncated: false };
	const parseErrors = new Set(listed.filter(note => note.frontmatterParse === "error").map(note => note.path));
	const skippedDetail: ScanSkip[] = scan.skippedDetail ? scan.skippedDetail.map(item => ({ ...item })) : scan.skipped.map(path => ({ path, kind: parseErrors.has(path) ? "parse-error" : "unreadable" }));
	for (const item of skippedDetail) if (item.kind === "parse-error") parseErrors.add(item.path);
	return { skipped: [...scan.skipped], truncated: scan.truncated, skippedDetail, parseErrors: [...parseErrors].sort() };
}

const listPaths = (paths: string[]): string => { const shown = paths.slice(0, 10); return `${shown.join(", ")}${paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : ""}`; };

/**
 * Why `--apply` is refused for the whole vault: a truncated scan, an unreadable or symlinked entry, or a parse-error note
 * inside the apply scope (under `--folders`, or one of the candidate hubs). Parse errors elsewhere are echoed in
 * `scan.parseErrors`; a hub they mention is withheld individually (`blocked-by-parse-error`), never the vault.
 */
function applyScanVeto(scan: ReconcileScanReport, result: ReconcileResult): string | null {
	if (scan.truncated) return "Vault discovery was truncated at the note limit; hubs may be missing, so reconcile apply is refused.";
	const unreadable = scan.skippedDetail.filter(item => item.kind !== "parse-error").map(item => item.path);
	if (unreadable.length) return `Vault discovery skipped ${unreadable.length} unreadable or symlinked ${unreadable.length === 1 ? "entry" : "entries"} (${listPaths(unreadable)}); reconcile apply is refused.`;
	const candidates = new Set(result.notes.filter(note => note.type === "paper-hub" && note.proposalEligible && note.proposed).map(note => note.path));
	const inScope = scan.parseErrors.filter(path => candidates.has(path) || (result.folders.length > 0 && inFolders(path, result.folders)));
	if (inScope.length) return `${inScope.length} ${inScope.length === 1 ? "note" : "notes"} with unparseable frontmatter ${inScope.length === 1 ? "lies" : "lie"} inside the apply scope (${listPaths(inScope)}); repair ${inScope.length === 1 ? "it" : "them"} or narrow --folders. Parse errors outside the scope are listed in scan.parseErrors and do not veto apply.`;
	return null;
}

export async function reconcileDryRun(host: ActionHost, request: ReconcileRequest, listedNotes?: NoteRecord[]): Promise<{ result: ReconcileResult; view: IndexView | null; stale: boolean; scan: ReconcileScanReport }> {
	const view = host.indexView;
	// Preserve raw freshness for proposals/apply: allowStale relaxes reporting only and never turns stale evidence fresh.
	const stale = view ? host.connection.index.complete !== true || host.connection.index.stale !== false : true;
	const listed = listedNotes ?? await host.reader.listNotes();
	const notes: NoteRecord[] = [];
	for (const note of listed) {
		const kind = noteKind(note);
		if (kind === "hub" || (kind === "raw" && typeof note.frontmatter?.citekey === "string")) notes.push({ ...note, body: await host.reader.readNote(note.path) });
		else notes.push(note);
	}
	const pdfPaths = await host.vaultPdfPaths();
	// 0.5 R8: parse-error notes are read once so hubs they mention can be withheld; one that vanished since the listing is unreadable.
	const scan = reconcileScanOf(host, listed);
	const parseErrorSources: { path: string; text: string }[] = [];
	for (const path of scan.parseErrors) {
		try { parseErrorSources.push({ path, text: await host.reader.readNote(path) }); }
		catch { scan.skippedDetail.push({ path, kind: "unreadable" }); if (!scan.skipped.includes(path)) scan.skipped.push(path); }
	}
	const result = reconcileNotes(notes, view?.index ?? null, { name: host.vault, pdfPaths }, { now: host.now, stale, allowStale: request.allowStale === true, folders: request.folders, parseErrorSources, ...(host.yaml ? { yaml: host.yaml } : {}) });
	const sourceByPath = new Map(notes.filter(note => note.body !== undefined).map(note => [note.path, note.body as string]));
	for (const note of result.notes) {
		const source = sourceByPath.get(note.path);
		if (source !== undefined) (note as typeof note & { sourceHash: string }).sourceHash = createHash("sha256").update(source).digest("hex");
	}
	return { result, view, stale, scan };
}

export async function reconcileAction(host: ActionHost, request: ReconcileRequest): Promise<Payload> {
	const { result, view, scan } = await reconcileDryRun(host, request);
	if (!request.apply) return { ...envelope(host, "reconcile", 2), mode: "dry-run", ...result, scan, apply: { mode: "dry-run" }, generatedAt: view?.index.generatedAt ?? null };
	const veto = applyScanVeto(scan, result); // 0.5 R8: scoped scan policy replaces the any-skip veto
	if (veto) return { ...envelope(host, "reconcile", 2, { reason: "scan-incomplete", message: veto }), mode: "apply", ...result, scan, apply: { mode: "refused", refusedReason: "scan-incomplete", refusedMessage: veto }, generatedAt: view?.index.generatedAt ?? null };
	if (!host.applyReconcile) return { ...envelope(host, "reconcile", 2, { reason: "requires-obsidian", message: "reconcile --apply requires the live Obsidian host." }), mode: "apply", ...result, scan, apply: { mode: "refused", refusedReason: "requires-obsidian" }, generatedAt: view?.index.generatedAt ?? null };
	const applied = await host.applyReconcile(result, request);
	const applyState = applied && typeof applied === "object" ? applied as { mode?: unknown; refusedReason?: unknown; notes?: unknown } : {};
	const failed = applyState.mode !== "applied";
	const outcomes = new Map<string, { status?: unknown; reason?: unknown }>();
	if (Array.isArray(applyState.notes)) for (const item of applyState.notes as unknown[]) {
		if (item && typeof item === "object" && "path" in item && typeof item.path === "string") outcomes.set(item.path, item as { status?: unknown; reason?: unknown });
	}
	const notes = result.notes.map(note => {
		const outcome = outcomes.get(note.path);
		return { ...note, applied: outcome?.status === "applied", ...(typeof outcome?.reason === "string" ? { skippedReason: outcome.reason } : {}) };
	});
	const reason = applyState.mode === "refused" && typeof applyState.refusedReason === "string" ? applyState.refusedReason as FailureReason : "apply-failed";
	return { ...envelope(host, "reconcile", 2, failed ? { reason, message: applyState.mode === "refused" ? `Reconcile apply was refused: ${reason}.` : "Reconcile apply was only partially completed; inspect per-note outcomes before retrying." } : undefined), mode: "apply", ...result, notes, scan, apply: applied, generatedAt: view?.index.generatedAt ?? null };
}

export async function infoAction(host: ActionHost): Promise<Payload> {
	const view = host.indexView;
	const index = view?.index ?? null;
	const libraries = new Map<string, { libraryID: number; libraryType: string; groupID?: number; count: number }>();
	for (const entry of index?.entries ?? []) {
		const key = `${entry.libraryType}:${entry.libraryID}`;
		const current = libraries.get(key) ?? { libraryID: entry.libraryID, libraryType: entry.libraryType, ...(entry.groupID === undefined ? {} : { groupID: entry.groupID }), count: 0 };
		current.count++;
		libraries.set(key, current);
	}
	return {
		...envelope(host, "info", 2),
		plugin: { version: host.connection.plugin.version, apiVersions: host.connection.plugin.apiVersions, legacyPluginEnabled: host.connection.legacyPluginEnabled },
		index: {
			present: index !== null, path: host.connection.index.path, schemaVersion: host.connection.index.schemaVersion, generatedAt: host.connection.index.generatedAt,
			...(host.indexFailure ? { failure: host.indexFailure } : {}),
			ageMinutes: host.connection.index.ageMinutes, stale: host.connection.index.stale, maxAgeMinutes: host.connection.index.maxAgeMinutes,
			count: index?.count ?? null, complete: index?.complete ?? null, libraries: [...libraries.values()],
			withPdf: index ? index.entries.filter(entry => entry.attachments.some(a => a.path?.toLowerCase().endsWith(".pdf"))).length : null,
			withAnnotations: index ? index.entries.filter(entry => entry.attachments.some(a => a.annotations.length > 0)).length : null,
			diagnosticsCount: index?.diagnostics.length ?? null,
		},
		settings: { zoteroIndexPath: host.settings.zoteroIndexPath, outputFolder: host.settings.outputFolder, bibliographyStyle: host.settings.bibliographyStyle, indexMaxAgeMinutes: host.settings.indexMaxAgeMinutes, peerVaults: host.settings.peerVaults.map(peer => peer.name) },
		git: host.connection.git,
		warnings: infoWarnings(host.connection),
	};
}

/** v1 diagnostics plus the contract-2 codes from reconcile (dry-run) and cites over research-question/synthesis notes. */
export async function diagnosticsAction(host: ActionHost, request: CommonRequest): Promise<Payload> {
	const index = requireIndex(host, "diagnostics", 1);
	if ("failure" in index) return index.failure;
	const view = index.view;
	const diagnostics: (Diagnostic | AgentDiagnostic)[] = [...view.index.diagnostics];
	const listed = await host.reader.listNotes();
	for (const note of listed) if (note.frontmatter?.citekeyProvisional === true) diagnostics.push({ code: "provisional-citekey", severity: "warning", message: `Provisional citekey: ${note.path}. Pin it in Zotero; do not rename the note automatically.`, path: note.path });
	const { result } = await reconcileDryRun(host, { allowStale: request.allowStale }, listed);
	diagnostics.push(...result.diagnostics);
	const citing = listed.filter(note => typeof note.frontmatter?.type === "string" && ["research-question", "synthesis"].includes(note.frontmatter.type));
	if (citing.length) {
		const forcedEvidenceGate = host.connection.index.complete !== true || host.connection.index.stale === null;
		const stale = forcedEvidenceGate || host.connection.index.stale === true;
		const allowStaleNegative = request.allowStale === true && !forcedEvidenceGate;
		const lookups = toRefMaps(buildNoteIndexes(listed), host.vault);
		const scan = scanOf(host);
		lookups.skipped = [...new Set([...(lookups.skipped ?? []), ...scan.skipped, ...(scan.truncated ? ["<vault-scan-truncated>"] : [])])];
		const withBodies: (NoteRecord & { body: string })[] = [];
		for (const note of citing.slice(0, MAX_CITES_FILES)) withBodies.push({ ...note, body: await host.reader.readNote(note.path) });
		const keys = [...new Set(withBodies.flatMap(note => citedKeys(note)))];
		const verdicts = classifyKeys(keys, view.index, lookups, stale, allowStaleNegative);
		diagnostics.push(...citesDiagnostics(withBodies.map(note => citesForNote(note, verdicts))));
	}
	if (host.connection.legacyPluginEnabled) diagnostics.push(diagnostic("legacy-plugin-enabled", "The legacy cmds-link-zotero plugin is enabled beside CMDS Zotero and shares the index path; disable it before refreshing."));
	if (host.connection.index.stale) diagnostics.push(diagnostic("index-stale", `The index is ${host.connection.index.ageMinutes} minutes old (limit ${host.connection.index.maxAgeMinutes}).`));
	if (host.connection.git?.repo && (host.connection.git.indexIgnored === false || host.connection.git.cacheIgnored === false)) diagnostics.push(diagnostic("index-in-git", "The vault is a git repository and the index or the .cmds-zotero cache is not ignored; add both to .gitignore and untrack the index."));
	return { ...envelope(host, "diagnostics", 1), generatedAt: view.index.generatedAt, complete: view.index.complete, count: view.index.count, diagnostics };
}

export interface LocateTarget {
	item: { id: string; citekey: string } | null;
	attachment: { key: string | null; openURI: string | null; path: string | null };
	prefix: string;
	/** For `--file` targets the exact cache name is known from the content hash. */
	exactName?: string;
	localPath: string | null;
}

/** Resolves the PDF target of pdf-text/locate: a Zotero attachment (by citekey or item key) or a vault-relative file. */
export async function locateTarget(host: ActionHost, request: LocateRequestArgs, citekeyFromNote: string | null): Promise<{ target: LocateTarget } | { failure: { reason: FailureReason; message: string; candidates?: unknown[] } }> {
	if (request.file) {
		const hash = await host.pdfCache.fileHash(request.file);
		if (!hash) return { failure: { reason: "path-outside-vault", message: `PDF not found inside the vault: ${request.file}` } };
		// 0.5 R13/F17: the prefix carries the path hash, so identical bytes at two vault paths never share a cache name.
		const prefix = cachePrefix({ kind: "file", path: request.file });
		return { target: { item: null, attachment: { key: null, openURI: null, path: request.file }, prefix, exactName: `${prefix}-${hash.sha256.slice(0, 16)}.json`, localPath: hash.absolutePath } };
	}
	if (!host.indexView) return { failure: host.indexFailure ?? { reason: "index-missing", message: "No validated Zotero index is available." } };
	const citekey = request.citekey ?? citekeyFromNote;
	const selector: Selector = request.itemKey ? { itemKey: request.itemKey, libraryID: request.libraryID } : { citekey: citekey ?? "" };
	if (!selector.itemKey && !selector.citekey) return { failure: { reason: "no-pdf-attachment", message: "Provide --citekey, --item-key with --library, or --file." } };
	const outcome = resolveIndex(host.indexView.index, selector);
	if (outcome.status !== "resolved" || !outcome.entry) return { failure: { reason: "no-pdf-attachment", message: `Item ${outcome.status}: ${JSON.stringify(selector)}` } };
	const entry = outcome.entry;
	const pdf = pickPdf(entry, request.attachment);
	if (pdf.pdfStatus === "ambiguous") return { failure: { reason: "attachment-ambiguous", message: "Several PDF attachments; pass --attachment KEY.", candidates: pdf.candidates } };
	if (pdf.pdfStatus === "missing-file" || pdf.pdfStatus === "unavailable") return { failure: { reason: "attachment-file-missing", message: pdf.pdfStatus === "unavailable" ? "Attachment lookup failed at the last refresh; refresh the index." : "The PDF attachment is indexed but its file is not on this machine (not downloaded); this is not evidence that the item has no PDF." } };
	if (pdf.pdfStatus !== "present" || !pdf.attachmentKey || !pdf.path) return { failure: { reason: "no-pdf-attachment", message: `No PDF attachment is indexed for @${entry.citekey} (pdfStatus ${pdf.pdfStatus}).` } };
	const prefix = cachePrefix({ kind: "attachment", libraryType: entry.libraryType, libraryID: entry.libraryID, attachmentKey: pdf.attachmentKey });
	return { target: { item: { id: entry.id, citekey: entry.citekey }, attachment: { key: pdf.attachmentKey, openURI: pdf.openURI, path: pdf.path }, prefix, localPath: pdf.path } };
}

type CacheLookup = { status: "found"; path: string; cache: PdfTextCache } | { status: "missing" } | { status: "invalid" };
async function findCache(host: ActionHost, target: LocateTarget): Promise<CacheLookup> {
	const names = (await host.pdfCache.list(PDF_TEXT_CACHE_DIR)).filter(name => name.endsWith(".json"));
	if (target.exactName) {
		if (!names.includes(target.exactName)) return { status: "missing" };
		const raw = await host.pdfCache.read(`${PDF_TEXT_CACHE_DIR}/${target.exactName}`);
		if (!raw) return { status: "invalid" };
		try { const parsed: unknown = JSON.parse(raw); return validateCache(parsed) ? { status: "found", path: `${PDF_TEXT_CACHE_DIR}/${target.exactName}`, cache: parsed } : { status: "invalid" }; }
		catch { return { status: "invalid" }; }
	}
	const entries: { name: string; extractedAt: string; cache: PdfTextCache }[] = [];
	let relevant = false;
	let invalid = false;
	for (const name of names) {
		const parsedName = parseCacheName(name);
		if (!parsedName || !name.startsWith(`${target.prefix}-`)) continue;
		relevant = true;
		const raw = await host.pdfCache.read(`${PDF_TEXT_CACHE_DIR}/${name}`);
		if (!raw) { invalid = true; continue; }
		try { const parsed: unknown = JSON.parse(raw); if (validateCache(parsed)) entries.push({ name, extractedAt: parsed.extractedAt, cache: parsed }); else invalid = true; } catch { invalid = true; }
	}
	const newest = pickNewest(entries, target.prefix);
	if (!newest) return relevant && invalid ? { status: "invalid" } : { status: "missing" };
	const hit = entries.find(entry => entry.name === newest.name);
	return hit ? { status: "found", path: `${PDF_TEXT_CACHE_DIR}/${hit.name}`, cache: hit.cache } : { status: "invalid" };
}

export async function locateAction(host: ActionHost, request: LocateRequestArgs): Promise<Payload> {
	let quotes: LocateRequest[] = [];
	let citekeyFromNote: string | null = null;
	if (request.path) {
		// 0.5 R13/F14: resolve the note record first (with or without `.md`, exactly as cites does) and read its real path;
		// an unknown note is a structured refusal, never a thrown error.
		const cleanPath = request.path.replace(/^\/+|\/+$/g, "");
		if (outsideVault(cleanPath)) return { ...envelope(host, "locate", 2, { reason: "path-outside-vault", message: `Note path is outside the vault: ${request.path}` }) };
		// PERF-07: a reader that can find one note without reading the whole vault answers exactly as the listing would.
		const note = host.reader.findNote ? await host.reader.findNote(cleanPath) : findNote(await host.reader.listNotes(), cleanPath);
		if (!note) return { ...envelope(host, "locate", 2, { reason: "invalid-request", message: `Note not found: ${request.path}` }) };
		const body = await host.reader.readNote(note.path);
		const fmKey = typeof note.frontmatter?.citekey === "string" ? note.frontmatter.citekey : null;
		if (request.citekey && fmKey && request.citekey !== fmKey) throw new Error(`--citekey ${request.citekey} disagrees with the note's citekey ${fmKey}.`);
		citekeyFromNote = fmKey;
		quotes = extractQuoteCallouts(body).map(item => ({ line: item.line, quote: item.quote }));
	}
	if (request.quote) quotes.push({ quote: request.quote });
	if (!quotes.length) return { ...envelope(host, "locate", 2, { reason: "quotes-empty", message: request.path ? "The note has no [!quote] callouts." : "Pass --quote or --path." }) };
	const resolved = await locateTarget(host, request, citekeyFromNote);
	if ("failure" in resolved) return { ...envelope(host, "locate", 2, { reason: resolved.failure.reason, message: resolved.failure.message }), ...(resolved.failure.candidates ? { candidates: resolved.failure.candidates } : {}) };
	const target = resolved.target;
	const found = await findCache(host, target);
	if (found.status !== "found") {
		const failure = found.status === "invalid" ? { reason: "cache-invalid" as const, message: "A matching PDF text cache exists but is corrupt or exceeds validation limits; re-extract with --force." } : { reason: "no-cache" as const, message: "No extracted text for this PDF yet; run pdf-text with Obsidian open." };
		return { ...envelope(host, "locate", 2, failure), item: target.item, attachment: target.attachment };
	}
	const stat = target.localPath ? await host.pdfCache.statLocal(target.localPath) : null;
	const verified = verifyCache(found.cache, stat);
	if (verified === false) return { ...envelope(host, "locate", 2, { reason: "source-changed", message: "The PDF changed after text extraction; re-extract before locating quotes." }), item: target.item, attachment: target.attachment, cache: { path: found.path, sha256: found.cache.sha256, extractedAt: found.cache.extractedAt, pageCount: found.cache.pageCount, verified } };
	const batch = locateBatch(found.cache.pages, quotes, { openURI: target.attachment.openURI });
	return {
		...envelope(host, "locate", 2),
		item: target.item, attachment: { key: target.attachment.key, openURI: target.attachment.openURI, ...(target.attachment.key ? {} : { path: target.attachment.path }) },
		cache: { path: found.path, sha256: found.cache.sha256, extractedAt: found.cache.extractedAt, pageCount: found.cache.pageCount, verified },
		results: batch.results, summary: batch.summary, warnings: batch.warnings,
	};
}


export function validateActionRequest(action: AgentAction, value: unknown): asserts value is ActionRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A request object is required.");
	const request = value as Record<string, unknown>;
	const allowed: Record<AgentAction, readonly string[]> = {
		connection: [], info: [], refresh: ["ifOlderThanMinutes"], resolve: ["citekey", "itemKey", "libraryID", "doi", "arxiv", "title", "year", "author", "query", "allowStale", "refresh"],
		identity: ["citekey", "itemKey", "libraryID", "doi", "arxiv", "title", "year", "author", "query", "allowStale", "refresh", "rawSource", "attachment", "style", "noBibliography"],
		cites: ["path", "recursive", "bibliography", "style", "strict", "allowStale", "format", "out", "force"], reconcile: ["folders", "apply", "strict", "allowStale"], diagnostics: ["allowStale"], // 0.5 R10: format/out/force
		"pdf-text": ["citekey", "itemKey", "libraryID", "file", "attachment", "pages", "force"], locate: ["path", "citekey", "itemKey", "libraryID", "file", "quote", "attachment"],
		recent: ["days"], import: ["citekey", "itemKey", "libraryID", "apply", "allowStale"],
	};
	for (const key of Object.keys(request)) if (!allowed[action].includes(key)) throw new Error(`Unsupported ${action} request field: ${key}.`);
	for (const key of ["allowStale", "refresh", "recursive", "bibliography", "strict", "apply", "noBibliography", "force"]) if (key in request && typeof request[key] !== "boolean") throw new Error(`${key} must be boolean.`);
	for (const key of ["citekey", "itemKey", "doi", "arxiv", "title", "year", "author", "query", "rawSource", "attachment", "style", "path", "file", "pages", "quote"]) { const value = request[key]; if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 8192)) throw new Error(`${key} must be a non-empty bounded string.`); }
	if ("libraryID" in request && (!Number.isSafeInteger(request.libraryID) || (request.libraryID as number) < 1)) throw new Error("libraryID must be a positive integer.");
	if ("ifOlderThanMinutes" in request && (!Number.isSafeInteger(request.ifOlderThanMinutes) || (request.ifOlderThanMinutes as number) < 1 || (request.ifOlderThanMinutes as number) > 10080)) throw new Error("ifOlderThanMinutes must be between 1 and 10080.");
	if ("folders" in request && (!Array.isArray(request.folders) || request.folders.some(folder => typeof folder !== "string" || !folder.trim()))) throw new Error("folders must be an array of non-empty paths.");
	if (request.itemKey !== undefined && (typeof request.itemKey !== "string" || !/^[A-Z0-9]{8}$/.test(request.itemKey) || request.libraryID === undefined)) throw new Error("itemKey requires eight uppercase letters/digits and libraryID.");
	if ((request.year !== undefined || request.author !== undefined) && request.title === undefined && request.query === undefined) throw new Error("year and author narrow title or query only.");
	if (action === "resolve" || action === "identity") {
		const selectors = ["citekey", "itemKey", "doi", "arxiv", "title", "query"].filter(key => request[key] !== undefined);
		if (action === "resolve" && selectors.length !== 1) throw new Error("resolve requires exactly one selector.");
		if (action === "identity" && (selectors.length < 1 || selectors.filter(key => key !== "citekey").length > 1)) throw new Error("identity requires one selector and may pair a vault citekey with one lookup selector.");
	}
	if (action === "cites" && request.path === undefined) throw new Error("cites requires path.");
	// 0.5 R10
	if (action === "cites" && request.format !== undefined && !BIBLIOGRAPHY_FORMATS.includes(request.format as BibliographyFormat)) throw new Error(`format must be one of ${BIBLIOGRAPHY_FORMATS.join(", ")}.`);
	if (action === "cites" && request.out !== undefined && request.out !== true && (typeof request.out !== "string" || !request.out.trim() || request.out.length > 4096)) throw new Error("out must be true (default sidecar path) or a non-empty vault-relative path.");
	if (action === "cites" && (request.format !== undefined || request.out !== undefined || request.force !== undefined) && request.bibliography !== true) throw new Error("format, out and force need bibliography.");
	if (action === "pdf-text" && ["citekey", "itemKey", "file"].filter(key => request[key] !== undefined).length !== 1) throw new Error("pdf-text requires exactly one target.");
	if (action === "recent" && request.days !== undefined && (!Number.isSafeInteger(request.days) || (request.days as number) < 1 || (request.days as number) > 365)) throw new Error("days must be an integer between 1 and 365.");
	if (action === "import" && ["citekey", "itemKey"].filter(key => request[key] !== undefined).length !== 1) throw new Error("import requires exactly one selector: citekey, or itemKey with libraryID.");
	if (action === "locate") {
		const targets = ["citekey", "itemKey", "file"].filter(key => request[key] !== undefined);
		if (request.path === undefined && (targets.length !== 1 || request.quote === undefined)) throw new Error("locate requires path, or one target with quote.");
		if (typeof request.quote === "string" && Buffer.byteLength(request.quote) > 8192) throw new Error("quote must be at most 8 KiB.");
	}
}

function pagesRequested(spec: string | undefined, pageCount: number): number[] {
	if (!spec) return [];
	const result = new Set<number>();
	for (const part of spec.split(",")) {
		const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
		if (!match) throw new Error("pages must be comma-separated page numbers or ranges.");
		const first = Number(match[1]); const last = Number(match[2] ?? match[1]);
		if (first < 1 || last < first || last > pageCount) throw new Error(`pages are outside 1-${pageCount}.`);
		for (let page = first; page <= last; page++) result.add(page);
	}
	return [...result].sort((a, b) => a - b);
}

export async function connectionAction(host: ActionHost): Promise<Payload> { return { ...envelope(host, "connection", 1), capabilities: host.connection.bbt.reachable === true ? { zotero: host.connection.bbt.zotero, betterbibtex: host.connection.bbt.betterbibtex } : null }; }

export async function refreshAction(host: ActionHost, request: RefreshRequest): Promise<Payload> {
	if (!host.refresh) return { ...envelope(host, "refresh", 1, { reason: "requires-obsidian", message: "refresh requires the live Obsidian host." }), status: "unavailable" };
	let outcome: Awaited<ReturnType<NonNullable<ActionHost["refresh"]>>>;
	try { outcome = await host.refresh(request); }
	catch (error) {
		// 0.5 R4: a classified refusal keeps its reason and adds the typed transport fault beside it; anything else propagates to the host.
		if (!(error instanceof IndexRefusalError)) throw error;
		const bbtError = bbtErrorPayload(error.cause);
		return { ...envelope(host, "refresh", 1, { reason: error.reason, message: error.message }), ...(bbtError ? { bbtError } : {}), status: "unavailable" };
	}
	const view = outcome.host.indexView;
	if (!view) {
		const checked = requireIndex(outcome.host, "refresh", 1);
		return "failure" in checked ? checked.failure : { ...envelope(outcome.host, "refresh", 1, { reason: "index-invalid", message: "Refresh returned no validated index." }), status: "unavailable" };
	}
	return { ...envelope(outcome.host, "refresh", 1), count: view.index.count, complete: view.index.complete, generatedAt: view.index.generatedAt, diagnostics: view.index.diagnostics, refreshed: outcome.refreshed, refreshReason: outcome.reason, ageMinutesBefore: outcome.ageMinutesBefore };
}

export async function pdfTextAction(host: ActionHost, request: PdfTextRequest): Promise<Payload> {
	if (!host.extractPdf) return { ...envelope(host, "pdf-text", 2, { reason: "requires-obsidian", message: "pdf-text requires the live Obsidian host." }) };
	const resolved = await locateTarget(host, request, null);
	if ("failure" in resolved) return { ...envelope(host, "pdf-text", 2, resolved.failure), ...(resolved.failure.candidates ? { candidates: resolved.failure.candidates } : {}) };
	const extraction = await host.extractPdf(resolved.target, request);
	const selected = pagesRequested(request.pages, extraction.extracted.pageCount);
	const inlinePages = selected.map(page => extraction.extracted.pages[page - 1]);
	// A scanned PDF extracts as empty (or watermark-only) pages: say so instead of returning silent emptiness as success.
	const textLayer = textLayerReport(extraction.extracted.pages);
	const layerWarning = textLayerWarning(textLayer, extraction.extracted.pageCount);
	if (Buffer.byteLength(JSON.stringify(inlinePages)) > 200 * 1024) return { ...envelope(host, "pdf-text", 2, { reason: "inline-too-large", message: "Selected inline page text exceeds 200 KiB; request fewer pages." }), item: resolved.target.item, attachment: resolved.target.attachment, cache: extraction.cache, textLayer, warnings: layerWarning ? [layerWarning] : [] };
	return { ...envelope(host, "pdf-text", 2), item: resolved.target.item, attachment: resolved.target.attachment, cache: extraction.cache, extracted: { sha256: extraction.extracted.sha256, bytes: extraction.extracted.bytes, pageCount: extraction.extracted.pageCount, extractedAt: extraction.extracted.extractedAt, tool: extraction.extracted.tool }, textLayer, pages: inlinePages, truncatedPages: extraction.truncatedPages, warnings: layerWarning ? [...extraction.warnings, layerWarning] : extraction.warnings };
}

/** `recent`: papers whose PDF Zotero opened within `days` (default from settings), newest first, with note states. */
export async function recentAction(host: ActionHost, request: RecentRequest): Promise<Payload> {
	if (!host.recentReads) return { ...envelope(host, "recent", 2, { reason: "requires-obsidian", message: "recent requires the live Obsidian host and a running Zotero." }) };
	const days = request.days ?? host.settings.recentReadsDays;
	let reports: RecentReport[];
	try { reports = await host.recentReads(days); }
	catch (error) {
		const bbtError = bbtErrorPayload(error);
		const message = error instanceof Error ? error.message : "Zotero's reading history could not be read.";
		return { ...envelope(host, "recent", 2, { reason: bbtError ? "bbt-unreachable" : "invalid-request", message }), ...(bbtError ? { bbtError } : {}) };
	}
	const today = localDay(host.now);
	return {
		...envelope(host, "recent", 2), days, today, count: reports.length,
		items: reports.map(report => ({
			citekey: report.read.citekey, id: report.id, itemKey: report.read.itemKey, libraryType: report.read.libraryType,
			...(report.read.groupID !== undefined ? { groupID: report.read.groupID } : {}), library: report.read.library,
			title: report.read.title, year: report.read.year, authors: report.read.authors,
			readOn: report.read.readOn, readLabel: readLabel(report.read.readOn, today), inIndex: report.inIndex, fresh: report.fresh,
			note: report.note ? { ...report.note, summary: describeNoteStatus(report.note), needsImport: needsSending(report.note) } : null,
			...(report.problem ? { problem: report.problem } : {}),
		})),
	};
}

/**
 * `import`: creates the literature note or refreshes its managed sections from the item as Zotero has it now; a dry run
 * unless `apply`. Edited generated sections are kept (soft conflicts); an unowned note, damaged markers or several notes
 * with one identity refuse (`note-conflict`). Without a fresh Zotero read it refuses unless `allowStale`.
 */
export async function importAction(host: ActionHost, request: ImportRequest): Promise<Payload> {
	if (!host.importNote) return { ...envelope(host, "import", 2, { reason: "requires-obsidian", message: "import requires the live Obsidian host." }) };
	const result = await host.importNote(request);
	if (result.failure) {
		const { reason, message, candidates, bbtError } = result.failure;
		return { ...envelope(host, "import", 2, { reason: reason as FailureReason, message }), ...(candidates ? { candidates } : {}), ...(bbtError ? { bbtError } : {}) };
	}
	const preview = result.preview;
	const outcome = result.outcome ?? null;
	const counts: Record<string, number> = {};
	for (const section of preview?.sections ?? []) counts[section.state] = (counts[section.state] ?? 0) + 1;
	const body = {
		dryRun: request.apply !== true, item: result.item ?? null, fresh: result.fresh === true,
		note: { path: preview?.path ?? outcome?.path ?? null, existed: preview?.exists ?? false, before: result.before ?? null, ...(result.after ? { after: result.after } : {}) },
		preview: preview ? { conflicts: preview.conflicts, softConflicts: preview.softConflicts, sections: counts, changes: preview.changes } : null,
		outcome: outcome ? { ...outcome, summary: describeSendOutcome(outcome) } : null,
		warnings: result.warnings ?? [],
	};
	const refused = (preview?.conflicts.length ?? 0) > 0 || outcome?.status === "refused";
	if (refused) return { ...envelope(host, "import", 2, { reason: "note-conflict", message: outcome?.message ?? preview?.conflicts.join("; ") ?? "The literature note cannot be written." }), ...body };
	return { ...envelope(host, "import", 2), ...body };
}

export async function runAction(host: ActionHost, action: AgentAction, request: unknown = {}): Promise<Payload> {
	validateActionRequest(action, request);
	let effectiveHost = host;
	if ((action === "resolve" || action === "identity") && (request as ResolveRequest).refresh === true) {
		if (!host.refresh) return { ...envelope(host, action, ACTION_API_VERSION[action], { reason: "requires-obsidian", message: "Explicit refresh requires the live Obsidian host." }), ...(action === "resolve" ? { status: "unavailable" } : {}) };
		effectiveHost = (await host.refresh({})).host;
	}
	switch (action) {
		case "connection": return connectionAction(host);
		case "info": return infoAction(host);
		case "refresh": return refreshAction(host, request as RefreshRequest);
		case "resolve": return resolveAction(effectiveHost, request as ResolveRequest);
		case "identity": return identityAction(effectiveHost, request as IdentityRequest);
		case "cites": return citesAction(host, request as CitesRequest);
		case "reconcile": return reconcileAction(host, request as ReconcileRequest);
		case "diagnostics": return diagnosticsAction(host, request as CommonRequest);
		case "pdf-text": return pdfTextAction(host, request as PdfTextRequest);
		case "locate": return locateAction(host, request as LocateRequestArgs);
		case "recent": return recentAction(host, request as RecentRequest);
		case "import": return importAction(host, request as ImportRequest);
	}
}
