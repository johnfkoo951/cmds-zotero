import { App, TFile, parseYaml } from "obsidian";
import type { NoteRecord, VaultReader } from "./agent/types";
import { assertVaultBoundary, relativePath } from "./vault-storage";
import { parseNoteText } from "./frontmatter-read";

export const MAX_LISTED_NOTES = 20000;
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/** Reads actual note text: a missing metadata-cache entry must not hide malformed YAML. */
export class ObsidianVaultReader implements VaultReader {
	private report = { skipped: [] as string[], truncated: false };
	constructor(private app: App) {}
	vaultName(): string { return this.app.vault.getName(); }
	scanWarnings(): { skipped: string[]; truncated: boolean } { return { skipped: [...this.report.skipped], truncated: this.report.truncated }; }

	async listNotes(): Promise<NoteRecord[]> {
		const notes: NoteRecord[] = [];
		this.report = { skipped: [], truncated: false };
		const files = this.app.vault.getMarkdownFiles().filter(file => !file.path.split("/").some(part => part.startsWith("."))).sort((a, b) => a.path.localeCompare(b.path));
		for (const file of files) {
			if (notes.length >= MAX_LISTED_NOTES) { this.report.truncated = true; break; }
			try {
				const parsed = parseNoteText(await this.readNote(file.path), parseYaml);
				if (parsed.frontmatterParse === "error") this.report.skipped.push(file.path);
				notes.push({ path: file.path, basename: file.basename, frontmatter: parsed.frontmatter, frontmatterParse: parsed.frontmatterParse });
			} catch { this.report.skipped.push(file.path); }
		}
		return notes;
	}

	async readNote(path: string): Promise<string> {
		const relative = relativePath(path);
		await assertVaultBoundary(this.app, relative);
		const file = this.app.vault.getAbstractFileByPath(relative);
		if (!(file instanceof TFile)) throw new Error(`Note not found: ${relative}`);
		if (file.stat.size > MAX_NOTE_BYTES) throw new Error(`Note exceeds ${MAX_NOTE_BYTES / 1024 / 1024} MiB: ${relative}`);
		const text = await this.app.vault.read(file);
		if (Buffer.byteLength(text) > MAX_NOTE_BYTES) throw new Error("Note grew beyond the size limit.");
		return text;
	}

	async exists(path: string): Promise<boolean> {
		const relative = relativePath(path);
		await assertVaultBoundary(this.app, relative);
		return this.app.vault.getAbstractFileByPath(relative) instanceof TFile;
	}
}
