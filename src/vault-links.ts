import { App, TFile } from "obsidian";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { noteDeepLink } from "./uris";
import { buildAliasIndex, noteIdentity } from "./note-aliases";
import { assertVaultBoundary, ensureDirectory, relativePath } from "./vault-storage";

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
		await ensureDirectory(this.app, MAP_PATH);
		if (!this.canWrite()) return;
		await this.app.vault.adapter.write(MAP_PATH, JSON.stringify(map, null, 2));
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
