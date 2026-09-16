/**
 * Shared contracts for the agent-facing surface (CLI contract 2). Pure types only: this file must never import `obsidian`.
 * Vocabulary source of truth: skills/cmds-zotero/references/cli-contract-v2.md (generated from these types and the docs).
 */
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import { obsidianOpenURI } from "../uris";

/** v1 resolution enum; the JSON name `status` is reserved for this enum only. */
export type ResolutionStatus = "resolved" | "ambiguous" | "not-found" | "unavailable";

export type MatchedBy = "citekey" | "citekeyHistory" | "itemKey" | "id" | "doi" | "arxiv" | "title" | null;
export type RankedMatch = Exclude<MatchedBy, null> | "titlePrefix" | "titleTokens" | "query";

export interface RankedItem {
	id: string;
	citekey: string;
	title: string;
	year: string;
	authors: string[];
	doi: string;
	libraryID: number;
	zoteroSelectURI: string;
	matchedBy: RankedMatch;
	score: number;
	reason: string;
}

/** Exactly one selector family must be present; the CLI enforces this before the request reaches the plugin. */
export interface Selector {
	citekey?: string;
	itemKey?: string;
	libraryID?: number;
	doi?: string;
	arxiv?: string;
	title?: string;
	year?: string;
	author?: string;
	query?: string;
}

export type SelectorKind = "citekey" | "itemKey" | "doi" | "arxiv" | "title" | "query";

export interface QueryEcho {
	kind: SelectorKind;
	raw: string;
	normalized: string;
	year?: string;
	author?: string;
	libraryID?: number;
}

export interface ResolveOutcome {
	status: ResolutionStatus;
	matchedBy: MatchedBy;
	entry: ZoteroIndexEntry | null;
	matchedHistory: boolean;
	/** v1 `candidates`: full entries when ambiguous. */
	candidates: ZoteroIndexEntry[];
	/** ambiguous: the candidates ranked; not-found: up to 10 suggestions; resolved: []. */
	ranked: RankedItem[];
	query: QueryEcho;
	message?: string;
}

/** A vault note as seen by pure modules. `body` is present only when the caller read it. */
export interface NoteRecord {
	path: string;
	basename: string;
	frontmatter: Record<string, unknown> | null;
	frontmatterParse: "ok" | "error";
	body?: string;
}

export interface NoteRef { path: string; basename: string; uri: string }

export interface VaultNotes {
	hub: NoteRef | null;
	raw: NoteRef[];
	atoms: NoteRef[];
	literatureNote: NoteRef | null;
	other: NoteRef[];
	warnings: string[];
}

/** `uri` is the canonical `obsidian://open` address (percent-encoded, `.md` stripped) that Obsidian and Hookmark use. 0.5 R15 */
export function noteRef(vault: string, path: string): NoteRef {
	const basename = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
	return { path, basename, uri: obsidianOpenURI(vault, path) };
}

/** Read-only vault access shared by live (Obsidian) and offline (fs) hosts. Paths are vault-relative with `/`. */
export interface VaultReader {
	vaultName(): string;
	/** Additive discovery report; hosts must not silently lose malformed or truncated notes. */
	scanWarnings?(): { skipped: string[]; truncated: boolean };
	/** Every Markdown note with parsed frontmatter (no body). Implementations cap at 20,000 files and skip dot-directories. */
	listNotes(): Promise<NoteRecord[]>;
	/** Full text of one note; throws when absent or outside the vault. */
	readNote(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
}

export interface PluginInfo { status: "ok" | "off" | "too-old" | "unknown"; version: string | null; apiVersions: number[] | null }
export interface BbtInfo { reachable: boolean | null; zotero?: string; betterbibtex?: string; error?: string }
export interface IndexInfo {
	source: "plugin" | "offline-file" | "none";
	path: string;
	schemaVersion: 2 | null;
	generatedAt: string | null;
	ageMinutes: number | null;
	count: number | null;
	complete: boolean | null;
	stale: boolean | null;
	maxAgeMinutes: number;
}
export interface GitInfo { repo: boolean; indexIgnored: boolean | null; cacheIgnored: boolean | null; indexTracked?: boolean | null; cacheTracked?: boolean | null }

export interface ConnectionInfo {
	mode: "live" | "offline";
	obsidian: "ok" | "unavailable";
	obsidianError?: string;
	plugin: PluginInfo;
	bbt: BbtInfo;
	index: IndexInfo;
	legacyPluginEnabled: boolean | null;
	git: GitInfo | null;
}

export type FailureReason =
	| "requires-obsidian" | "bbt-unreachable" | "stale-index" | "index-missing" | "index-invalid" | "bundle-missing"
	| "ambiguous-vault-path" | "endpoint-not-local" | "path-outside-vault" | "no-pdf-attachment" | "attachment-ambiguous"
	| "attachment-file-missing" | "pdf-too-large" | "pdf-invalid" | "pdfjs-unavailable" | "no-cache" | "quotes-empty"
	| "inline-too-large" | "timeout" | "plugin-too-old" | "legacy-plugin-enabled"
	| "index-incomplete" | "invalid-request" | "cache-invalid" | "source-changed" | "apply-failed" | "scan-incomplete"
	| "discovery-incomplete";

/** Every response carries this envelope; v1 actions keep `apiVersion: 1`, new actions use 2. */
export interface Envelope {
	apiVersion: 1 | 2;
	contract: 2;
	apiVersions: number[];
	action: string;
	vault: string;
	ok: boolean;
	reason?: FailureReason;
	message?: string;
	checkedAt: string;
	connection: ConnectionInfo;
}

export type CiteStatus = "resolved" | "hub-only" | "raw-only" | "dangling" | "ambiguous" | "unchecked";
/**
 * Why a `cites` verdict is `unchecked`: `discovery-incomplete` when vault discovery skipped or truncated notes (a hub or
 * raw source may exist unseen; `--allow-stale` does not apply), `stale-index` when the stale gate withheld a negative.
 */
export type UncheckedReason = "discovery-incomplete" | "stale-index";
/** Additive discovery report returned by resolve/identity/cites/reconcile so callers can see what a vault scan omitted. */
export interface ScanReport { skipped: string[]; truncated: boolean }
export type HubClassification = "registered-consistent" | "registered-desynced" | "registered-unpinned" | "provisional-now-registered" | "unregistered-flagged" | "unregistered-unflagged" | "ambiguous" | "unchecked";
export type PdfStatus = "present" | "missing-file" | "unknown-type" | "none" | "ambiguous" | "unavailable";
export type MatchStatus = "found" | "multiple" | "fuzzy" | "not-found";
export type CitekeyShape = "vault" | "bbt-default" | "bbt-disambiguated" | "other";

/** The five hub keys the plugin may emit and, under `reconcile --apply`, write. Order is the YAML fragment order. */
export const HUB_IDENTITY_KEYS = ["citekey", "citekeyProvisional", "doi", "zoteroID", "zoteroSelectURI", "zoteroStatus", "zoteroCheckedAt"] as const;
export const HUB_WRITABLE_KEYS = ["citekeyProvisional", "zoteroID", "zoteroSelectURI", "zoteroStatus", "zoteroCheckedAt"] as const;

export interface HubIdentityFrontmatter {
	citekey?: string;
	citekeyProvisional: boolean;
	doi: string;
	zoteroID?: string;
	zoteroSelectURI?: string;
	zoteroStatus: ResolutionStatus;
	zoteroCheckedAt: string;
}

/** Index access shared by pure modules: the validated index plus its freshness as computed by the host. */
export interface IndexView {
	index: ZoteroIndex;
	stale: boolean;
	ageMinutes: number;
}
