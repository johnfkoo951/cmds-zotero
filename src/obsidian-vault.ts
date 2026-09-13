import { App, TFile } from "obsidian";
import type { NoteRecord, VaultReader } from "./agent/types";
import { assertVaultBoundary, relativePath } from "./vault-storage";

export const MAX_LISTED_NOTES = 20000;
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/** Read-only vault access for the live host, backed by the metadata cache for frontmatter and the vault API for bodies. */
export class ObsidianVaultReader implements VaultReader {
	constructor(private app: App) {}

	vaultName(): string { return this.app.vault.getName(); }

	listNotes(): Promise<NoteRecord[]> {
		const notes: NoteRecord[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (notes.length >= MAX_LISTED_NOTES) break;
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : null;
			if (frontmatter) delete (frontmatter as Record<string, unknown>).position;
			notes.push({ path: file.path, basename: file.basename, frontmatter, frontmatterParse: "ok" });
		}
		return Promise.resolve(notes);
	}

	async readNote(path: string): Promise<string> {
		const relative = relativePath(path);
		await assertVaultBoundary(this.app, relative);
		const file = this.app.vault.getAbstractFileByPath(relative);
		if (!(file instanceof TFile)) throw new Error(`Note not found: ${relative}`);
		if (file.stat.size > MAX_NOTE_BYTES) throw new Error(`Note exceeds ${MAX_NOTE_BYTES / 1024 / 1024} MiB: ${relative}`);
		return this.app.vault.cachedRead(file);
	}

	async exists(path: string): Promise<boolean> {
		const relative = relativePath(path);
		await assertVaultBoundary(this.app, relative);
		return this.app.vault.getAbstractFileByPath(relative) instanceof TFile;
	}
}
