import { App, FileSystemAdapter, parseYaml, TFile, TFolder } from "obsidian";
import type { BbtService } from "./bbt";
import type { CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { hashText, renderLiterature, safeVaultPath, type RenderedNote, type SectionInfo } from "./note-writer";
import { relatedCitekeys } from "./related";
import { checkVaultDestination, hashBytes, MAX_IMAGE_BYTES, readAnnotationImage } from "./import/images";
import { assertVaultBoundary, BACKUP_DIR, ensureCmdsIgnore, ensureDirectory } from "./vault-storage";

export interface ImportPreview {
	path: string;
	content: string;
	/** Hard conflicts: apply is refused. */
	conflicts: string[];
	/** 0.5 R5: soft conflicts (edited sections kept verbatim); apply is allowed. */
	softConflicts: string[];
	/** 0.5 R5: IDs of detached (user-owned) blocks. */
	detached: string[];
	/** 0.5 R5: per-section states for the preview UI. */
	sections: SectionInfo[];
	exists: boolean;
}
// 0.5 R5: per-apply choices; ids are applied before writing.
export interface ApplyOptions { detach?: string[]; reset?: string[] }
export interface ApplyResult { path: string; conflicts: string[]; changed: boolean; preserved: string[]; detached: string[]; reset: string[] }
interface Snapshot {
	path: string;
	content: string;
	original: string | null;
	images: { source: string; path: string; hash: string }[];
	conflicts: string[];
	rendered: RenderedNote | null;
	/** Inputs needed to re-render with detach/reset choices at apply time. */
	render: { entry: ZoteroIndexEntry; bibliography: string; settings: CmdsZoteroSettings; imageHashes: Map<string, string>; related: string[] } | null;
}
/** 0.5 R5: note backups written before a reset: `.cmds-zotero/backups/notes/<basename>-<epoch ms>.md`. */
export const NOTE_BACKUP_DIR = `${BACKUP_DIR}/notes`;

// 0.5 R12: bibliography text is injected (the plugin serves memory → sidecar → BBT); an empty string means "unavailable now".
export type BibliographyProvider = (entry: ZoteroIndexEntry, options?: PreviewOptions) => Promise<string>;
/** `offline`: the caller already knows BBT is down for this batch; the provider must not wait on a BBT request. */
export interface PreviewOptions { offline?: boolean }

export class ImportService {
	private snapshots = new WeakMap<ImportPreview, Snapshot>();
	private applying = false;
	private readonly bibliography: BibliographyProvider;
	constructor(private app: App, private bbt: BbtService, private settings: () => CmdsZoteroSettings, bibliography?: BibliographyProvider, private noteMarkdown?: (html: string) => string) {
		this.bibliography = bibliography ?? (entry => this.bbt.bibliography(entry));
	}

	async preview(entry: ZoteroIndexEntry, index?: ZoteroIndex, options: PreviewOptions = {}): Promise<ImportPreview> {
		if (!entry.citekey || /[\\/:*?"<>|]/.test(entry.citekey) || [...entry.citekey].some(c => c.charCodeAt(0) < 32) || entry.citekey.endsWith(".")) throw new Error("Unsafe citation key filename");
		const settings = this.settings();
		const defaultPath = safeVaultPath(`${settings.outputFolder}/@${entry.citekey}.md`);
		const identities = await this.findIdentityPaths(settings.outputFolder, entry.id);
		if (identities.length > 1) {
			const conflicts = [`Multiple notes have this Zotero identity; choose one before importing: ${identities.join(", ")}`];
			const preview: ImportPreview = { path: defaultPath, content: "", conflicts: [...conflicts], softConflicts: [], detached: [], sections: [], exists: true };
			this.snapshots.set(preview, { path: defaultPath, content: "", original: null, images: [], conflicts, rendered: null, render: null });
			return preview;
		}
		const path = identities[0] ?? defaultPath;
		await this.checkPath(path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) throw new Error("Literature note path is not a file");
		const original = existing instanceof TFile ? await this.app.vault.read(existing) : null;
		const bibliography = await this.bibliography(entry, options); // 0.5 R12
		const imageHashes = new Map<string, string>();
		for (const attachment of entry.attachments) for (const annotation of attachment.annotations) {
			if (annotation.imagePath && !imageHashes.has(annotation.imagePath)) imageHashes.set(annotation.imagePath, hashBytes(await readAnnotationImage(annotation.imagePath)));
		}
		const related = index ? relatedCitekeys(entry, index) : [];
		const rendered = renderLiterature(entry, bibliography, settings, original, imageHashes, { related, noteMarkdown: this.noteMarkdown });
		const images: Snapshot["images"] = [];
		for (const image of rendered.images) {
			await this.checkPath(image.path);
			const hash = imageHashes.get(image.source);
			if (!hash) throw new Error("Missing validated annotation image hash");
			const found = this.app.vault.getAbstractFileByPath(image.path);
			if (found && (!(found instanceof TFile) || found.stat.size > MAX_IMAGE_BYTES || hashBytes(new Uint8Array(await this.app.vault.readBinary(found))) !== hash)) rendered.conflicts.push(`Image destination contains different content: ${image.path}`);
			images.push({ ...image, hash });
		}
		const preview: ImportPreview = { path, content: rendered.content, conflicts: [...rendered.conflicts], softConflicts: [...rendered.softConflicts], detached: [...rendered.detached], sections: rendered.sections.map(section => ({ ...section })), exists: original !== null };
		this.snapshots.set(preview, { path, content: rendered.content, original, images, conflicts: [...rendered.conflicts], rendered, render: { entry, bibliography, settings, imageHashes, related } });
		return preview;
	}

	/**
	 * Writes the previewed note. Soft conflicts (edited sections) do not block: those blocks stay verbatim and are
	 * reported as `preserved`. `options.detach` freezes blocks as user-owned; `options.reset` replaces edited or
	 * detached blocks with the fresh render after backing up the previous note text (0.5 R5).
	 */
	async apply(preview: ImportPreview, options: ApplyOptions = {}): Promise<ApplyResult> {
		const snapshot = this.snapshots.get(preview);
		if (!snapshot) throw new Error("Unknown or already applied import preview");
		const path = snapshot.path;
		const refuse = (message: string): ApplyResult => ({ path, conflicts: [message], changed: false, preserved: [], detached: [], reset: [] });
		if (snapshot.conflicts.length) return { ...refuse(""), conflicts: [...snapshot.conflicts] };
		let rendered = snapshot.rendered;
		let content = snapshot.content;
		const choices = { detach: [...new Set(options.detach ?? [])], reset: [...new Set(options.reset ?? [])] };
		if ((choices.detach.length || choices.reset.length) && snapshot.render) {
			const { entry, bibliography, settings, imageHashes, related } = snapshot.render;
			rendered = renderLiterature(entry, bibliography, settings, snapshot.original, imageHashes, { related, noteMarkdown: this.noteMarkdown, ...choices });
			if (rendered.conflicts.length) return { ...refuse(""), conflicts: [...rendered.conflicts] };
			content = rendered.content;
		}
		const preserved = rendered ? rendered.sections.filter(section => section.state === "edited").map(section => section.id) : [];
		const detached = rendered ? [...rendered.detached] : [];
		const reset = rendered ? [...rendered.reset] : [];
		const changed = snapshot.original !== content;
		if (this.applying) return refuse("Another import is being applied");
		this.applying = true;
		try {
			await this.checkPath(path);
			if (!(await this.matches(snapshot))) return refuse("Note changed after preview; preview again");
			const pending: { path: string; bytes: Uint8Array }[] = [];
			// Finish all source and destination checks before creating any files.
			for (const image of snapshot.images) {
				await this.checkPath(image.path);
				const bytes = await readAnnotationImage(image.source);
				if (hashBytes(bytes) !== image.hash) return refuse("Annotation image changed after preview");
				const existing = this.app.vault.getAbstractFileByPath(image.path);
				if (existing) {
					if (!(existing instanceof TFile) || existing.stat.size > MAX_IMAGE_BYTES || hashBytes(new Uint8Array(await this.app.vault.readBinary(existing))) !== image.hash) return refuse(`Image conflict: ${image.path}`);
				} else pending.push({ path: image.path, bytes });
			}
			for (const image of pending) {
				await this.ensureParent(image.path);
				await this.checkPath(image.path);
				await this.app.vault.createBinary(image.path, image.bytes.buffer);
			}
			await this.ensureParent(path);
			await this.checkPath(path);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (snapshot.original === null) {
				if (file) return refuse("Note appeared after preview; refusing overwrite");
				await this.app.vault.create(path, content);
			} else {
				if (!(file instanceof TFile)) return refuse("Note removed after preview");
				// A reset discards the user's edited text: keep a copy in the private (ignored) backup folder first.
				if (reset.length && changed) await this.backupNote(path, snapshot.original);
				await this.app.vault.process(file, current => {
					if (hashText(current) !== hashText(snapshot.original ?? "")) throw new Error("Note changed after preview; no note content was written");
					return content;
				});
			}
			this.snapshots.delete(preview);
			return { path, conflicts: [], changed, preserved, detached, reset };
		} finally { this.applying = false; }
	}

	// 0.5 R5
	private async backupNote(path: string, text: string): Promise<string> {
		await ensureCmdsIgnore(this.app);
		const basename = (path.split("/").pop() ?? "note").replace(/\.md$/i, "");
		const backup = `${NOTE_BACKUP_DIR}/${basename}-${Date.now()}.md`;
		await assertVaultBoundary(this.app, backup);
		await ensureDirectory(this.app, backup);
		await this.app.vault.adapter.write(backup, text);
		return backup;
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
