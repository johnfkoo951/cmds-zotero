/**
 * Pure citekey checks for `identity.citekeyCheck`: shape classification (vocabulary §5), p7 validity, index presence,
 * collisions against the index and the vault's hubs / raw sources, and the exact Better BibTeX pin instruction.
 * Never imports `obsidian`.
 */
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import { arxivFromDoi, citekeyShape, entryArxiv, normalizeArxiv, normalizeDoi } from "./search";
import { noteRef } from "./types";
import type { CitekeyShape, NoteRecord, NoteRef } from "./types";

export { citekeyShape } from "./search";
export const P7_VALID = /^[A-Za-z][A-Za-z0-9._:-]*$/;

export type CollisionKind = "index" | "history" | "hub" | "raw-source" | "hub-doi" | "raw-doi" | "hub-citekey-ci" | "raw-citekey-ci";

export interface Collision {
	kind: CollisionKind;
	/** `entry.id` for index/history kinds, the vault-relative note path otherwise. */
	ref: string;
}

/** Vault lookups keyed by exact `citekey` and by `normalizeDoi` output (arXiv ids as `10.48550/arxiv.<id>`). */
export interface NoteLookup {
	hubByCitekey: ReadonlyMap<string, NoteRef[]>;
	rawByCitekey: ReadonlyMap<string, NoteRef[]>;
	hubByDoi: ReadonlyMap<string, NoteRef[]>;
	rawByDoi: ReadonlyMap<string, NoteRef[]>;
}

export interface CitekeyHints {
	/** Identifiers of the paper being checked (the selector or the resolved entry). */
	doi?: string;
	arxiv?: string;
	/** `entry.id` of the resolved item; that entry is the paper itself, never a collision. */
	ownId?: string;
	/** Vault paths to exclude from note collisions (e.g. the hub currently being reconciled). */
	ownPaths?: string[];
}

export interface CitekeyCheck {
	citekey: string;
	shape: CitekeyShape;
	/** The vault convention is the `vault` shape (`authYearShorttitle`). */
	conventionOk: boolean;
	p7Valid: boolean;
	existsInIndex: boolean;
	collisions: Collision[];
	/** Non-null whenever the key is not the index key of the paper itself (unregistered or registered under another key). */
	pinInstruction: string | null;
}

export type Recommendation = "ok" | "pinned" | "pin-pending" | "collision" | "nonconforming";

export function isP7Valid(key: string): boolean {
	return P7_VALID.test(key);
}

/** The exact string the agent pastes for the user; Better BibTeX pins the key on save, the plugin never writes it. */
export function pinInstruction(key: string): string {
	return `Zotero → item → Extra field → add line \`Citation Key: ${key}\` (Better BibTeX pins it on save; the plugin cannot write it)`;
}

function arxivDoi(arxiv: string): string {
	return `10.48550/arxiv.${arxiv}`;
}

function push(map: Map<string, NoteRef[]>, key: string, ref: NoteRef): void {
	const list = map.get(key) ?? [];
	if (!list.some(item => item.path === ref.path)) list.push(ref);
	map.set(key, list);
}

/** Classify notes by frontmatter `type` (`paper-hub` → hub, `raw-source` → raw) and index them by citekey and DOI/arXiv. */
export function buildNoteLookup(vault: string, notes: NoteRecord[]): NoteLookup {
	const hubByCitekey = new Map<string, NoteRef[]>();
	const rawByCitekey = new Map<string, NoteRef[]>();
	const hubByDoi = new Map<string, NoteRef[]>();
	const rawByDoi = new Map<string, NoteRef[]>();
	for (const note of notes) {
		const fm = note.frontmatter;
		if (!fm || (fm.type !== "paper-hub" && fm.type !== "raw-source")) continue;
		const [byCitekey, byDoi] = fm.type === "paper-hub" ? [hubByCitekey, hubByDoi] : [rawByCitekey, rawByDoi];
		const ref = noteRef(vault, note.path);
		const citekey = typeof fm.citekey === "string" ? fm.citekey.trim() : "";
		if (citekey) push(byCitekey, citekey, ref);
		const doi = typeof fm.doi === "string" ? normalizeDoi(fm.doi) : "";
		if (doi) push(byDoi, doi, ref);
		const arxiv = typeof fm.arxiv === "string" ? normalizeArxiv(fm.arxiv) : "";
		if (arxiv) push(byDoi, arxivDoi(arxiv), ref);
	}
	return { hubByCitekey, rawByCitekey, hubByDoi, rawByDoi };
}

