import { App, TFile } from "obsidian";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CmdsZoteroSettings, PeerVault, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { compareNoteRows, listsAdvancedUri, obsidianOpenURI, peerNoteURI } from "./uris";
import { noteIdentity, type AliasIndex } from "./note-aliases";
import { indexDerived } from "./index-derived";
import { assertVaultBoundary, ensureCmdsIgnore, ensureDirectory, relativePath } from "./vault-storage";

const MAP_PATH = ".cmds-zotero/note-map.json";
interface NoteMap {
	version: 1;
	vault: string;
	generatedAt: string;
	indexGeneratedAt: string;
	notes: Record<string, string[]>;
}
export interface VaultNoteLink { vault: string; path: string; uri: string }
export interface VaultLinkReport { links: VaultNoteLink[]; warnings: string[] }

/** The part of a note map that decides whether a publication changes anything; `generatedAt` is deliberately excluded. */
function mapFingerprint(map: Pick<NoteMap, "version" | "vault" | "indexGeneratedAt" | "notes">): string {
	return JSON.stringify([map.version, map.vault, map.indexGeneratedAt, map.notes]);
}

/** One recognized literature note: the entry it belongs to and its file. */
interface ResolvedNote { id: string; file: TFile }

export class VaultLinks {
	private publication: Promise<void> = Promise.resolve();
	/** Fingerprint of the map last seen on disk or written by this instance; null until the first publication seeds it. */
	private lastPublished: string | null = null;
	/**
	 * 0.6 OPT-05: path → entry of every note recognized as a literature note, under one index generation (its entries
	 * array). A new generation, or a change that is not pinned to note paths (`allNotesChanged`), resolves every note again;
	 * otherwise only the paths reported through `noteChanged` are resolved again, from the metadata cache, before the next
	 * answer. Identities depend only on a note's basename and frontmatter, so the answers equal a full pass as long as the
	 * host reports every note that changed, appeared, moved or disappeared.
	 */
	private resolved: { entries: readonly ZoteroIndexEntry[]; byPath: Map<string, ResolvedNote> } | null = null;
	private readonly dirty = new Set<string>();
	private dirtyAll = false;
	/** Bumped by every full pass and by every note whose identity or path changed. */
	private revision = 0;
	/** The revision and index generation the map on disk was last confirmed or written for. */
	private published: { revision: number; indexGeneratedAt: string } | null = null;
	constructor(private app: App, private settings: () => CmdsZoteroSettings, private canWrite: () => boolean = () => true) {}

	/** 0.6 OPT-05: the Markdown note at `path` changed, appeared, moved or disappeared; only it is resolved again. */
	noteChanged(path: string): void {
		// Before the first pass (or with a full pass pending) there is nothing to update: the next pass reads every note.
		if (this.resolved && !this.dirtyAll) this.dirty.add(path);
	}

	/** 0.6 OPT-05: something changed that is not pinned to note paths (a folder moved or vanished): every note is resolved again. */
	allNotesChanged(): void {
		this.dirtyAll = true;
		this.dirty.clear();
	}

	private identityOf(file: TFile, lookup: AliasIndex): string | null {
		return noteIdentity(file.basename, this.app.metadataCache.getFileCache(file)?.frontmatter, lookup);
	}

	/** The recognized notes for `index`, brought up to date with the reported changes. */
	private resolve(index: ZoteroIndex): Map<string, ResolvedNote> {
		const lookup = indexDerived(index.entries).aliasIndex;
		const current = this.resolved;
		if (!current || current.entries !== index.entries || this.dirtyAll) {
			const byPath = new Map<string, ResolvedNote>();
			for (const file of this.app.vault.getMarkdownFiles()) {
				const id = this.identityOf(file, lookup);
				if (id) byPath.set(file.path, { id, file });
			}
			this.resolved = { entries: index.entries, byPath };
			this.dirty.clear();
			this.dirtyAll = false;
			this.revision++;
			return byPath;
		}
		for (const path of this.dirty) {
			const file = this.app.vault.getFileByPath(path);
			const id = file && file.extension === "md" ? this.identityOf(file, lookup) : null;
			const before = current.byPath.get(path);
			if (id && file) {
				if (before?.id === id && before.file === file) continue;
				current.byPath.set(path, { id, file });
			} else if (before) current.byPath.delete(path);
			else continue;
			this.revision++;
		}
		this.dirty.clear();
		return current.byPath;
	}

