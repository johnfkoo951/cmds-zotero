import { App, FileSystemAdapter, parseYaml, TFile, TFolder } from "obsidian";
import type { BbtService } from "./bbt";
import type { Annotation, CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { annotationImagePath, hashText, literatureSections, ownerMarker, renderLiterature, safeVaultPath, type RenderedNote, type SectionGroup, type SectionInfo } from "./note-writer";
import { relatedCitekeys } from "./related";
import { checkVaultDestination, hashBytes, MAX_IMAGE_BYTES, readAnnotationImage } from "./import/images";
import { assertVaultBoundary, BACKUP_DIR, ensureCmdsIgnore, ensureDirectory, vaultBoundaryScan } from "./vault-storage";
import { IdentityMap } from "./batch/identity-map";
import { parseNoteText } from "./frontmatter-read";
import { newNotePath } from "./note-path";
import { repairManagedMarkers } from "./note-repair";
import { adoptedNoteText, adoptRefusal, hasBetterNotesSync } from "./note-adopt";
import { frontmatterAndBody, verifyFrontmatterEdit } from "./note-frontmatter";

/** 0.6.3: what a preview writes: an import or update, a rebuild of an owned note, or the adoption of another note. */
export type PreviewMode = "import" | "rebuild" | "adopt";
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
	/** 0.6.3: absent means `import`. */
	mode?: PreviewMode;
	/** 0.6.3 better-notes-guard and others: shown above the sections; apply stays possible. */
	warnings?: string[];
	/** 0.6.3 rebuild: the marker repairs the rebuild makes, with line numbers. */
	repairs?: string[];
	/** 0.6.3 selective-update-scope: the groups this preview refreshes (absent: all). */
	scope?: SectionGroup[];
	/** 0.6.3: the previous note text is copied to the private backup folder before the write (rebuild, adopt). */
	backup?: boolean;
	/** 0.6.3: recovery mode when an import is blocked by an unowned note (`adopt`) or damaged markers (`rebuild`). */
	recovery?: "adopt" | "rebuild";
}
// 0.5 R5: per-apply choices; ids are applied before writing.
export interface ApplyOptions { detach?: string[]; reset?: string[] }
export interface ApplyResult { path: string; conflicts: string[]; changed: boolean; preserved: string[]; detached: string[]; reset: string[]; /** 0.6.3: the backup copy written before this apply. */ backup?: string; /** 0.6.3: the post-write check found other text in the note. */ unverified?: string }
interface RenderInputs { entry: ZoteroIndexEntry; bibliography: string; settings: CmdsZoteroSettings; imageHashes: Map<string, string>; related: string[]; previous: string | null; scope?: SectionGroup[] }
interface Snapshot {
	path: string;
	content: string;
	original: string | null;
	images: { source: string; path: string; hash: string }[];
	conflicts: string[];
	rendered: RenderedNote | null;
	/** Inputs needed to re-render with detach/reset choices at apply time (`previous`: the repaired text of a rebuild). */
	render: RenderInputs | null;
	/** 0.6 OPT-02: the identity map the preview consulted; apply records the written note in it. */
	identities: IdentityMap;
	/** 0.6.3: back the note up before writing (rebuild, adopt). */
	backup: boolean;
	/** 0.6.3: the preview the snapshot belongs to (for `revise`). */
	preview: Omit<ImportPreview, "content" | "conflicts" | "softConflicts" | "detached" | "sections">;
}
/** Better Notes would overwrite an update of a note it syncs (0.6.3 better-notes-guard). */
export const BETTER_NOTES_WARNING = "This note carries Zotero Better Notes sync frontmatter ($libraryID, $itemKey). Better Notes may overwrite what CMDS Zotero writes; keep one of the two plugins writing this note.";
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
	/** 0.6.3 selective-update-scope: the section groups an update refreshes (absent: all). */
	scope?: SectionGroup[];
	/** 0.6.3 rebuild-or-repair-note: repair damaged, duplicate and missing markers of the owned note first; a backup is kept. */
	rebuild?: boolean;
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
		// 0.6.3 filename-folder-pattern: a new note's path; the defaults give the 0.6.1 `<outputFolder>/@<citekey>.md`.
		const defaultPath = newNotePath(entry, settings);
		const { identities: given, scope, rebuild, ...providerOptions } = options;
		const identities = given?.folder === settings.outputFolder ? given : await this.identityMap();
		const paths = await identities.pathsFor(entry.id);
		if (paths.length > 1) {
			const conflicts = [`Multiple notes have this Zotero identity; choose one before importing: ${paths.join(", ")}`];
			const preview: ImportPreview = { path: defaultPath, content: "", conflicts: [...conflicts], softConflicts: [], detached: [], sections: [], exists: true };
			this.snapshots.set(preview, { path: defaultPath, content: "", original: null, images: [], conflicts, rendered: null, render: null, identities, backup: false, preview: { path: defaultPath, exists: true } });
			return preview;
		}
		const path = paths[0] ?? defaultPath;
		await this.checkPath(path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) throw new Error("Literature note path is not a file");
		const original = existing instanceof TFile ? await this.app.vault.read(existing) : null;
		const warnings = this.betterNotesWarnings(original);
		// 0.6.3 rebuild-or-repair-note: an owned note's markers are repaired first; the render then works on the repaired text.
		let previous = original;
		let repairs: string[] | undefined;
		if (rebuild) {
			if (original === null) throw new Error("There is no literature note to rebuild yet. Import it first.");
			if (!original.includes(ownerMarker(entry.id))) throw new Error("This note was not created by CMDS Zotero for this item. Adopt it instead of rebuilding it.");
			const repaired = repairManagedMarkers(original, ownerMarker(entry.id));
			previous = repaired.text;
			repairs = repaired.repairs;
		}
		const bibliography = await this.bibliography(entry, providerOptions); // 0.5 R12
		const imageHashes = await this.imageHashes(entry);
		const related = index ? relatedCitekeys(entry, index) : [];
		const inputs: RenderInputs = { entry, bibliography, settings, imageHashes, related, previous, ...(scope && original !== null ? { scope } : {}) };
		const meta: Snapshot["preview"] = { path, exists: original !== null, ...(rebuild ? { mode: "rebuild" as const, repairs, backup: true } : {}), ...(warnings.length ? { warnings } : {}), ...(inputs.scope ? { scope: inputs.scope } : {}) };
		return this.snapshotPreview(meta, original, inputs, identities, !!rebuild);
	}

	/**
	 * 0.6.3 selective-update-scope: the same preview rendered again with another scope (no new Zotero read; the note is
	 * the text the first preview read). The old preview can no longer be applied.
	 */
	async revise(preview: ImportPreview, scope: SectionGroup[] | undefined): Promise<ImportPreview> {
		const snapshot = this.snapshots.get(preview);
		if (!snapshot?.render || snapshot.original === null) throw new Error("This preview cannot be limited; preview again.");
		this.snapshots.delete(preview);
		const { scope: _old, ...inputs } = snapshot.render;
		const { scope: _previous, ...meta } = snapshot.preview;
		return this.snapshotPreview({ ...meta, ...(scope ? { scope } : {}) }, snapshot.original, { ...inputs, ...(scope ? { scope } : {}) }, snapshot.identities, snapshot.backup);
	}

	/** Renders `inputs`, checks the image destinations and records the snapshot apply will use. */
	private async snapshotPreview(meta: Snapshot["preview"], original: string | null, inputs: RenderInputs, identities: IdentityMap, backup: boolean): Promise<ImportPreview> {
		const { entry, bibliography, settings, imageHashes, related, previous, scope } = inputs;
		const rendered = renderLiterature(entry, bibliography, settings, previous, imageHashes, { related, noteMarkdown: this.noteMarkdown, ...(scope ? { scope } : {}) });
		const images = await this.checkImages(rendered.images, imageHashes, rendered.conflicts);
		let recovery: ImportPreview["recovery"];
		if (!meta.mode && original !== null) {
			if (!original.includes(ownerMarker(entry.id))) {
				const parsed = parseNoteText(original, yaml => parseYaml(yaml) as unknown);
				const basename = (meta.path.split("/").pop() ?? meta.path).replace(/\.md$/i, "");
				if (parsed.frontmatterParse !== "error" && adoptRefusal({ path: meta.path, basename, frontmatter: parsed.frontmatter }, original) === null) recovery = "adopt";
			} else if (rendered.conflicts.some(conflict => /^(?:Duplicate|Malformed|Missing) managed /.test(conflict))) {
				recovery = "rebuild";
			}
		}
		const previewMeta: Snapshot["preview"] = { ...meta, ...(recovery ? { recovery } : {}) };
		const preview: ImportPreview = { ...previewMeta, content: rendered.content, conflicts: [...rendered.conflicts], softConflicts: [...rendered.softConflicts], detached: [...rendered.detached], sections: rendered.sections.map(section => ({ ...section })) };
		this.snapshots.set(preview, { path: meta.path, content: rendered.content, original, images, conflicts: [...rendered.conflicts], rendered, render: inputs, identities, backup, preview: previewMeta });
		return preview;
	}

	/**
	 * 0.6.3 adopt-existing-notes: a preview that makes the note at `path` (made by another plugin or by hand) this item's
	 * literature note: missing identity keys are added to its frontmatter line by line (L1), and the owner marker and the
	 * managed sections are appended below its text (L2). Nothing of the note's text changes; a backup is kept. Refused for
	 * notes that already belong to CMDS Zotero, Better Notes, Bookends, paper hubs and Raw Sources, for a key that names
	 * another item, and when another note already is this item's literature note.
	 */
	async adoptPreview(entry: ZoteroIndexEntry, path: string, index?: ZoteroIndex, options: Pick<PreviewOptions, "offline" | "identities"> = {}): Promise<ImportPreview> {
		const settings = this.settings();
		await this.checkPath(path);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error("The note to adopt is not a file.");
		const original = await this.app.vault.read(file);
		const parsed = parseNoteText(original, yaml => parseYaml(yaml) as unknown);
		const basename = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
		const refuse = (message: string): ImportPreview => {
			const preview: ImportPreview = { path, content: original, conflicts: [message], softConflicts: [], detached: [], sections: [], exists: true, mode: "adopt" };
			this.snapshots.set(preview, { path, content: original, original, images: [], conflicts: [message], rendered: null, render: null, identities: options.identities ?? IdentityMap.empty(settings.outputFolder), backup: true, preview: { path, exists: true, mode: "adopt" } });
			return preview;
		};
		if (parsed.frontmatterParse === "error") return refuse("The note's frontmatter does not parse; fix it before adopting the note.");
		const why = adoptRefusal({ path, basename, frontmatter: parsed.frontmatter }, original);
		if (why) return refuse(`Not adopted: ${why}.`);
		const identities = options.identities?.folder === settings.outputFolder ? options.identities : await this.identityMap();
		const others = (await identities.pathsFor(entry.id)).filter(other => other !== path);
		if (others.length) return refuse(`@${entry.citekey} already has a literature note: ${others.join(", ")}. Open that note instead.`);
		const bibliography = await this.bibliography(entry, options.offline ? { offline: true } : {});
		const imageHashes = await this.imageHashes(entry);
		const related = index ? relatedCitekeys(entry, index) : [];
		const { sections, images: plans } = literatureSections(entry, bibliography, settings, true, imageHashes, { related, noteMarkdown: this.noteMarkdown });
		const adopted = adoptedNoteText(original, parsed.frontmatter, entry, sections, settings);
		if ("refuse" in adopted) return refuse(`Not adopted: ${adopted.refuse}.`);
		const expectedBody = frontmatterAndBody(adopted.text).body;
		const problem = verifyFrontmatterEdit(original, adopted.text, adopted.edit, yaml => parseYaml(yaml) as unknown, expectedBody);
		const ownBody = frontmatterAndBody(original).body.replace(/[\r\n\s]*$/, "");
		if (problem || !expectedBody.startsWith(ownBody)) return refuse(`Not adopted: ${problem ?? "the note's own text would change"}.`);
		const conflicts: string[] = [];
		const images = await this.checkImages(plans, imageHashes, conflicts);
		const report: SectionInfo[] = [...sections].map(([id, body]) => ({ id, state: "fresh", reason: "appended below your text", body }));
		const warnings = [`Frontmatter keys added: ${adopted.added.length ? adopted.added.join(", ") : "none"}. Your text and other keys stay as they are; the generated sections are appended at the end.`];
		const meta: Snapshot["preview"] = { path, exists: true, mode: "adopt", backup: true, warnings };
		const preview: ImportPreview = { ...meta, content: adopted.text, conflicts: [...conflicts], softConflicts: [], detached: [], sections: report };
		this.snapshots.set(preview, { path, content: adopted.text, original, images, conflicts, rendered: null, render: null, identities, backup: true, preview: meta });
		return preview;
	}

	/** 0.6.3 better-notes-guard: a warning when the note carries Better Notes sync frontmatter. */
	private betterNotesWarnings(text: string | null): string[] {
		if (text === null) return [];
		const parsed = parseNoteText(text, yaml => parseYaml(yaml) as unknown);
		return hasBetterNotesSync(parsed.frontmatter) ? [BETTER_NOTES_WARNING] : [];
	}

	/** Validated content hashes of the item's annotation images, read once per preview. */
	private async imageHashes(entry: ZoteroIndexEntry): Promise<Map<string, string>> {
		const imageHashes = new Map<string, string>();
		for (const attachment of entry.attachments) for (const annotation of attachment.annotations) {
			if (annotation.imagePath && !imageHashes.has(annotation.imagePath)) imageHashes.set(annotation.imagePath, hashBytes(await readAnnotationImage(annotation.imagePath)));
		}
		return imageHashes;
	}

	/** The images a render copies, each destination checked; a destination with other content is a conflict. */
	private async checkImages(plans: readonly { source: string; path: string }[], imageHashes: ReadonlyMap<string, string>, conflicts: string[]): Promise<Snapshot["images"]> {
		const images: Snapshot["images"] = [];
		for (const image of plans) {
			await this.checkPath(image.path);
			const hash = imageHashes.get(image.source);
			if (!hash) throw new Error("Missing validated annotation image hash");
			const found = this.app.vault.getAbstractFileByPath(image.path);
			if (found && (!(found instanceof TFile) || found.stat.size > MAX_IMAGE_BYTES || hashBytes(new Uint8Array(await this.app.vault.readBinary(found))) !== hash)) conflicts.push(`Image destination contains different content: ${image.path}`);
			images.push({ ...image, hash });
		}
		return images;
	}

	/**
	 * 0.6 OPT-02: the output folder's `zoteroID` → note paths, read from the notes themselves (never the metadata cache):
	 * every read passes the vault-boundary walk (the vault root resolved once per round of reads), 8 reads in flight. A
	 * batch builds it once, passes it to every `preview`, and `apply` records each written note in it.
	 * 0.6.3 find-moved-notes: notes outside the folder whose cached frontmatter has a `zoteroID` are read too, and count
	 * when they carry that item's owner marker, so a moved or renamed literature note is updated where it is now instead
	 * of being created again in the folder.
	 */
	identityMap(): Promise<IdentityMap> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return Promise.reject(new Error("Safe local import requires a desktop filesystem vault"));
		const cache = (this.app as { metadataCache?: App["metadataCache"] }).metadataCache;
		return IdentityMap.build(this.settings().outputFolder, {
			list: () => this.app.vault.getMarkdownFiles().map(file => file.path),
			outside: () => cache ? this.app.vault.getMarkdownFiles().filter(file => typeof cache.getFileCache(file)?.frontmatter?.zoteroID === "string").map(file => file.path) : [],
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
			const { entry, bibliography, settings, imageHashes, related, previous, scope } = snapshot.render;
			rendered = renderLiterature(entry, bibliography, settings, previous, imageHashes, { related, noteMarkdown: this.noteMarkdown, ...choices, ...(scope ? { scope } : {}) });
			if (rendered.conflicts.length) return { ...refuse(""), conflicts: [...rendered.conflicts] };
			content = rendered.content;
		}
		const preserved = rendered ? rendered.sections.filter(section => section.state === "edited").map(section => section.id) : [];
		const detached = rendered ? [...rendered.detached] : [];
		const reset = rendered ? [...rendered.reset] : [];
		const changed = snapshot.original !== content;
		let backup: string | undefined;
		let unverified: string | undefined;
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
				// A reset discards the user's edited text, and a rebuild or adopt changes a note's structure: keep a copy in the
				// private (ignored) backup folder first.
				if ((reset.length || snapshot.backup) && changed) backup = await this.backupNote(path, snapshot.original);
				await this.app.vault.process(file, current => {
					if (hashText(current) !== hashText(snapshot.original ?? "")) throw new Error("Note changed after preview; no note content was written");
					return content;
				});
				// 0.6.3: a rebuild or adopt is checked after the write; another edit at that moment is reported, never undone.
				if (snapshot.backup && changed) {
					const written = this.app.vault.getAbstractFileByPath(path);
					const now = written instanceof TFile ? await this.app.vault.read(written) : null;
					if (now !== content) unverified = `The note does not read back as written (another edit at the same moment?). Check it; the previous text is in ${backup ?? "the backup folder"}.`;
				}
			}
			snapshot.identities.noteWritten(path, content); // 0.6 OPT-02: later previews of the batch see this note
			this.snapshots.delete(preview);
			return { path, conflicts: [], changed, preserved, detached, reset, ...(backup ? { backup } : {}), ...(unverified ? { unverified } : {}) };
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

	/** 0.5 R5 (0.6.3: also used by the frontmatter patches): copies `text` to the private backup folder and returns the copy's path. */
	async backupNote(path: string, text: string): Promise<string> {
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
