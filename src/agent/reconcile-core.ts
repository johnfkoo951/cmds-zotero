/**
 * Pure reconcile core (CLI contract 2, action `reconcile`): resolves paper hubs and raw sources against the validated
 * index, classifies every hub, and proposes the frontmatter keys and S01 lines an agent (or `reconcile --apply`) may
 * write. Never imports `obsidian`; the clock, index freshness and the vault PDF listing are injected by the host.
 * Vocabulary: spec-0.4-vocabulary §1 (keys), §2 (classifications, findings, transition table, diagnostic codes).
 */
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import type { ParsedZoteroURI } from "../uris";
import { parseZoteroURI } from "../uris";
import type { AgentDiagnostic } from "../diagnostics";
import { diagnostic } from "../diagnostics";
import type { CitekeyShape, HubClassification, NoteRecord, ResolutionStatus } from "./types";
import { HUB_WRITABLE_KEYS, LEGACY_LITERATURE_KEYS } from "./types";
import { arxivFromDoi, citekeyShape, entryArxiv, normalizeArxiv, normalizeDoi } from "./search";

export const HUB_FINDINGS = [
	"missing-zoteroID", "missing-zoteroSelectURI", "missing-zoteroStatus", "missing-zoteroCheckedAt",
	"citekeyProvisional-absent", "malformed-identity", "identity-conflict", "citekeyProvisional-stale", "zoteroID-mismatch", "zoteroStatus-stale",
	"s01-says-unregistered", "citekey-not-pinned", "doi-nonconforming", "hub-attachment-missing", "index-stale", "index-incomplete",
	"raw-source-path", "frontmatter-parse-error",
	"legacy-frontmatter-dialect", // 0.5 R14: report-only, literature notes carrying pre-0.5 keys
] as const;
export type HubFinding = typeof HUB_FINDINGS[number];

/** `missing-*` and the flag/status transitions may be written by `--apply`; every other finding is report-only. */
export const APPLY_ELIGIBLE_FINDINGS: readonly HubFinding[] = ["missing-zoteroID", "missing-zoteroSelectURI", "missing-zoteroStatus", "missing-zoteroCheckedAt", "citekeyProvisional-absent"];

/** A resolved hub carrying any of these is `registered-desynced` (unless the flag is `true`, which wins as `provisional-now-registered`). */
export const DESYNC_FINDINGS: readonly HubFinding[] = ["malformed-identity", "identity-conflict", "zoteroID-mismatch", "s01-says-unregistered", "citekeyProvisional-absent", "zoteroStatus-stale"];

/** Vault folder holding `*-<citekey>.pdf` copies named by `hub-attachment-missing`. */
export const HUB_ATTACHMENT_FOLDER = "80. References/Attachments/";

export type HubWritableKey = typeof HUB_WRITABLE_KEYS[number];
export type ProposedFrontmatter = Partial<Record<HubWritableKey, unknown>>;
export type ResolvedVia = "zoteroID" | "zoteroSelectURI" | "citekey" | "citekeyHistory" | "folder" | "doi" | "arxiv" | null;
export type S01Marker = "registered" | "not-registered" | "provisional" | "confirmed" | null;
export type SkippedReason = "not-paper-hub" | "raw-source" | "raw-source-path" | "ambiguous" | "unchecked" | "malformed-identity" | "identity-conflict" | "index-stale" | "index-incomplete" | "frontmatter-parse-error" | "yaml-roundtrip-unsafe" | "write-error" | "post-write-mismatch";
export type ReconcileNoteType = "paper-hub" | "raw-source" | "parse-error" | "literature";

/**
 * Transition table for `reconcile --apply` (vocabulary §2). Keys are the observed value (`absent` when the key is
 * missing); values are the states that may be written. Guards that the table cannot express are listed under `guards`
 * and enforced by `statusTransitionAllowed` / `flagTransitionAllowed`.
 */
export const STATUS_TRANSITIONS = {
	zoteroStatus: { absent: ["resolved", "not-found"], "not-found": ["resolved"], unavailable: ["resolved", "not-found"], ambiguous: ["resolved", "not-found"], resolved: [] },
	citekeyProvisional: { absent: ["true", "false"], true: ["false"], false: [] },
	zoteroID: { absent: ["value"], present: [] },
	zoteroSelectURI: { absent: ["value"], present: [] },
	zoteroCheckedAt: { any: ["rewritten with any other write"] },
	guards: {
		"zoteroStatus -> not-found": "connection.index.stale === false and no identity key resolved",
		"citekeyProvisional true -> false": "index citekey equals the hub citekey (pinned)",
	},
} as const;

export interface S01Parse {
	zotero: string | null;
	citekey: string | null;
	/** Text after the first token of the citekey line (backticks stripped), `""` when absent. */
	citekeyNote: string;
	doi: string | null;
	marker: S01Marker;
}

export interface ResolutionEvidence {
	via: Exclude<ResolvedVia, null>;
	entryID: string;
}

export interface HubResolution {
	status: ResolutionStatus;
	resolvedVia: ResolvedVia;
	entry: ZoteroIndexEntry | null;
	ambiguous: boolean;
	/** Full entries when ambiguous; `[]` otherwise. */
	candidates: ZoteroIndexEntry[];
	/** The vault key: frontmatter `citekey`, else the folder basename, else `""`. Never `entry.citekey`. */
	citekey: string;
	citekeySource: "frontmatter" | "folder" | null;
	/** All positive identity matches, deduplicated by entry and evidence kind. */
	evidence: ResolutionEvidence[];
	/** True when valid identity fields positively identify different index entries. */
	identityConflict: boolean;
	/** Only a complete index can authorize a proposal. */
	indexComplete: boolean;
}

export interface Finding {
	code: HubFinding;
	message: string;
	detail?: string;
}

export interface HubVerdict {
	classification: HubClassification;
	findings: Finding[];
	citekeyCurrent?: string;
	pinInstruction?: string;
}

export type IdentityFieldState = "absent" | "valid" | "malformed";
export interface IdentityFieldObservation {
	state: IdentityFieldState;
	raw?: unknown;
}

export interface ObservedIdentity {
	/** Raw key presence/validity retained so malformed-present values can never be mistaken for absent keys. */
	fields?: Record<"citekey" | "doi" | "citekeyProvisional" | "zoteroID" | "zoteroSelectURI" | "zoteroStatus" | "zoteroCheckedAt", IdentityFieldObservation>;
	citekeyProvisional?: boolean;
	zoteroID?: string;
	zoteroSelectURI?: string;
	zoteroStatus?: string;
	doi?: string;
	s01Zotero?: string;
	s01Citekey?: string;
}