	/**
	 * 0.5 R13/F06: every Markdown note this plugin recognizes as a literature note, grouped by index entry id. Paths within
	 * an entry are sorted. 0.6 OPT-05: one pass over the vault per index generation; after that a lookup costs one
	 * metadata-cache read per note reported changed since the previous lookup.
	 */
	localFilesByEntry(index: ZoteroIndex): Map<string, TFile[]> {
		const byEntry = new Map<string, TFile[]>();
		for (const { id, file } of this.resolve(index).values()) {
			const files = byEntry.get(id);
			if (files) files.push(file); else byEntry.set(id, [file]);
		}
		for (const files of byEntry.values()) files.sort((a, b) => a.path.localeCompare(b.path));
		return byEntry;
	}

	localFiles(entry: ZoteroIndexEntry, index: ZoteroIndex): TFile[] {
		return this.localFilesByEntry(index).get(entry.id) ?? [];
	}

	/** Publishes the map for `index` (written only when it differs from the map on disk). */
	publish(index: ZoteroIndex): Promise<void> {
		this.publication = this.publication.catch(() => undefined).then(() => this.publishNow(index, false));
		return this.publication;
	}

	/**
	 * 0.6 OPT-05: publishes only when a note's identity or path changed since the last publication, or `index` is another
	 * generation; otherwise nothing is computed and the disk is not touched (the edit-time path).
	 */
	publishIfChanged(index: ZoteroIndex): Promise<void> {
		this.publication = this.publication.catch(() => undefined).then(() => this.publishNow(index, true));
		return this.publication;
	}

	/**
	 * 0.5 R13/F07: deterministic map (sorted entry ids, sorted paths) compared against the last published fingerprint,
	 * seeded from disk on the first publication of a session, so an unchanged map is never rewritten.
	 */
	private async publishNow(index: ZoteroIndex, onlyIfChanged: boolean): Promise<void> {
		if (!this.canWrite()) return;
		const byPath = this.resolve(index);
		const carried = { revision: this.revision, indexGeneratedAt: index.generatedAt };
		if (onlyIfChanged && this.published?.revision === carried.revision && this.published.indexGeneratedAt === carried.indexGeneratedAt) return;
		const grouped = new Map<string, string[]>();
		for (const [path, { id }] of byPath) {
			const paths = grouped.get(id);
			if (paths) paths.push(path); else grouped.set(id, [path]);
		}
		const notes: Record<string, string[]> = {};
		for (const id of [...grouped.keys()].sort()) notes[id] = grouped.get(id)!.sort();
		const map: NoteMap = { version: 1, vault: this.app.vault.getName(), generatedAt: new Date().toISOString(), indexGeneratedAt: index.generatedAt, notes };
		await assertVaultBoundary(this.app, MAP_PATH);
		if (!this.canWrite()) return;
		// Published from every UI read: rewriting an unchanged map would dirty a git-tracked vault on each start.
		const fingerprint = mapFingerprint(map);
		if (this.lastPublished === null) this.lastPublished = await this.fingerprintOnDisk();
		if (this.lastPublished === fingerprint && await this.app.vault.adapter.exists(MAP_PATH)) { this.published = carried; return; }
		await ensureCmdsIgnore(this.app);
		await ensureDirectory(this.app, MAP_PATH);
		if (!this.canWrite()) return;
		await this.app.vault.adapter.write(MAP_PATH, JSON.stringify(map, null, 2));
		this.lastPublished = fingerprint;
		this.published = carried;
	}

	/** Fingerprint of the map currently on disk; "" when absent or unreadable (so any real map differs from it). */
	private async fingerprintOnDisk(): Promise<string> {
		try {
			if (!(await this.app.vault.adapter.exists(MAP_PATH))) return "";
			const raw: unknown = JSON.parse(await this.app.vault.adapter.read(MAP_PATH));
			if (!raw || typeof raw !== "object") return "";
			const existing = raw as Partial<NoteMap>;
			if (existing.version !== 1 || typeof existing.vault !== "string" || typeof existing.indexGeneratedAt !== "string" || !existing.notes || typeof existing.notes !== "object") return "";
			const notes: Record<string, string[]> = {};
			for (const id of Object.keys(existing.notes).sort()) {
				const paths: unknown = existing.notes[id];
				if (!Array.isArray(paths) || paths.some(value => typeof value !== "string")) return "";
				notes[id] = [...paths as string[]].sort();
			}
			return mapFingerprint({ version: 1, vault: existing.vault, indexGeneratedAt: existing.indexGeneratedAt, notes });
		} catch { return ""; }
	}

