import { App, TFile, parseYaml } from "obsidian";
import type { NoteRecord, VaultReader } from "./agent/types";
import { findNote as findListedNote, notePathCandidates } from "./agent/note-lookup";
import { assertVaultBoundary, relativePath, vaultBoundaryScan } from "./vault-storage";
import { parseNoteText } from "./frontmatter-read";
import { SCAN_CONCURRENCY, scanInOrder } from "./vault-scan";

export const MAX_LISTED_NOTES = 20000;
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

type Boundary = (value: string) => Promise<void>;

/** Reads actual note text: a missing metadata-cache entry must not hide malformed YAML. */
export class ObsidianVaultReader implements VaultReader {
	private report = { skipped: [] as string[], truncated: false };
	/** `limit` is the note cap of one scan (MAX_LISTED_NOTES); tests lower it. */
	constructor(private app: App, private limit = MAX_LISTED_NOTES) {}
	vaultName(): string { return this.app.vault.getName(); }
	scanWarnings(): { skipped: string[]; truncated: boolean } { return { skipped: [...this.report.skipped], truncated: this.report.truncated }; }

	/** The Markdown files a scan may list: no path segment starts with a dot. Unsorted. */
	private listable(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter(file => !file.path.split("/").some(part => part.startsWith(".")));
	}

	async listNotes(): Promise<NoteRecord[]> {
		const notes: NoteRecord[] = [];
		this.report = { skipped: [], truncated: false };
		const files = this.listable().sort((a, b) => a.path.localeCompare(b.path));
		// PERF-07: one boundary scan (root realpath once, parent folders' lstat shared) and up to SCAN_CONCURRENCY reads in
		// flight; outcomes are visited in path order, so notes, skipped and truncated equal the sequential scan's.
		const boundary = vaultBoundaryScan(this.app);
		await scanInOrder(files, SCAN_CONCURRENCY, file => this.readParsed(file.path, boundary), (file, outcome) => {
			if (notes.length >= this.limit) { this.report.truncated = true; return false; }
			if (!outcome?.ok) { this.report.skipped.push(file.path); return true; }
			if (outcome.value.frontmatterParse === "error") this.report.skipped.push(file.path);
			notes.push(recordOf(file, outcome.value));
			return true;
		});
		return notes;
	}

	/**
	 * PERF-07: the answer of `findNote(await this.listNotes(), path)`, reading only the (at most two) candidate files. Past
	 * the note cap only a scan can tell whether a candidate would be listed, so the scan answers then (and only then
	 * updates the scan report).
	 */
	async findNote(path: string): Promise<NoteRecord | null> {
		const files = this.listable();
		if (files.length > this.limit) return findListedNote(await this.listNotes(), path);
		const wanted = new Set<string>(notePathCandidates(path));
		const boundary = vaultBoundaryScan(this.app);
		for (const file of files.filter(candidate => wanted.has(candidate.path)).sort((a, b) => a.path.localeCompare(b.path))) {
			try { return recordOf(file, await this.readParsed(file.path, boundary)); }
			catch { /* Unreadable: a scan skips it, so the next candidate decides. */ }
		}
		return null;
	}

	async readNote(path: string): Promise<string> {
		return this.read(path, value => assertVaultBoundary(this.app, value));
	}

	async exists(path: string): Promise<boolean> {
		const relative = relativePath(path);
		await assertVaultBoundary(this.app, relative);
		return this.app.vault.getAbstractFileByPath(relative) instanceof TFile;
	}

	private async readParsed(path: string, boundary: Boundary): Promise<ReturnType<typeof parseNoteText>> {
		return parseNoteText(await this.read(path, boundary), parseYaml);
	}

	private async read(path: string, boundary: Boundary): Promise<string> {
		const relative = relativePath(path);
		await boundary(relative);
		const file = this.app.vault.getAbstractFileByPath(relative);
		if (!(file instanceof TFile)) throw new Error(`Note not found: ${relative}`);
		if (file.stat.size > MAX_NOTE_BYTES) throw new Error(`Note exceeds ${MAX_NOTE_BYTES / 1024 / 1024} MiB: ${relative}`);
		const text = await this.app.vault.read(file);
		if (Buffer.byteLength(text) > MAX_NOTE_BYTES) throw new Error("Note grew beyond the size limit.");
		return text;
	}
}

function recordOf(file: TFile, parsed: ReturnType<typeof parseNoteText>): NoteRecord {
	return { path: file.path, basename: file.basename, frontmatter: parsed.frontmatter, frontmatterParse: parsed.frontmatterParse };
}
