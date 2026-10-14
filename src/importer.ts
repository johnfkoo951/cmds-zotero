import { App, FileSystemAdapter, parseYaml, TFile, TFolder } from "obsidian";
import type { BbtService } from "./bbt";
import type { Annotation, CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { annotationImagePath, hashText, renderLiterature, safeVaultPath, type RenderedNote, type SectionInfo } from "./note-writer";
import { relatedCitekeys } from "./related";
import { checkVaultDestination, hashBytes, MAX_IMAGE_BYTES, readAnnotationImage } from "./import/images";
import { assertVaultBoundary, BACKUP_DIR, ensureCmdsIgnore, ensureDirectory, vaultBoundaryScan } from "./vault-storage";
import { IdentityMap } from "./batch/identity-map";

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
	/** 0.6 OPT-02: the identity map the preview consulted; apply records the written note in it. */
	identities: IdentityMap;
}
/** 0.5 R5: note backups written before a reset: `.cmds-zotero/backups/notes/<basename>-<epoch ms>.md`. */
export const NOTE_BACKUP_DIR = `${BACKUP_DIR}/notes`;

// 0.5 R12: bibliography text is injected (the plugin serves memory → sidecar → BBT); an empty string means "unavailable now".
export type BibliographyProvider = (entry: ZoteroIndexEntry, options?: Pick<PreviewOptions, "offline">) => Promise<string>;
export interface PreviewOptions {
	/** The caller already knows BBT is down for this batch; the provider must not wait on a BBT request. */
	offline?: boolean;
	/**
	 * 0.6 OPT-02: the batch's identity map for the output folder (`identityMap()`), so a batch reads the folder once instead
	 * of once per preview. Without it, or when the output folder changed since it was built, the preview builds its own.
	 */
	identities?: IdentityMap;
}

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
		const { identities: given, ...providerOptions } = options;
		const identities = given?.folder === settings.outputFolder ? given : await this.identityMap();
		const paths = await identities.pathsFor(entry.id);
		if (paths.length > 1) {
			const conflicts = [`Multiple notes have this Zotero identity; choose one before importing: ${paths.join(", ")}`];
			const preview: ImportPreview = { path: defaultPath, content: "", conflicts: [...conflicts], softConflicts: [], detached: [], sections: [], exists: true };
			this.snapshots.set(preview, { path: defaultPath, content: "", original: null, images: [], conflicts, rendered: null, render: null, identities });
			return preview;
		}
		const path = paths[0] ?? defaultPath;
		await this.checkPath(path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) throw new Error("Literature note path is not a file");
		const original = existing instanceof TFile ? await this.app.vault.read(existing) : null;
		const bibliography = await this.bibliography(entry, providerOptions); // 0.5 R12
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
		this.snapshots.set(preview, { path, content: rendered.content, original, images, conflicts: [...rendered.conflicts], rendered, render: { entry, bibliography, settings, imageHashes, related }, identities });
		return preview;
	}

	/**
	 * 0.6 OPT-02: the output folder's `zoteroID` → note paths, read from the notes themselves (never the metadata cache):
	 * every read passes the vault-boundary walk (the vault root resolved once per round of reads), 8 reads in flight. A
	 * batch builds it once, passes it to every `preview`, and `apply` records each written note in it.
	 */
	identityMap(): Promise<IdentityMap> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return Promise.reject(new Error("Safe local import requires a desktop filesystem vault"));
		return IdentityMap.build(this.settings().outputFolder, {
			list: () => this.app.vault.getMarkdownFiles().map(file => file.path),
			reader: () => {
				const boundary = vaultBoundaryScan(this.app);
				return async path => {
					safeVaultPath(path);
					await boundary(path);
					const file = this.app.vault.getAbstractFileByPath(path);
					return file instanceof TFile ? this.app.vault.read(file) : null;
				};
			},
			parseYaml: yaml => parseYaml(yaml) as unknown,
		});
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
			snapshot.identities.noteWritten(path, content); // 0.6 OPT-02: later previews of the batch see this note
			this.snapshots.delete(preview);
			return { path, conflicts: [], changed, preserved, detached, reset };
		} finally { this.applying = false; }
	}

	/**
	 * 0.6.1 annotation-drag-insert: copies one annotation's image to the path the import uses (validated source, content-hash
	 * name, vault-boundary and symlink checks) and returns that vault path. Creates a new file only: a file already there
	 * with the same content is reused, any other content is refused.
	 */
	async copyAnnotationImage(entry: ZoteroIndexEntry, annotation: Annotation): Promise<string> {
		if (!annotation.imagePath) throw new Error("This annotation has no image.");
		const bytes = await readAnnotationImage(annotation.imagePath);
		const hash = hashBytes(bytes);
		const path = annotationImagePath(this.settings().imageFolder, entry, annotation.attachmentKey, annotation, hash);
		await this.checkPath(path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) {
			if (!(existing instanceof TFile) || existing.stat.size > MAX_IMAGE_BYTES || hashBytes(new Uint8Array(await this.app.vault.readBinary(existing))) !== hash) throw new Error(`Image destination contains different content: ${path}`);
			return path;
		}
		await this.ensureParent(path);
		await this.checkPath(path);
		await this.app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		return path;
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