	/** 0.5 R15: rows carry the address people and Hookmark use (obsidian://open, or Advanced URI when the peer vault lists it); hub/@citekey rows first. */
	async find(entry: ZoteroIndexEntry, index: ZoteroIndex): Promise<VaultLinkReport> {
		const citekeys = [entry.citekey, ...entry.citekeyHistory];
		const order = (a: VaultNoteLink, b: VaultNoteLink): number => compareNoteRows(a, b, citekeys);
		const links: VaultNoteLink[] = this.localFiles(entry, index)
			.map(file => ({ vault: this.app.vault.getName(), path: file.path, uri: obsidianOpenURI(this.app.vault.getName(), file.path) }))
			.sort(order);
		const warnings: string[] = [];
		for (const peer of this.settings().peerVaults) {
			const rows: VaultNoteLink[] = [];
			let warning: string | null = null;
			try {
				const { root, map } = await this.loadPeerMap(peer);
				const paths: unknown = map.notes[entry.id];
				if (!Array.isArray(paths)) continue;
				const advancedUri = await this.peerListsAdvancedUri(root);
				for (const value of paths) {
					if (typeof value !== "string") continue;
					try {
						const relative = relativePath(value);
						if (!relative.endsWith(".md")) continue;
						const realFile = await fs.realpath(path.join(root, relative));
						if (!realFile.startsWith(root + path.sep)) throw new Error("A peer note points outside its vault.");
						rows.push({ vault: peer.name, path: relative, uri: peerNoteURI(peer.name, relative, { advancedUri }) });
					} catch (error) {
						warning ??= `${peer.name}: ${error instanceof Error && !/^E[A-Z]+:/.test(error.message) ? error.message : "A peer note could not be read."}`;
					}
				}
			} catch (error) {
				warning ??= `${peer.name}: ${error instanceof Error && !/^E[A-Z]+:/.test(error.message) ? error.message : "Could not read the peer note map."}`;
			} finally {
				if (warning) warnings.push(warning);
				links.push(...rows.sort(order));
			}
		}
		return { links, warnings };
	}

	/** A registered vault's published note map, validated; throws with a human reason when it cannot be used. */
	private async loadPeerMap(peer: PeerVault): Promise<{ root: string; map: NoteMap }> {
		if (!path.isAbsolute(peer.path)) throw new Error("The registered vault path must be absolute.");
		const root = await fs.realpath(peer.path);
		const candidate = path.join(root, MAP_PATH);
		const resolved = await fs.realpath(candidate);
		if (!resolved.startsWith(root + path.sep)) throw new Error("Note map points outside the registered vault.");
		const info = await fs.stat(resolved);
		if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("Note map is missing or too large.");
		const raw: unknown = JSON.parse(await fs.readFile(resolved, "utf8"));
		if (!raw || typeof raw !== "object") throw new Error("Invalid note map.");
		const map = raw as Partial<NoteMap>;
		if (map.version !== 1 || map.vault !== peer.name || !map.notes || typeof map.notes !== "object") throw new Error("Refresh the index in the registered vault to publish its note map.");
		return { root, map: map as NoteMap };
	}

	/** 0.6.1 doctor: whether each registered vault's note map can be read (read-only; names, never paths, in the result). */
	async peerMapStatus(): Promise<{ name: string; readable: boolean; detail?: string }[]> {
		const rows: { name: string; readable: boolean; detail?: string }[] = [];
		for (const peer of this.settings().peerVaults) {
			try { await this.loadPeerMap(peer); rows.push({ name: peer.name, readable: true }); }
			catch (error) { rows.push({ name: peer.name, readable: false, detail: error instanceof Error && !/^E[A-Z]+:/.test(error.message) ? error.message : "the vault folder or its note map cannot be read" }); }
		}
		return rows;
	}

	/**
	 * Read-only check of a peer vault's `<configDir>/community-plugins.json`, where `configDir` is this vault's configuration
	 * folder name (`Vault#configDir`; the peer's own setting is not readable without hardcoding a folder name). A peer using a
	 * different folder name, or an unreadable/oversized file, means "no Advanced URI": the row falls back to `obsidian://open`.
	 * Documented in the README. 0.5 R15
	 */
	private async peerListsAdvancedUri(root: string): Promise<boolean> {
		try {
			const candidate = await fs.realpath(path.join(root, this.app.vault.configDir, "community-plugins.json"));
			if (!candidate.startsWith(root + path.sep)) return false;
			const info = await fs.stat(candidate);
			if (!info.isFile() || info.size > 256 * 1024) return false;
			return listsAdvancedUri(JSON.parse(await fs.readFile(candidate, "utf8")));
		} catch { return false; }
	}
}