export interface ProposedS01 {
	zotero: string;
	citekey: string;
}

export interface ReconcileNote {
	path: string;
	type: ReconcileNoteType;
	citekey: string;
	resolvedVia: ResolvedVia;
	classification: HubClassification;
	findings: Finding[];
	index: { id: string; citekey: string; citekeyShape: CitekeyShape; hasPdf: boolean } | null;
	citekeyCurrent?: string;
	observed: ObservedIdentity;
	/** Positive identity evidence retained for apply-time revalidation. */
	identityEvidence: ResolutionEvidence[];
	/** Deterministic candidate ids when resolution is ambiguous. */
	candidateIDs: string[];
	/** Core safety gate only; the writer must still re-read and validate immediately before writing. */
	proposalEligible: boolean;
	proposed: ProposedFrontmatter | null;
	proposedS01: ProposedS01 | null;
	pinInstruction?: string;
	applied: boolean;
	skippedReason?: SkippedReason;
}

export interface HubSummary {
	registeredConsistent: number;
	registeredDesynced: number;
	registeredUnpinned: number;
	provisionalNowRegistered: number;
	unregisteredFlagged: number;
	unregisteredUnflagged: number;
	ambiguous: number;
	unchecked: number;
}

export interface ReconcileOptions {
	now: Date;
	/** `connection.index.stale` as computed by the host. */
	stale: boolean;
	allowStale: boolean;
	/** `--folders`: narrows discovery to notes under these vault-relative folders; never defines discovery. */
	folders?: string[];
}

export interface ReconcileVault {
	name: string;
	/** Vault-relative paths of PDF files (at least everything under `HUB_ATTACHMENT_FOLDER`). */
	pdfPaths: string[];
}

export interface ReconcileResult {
	folders: string[];
	scanned: { hubs: number; rawSources: number; parseErrors: number };
	notes: ReconcileNote[];
	summary: { hubs: HubSummary };
	diagnostics: AgentDiagnostic[];
}

const S01_ZOTERO = /^- \*\*Zotero\*\*:\s*(.+)$/m;
const S01_CITEKEY = /^- \*\*citekey\*\*:\s*(.+)$/m;
const S01_DOI = /^- \*\*DOI\*\*:\s*(.+)$/im;
const CALLOUT_CONFIRMED = /\[!check\][+-]?\s*zotero citekey confirmed/i;
const CALLOUT_PROVISIONAL = /\[!warning\][+-]?\s*provisional citekey/i;
const CALLOUT_PINNED = /\[!info\][+-]?\s*citekey pinned/i;

