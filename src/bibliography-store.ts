// 0.5 R12: offline bibliography sidecar. Pure (no `obsidian` import); storage is injected so the store is testable.
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from "node:timers";
import type { ZoteroIndexEntry } from "./types";

/** Vault-relative path of the sidecar; lives in the plugin's private, self-gitignored directory. */
export const BIBLIOGRAPHY_SIDECAR = ".cmds-zotero/bibliography.json";
/** Serialized size bound; the oldest renderings are evicted when a write would exceed it. */
export const BIBLIOGRAPHY_MAX_BYTES = 4 * 1024 * 1024;
/** Quiet period after the last successful rendering before the sidecar is written. */
export const BIBLIOGRAPHY_WRITE_DELAY_MS = 1500;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_KEY_CHARS = 200;
const MAX_VERSION_CHARS = 64;

/** Where one bibliography text came from. `fallback` carries no text: the caller synthesizes an author-year line. */
export type BibliographySource = "live" | "cached" | "fallback";

export interface BibliographyDetail {
	text: string;
	source: BibliographySource;
	/** When a `cached` text was rendered by BBT (ISO timestamp). */
	renderedAt?: string;
	/** The BBT failure that made a `cached` or `fallback` answer necessary; absent for a sidecar hit without a BBT attempt. */
	error?: unknown;
}

export interface BibliographyRecord {
	contentHash: string;
	/** Better BibTeX version that rendered the text, or "" when unknown at rendering time. */
	bbtVersion: string;
	text: string;
	renderedAt: string;
}

export interface BibliographySidecar { version: 1; styles: Record<string, Record<string, BibliographyRecord>> }

/** Text storage the store reads and writes through; the host binds it to the vault adapter. */
export interface BibliographyStorage {
	read(): Promise<string | null>;
	write(text: string): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const boundedString = (value: unknown, max: number, allowEmpty = false): value is string => typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0) && !value.includes("\0");

function validRecord(value: unknown): value is BibliographyRecord {
	if (!isRecord(value)) return false;
	return boundedString(value.contentHash, 128) && /^[A-Za-z0-9:_-]+$/.test(value.contentHash)
		&& boundedString(value.bbtVersion, MAX_VERSION_CHARS, true)
		&& boundedString(value.text, MAX_TEXT_CHARS)
		&& boundedString(value.renderedAt, 64) && Number.isFinite(Date.parse(value.renderedAt));
}

/** Parses sidecar text; a malformed envelope yields an empty sidecar and malformed records are dropped one by one. */
export function parseBibliographySidecar(text: string | null): BibliographySidecar {
	const empty: BibliographySidecar = { version: 1, styles: {} };
	if (!text) return empty;
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return empty; }
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.styles)) return empty;
	const styles: BibliographySidecar["styles"] = {};
	for (const [style, entries] of Object.entries(parsed.styles)) {
		if (!boundedString(style, MAX_KEY_CHARS) || !isRecord(entries)) continue;
		const kept: Record<string, BibliographyRecord> = {};
		for (const [id, record] of Object.entries(entries)) {
			if (!boundedString(id, MAX_KEY_CHARS) || !validRecord(record)) continue;
			kept[id] = { contentHash: record.contentHash, bbtVersion: record.bbtVersion, text: record.text, renderedAt: record.renderedAt };
		}
		if (Object.keys(kept).length) styles[style] = kept;
	}
	return { version: 1, styles };
}

export function serializeBibliographySidecar(sidecar: BibliographySidecar): string {
	const styles: BibliographySidecar["styles"] = {};
	for (const style of Object.keys(sidecar.styles).sort()) {
		const entries = sidecar.styles[style];
		styles[style] = Object.fromEntries(Object.keys(entries).sort().map(id => [id, entries[id]]));
	}
	return `${JSON.stringify({ version: 1, styles }, null, "\t")}\n`;
}

const encoder = new TextEncoder();
/** Approximate serialized bytes of one record (keys, quoting and indentation included). */
function recordBytes(id: string, record: BibliographyRecord): number {
	return encoder.encode(id).length + encoder.encode(record.text).length + record.contentHash.length + record.bbtVersion.length + record.renderedAt.length + 96;
}

export interface BibliographyStoreOptions {
	maxBytes?: number;
	writeDelayMs?: number;
	now?: () => Date;
}

/**
 * Write-through cache of rendered bibliography text keyed by style and entry id. A hit requires the stored
 * `contentHash` to equal the entry's current hash and, when the caller knows the BBT version, the same version.
 * Records are written lazily (debounced) after each successful rendering; nothing is rendered at refresh time.
 */
export class BibliographyStore {
	private sidecar: BibliographySidecar | null = null;
	private loading: Promise<BibliographySidecar> | null = null;
	private bytes = 0;
	private dirty = false;
	private timer: NodeJS.Timeout | null = null;
	private writing: Promise<void> = Promise.resolve();
	private readonly maxBytes: number;
	private readonly writeDelayMs: number;
	private readonly now: () => Date;