function ownMatcher(hints: CitekeyHints, entries: ZoteroIndexEntry[]): (entry: ZoteroIndexEntry) => boolean {
	if (hints.ownId) return entry => entry.id === hints.ownId;
	const doi = hints.doi ? normalizeDoi(hints.doi) : "";
	const arxiv = (hints.arxiv ? normalizeArxiv(hints.arxiv) : "") || (doi ? arxivFromDoi(doi) : "");
	if (!doi && !arxiv) return () => false;
	const matchingIds = new Set(entries
		.filter(entry => (doi !== "" && normalizeDoi(entry.doi) === doi) || (arxiv !== "" && entryArxiv(entry) === arxiv))
		.map(entry => entry.id));
	if (matchingIds.size !== 1) return () => false;
	const [ownId] = matchingIds;
	return entry => entry.id === ownId;
}

function noteCollisions(kind: CollisionKind, refs: NoteRef[] | undefined, excluded: Set<string>): Collision[] {
	return (refs ?? []).filter(ref => !excluded.has(ref.path)).map(ref => ({ kind, ref: ref.path }));
}

function caseInsensitiveCollisions(kind: CollisionKind, byCitekey: ReadonlyMap<string, NoteRef[]>, citekey: string, excluded: Set<string>): Collision[] {
	const wanted = citekey.toLowerCase();
	const found: Collision[] = [];
	for (const [key, refs] of byCitekey) {
		if (key !== citekey && key.toLowerCase() === wanted) found.push(...noteCollisions(kind, refs, excluded));
	}
	return found;
}

/**
 * Check `key` against the index and the vault. An index entry with the same citekey is the paper itself when
 * `hints.ownId` names it (or, lacking `ownId`, when its DOI/arXiv equals the hints): then `existsInIndex` is true and
 * `pinInstruction` is null. Any other entry holding the key (or
 * carrying it in `citekeyHistory`) is a collision, as is every hub / raw source with the same key (exact or
 * case-insensitive) or the same DOI/arXiv. With no identity hints, an existing key is conservatively a collision.
 */
export function checkCitekey(key: string, index: ZoteroIndex, notes: NoteLookup, hints: CitekeyHints = {}): CitekeyCheck {
	const citekey = key.trim();
	const own = ownMatcher(hints, index.entries);
	const collisions: Collision[] = [];
	let existsInIndex = false;
	let pinned = false;
	for (const entry of index.entries) {
		if (entry.citekey === citekey) {
			existsInIndex = true;
			if (own(entry)) pinned = true;
			else collisions.push({ kind: "index", ref: entry.id });
		} else if (entry.citekeyHistory.includes(citekey) && !own(entry)) {
			collisions.push({ kind: "history", ref: entry.id });
		}
	}
	const excluded = new Set(hints.ownPaths ?? []);
	collisions.push(...noteCollisions("hub", notes.hubByCitekey.get(citekey), excluded));
	collisions.push(...noteCollisions("raw-source", notes.rawByCitekey.get(citekey), excluded));
	const doi = (hints.doi ? normalizeDoi(hints.doi) : "") || (hints.arxiv ? arxivDoi(normalizeArxiv(hints.arxiv)) : "");
	if (doi) {
		collisions.push(...noteCollisions("hub-doi", notes.hubByDoi.get(doi), excluded));
		collisions.push(...noteCollisions("raw-doi", notes.rawByDoi.get(doi), excluded));
	}
	collisions.push(...caseInsensitiveCollisions("hub-citekey-ci", notes.hubByCitekey, citekey, excluded));
	collisions.push(...caseInsensitiveCollisions("raw-citekey-ci", notes.rawByCitekey, citekey, excluded));
	const shape = citekeyShape(citekey);
	return { citekey, shape, conventionOk: shape === "vault", p7Valid: isP7Valid(citekey), existsInIndex, collisions, pinInstruction: pinned ? null : pinInstruction(citekey) };
}

/** Payload `citekeyCheck.recommendation`; `citekeyCurrent` is the index key of the resolved item (null when not resolved). */
export function recommend(check: CitekeyCheck, citekeyCurrent: string | null = null): Recommendation {
	if (check.collisions.length) return "collision";
	if (check.pinInstruction === null && check.existsInIndex) return "pinned";
	if (!check.conventionOk) return "nonconforming";
	if (citekeyCurrent !== null && citekeyCurrent !== check.citekey) return "pin-pending";
	return "ok";
}