function classifyMarkerText(text: string): S01Marker {
	const lower = text.toLowerCase();
	if (!lower) return null;
	if (/not\s+registered|unregistered/.test(lower)) return "not-registered";
	if (lower.includes("provisional")) return "provisional";
	if (lower.includes("confirmed")) return "confirmed";
	if (/pinned|registered|zotero:\/\/select\//.test(lower)) return "registered";
	return null;
}

function calloutMarker(body: string): S01Marker {
	if (CALLOUT_CONFIRMED.test(body)) return "confirmed";
	if (CALLOUT_PROVISIONAL.test(body)) return "provisional";
	if (CALLOUT_PINNED.test(body)) return "registered";
	return null;
}

/**
 * S01 identity lines: `- **Zotero**: …`, `- **citekey**: \`key\` (…)` (first backtick-stripped token is the key) and
 * `- **DOI**: …`. The marker comes from the citekey remainder first, then the confirmed/provisional/pinned callouts,
 * then the Zotero line; `(Zotero/BBT confirmed <date>)` is a registered marker and never a mismatch.
 */
export function parseS01(body: string): S01Parse {
	const zotero = S01_ZOTERO.exec(body)?.[1].trim() ?? null;
	const doi = S01_DOI.exec(body)?.[1].replace(/`/g, "").trim() ?? null;
	const citekeyLine = S01_CITEKEY.exec(body)?.[1].replace(/`/g, "").trim() ?? null;
	let citekey: string | null = null;
	let citekeyNote = "";
	if (citekeyLine) {
		const [first, ...rest] = citekeyLine.split(/\s+/);
		citekey = first || null;
		citekeyNote = rest.join(" ");
	}
	const marker = classifyMarkerText(citekeyNote) ?? calloutMarker(body) ?? classifyMarkerText(zotero ?? "");
	return { zotero, citekey, citekeyNote, doi, marker };
}

export function s01SaysUnregistered(marker: S01Marker): boolean {
	return marker === "not-registered" || marker === "provisional";
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function folderBasename(path: string): string | undefined {
	const parts = path.split("/");
	return parts.length >= 2 ? stringValue(parts[parts.length - 2]) : undefined;
}

function selectIdentity(uri: string | undefined): ParsedZoteroURI | null {
	if (!uri) return null;
	try {
		const parsed = parseZoteroURI(uri);
		return parsed.action === "select" ? parsed : null;
	} catch {
		return null;
	}
}

type ResolutionBase = Pick<HubResolution, "citekey" | "citekeySource">;

type EvidenceHit = { entry: ZoteroIndexEntry; via: Exclude<ResolvedVia, null> };

const RESOLUTION_PRIORITY: readonly Exclude<ResolvedVia, null>[] = ["zoteroID", "zoteroSelectURI", "citekey", "citekeyHistory", "folder", "doi", "arxiv"];

function sortedCandidates(candidates: ZoteroIndexEntry[]): ZoteroIndexEntry[] {
	return [...candidates].sort((a, b) => a.citekey.localeCompare(b.citekey) || a.id.localeCompare(b.id));
}

function finalizeResolution(hits: EvidenceHit[], base: ResolutionBase, indexComplete: boolean): HubResolution | null {
	const uniqueEvidence = new Map<string, EvidenceHit>();
	for (const hit of hits) uniqueEvidence.set(`${hit.via}|${hit.entry.id}`, hit);
	const evidenceHits = [...uniqueEvidence.values()].sort((a, b) => RESOLUTION_PRIORITY.indexOf(a.via) - RESOLUTION_PRIORITY.indexOf(b.via) || a.entry.id.localeCompare(b.entry.id));
	if (!evidenceHits.length) return null;
	const entries = new Map(evidenceHits.map(hit => [hit.entry.id, hit.entry]));
	const evidence = evidenceHits.map(hit => ({ via: hit.via, entryID: hit.entry.id }));
	if (entries.size > 1) {
		const identityConflict = new Set(evidenceHits.map(hit => hit.via)).size > 1;
		return { status: "ambiguous", resolvedVia: null, entry: null, ambiguous: true, candidates: sortedCandidates([...entries.values()]), evidence, identityConflict, indexComplete, ...base };
	}
	const entry = entries.values().next().value as ZoteroIndexEntry;
	return { status: "resolved", resolvedVia: evidenceHits[0].via, entry, ambiguous: false, candidates: [], evidence, identityConflict: false, indexComplete, ...base };
}

function unresolved(status: "not-found" | "unavailable", base: ResolutionBase, indexComplete: boolean): HubResolution {
	return { status, resolvedVia: null, entry: null, ambiguous: false, candidates: [], evidence: [], identityConflict: false, indexComplete, ...base };
}

function keyHits(entries: ZoteroIndexEntry[], key: string, currentVia: Exclude<ResolvedVia, null>, historyVia: Exclude<ResolvedVia, null>): EvidenceHit[] {
	const hits: EvidenceHit[] = [];
	for (const entry of entries) {
		if (entry.citekey === key) hits.push({ entry, via: currentVia });
		if (entry.citekeyHistory.includes(key)) hits.push({ entry, via: historyVia });
	}
	return hits;
}

function identifierHits(entries: ZoteroIndexEntry[], frontmatter: Record<string, unknown>): EvidenceHit[] {
	const doi = normalizeDoi(stringValue(frontmatter.doi) ?? "");
	const arxiv = normalizeArxiv(stringValue(frontmatter.arxiv) ?? "") || (doi ? arxivFromDoi(doi) : "");
	const hits: EvidenceHit[] = [];
	for (const entry of entries) {
		if (doi && normalizeDoi(entry.doi) === doi) hits.push({ entry, via: "doi" });
		if (arxiv && entryArxiv(entry) === arxiv) hits.push({ entry, via: "arxiv" });
	}
	return hits;
}

/**
 * Resolves all valid identity evidence and unions matches by canonical entry id. Multiple evidence kinds may resolve the
 * same item, but evidence identifying different items is always ambiguous; no field silently wins by precedence.
 */
export function resolveHub(note: NoteRecord, index: ZoteroIndex | null): HubResolution {
	const frontmatter = note.frontmatter ?? {};
	const frontmatterKey = stringValue(frontmatter.citekey);
	const folderKey = folderBasename(note.path);
	const base: ResolutionBase = { citekey: frontmatterKey ?? folderKey ?? "", citekeySource: frontmatterKey ? "frontmatter" : folderKey ? "folder" : null };
	if (!index) return unresolved("unavailable", base, false);
	const entries = index.entries;
	const hits: EvidenceHit[] = [];
	const zoteroID = stringValue(frontmatter.zoteroID);
	if (zoteroID) for (const entry of entries) if (entry.id === zoteroID) hits.push({ entry, via: "zoteroID" });
	const select = selectIdentity(stringValue(frontmatter.zoteroSelectURI));
	if (select) {
		for (const entry of entries) {
			if (entry.itemKey === select.itemKey && entry.libraryType === select.libraryType && entry.groupID === select.groupID) hits.push({ entry, via: "zoteroSelectURI" });
		}
	}
	if (frontmatterKey) hits.push(...keyHits(entries, frontmatterKey, "citekey", "citekeyHistory"));
	else if (folderKey) hits.push(...keyHits(entries, folderKey, "folder", "folder"));
	hits.push(...identifierHits(entries, frontmatter));
	const resolution = finalizeResolution(hits, base, index.complete === true) ?? unresolved("not-found", base, index.complete === true);
	if (resolution.entry) {
		const entry = resolution.entry;
		const idConflict = zoteroID !== undefined && zoteroID !== entry.id;
		const uriConflict = select !== null && !(entry.itemKey === select.itemKey && entry.libraryType === select.libraryType && entry.groupID === select.groupID);
		const doi = normalizeDoi(stringValue(frontmatter.doi) ?? "");
		const doiConflict = Boolean(doi && doi !== normalizeDoi(entry.doi));
		resolution.identityConflict ||= idConflict || uriConflict || doiConflict;
	}
	return resolution;
}

/** The identity keys as written, retaining raw presence/validity, plus the S01 lines. */
export function observeIdentity(note: NoteRecord): ObservedIdentity {
	const frontmatter = note.frontmatter ?? {};
	const field = (key: keyof NonNullable<ObservedIdentity["fields"]>, valid: (value: unknown) => boolean): IdentityFieldObservation => {
		if (!(key in frontmatter)) return { state: "absent" };
		const raw = frontmatter[key];
		return { state: valid(raw) ? "valid" : "malformed", raw };
	};
	const fields: NonNullable<ObservedIdentity["fields"]> = {
		citekey: field("citekey", value => typeof value === "string" && value.trim().length > 0),
		doi: field("doi", value => typeof value === "string" && (value === "" || normalizeDoi(value) !== "")),
		citekeyProvisional: field("citekeyProvisional", value => typeof value === "boolean"),
		zoteroID: field("zoteroID", value => typeof value === "string" && /^[1-9]\d*:[A-Z0-9]{8}$/.test(value.trim())),
		zoteroSelectURI: field("zoteroSelectURI", value => typeof value === "string" && selectIdentity(value.trim()) !== null),
		zoteroStatus: field("zoteroStatus", value => typeof value === "string" && ["resolved", "not-found", "unavailable", "ambiguous"].includes(value.trim())),
		zoteroCheckedAt: field("zoteroCheckedAt", value => typeof value === "string" && Number.isFinite(Date.parse(value))),
	};
	const observed: ObservedIdentity = { fields };
	if (fields.citekeyProvisional.state === "valid") observed.citekeyProvisional = frontmatter.citekeyProvisional as boolean;
	if (fields.zoteroID.state === "valid") observed.zoteroID = (frontmatter.zoteroID as string).trim();
	if (fields.zoteroSelectURI.state === "valid") observed.zoteroSelectURI = (frontmatter.zoteroSelectURI as string).trim();
	if (fields.zoteroStatus.state === "valid") observed.zoteroStatus = (frontmatter.zoteroStatus as string).trim();
	if ("doi" in frontmatter) {
		const doi = frontmatter.doi;
		observed.doi = doi === null || doi === undefined ? "" : typeof doi === "string" ? doi.trim() : JSON.stringify(doi);
	}
	const s01 = parseS01(note.body ?? "");
	if (s01.zotero !== null) observed.s01Zotero = s01.zotero;
	if (s01.citekey !== null) observed.s01Citekey = s01.citekey;
	return observed;
}

function malformedIdentityFindings(observed: ObservedIdentity): Finding[] {
	const labels = Object.entries(observed.fields ?? {}).filter(([, value]) => value.state === "malformed").map(([key]) => key).sort();
	return labels.map(key => finding("malformed-identity", `${key} is present but malformed; reconcile will not treat it as absent or propose writes.`, key));
}

function hasMalformedIdentity(observed: ObservedIdentity): boolean {
	return Object.values(observed.fields ?? {}).some(value => value.state === "malformed");
}

function finding(code: HubFinding, message: string, detail?: string): Finding {
	return detail === undefined ? { code, message } : { code, message, detail };
}

function doiFinding(observed: ObservedIdentity): Finding[] {
	if (observed.doi === undefined || observed.doi === "" || /^10\./.test(observed.doi)) return [];
	return [finding("doi-nonconforming", `doi "${observed.doi}" is neither empty nor a DOI; write "" for prose values.`)];
}

function observedFieldState(observed: ObservedIdentity, key: keyof NonNullable<ObservedIdentity["fields"]>, legacyValue: unknown): IdentityFieldState {
	return observed.fields?.[key].state ?? (legacyValue === undefined ? "absent" : "valid");
}

function missingKeyFindings(observed: ObservedIdentity, entry: ZoteroIndexEntry | null): Finding[] {
	const findings: Finding[] = [];
	if (entry && observedFieldState(observed, "zoteroID", observed.zoteroID) === "absent") findings.push(finding("missing-zoteroID", `zoteroID is missing; index has ${entry.id}.`, entry.id));
	if (entry && observedFieldState(observed, "zoteroSelectURI", observed.zoteroSelectURI) === "absent") findings.push(finding("missing-zoteroSelectURI", `zoteroSelectURI is missing; index has ${entry.zoteroSelectURI}.`, entry.zoteroSelectURI));
	if (observedFieldState(observed, "zoteroStatus", observed.zoteroStatus) === "absent") findings.push(finding("missing-zoteroStatus", "zoteroStatus is missing."));
	if (observedFieldState(observed, "citekeyProvisional", observed.citekeyProvisional) === "absent") findings.push(finding("citekeyProvisional-absent", "citekeyProvisional is missing."));
	return findings;
}

function checkedAtFinding(observed: ObservedIdentity): Finding[] {
	return observedFieldState(observed, "zoteroCheckedAt", undefined) === "absent" ? [finding("missing-zoteroCheckedAt", "zoteroCheckedAt is missing.")] : [];
}

function statusStaleFinding(observed: ObservedIdentity, verdict: "resolved" | "not-found"): Finding[] {
	if (observed.zoteroStatus === undefined || observed.zoteroStatus === verdict) return [];
	if (verdict === "resolved" || observed.zoteroStatus === "resolved" || !(observed.zoteroStatus in STATUS_TRANSITIONS.zoteroStatus)) {
		return [finding("zoteroStatus-stale", `zoteroStatus "${observed.zoteroStatus}" contradicts the index verdict "${verdict}".`)];
	}
	return [];
}

function pinInstructionFor(hubKey: string, entry: ZoteroIndexEntry): string {
	return `Pin citekey "${hubKey}" on Zotero item ${entry.id} (current Better BibTeX key "${entry.citekey}"): in Zotero, add the line "Citation Key: ${hubKey}" to the item's Extra field so Better BibTeX pins it, then refresh the index. Never rename the hub.`;
}

function classifyUnregistered(note: NoteRecord, observed: ObservedIdentity, stale: boolean, allowStale: boolean): HubVerdict {
	if (stale && !allowStale) {
		return { classification: "unchecked", findings: [finding("index-stale", "Index is stale; the negative verdict is withheld (refresh the index or pass --allow-stale)."), ...doiFinding(observed)] };
	}
	const findings: Finding[] = [...doiFinding(observed), ...missingKeyFindings(observed, null), ...checkedAtFinding(observed), ...malformedIdentityFindings(observed), ...statusStaleFinding(observed, "not-found")];
	if (observed.zoteroID !== undefined) findings.push(finding("zoteroID-mismatch", `zoteroID ${observed.zoteroID} is not in the index.`, observed.zoteroID));
	if (observed.citekeyProvisional === false) findings.push(finding("citekeyProvisional-stale", "citekeyProvisional is false but the item is not registered in Zotero."));
	return { classification: observed.citekeyProvisional === true ? "unregistered-flagged" : "unregistered-unflagged", findings: orderFindings(findings) };
}

function classifyRegistered(note: NoteRecord, observed: ObservedIdentity, resolution: HubResolution, entry: ZoteroIndexEntry): HubVerdict {
	const hubKey = resolution.citekey;
	const pinned = entry.citekey === hubKey;
	const inHistory = !pinned && entry.citekeyHistory.includes(hubKey);
	const s01 = parseS01(note.body ?? "");
	const marker = s01.marker;
	const findings: Finding[] = [...doiFinding(observed), ...missingKeyFindings(observed, entry), ...checkedAtFinding(observed), ...malformedIdentityFindings(observed), ...statusStaleFinding(observed, "resolved")];
	if (observed.zoteroID !== undefined && observed.zoteroID !== entry.id) findings.push(finding("zoteroID-mismatch", `zoteroID ${observed.zoteroID} does not match the resolved item ${entry.id}.`, entry.id));
	if (!pinned && !inHistory) {
		findings.push(finding("citekey-not-pinned", `Item resolved by ${resolution.resolvedVia ?? "unknown"} under Zotero key "${entry.citekey}"; hub citekey "${hubKey}" is not pinned.`, entry.citekey));
		if (observed.citekeyProvisional === false) findings.push(finding("citekeyProvisional-stale", "citekeyProvisional is false but the citekey is not pinned in Zotero."));
		// A provisional citekey line is accurate while the pin is pending; only an explicit "not registered" contradicts the item.
		if (marker === "not-registered" || classifyMarkerText(s01.zotero ?? "") === "not-registered") findings.push(finding("s01-says-unregistered", "S01 says the item is not registered, but it is registered in Zotero under another key."));
		return { classification: "registered-unpinned", findings: orderFindings(findings), citekeyCurrent: entry.citekey, pinInstruction: pinInstructionFor(hubKey, entry) };
	}
	if (s01SaysUnregistered(marker)) findings.push(finding("s01-says-unregistered", `S01 marks the citekey as ${marker === "provisional" ? "provisional" : "not registered"}, but the item is registered in Zotero.`));
	if (inHistory && observed.citekeyProvisional === false) findings.push(finding("citekeyProvisional-stale", `citekeyProvisional is false but the hub citekey is a former key; Zotero now uses "${entry.citekey}".`));
	const ordered = orderFindings(findings);
	const verdict: HubVerdict = { classification: "registered-consistent", findings: ordered };
	if (inHistory) verdict.citekeyCurrent = entry.citekey;
	if (pinned && observed.citekeyProvisional === true) verdict.classification = "provisional-now-registered";
	else if (ordered.some(item => DESYNC_FINDINGS.includes(item.code))) verdict.classification = "registered-desynced";
	return verdict;
}

function orderFindings(findings: Finding[]): Finding[] {
	return [...findings].sort((a, b) => HUB_FINDINGS.indexOf(a.code) - HUB_FINDINGS.indexOf(b.code));
}

/**
 * Classification rules (spec-action-reconcile): ambiguous index → `ambiguous`; missing index, or a negative verdict on
 * a stale index without `--allow-stale` → `unchecked` (+ `index-stale`); not-found → `unregistered-flagged|unflagged`;
 * resolved under another key not in history → `registered-unpinned`; resolved by key with the flag `true` →
 * `provisional-now-registered`; resolved with a desync finding → `registered-desynced`; else `registered-consistent`.
 */
export function classifyHub(note: NoteRecord, resolution: HubResolution, stale: boolean, allowStale: boolean): HubVerdict {
	const observed = observeIdentity(note);
	const malformed = malformedIdentityFindings(observed);
	if (resolution.status === "unavailable") return { classification: "unchecked", findings: orderFindings([...doiFinding(observed), ...malformed]) };
	if (resolution.status === "ambiguous") {
		const conflicts = resolution.identityConflict ? [finding("identity-conflict", "Valid identity fields resolve to different Zotero items; reconcile proposals are suppressed.")] : [];
		return { classification: "ambiguous", findings: orderFindings([...doiFinding(observed), ...malformed, ...conflicts]) };
	}
	if (!resolution.indexComplete && (resolution.status === "not-found" || !resolution.entry)) {
		return { classification: "unchecked", findings: orderFindings([...doiFinding(observed), ...malformed, finding("index-incomplete", "Index is incomplete; the negative verdict and all proposals are withheld.")]) };
	}
	if (resolution.status === "not-found" || !resolution.entry) return classifyUnregistered(note, observed, stale, allowStale);
	const verdict = classifyRegistered(note, observed, resolution, resolution.entry);
	if (resolution.identityConflict) verdict.findings = orderFindings([...verdict.findings, finding("identity-conflict", "Existing identity fields contradict the resolved Zotero item; reconcile proposals are suppressed.")]);
	if (!resolution.indexComplete) verdict.findings = orderFindings([...verdict.findings, finding("index-incomplete", "Index is incomplete; the match is report-only and all proposals are withheld.")]);
	if (verdict.findings.some(item => DESYNC_FINDINGS.includes(item.code)) && verdict.classification === "registered-consistent") verdict.classification = "registered-desynced";
	return verdict;
}

/** `zoteroStatus` transition per `STATUS_TRANSITIONS`; `not-found` additionally needs a fresh index. */
export function statusTransitionAllowed(from: string | undefined, to: "resolved" | "not-found", stale: boolean): boolean {
	const key = from ?? "absent";
	const allowed: readonly string[] = Object.prototype.hasOwnProperty.call(STATUS_TRANSITIONS.zoteroStatus, key) ? STATUS_TRANSITIONS.zoteroStatus[key as keyof typeof STATUS_TRANSITIONS.zoteroStatus] : [];
	if (!allowed.includes(to)) return false;
	return to !== "not-found" || !stale;
}

/** `citekeyProvisional` transition per `STATUS_TRANSITIONS`; `true → false` additionally needs the index citekey to equal the hub citekey. */
export function flagTransitionAllowed(from: boolean | undefined, to: boolean, pinned: boolean): boolean {
	const key = from === undefined ? "absent" : from ? "true" : "false";
	const allowed: readonly string[] = STATUS_TRANSITIONS.citekeyProvisional[key];
	if (!allowed.includes(to ? "true" : "false")) return false;
	return !(from === true && !to && !pinned);
}

/**
 * Frontmatter an agent or `--apply` may write: write-once `zoteroID`/`zoteroSelectURI`, `zoteroStatus` and
 * `citekeyProvisional` per the transition table, `zoteroCheckedAt` whenever anything else is written. Negative verdicts
 * (`not-found`, a new `true` flag) need a fresh index and no identity key in the note. `null` when nothing changes.
 */
export function proposedFrontmatter(observed: ObservedIdentity, resolution: HubResolution, classification: HubClassification, now: Date, stale: boolean): ProposedFrontmatter | null {
	// `allow-stale` changes reporting only. Unknown/raw truthy stale values, incomplete indexes, malformed keys and
	// contradictory identity are never write-authorizing states.
	if (stale !== false || !resolution.indexComplete || resolution.identityConflict || hasMalformedIdentity(observed)) return null;
	const proposal: ProposedFrontmatter = {};
	const entry = resolution.entry;
	if (entry && classification !== "ambiguous" && classification !== "unchecked") {
		if (observedFieldState(observed, "zoteroID", observed.zoteroID) === "absent") proposal.zoteroID = entry.id;
		if (observedFieldState(observed, "zoteroSelectURI", observed.zoteroSelectURI) === "absent") proposal.zoteroSelectURI = entry.zoteroSelectURI;
		if (statusTransitionAllowed(observed.zoteroStatus, "resolved", stale)) proposal.zoteroStatus = "resolved";
		const pinned = entry.citekey === resolution.citekey;
		if (flagTransitionAllowed(observed.citekeyProvisional, !pinned, pinned) && observed.citekeyProvisional !== !pinned) proposal.citekeyProvisional = !pinned;
	} else if (classification === "unregistered-flagged" || classification === "unregistered-unflagged") {
		const identityPresent = observedFieldState(observed, "zoteroID", observed.zoteroID) !== "absent" || observedFieldState(observed, "zoteroSelectURI", observed.zoteroSelectURI) !== "absent";
		if (!identityPresent) {
			if (statusTransitionAllowed(observed.zoteroStatus, "not-found", stale)) proposal.zoteroStatus = "not-found";
			if (observedFieldState(observed, "citekeyProvisional", observed.citekeyProvisional) === "absent") proposal.citekeyProvisional = true;
		}
	}
	if (!Object.keys(proposal).length) return null;
	proposal.zoteroCheckedAt = now.toISOString();
	return orderProposal(proposal);
}
function orderProposal(proposal: ProposedFrontmatter): ProposedFrontmatter {
	const ordered: ProposedFrontmatter = {};
	for (const key of HUB_WRITABLE_KEYS) if (key in proposal) ordered[key] = proposal[key];
	return ordered;
}

function desiredS01(hubKey: string, entry: ZoteroIndexEntry | null, classification: HubClassification, now: Date): ProposedS01 | null {
	if (classification === "unregistered-flagged" || classification === "unregistered-unflagged") return { zotero: "not registered", citekey: `\`${hubKey}\` (provisional)` };
	if (!entry) return null;
	if (classification === "ambiguous" || classification === "unchecked") return null;
	if (entry.citekey === hubKey) return { zotero: entry.zoteroSelectURI, citekey: `\`${hubKey}\` (Zotero/BBT confirmed ${now.toISOString().slice(0, 10)})` };
	return { zotero: entry.zoteroSelectURI, citekey: `\`${hubKey}\` (Zotero key: ${entry.citekey} — pin pending)` };
}

function s01Satisfied(s01: S01Parse, hubKey: string, entry: ZoteroIndexEntry | null, desired: ProposedS01): boolean {
	if (s01.citekey !== hubKey) return false;
	if (!entry) return classifyMarkerText(s01.zotero ?? "") === "not-registered" && s01SaysUnregistered(s01.marker);
	if (!(s01.zotero ?? "").includes(entry.zoteroSelectURI)) return false;
	if (entry.citekey === hubKey) return s01.marker === "confirmed" || s01.marker === "registered";
	return desired.citekey.endsWith(s01.citekeyNote) && /pin pending/i.test(s01.citekeyNote) && s01.citekeyNote.includes(entry.citekey);
}

/**
 * The S01 `Zotero` and `citekey` line values an agent should write, or `null` when explicit proposal eligibility
 * was not supplied, the body was not read, the verdict is withheld, or the existing lines already agree. A
 * `(Zotero/BBT confirmed <date>)` line is never rewritten for the date.
 */
export function proposedS01(note: NoteRecord, resolution: HubResolution, classification: HubClassification, now: Date, applyEligible = false): ProposedS01 | null {
	if (!applyEligible || !resolution.indexComplete || resolution.identityConflict || hasMalformedIdentity(observeIdentity(note)) || note.body === undefined) return null;
	const desired = desiredS01(resolution.citekey, resolution.entry, classification, now);
	if (!desired) return null;
	return s01Satisfied(parseS01(note.body), resolution.citekey, resolution.entry, desired) ? null : desired;
}

export function hasPdf(entry: ZoteroIndexEntry): boolean {
	return entry.attachments.some(attachment => attachment.path !== null && attachment.path.toLowerCase().endsWith(".pdf")) || entry.attachmentPath.toLowerCase().endsWith(".pdf");
}

/**
 * `hub-attachment-missing` when the resolved item has a complete attachment listing without a local PDF file; names the
 * `80. References/Attachments/*-<citekey>.pdf` vault copy (hub or index key) when the listing contains one.
 */
export function hubAttachmentFinding(entry: ZoteroIndexEntry, vaultPdfCandidates: string[], hubCitekey?: string): Finding | null {
	if (entry.attachmentStatus !== "complete" || hasPdf(entry)) return null;
	const keys = new Set([entry.citekey, hubCitekey].filter((key): key is string => Boolean(key)));
	const copies = vaultPdfCandidates.filter(path => {
		if (!path.startsWith(HUB_ATTACHMENT_FOLDER)) return false;
		const basename = path.slice(path.lastIndexOf("/") + 1);
		return [...keys].some(key => basename.endsWith(`-${key}.pdf`));
	}).sort();
	const reason = entry.attachments.length ? "no PDF attachment has a local file" : "no PDF attachment";
	if (copies.length) return finding("hub-attachment-missing", `Zotero item ${entry.id} has ${reason}; vault copy at ${copies[0]}.`, copies[0]);
	return finding("hub-attachment-missing", `Zotero item ${entry.id} has ${reason}; no vault copy under ${HUB_ATTACHMENT_FOLDER}.`);
}

function normalizeFolders(folders: string[] | undefined): string[] {
	return [...new Set((folders ?? []).map(folder => folder.trim().replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean))].sort();
}

function inFolders(path: string, folders: string[]): boolean {
	return !folders.length || folders.some(folder => path === folder || path.startsWith(`${folder}/`));
}

export const RAW_SOURCES_ROOT = "10. Raw Sources";

function isRawSourcePath(path: string): boolean {
	return path === RAW_SOURCES_ROOT || path.startsWith(`${RAW_SOURCES_ROOT}/`);
}

function noteType(note: NoteRecord): ReconcileNoteType | null {
	if (note.frontmatterParse === "error") return "parse-error";
	const frontmatter = note.frontmatter;
	if (!frontmatter) return null;
	if (isRawSourcePath(note.path) && frontmatter.type === "paper-hub") return "raw-source";
	if (isRawSourcePath(note.path) && frontmatter.type === "raw-source" && stringValue(frontmatter.citekey)) return "raw-source";
	if (frontmatter.type === "paper-hub") return "paper-hub";
	if (frontmatter.type === "raw-source" && stringValue(frontmatter.citekey)) return "raw-source";
	if (frontmatter.type === "zotero" && legacyLiteratureKeys(frontmatter).length) return "literature";
	return null;
}

// 0.5 R14
/** The pre-0.5 literature-note keys present on a note (`zotero-id`, `zoteroItemKey`, …), in vocabulary order. */
export function legacyLiteratureKeys(frontmatter: Record<string, unknown>): string[] {
	return LEGACY_LITERATURE_KEYS.filter(key => key in frontmatter);
}

/**
 * A `type: zotero` literature note carrying pre-0.5 keys: listed for information only. Reconcile never classifies or
 * patches literature notes (their frontmatter is user-owned after creation), so the row is `unchecked`,
 * `skippedReason: not-paper-hub`, never proposal-eligible, and its only finding is `legacy-frontmatter-dialect`
 * (surfaced as a single aggregated diagnostic by `legacyDialectDiagnostic`, not per note).
 */
function legacyLiteratureNote(note: NoteRecord, index: ZoteroIndex | null): ReconcileNote {
	const keys = legacyLiteratureKeys(note.frontmatter ?? {});
	const resolution = resolveHub(note, index);
	const entry = resolution.entry;
	return {
		path: note.path, type: "literature", citekey: resolution.citekey, resolvedVia: resolution.resolvedVia, classification: "unchecked",
		findings: [finding("legacy-frontmatter-dialect", `Literature note carries pre-0.5 keys (${keys.join(", ")}); frontmatter is user-owned and is not rewritten. zoteroID remains the only identity key agents may rely on.`, keys.join(", "))],
		index: entry ? { id: entry.id, citekey: entry.citekey, citekeyShape: citekeyShape(entry.citekey), hasPdf: hasPdf(entry) } : null,
		observed: observeIdentity(note), identityEvidence: resolution.evidence, candidateIDs: resolution.candidates.map(candidate => candidate.id),
		proposalEligible: false, proposed: null, proposedS01: null, applied: false, skippedReason: "not-paper-hub",
	};
}

function emptySummary(): HubSummary {
	return { registeredConsistent: 0, registeredDesynced: 0, registeredUnpinned: 0, provisionalNowRegistered: 0, unregisteredFlagged: 0, unregisteredUnflagged: 0, ambiguous: 0, unchecked: 0 };
}

const SUMMARY_KEY: Record<HubClassification, keyof HubSummary> = {
	"registered-consistent": "registeredConsistent", "registered-desynced": "registeredDesynced", "registered-unpinned": "registeredUnpinned",
	"provisional-now-registered": "provisionalNowRegistered", "unregistered-flagged": "unregisteredFlagged", "unregistered-unflagged": "unregisteredUnflagged",
	ambiguous: "ambiguous", unchecked: "unchecked",
};

function skippedReasonFor(type: ReconcileNoteType, classification: HubClassification, findings: Finding[], stale: boolean, indexComplete: boolean): SkippedReason | undefined {
	if (type === "parse-error") return "frontmatter-parse-error";
	if (type === "raw-source") return findings.some(item => item.code === "raw-source-path") ? "raw-source-path" : "raw-source";
	if (findings.some(item => item.code === "malformed-identity")) return "malformed-identity";
	if (findings.some(item => item.code === "identity-conflict")) return "identity-conflict";
	if (stale !== false) return "index-stale";
	if (!indexComplete) return "index-incomplete";
	if (classification === "ambiguous") return "ambiguous";
	if (classification === "unchecked") return "unchecked";
	return undefined;
}

function parseErrorNote(note: NoteRecord): ReconcileNote {
	const citekey = folderBasename(note.path) ?? "";
	return {
		path: note.path, type: "parse-error", citekey, resolvedVia: null, classification: "unchecked",
		findings: [finding("frontmatter-parse-error", "Frontmatter could not be parsed; the note is visible but reconcile will not classify or propose changes.")],
		index: null, observed: observeIdentity(note), identityEvidence: [], candidateIDs: [], proposalEligible: false,
		proposed: null, proposedS01: null, applied: false, skippedReason: "frontmatter-parse-error",
	};
}

function reconcileNote(note: NoteRecord, type: ReconcileNoteType, index: ZoteroIndex | null, vault: ReconcileVault, opts: ReconcileOptions): ReconcileNote {
	if (type === "parse-error") return parseErrorNote(note);
	if (type === "literature") return legacyLiteratureNote(note, index);
	const resolution = resolveHub(note, index);
	const verdict = classifyHub(note, resolution, opts.stale, opts.allowStale);
	const hub = type === "paper-hub";
	const observed = observeIdentity(note);
	const findings = hub ? [...verdict.findings] : verdict.findings.filter(item => !APPLY_ELIGIBLE_FINDINGS.includes(item.code));
	if (isRawSourcePath(note.path) && note.frontmatter?.type === "paper-hub") findings.push(finding("raw-source-path", `A note under ${RAW_SOURCES_ROOT}/ is report-only even when mislabeled type: paper-hub.`));
	if (opts.stale !== false && !findings.some(item => item.code === "index-stale")) findings.push(finding("index-stale", "Index is stale; allow-stale permits reporting only, never proposals."));
	const attachment = hub && resolution.entry ? hubAttachmentFinding(resolution.entry, vault.pdfPaths, resolution.citekey) : null;
	if (attachment) findings.push(attachment);
	const orderedFindings = orderFindings(findings);
	const entry = resolution.entry;
	const applyEligible = hub && opts.stale === false && resolution.indexComplete && !resolution.identityConflict && !hasMalformedIdentity(observed);
	const result: ReconcileNote = {
		path: note.path,
		type,
		citekey: resolution.citekey,
		resolvedVia: resolution.resolvedVia,
		classification: verdict.classification,
		findings: orderedFindings,
		index: entry ? { id: entry.id, citekey: entry.citekey, citekeyShape: citekeyShape(entry.citekey), hasPdf: hasPdf(entry) } : null,
		observed,
		identityEvidence: resolution.evidence,
		candidateIDs: resolution.candidates.map(candidate => candidate.id),
		proposalEligible: applyEligible,
		proposed: applyEligible ? proposedFrontmatter(observed, resolution, verdict.classification, opts.now, opts.stale) : null,
		proposedS01: proposedS01(note, resolution, verdict.classification, opts.now, applyEligible),
		applied: false,
	};
	if (verdict.citekeyCurrent !== undefined) result.citekeyCurrent = verdict.citekeyCurrent;
	if (verdict.pinInstruction !== undefined) result.pinInstruction = verdict.pinInstruction;
	const skippedReason = skippedReasonFor(type, verdict.classification, orderedFindings, opts.stale, resolution.indexComplete);
	if (skippedReason) result.skippedReason = skippedReason;
	return result;
}

/** Reconcile-derived diagnostics for one note (vocabulary §2 codes). `index-stale` is envelope-level and left to the host. */
export function noteDiagnostics(note: ReconcileNote): AgentDiagnostic[] {
	const extra = { citekey: note.citekey, path: note.path, ...(note.index ? { itemID: note.index.id } : {}) };
	const diagnostics: AgentDiagnostic[] = [];
	switch (note.classification) {
		case "unregistered-unflagged":
			diagnostics.push(diagnostic("citekey-unregistered", `Citekey "${note.citekey}" is not registered in Zotero and the note is not flagged provisional: ${note.path}`, extra));
			break;
		case "registered-unpinned":
			diagnostics.push(diagnostic("citekey-not-pinned", `Citekey "${note.citekey}" is not pinned in Zotero; item ${note.index?.id ?? "?"} currently uses "${note.citekeyCurrent ?? note.index?.citekey ?? "?"}": ${note.path}`, extra));
			break;
		case "registered-desynced":
			if (note.type === "paper-hub") diagnostics.push(diagnostic("identity-desync", `Hub identity is out of sync with Zotero (${note.findings.filter(item => DESYNC_FINDINGS.includes(item.code)).map(item => item.code).join(", ")}): ${note.path}`, extra));
			break;
		case "provisional-now-registered":
			if (note.type === "paper-hub") diagnostics.push(diagnostic("provisional-now-registered", `Provisional citekey "${note.citekey}" is now registered in Zotero; citekeyProvisional can be set to false: ${note.path}`, extra));
			break;
		case "ambiguous":
			diagnostics.push(diagnostic("citekey-ambiguous", `Citekey "${note.citekey}" matches more than one Zotero item; explicit identity is required: ${note.path}`, extra));
			break;
		default:
			break;
	}
	for (const item of note.findings) {
		if (item.code === "hub-attachment-missing") diagnostics.push(diagnostic("attachment-missing-for-hub", `${item.message} Hub: ${note.path}`, extra));
	}
	return diagnostics;
}

// 0.5 R14
/** Paths named in the aggregated `legacy-frontmatter-dialect` diagnostic; the rest are counted. */
export const LEGACY_DIALECT_SAMPLE = 5;

/**
 * One informational diagnostic for all pre-0.5 literature notes (there is one per note in `notes`): every 0.3/0.4 note
 * carries the dropped keys forever, so a per-note diagnostic would inflate `diagnostics`/`reconcile` payloads for a
 * condition that has no remedy. `path` is the first sampled note; the message carries the count and a bounded sample.
 */
export function legacyDialectDiagnostic(notes: ReconcileNote[]): AgentDiagnostic | null {
	const paths = notes.filter(note => note.type === "literature").map(note => note.path);
	if (!paths.length) return null;
	const sample = paths.slice(0, LEGACY_DIALECT_SAMPLE);
	const rest = paths.length - sample.length;
	const plural = paths.length === 1 ? "note carries" : "notes carry";
	return diagnostic("legacy-frontmatter-dialect", `${paths.length} literature ${plural} pre-0.5 frontmatter keys; frontmatter is user-owned and is not rewritten. zoteroID remains the only identity key agents may rely on. Sample: ${sample.join(", ")}${rest ? ` (+${rest} more)` : ""}`, { path: sample[0] });
}

/**
 * Walks `type: paper-hub` notes and `type: raw-source` notes that carry a citekey (report-only), narrowed by `folders`,
 * and returns per-note verdicts, the hub summary and the reconcile-derived diagnostics. Nothing is written.
 * `type: zotero` literature notes appear only when they carry pre-0.5 keys (`legacy-frontmatter-dialect`, informational).
 */
export function reconcileNotes(notes: NoteRecord[], index: ZoteroIndex | null, vault: ReconcileVault, opts: ReconcileOptions): ReconcileResult {
	const folders = normalizeFolders(opts.folders);
	const summary = emptySummary();
	const results: ReconcileNote[] = [];
	const diagnostics: AgentDiagnostic[] = [];
	let hubs = 0;
	let rawSources = 0;
	let parseErrors = 0;
	for (const note of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
		const type = noteType(note);
		if (!type || !inFolders(note.path, folders)) continue;
		if (type === "paper-hub") hubs += 1;
		else if (type === "raw-source") rawSources += 1;
		else if (type === "parse-error") parseErrors += 1;
		const result = reconcileNote(note, type, index, vault, opts);
		if (type === "paper-hub") summary[SUMMARY_KEY[result.classification]] += 1;
		results.push(result);
		diagnostics.push(...noteDiagnostics(result));
	}
	const legacyDialect = legacyDialectDiagnostic(results); // 0.5 R14
	if (legacyDialect) diagnostics.push(legacyDialect);
	return { folders, scanned: { hubs, rawSources, parseErrors }, notes: results, summary: { hubs: summary }, diagnostics };
}

/** Deterministic Markdown summary for the `markdown` field of the reconcile response. */
export function renderReport(result: ReconcileResult): string {
	const hubs = result.summary.hubs;
	const lines = [
		"# Reconcile report",
		"",
		`Hubs: ${result.scanned.hubs} · Raw sources: ${result.scanned.rawSources} · Parse errors: ${result.scanned.parseErrors}${result.folders.length ? ` · Folders: ${result.folders.join(", ")}` : ""}`,
		"",
		`registered-consistent ${hubs.registeredConsistent} · registered-desynced ${hubs.registeredDesynced} · registered-unpinned ${hubs.registeredUnpinned} · provisional-now-registered ${hubs.provisionalNowRegistered} · unregistered-flagged ${hubs.unregisteredFlagged} · unregistered-unflagged ${hubs.unregisteredUnflagged} · ambiguous ${hubs.ambiguous} · unchecked ${hubs.unchecked}`,
		"",
	];
	if (result.notes.length) {
		lines.push("| Path | Type | Citekey | Classification | Findings | Proposed |", "|---|---|---|---|---|---|");
		for (const note of result.notes) {
			const proposed = note.proposed ? Object.keys(note.proposed).join(", ") : note.skippedReason ?? "—";
			lines.push(`| ${note.path} | ${note.type} | ${note.citekey || "—"} | ${note.classification} | ${note.findings.map(item => item.code).join(", ") || "—"} | ${proposed} |`);
		}
		lines.push("");
	}
	const count = (severity: AgentDiagnostic["severity"]): number => result.diagnostics.filter(item => item.severity === severity).length;
	lines.push(`Diagnostics: ${result.diagnostics.length} (error ${count("error")}, warning ${count("warning")}, info ${count("info")})`);
	return `${lines.join("\n")}\n`;
}
