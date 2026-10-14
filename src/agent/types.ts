/**
 * Shared contracts for the agent-facing surface (CLI contract 2). Pure types only: this file must never import `obsidian`.
 * Vocabulary source of truth: skills/cmds-zotero/references/cli-contract-v2.md (generated from these types and the docs).
 */
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import { obsidianOpenURI } from "../uris";
import type { BbtTransportReason } from "../api/transport"; // 0.5 R4: type-only, keeps this module pure

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
	/** Additive discovery report; hosts must not silently lose malformed or truncated notes. `skippedDetail` (0.5 R8) classifies each skipped path. */
	scanWarnings?(): { skipped: string[]; truncated: boolean; skippedDetail?: ScanSkip[] };
	/** Every Markdown note with parsed frontmatter (no body). Implementations cap at 20,000 files and skip dot-directories. */
	listNotes(): Promise<NoteRecord[]>;
	/** Full text of one note; throws when absent or outside the vault. */
	readNote(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	/**
	 * PERF-07: optional fast path with the exact answer of `findNote(await listNotes(), path)` that need not read every
	 * note; the scan report may stay untouched. Callers use the listing when a reader does not provide it.
	 */
	findNote?(path: string): Promise<NoteRecord | null>;
}

export interface PluginInfo { status: "ok" | "off" | "too-old" | "unknown"; version: string | null; apiVersions: number[] | null }
export interface BbtInfo { reachable: boolean | null; zotero?: string; betterbibtex?: string; error?: string; /** 0.5 R4: typed transport reason beside `error`. */ reason?: BbtTransportReason }
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
	| "discovery-incomplete" | "note-conflict" | "zotero-too-old";

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

// 0.5 R14
/**
 * Frontmatter keys of a literature note created by this plugin, in YAML order after `type: zotero`. Frontmatter is
 * written once and stays user-owned afterwards, so notes created before 0.5 keep their extra keys
 * (`LEGACY_LITERATURE_KEYS`, a "pre-0.5 vintage"). `zoteroID` is the only key agents may rely on; `zoteroSelectURI`
 * carries library scope (group items included); `zotero-key` is the ZotLit-compatible item key; `citekey`, `doi`,
 * `title`, `authors`, `year` and `tags` are plain metadata; `zotero_*` mirror the earlier CMDS template for display
 * parity and carry no identity.
 */
export const LITERATURE_IDENTITY_KEYS = [
	"zoteroID", "zoteroSelectURI", "zotero-key", "citekey", "doi", "title", "authors", "year", "tags",
	"zotero_title", "zotero_author", "zotero_year", "zotero_journal", "zotero_doi", "zotero_url", "zotero_tags",
] as const;
export type LiteratureIdentityKey = typeof LITERATURE_IDENTITY_KEYS[number];
/** Keys 0.3/0.4 wrote and 0.5 no longer emits (all derivable from `zoteroID`/`zoteroSelectURI`); reconcile reports them as `legacy-frontmatter-dialect`. */
export const LEGACY_LITERATURE_KEYS = ["zotero-id", "zotero-library-id", "zoteroItemKey", "zoteroLibraryID", "zoteroLibraryType", "zoteroGroupID"] as const;
/** Frontmatter `type` values under which citekey equality may identify a Zotero item; any other `type` is a foreign convention. */
export const ZOTERO_NOTE_TYPES = ["zotero", "paper-hub", "paper-analysis", "raw-source", "literature-zotero"] as const;

// 0.5 R8
/** Why a vault scan skipped a path: it could not be read, its frontmatter did not parse, or it is a symlink (offline reader). */
export type ScanSkipKind = "unreadable" | "parse-error" | "symlink";
export interface ScanSkip { path: string; kind: ScanSkipKind }
/**
 * `reconcile` scan report: the shared `{skipped, truncated}` plus the per-path kind and every parse-error path
 * (parse errors veto `--apply` only inside the `--folders` scope or on a candidate hub; see the contract's apply protocol).
 */
export interface ReconcileScanReport extends ScanReport { skippedDetail: ScanSkip[]; parseErrors: string[] }
/** YAML codec the live host injects (Obsidian `parseYaml`/`stringifyYaml`); the offline host omits it, so its rows carry no `yamlNormalisable`. */
export interface YamlCodec { parse(text: string): unknown; stringify(value: unknown): string }
