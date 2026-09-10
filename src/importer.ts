import { App, FileSystemAdapter, parseYaml, TFile, TFolder } from "obsidian";
import type { BbtService } from "./bbt";
import type { CmdsZoteroSettings, ZoteroIndexEntry } from "./types";
import { hashText, renderLiterature, safeVaultPath } from "./note-writer";
import { checkVaultDestination, hashBytes, MAX_IMAGE_BYTES, readAnnotationImage } from "./import/images";

export interface ImportPreview {
	path: string;
	content: string;
	conflicts: string[];
	exists: boolean;
}
interface Snapshot {
	path: string;
	content: string;
	original: string | null;
	images: { source: string; path: string; hash: string }[];
	conflicts: string[];
}

export class ImportService {
	private snapshots = new WeakMap<ImportPreview, Snapshot>();
	private applying = false;
	constructor(private app: App, private bbt: BbtService, private settings: () => CmdsZoteroSettings) {}

	async preview(entry: ZoteroIndexEntry): Promise<ImportPreview> {
		if (!entry.citekey || /[\\/:*?"<>|]/.test(entry.citekey) || [...entry.citekey].some(c => c.charCodeAt(0) < 32) || entry.citekey.endsWith(".")) throw new Error("Unsafe citation key filename");
		const settings = this.settings();
		const defaultPath = safeVaultPath(`${settings.outputFolder}/@${entry.citekey}.md`);
		const identities = await this.findIdentityPaths(settings.outputFolder, entry.id);
		if (identities.length > 1) {
			const conflicts = [`Multiple notes have this Zotero identity; choose one before importing: ${identities.join(", ")}`];
			const preview: ImportPreview = { path: defaultPath, content: "", conflicts: [...conflicts], exists: true };
			this.snapshots.set(preview, { path: defaultPath, content: "", original: null, images: [], conflicts });
			return preview;
		}
		const path = identities[0] ?? defaultPath;
		await this.checkPath(path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) throw new Error("Literature note path is not a file");
		const original = existing instanceof TFile ? await this.app.vault.read(existing) : null;
		const bibliography = await this.bbt.bibliography(entry);
		const imageHashes = new Map<string, string>();
		for (const attachment of entry.attachments) for (const annotation of attachment.annotations) {
			if (annotation.imagePath && !imageHashes.has(annotation.imagePath)) imageHashes.set(annotation.imagePath, hashBytes(await readAnnotationImage(annotation.imagePath)));
		}
		const rendered = renderLiterature(entry, bibliography, settings, original, imageHashes);
		const images: Snapshot["images"] = [];
		for (const image of rendered.images) {
			await this.checkPath(image.path);
			const hash = imageHashes.get(image.source);
			if (!hash) throw new Error("Missing validated annotation image hash");
			const found = this.app.vault.getAbstractFileByPath(image.path);
			if (found && (!(found instanceof TFile) || found.stat.size > MAX_IMAGE_BYTES || hashBytes(new Uint8Array(await this.app.vault.readBinary(found))) !== hash)) rendered.conflicts.push(`Image destination contains different content: ${image.path}`);
			images.push({ ...image, hash });
		}
		const preview: ImportPreview = { path, content: rendered.content, conflicts: [...rendered.conflicts], exists: original !== null };
		this.snapshots.set(preview, { path, content: rendered.content, original, images, conflicts: [...rendered.conflicts] });
		return preview;
	}

	async apply(preview: ImportPreview): Promise<{ path: string; conflicts: string[] }> {
		const snapshot = this.snapshots.get(preview);
		if (!snapshot) throw new Error("Unknown or already applied import preview");
		const path = snapshot.path;
		if (snapshot.conflicts.length) return { path, conflicts: [...snapshot.conflicts] };
		if (this.applying) return { path, conflicts: ["Another import is being applied"] };
		this.applying = true;
		try {
			await this.checkPath(path);
			if (!(await this.matches(snapshot))) return { path, conflicts: ["Note changed after preview; preview again"] };
			const pending: { path: string; bytes: Uint8Array }[] = [];
			// Finish all source and destination checks before creating any files.
			for (const image of snapshot.images) {
				await this.checkPath(image.path);
				const bytes = await readAnnotationImage(image.source);
				if (hashBytes(bytes) !== image.hash) return { path, conflicts: ["Annotation image changed after preview"] };
				const existing = this.app.vault.getAbstractFileByPath(image.path);
				if (existing) {
					if (!(existing instanceof TFile) || existing.stat.size > MAX_IMAGE_BYTES || hashBytes(new Uint8Array(await this.app.vault.readBinary(existing))) !== image.hash) return { path, conflicts: [`Image conflict: ${image.path}`] };
				} else pending.push({ path: image.path, bytes });
			}
			for (const image of pending) {
				await this.ensureParent(image.path);
				await this.checkPath(image.path);
				await this.app.vault.createBinary(image.path, image.bytes.buffer as ArrayBuffer);
			}
			await this.ensureParent(path);
			await this.checkPath(path);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (snapshot.original === null) {
				if (file) return { path, conflicts: ["Note appeared after preview; refusing overwrite"] };
				await this.app.vault.create(path, snapshot.content);
			} else {
				if (!(file instanceof TFile)) return { path, conflicts: ["Note removed after preview"] };
				await this.app.vault.process(file, current => {
					if (hashText(current) !== hashText(snapshot.original ?? "")) throw new Error("Note changed after preview; no note content was written");
					return snapshot.content;
				});
			}
			this.snapshots.delete(preview);
			return { path, conflicts: [] };
		} finally { this.applying = false; }
	}

	private async findIdentityPaths(folder: string, identity: string): Promise<string[]> {
		const prefix = `${safeVaultPath(folder)}/`;
		const matches: string[] = [];
		// Read actual frontmatter rather than depending on an asynchronously updated metadata cache.
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(prefix)) continue;
			await this.checkPath(file.path);
			const content = await this.app.vault.read(file);
			const withoutBOM = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
			const yaml = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(withoutBOM)?.[1];
			if (yaml === undefined) continue;
			try {
				const data: unknown = parseYaml(yaml);
				if (data && typeof data === "object" && (data as Record<string, unknown>).zoteroID === identity) matches.push(file.path);
			} catch {
				// Invalid YAML in an unrelated user note is not ours to repair.
			}
		}
		return matches.sort();
	}

	private async matches(snapshot: Snapshot): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(snapshot.path);
		return snapshot.original === null ? file === null : file instanceof TFile && await this.app.vault.read(file) === snapshot.original;
	}
	private async checkPath(path: string): Promise<void> {
		safeVaultPath(path);
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("Safe local import requires a desktop filesystem vault");
		await checkVaultDestination(adapter.getBasePath(), path);
	}
	private async ensureParent(path: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			const folder = parts.slice(0, i).join("/");
			await this.checkPath(folder);
			const found = this.app.vault.getAbstractFileByPath(folder);
			if (!found) await this.app.vault.createFolder(folder);
			else if (!(found instanceof TFolder)) throw new Error("Import folder is occupied by a file");
		}
	}
}
