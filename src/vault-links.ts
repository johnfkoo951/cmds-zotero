import { App, TFile } from "obsidian";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { compareNoteRows, listsAdvancedUri, obsidianOpenURI, peerNoteURI } from "./uris";
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

export class VaultLinks {
	private publication: Promise<void> = Promise.resolve();
	constructor(private app: App, private settings: () => CmdsZoteroSettings, private canWrite: () => boolean = () => true) {}

	localFiles(entry: ZoteroIndexEntry, index: ZoteroIndex): TFile[] {
		const lookup = buildAliasIndex(index.entries);
		return this.app.vault.getMarkdownFiles().filter(file => {
			const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
			return noteIdentity(file.basename, fm, lookup) === entry.id;
		});
	}

	publish(index: ZoteroIndex): Promise<void> {
		this.publication = this.publication.catch(() => undefined).then(() => this.publishNow(index));
		return this.publication;
	}

	private async publishNow(index: ZoteroIndex): Promise<void> {
		if (!this.canWrite()) return;
		const notes: Record<string, string[]> = {};
		const lookup = buildAliasIndex(index.entries);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const id = noteIdentity(file.basename, fm, lookup);
			if (id) (notes[id] ??= []).push(file.path);
		}
		for (const files of Object.values(notes)) files.sort();
		const map: NoteMap = { version: 1, vault: this.app.vault.getName(), generatedAt: new Date().toISOString(), indexGeneratedAt: index.generatedAt, notes };
		await assertVaultBoundary(this.app, MAP_PATH);
		if (!this.canWrite()) return;
		// Published from every UI read: rewriting an unchanged map would dirty a git-tracked vault on each start.
		if (await this.unchanged(map)) return;
		await ensureCmdsIgnore(this.app);
		await ensureDirectory(this.app, MAP_PATH);
		if (!this.canWrite()) return;
		await this.app.vault.adapter.write(MAP_PATH, JSON.stringify(map, null, 2));
	}

	/** True when the map on disk already carries the same vault, index generation and notes (its own `generatedAt` is ignored). */
	private async unchanged(map: NoteMap): Promise<boolean> {
		try {
			if (!(await this.app.vault.adapter.exists(MAP_PATH))) return false;
			const raw: unknown = JSON.parse(await this.app.vault.adapter.read(MAP_PATH));
			if (!raw || typeof raw !== "object") return false;
			const existing = raw as Partial<NoteMap>;
			return existing.version === map.version && existing.vault === map.vault && existing.indexGeneratedAt === map.indexGeneratedAt && JSON.stringify(existing.notes) === JSON.stringify(map.notes);
		} catch { return false; }
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
				const advancedUri = await this.peerListsAdvancedUri(root);
				for (const value of paths) {
					if (typeof value !== "string") continue;
					const relative = relativePath(value);
					if (!relative.endsWith(".md")) continue;
					const realFile = await fs.realpath(path.join(root, relative));
					if (!realFile.startsWith(root + path.sep)) throw new Error("A peer note points outside its vault.");
					rows.push({ vault: peer.name, path: relative, uri: peerNoteURI(peer.name, relative, { advancedUri }) });
				}
			} catch (error) {
				warnings.push(`${peer.name}: ${error instanceof Error ? error.message : "Could not read the peer note map."}`);
			} finally {
				links.push(...rows.sort(order));
			}
		}
		return { links, warnings };
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
