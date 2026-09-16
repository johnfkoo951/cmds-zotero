import { App, TFile } from "obsidian";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { noteDeepLink } from "./uris";
import { buildAliasIndex, noteIdentity } from "./note-aliases";
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

export class VaultLinks {
	private publication: Promise<void> = Promise.resolve();
	/** Fingerprint of the map last seen on disk or written by this instance; null until the first publication seeds it. */
	private lastPublished: string | null = null;
	constructor(private app: App, private settings: () => CmdsZoteroSettings, private canWrite: () => boolean = () => true) {}

	/**
	 * 0.5 R13/F06: every Markdown note this plugin recognizes as a literature note, grouped by index entry id, in one pass
	 * over the vault (one alias index, one metadata-cache lookup per file). Paths within an entry are sorted.
	 */
	localFilesByEntry(index: ZoteroIndex): Map<string, TFile[]> {
		const lookup = buildAliasIndex(index.entries);
		const byEntry = new Map<string, TFile[]>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const id = noteIdentity(file.basename, fm, lookup);
			if (!id) continue;
			const files = byEntry.get(id);
			if (files) files.push(file); else byEntry.set(id, [file]);
		}
		for (const files of byEntry.values()) files.sort((a, b) => a.path.localeCompare(b.path));
		return byEntry;
	}

	localFiles(entry: ZoteroIndexEntry, index: ZoteroIndex): TFile[] {
		return this.localFilesByEntry(index).get(entry.id) ?? [];
	}

	publish(index: ZoteroIndex): Promise<void> {
		this.publication = this.publication.catch(() => undefined).then(() => this.publishNow(index));
		return this.publication;
	}

	/**
	 * 0.5 R13/F07: deterministic map (sorted entry ids, sorted paths) compared against the last published fingerprint,
	 * seeded from disk on the first publication of a session, so an unchanged map is never rewritten.
	 */
	private async publishNow(index: ZoteroIndex): Promise<void> {
		if (!this.canWrite()) return;
		const notes: Record<string, string[]> = {};
		const byEntry = this.localFilesByEntry(index);
		for (const id of [...byEntry.keys()].sort()) notes[id] = byEntry.get(id)!.map(file => file.path).sort();
		const map: NoteMap = { version: 1, vault: this.app.vault.getName(), generatedAt: new Date().toISOString(), indexGeneratedAt: index.generatedAt, notes };
		await assertVaultBoundary(this.app, MAP_PATH);
		if (!this.canWrite()) return;
		// Published from every UI read: rewriting an unchanged map would dirty a git-tracked vault on each start.
		const fingerprint = mapFingerprint(map);
		if (this.lastPublished === null) this.lastPublished = await this.fingerprintOnDisk();
		if (this.lastPublished === fingerprint && await this.app.vault.adapter.exists(MAP_PATH)) return;
		await ensureCmdsIgnore(this.app);
		await ensureDirectory(this.app, MAP_PATH);
		if (!this.canWrite()) return;
		await this.app.vault.adapter.write(MAP_PATH, JSON.stringify(map, null, 2));
		this.lastPublished = fingerprint;
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

	async find(entry: ZoteroIndexEntry, index: ZoteroIndex): Promise<VaultLinkReport> {
		const links = this.localFiles(entry, index).map(file => ({
			vault: this.app.vault.getName(), path: file.path,
			uri: `obsidian://open?${new URLSearchParams({ vault: this.app.vault.getName(), file: file.path }).toString()}`,
		}));
		const warnings: string[] = [];
		for (const peer of this.settings().peerVaults) {
			try {
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
				const paths: unknown = map.notes[entry.id];
				if (!Array.isArray(paths)) continue;
				for (const value of paths) {
					if (typeof value !== "string") continue;
					const relative = relativePath(value);
					if (!relative.endsWith(".md")) continue;
					const realFile = await fs.realpath(path.join(root, relative));
					if (!realFile.startsWith(root + path.sep)) throw new Error("A peer note points outside its vault.");
					links.push({ vault: peer.name, path: relative, uri: noteDeepLink(peer.name, entry) });
				}
			} catch (error) {
				warnings.push(`${peer.name}: ${error instanceof Error ? error.message : "Could not read the peer note map."}`);
			}
		}
		return { links, warnings };
	}
}