	constructor(private readonly storage: BibliographyStorage, options: BibliographyStoreOptions = {}) {
		this.maxBytes = options.maxBytes ?? BIBLIOGRAPHY_MAX_BYTES;
		this.writeDelayMs = options.writeDelayMs ?? BIBLIOGRAPHY_WRITE_DELAY_MS;
		this.now = options.now ?? (() => new Date());
	}

	/** Reads the sidecar once; a storage fault or malformed file starts an empty sidecar (the cache is never required). */
	load(): Promise<BibliographySidecar> {
		if (this.sidecar) return Promise.resolve(this.sidecar);
		if (this.loading) return this.loading;
		this.loading = this.storage.read().catch(() => null).then(text => {
			const sidecar = parseBibliographySidecar(text);
			this.sidecar = sidecar;
			this.bytes = 0;
			for (const entries of Object.values(sidecar.styles)) for (const [id, record] of Object.entries(entries)) this.bytes += recordBytes(id, record);
			this.loading = null;
			return sidecar;
		});
		return this.loading;
	}

	/** True once `load()` has completed; `get` and `set` answer only then. */
	get loaded(): boolean { return this.sidecar !== null; }

	/** Number of stored records across styles. */
	get size(): number { return this.sidecar ? Object.values(this.sidecar.styles).reduce((sum, entries) => sum + Object.keys(entries).length, 0) : 0; }

	/**
	 * The stored rendering for `entry` in `style`, when its content hash matches the entry and, if `bbtVersion` is known
	 * (non-empty), the record was rendered by that version. Null before `load()` and on any mismatch.
	 */
	get(style: string, entry: Pick<ZoteroIndexEntry, "id" | "contentHash">, bbtVersion?: string): BibliographyRecord | null {
		const record = this.sidecar?.styles[style]?.[entry.id];
		if (!record || record.contentHash !== entry.contentHash) return null;
		if (bbtVersion && record.bbtVersion && record.bbtVersion !== bbtVersion) return null;
		if (bbtVersion && !record.bbtVersion) return null;
		return record;
	}

	/** Stores a successful rendering and schedules a debounced write; oversized or empty text is not stored. */
	set(style: string, entry: Pick<ZoteroIndexEntry, "id" | "contentHash">, text: string, bbtVersion = ""): BibliographyRecord | null {
		if (!this.sidecar) return null;
		const trimmed = text.trim();
		if (!trimmed || trimmed.length > MAX_TEXT_CHARS || !boundedString(style, MAX_KEY_CHARS) || !boundedString(entry.id, MAX_KEY_CHARS) || !boundedString(entry.contentHash, 128)) return null;
		const record: BibliographyRecord = { contentHash: entry.contentHash, bbtVersion: bbtVersion.slice(0, MAX_VERSION_CHARS), text: trimmed, renderedAt: this.now().toISOString() };
		const entries = this.sidecar.styles[style] ?? (this.sidecar.styles[style] = {});
		const previous = entries[entry.id];
		if (previous) this.bytes -= recordBytes(entry.id, previous);
		entries[entry.id] = record;
		this.bytes += recordBytes(entry.id, record);
		this.evict();
		this.dirty = true;
		this.schedule();
		return record;
	}

	/** Evicts the oldest renderings (by `renderedAt`) until the estimated size fits the bound. */
	private evict(): void {
		if (!this.sidecar || this.bytes <= this.maxBytes) return;
		const all: { style: string; id: string; record: BibliographyRecord }[] = [];
		for (const [style, entries] of Object.entries(this.sidecar.styles)) for (const [id, record] of Object.entries(entries)) all.push({ style, id, record });
		all.sort((left, right) => Date.parse(left.record.renderedAt) - Date.parse(right.record.renderedAt) || left.id.localeCompare(right.id));
		for (const { style, id, record } of all) {
			if (this.bytes <= this.maxBytes) break;
			const entries = this.sidecar.styles[style];
			if (!entries?.[id]) continue;
			delete entries[id];
			this.bytes -= recordBytes(id, record);
			if (!Object.keys(entries).length) delete this.sidecar.styles[style];
		}
	}

	private schedule(): void {
		if (this.timer !== null) nodeClearTimeout(this.timer);
		// A pending debounce never keeps a process alive (tests); the host flushes explicitly on unload.
		this.timer = nodeSetTimeout(() => { this.timer = null; void this.flush(); }, this.writeDelayMs).unref();
	}

	/** Writes pending changes now (also cancels the debounce timer). Storage faults are swallowed: the cache is best effort. */
	flush(): Promise<void> {
		if (this.timer !== null) { nodeClearTimeout(this.timer); this.timer = null; }
		if (!this.dirty || !this.sidecar) return this.writing;
		const text = serializeBibliographySidecar(this.sidecar);
		this.dirty = false;
		this.writing = this.writing.then(() => this.storage.write(text)).catch(() => { this.dirty = true; });
		return this.writing;
	}

	/** Cancels a pending write without writing; used when the host is torn down. */
	dispose(): void {
		if (this.timer !== null) { nodeClearTimeout(this.timer); this.timer = null; }
	}

	/** Estimated serialized bytes (for tests and diagnostics). */
	get estimatedBytes(): number { return this.bytes; }
}
