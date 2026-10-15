import { FileSystemAdapter, MarkdownView, Notice, TFile, type Editor } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import type { SnapshotState } from "../citations/reference-rows";
import { adjacentOccurrence, citedKeyAt, citedKeySet } from "../citations/cited-keys";
import { checkCitations, referenceRowsFromSet, renamedKeys } from "../citations/check";
import { planReferencesSection, referencesBody, withoutReferencesBlock } from "../citations/references-block";
import { markdownEntry } from "../bibliography/format";
import { findStyle, homeRelative, independentStyle } from "../bibliography/csl-styles";
import { sanitizeForExport, sanitizeSummary, type LinkTarget } from "../export/sanitize";
import { KIT_BIBLIOGRAPHY, KIT_DEFAULTS, KIT_MANIFEST, defaultsYaml, kitDecision, kitFolder, kitName, manifestText, pandocCommand, sha256, vaultRootFrom, type KitManifest } from "../export/kit";
import { lineDiff } from "../fragments";
import { NOTE_BACKUP_DIR } from "../importer";
import { assertVaultBoundary, ensureCmdsIgnore, ensureDirectory } from "../vault-storage";
import { CitationCheckModal, checkReportText } from "../modals/citation-check";
import { SectionPreviewModal } from "../modals/section-preview";
import { ActionsModal } from "../modals/actions";
import { ReportModal } from "../modals/report";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "tif", "tiff"]);
/** Fresh kit folders tried (`<name> 2` … `<name> 50`) before giving up. */
const MAX_KIT_ATTEMPTS = 50;

/**
 * 0.6.2 WP6: the citation check, occurrence navigation, the managed references section and the pandoc export kit, all
 * for the active note. Reads use the saved index only (never a BBT read for a UI answer); the references section and the
 * kit render through the bibliography controller and Better BibTeX's export like the existing pandoc commands.
 */
export class ReferencesController {
	constructor(private readonly plugin: CMDSZoteroPlugin) {}

	/** The active Markdown note (or the last one in a Markdown view). */
	private activeFile(): TFile {
		const view = this.plugin.lastMarkdownView();
		const file = view?.file ?? this.plugin.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") throw new Error("Open a Markdown note first.");
		return file;
	}

	/** The loaded snapshot, else the saved one from disk; never Better BibTeX. */
	private async snapshot(): Promise<{ index: ZoteroIndex | null; state: SnapshotState }> {
		const index = this.plugin.lastIndex ?? await this.plugin.savedIndex();
		return { index, state: { loaded: index !== null, stale: index ? this.plugin.index.isStale(index) === true : false, ageMinutes: index ? this.plugin.index.ageMinutes(index) : null } };
	}

	/** Puts the cursor on `line`/`column` of `file`, opening it when no Markdown view shows it. */
	async jump(file: TFile, line: number, column = 0, length = 0): Promise<void> {
		const leaf = this.plugin.app.workspace.getLeavesOfType("markdown").find(item => item.view instanceof MarkdownView && item.view.file === file);
		if (leaf) this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
		else await this.plugin.app.workspace.getLeaf(false).openFile(file, { eState: { line } });
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file !== file) return;
		const from = { line, ch: column };
		view.editor.setSelection(from, { line, ch: column + length });
		view.editor.scrollIntoView({ from, to: from }, true);
	}

	// check-citations

	async checkCitations(): Promise<void> {
		const file = this.activeFile();
		const view = this.plugin.lastMarkdownView();
		const text = view?.file === file ? view.editor.getValue() : await this.plugin.app.vault.cachedRead(file);
		const { index, state } = await this.snapshot();
		const notes = index ? this.plugin.links.localFilesByEntry(index) : null;
		const report = checkCitations(citedKeySet(withoutReferencesBlock(text)), index?.entries ?? [], state, entry => notes ? notes.get(entry.id)?.length ?? 0 : null);
		new CitationCheckModal(this.plugin.app, `Citations in ${file.basename}`, report, (line, column) => { void this.jump(file, line, column); }, checkReportText(file.basename, report)).open();
	}

	// citation-occurrence-navigation

	/** Moves to the next or previous occurrence of `citekey` in the editor (wrapping); false when it does not occur. */
	goToOccurrence(editor: Editor, citekey: string, direction: "next" | "previous"): boolean {
		const set = citedKeySet(editor.getValue());
		const target = adjacentOccurrence(set, citekey, editor.getCursor(), direction);
		if (!target) return false;
		const from = { line: target.line, ch: target.column };
		editor.setSelection(from, { line: target.line, ch: target.end });
		editor.scrollIntoView({ from, to: from }, true);
		return true;
	}

	/** Palette command: the next or previous occurrence of the citation under the cursor. */
	goToOccurrenceAtCursor(editor: Editor, direction: "next" | "previous"): void {
		const key = citedKeyAt(citedKeySet(editor.getValue()), editor.getCursor());
		if (!key) { new Notice("No citation under the cursor."); return; }
		this.goToOccurrence(editor, key, direction);
	}

	/** References sidebar: jump in the note it shows (the active editor when that is the note). */
	async goToOccurrenceIn(file: TFile, citekey: string, direction: "next" | "previous"): Promise<void> {
		let view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView) ?? this.plugin.lastMarkdownView();
		if (!view || view.file !== file) { await this.jump(file, 0); view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView); }
		if (!view || view.file !== file) return;
		if (!this.goToOccurrence(view.editor, citekey, direction)) new Notice(`@${citekey} is only in nocite or no longer in the note.`);
	}

	// managed-references-section

	/** Resolved entries (one per item) for the note's cited set, and the keys that could not be listed. */
	private resolveCited(text: string, entries: readonly ZoteroIndexEntry[], loaded: boolean): { entries: ZoteroIndexEntry[]; skipped: string[] } {
		const rows = referenceRowsFromSet(citedKeySet(text), entries, loaded);
		const seen = new Set<string>();
		const resolved: ZoteroIndexEntry[] = [];
		const skipped: string[] = [];
		for (const row of rows) {
			if (row.status !== "resolved" || !row.entry) { skipped.push(`@${row.citekey} (${row.status === "ambiguous" ? "ambiguous" : row.status === "unchecked" ? "index not loaded" : "not in the index"})`); continue; }
			if (seen.has(row.entry.id)) continue;
			seen.add(row.entry.id);
			resolved.push(row.entry);
		}
		return { entries: resolved, skipped };
	}

	/** "Insert/update references section": previewed; a new block is appended at the end after a backup of the note. */
	async insertReferencesSection(): Promise<void> {
		const file = this.activeFile();
		const text = await this.plugin.readSaved(file);
		const { index, state } = await this.snapshot();
		if (!index) throw new Error("No saved index yet. Refresh the citekey index first.");
		const cited = this.resolveCited(withoutReferencesBlock(text), index.entries, state.loaded);
		if (!cited.entries.length) throw new Error("No resolved citations in this note to list.");
		const format = await this.plugin.bibliography.noteFormat(file);
		const list = await this.plugin.bibliography.renderList(cited.entries, format);
		const body = referencesBody(list.text.map(markdownEntry));
		const heading = this.plugin.settings.referencesHeadings[0] ?? "References";
		const plan = planReferencesSection(text, body, heading);
		const at = `line ${plan.line + 1}`;
		switch (plan.kind) {
			case "conflict": throw new Error(`The references section was not changed: ${plan.message} (${at}).`);
			case "edited": new Notice(`The references section (${at}) was edited by hand, so it was kept as it is. Delete it to insert a fresh one, or change its marker to :detached to keep it as yours.`, 12000); return;
			case "detached": new Notice(`The references section (${at}) is detached (yours); it is never updated.`); return;
			case "unchanged": new Notice("The references section is up to date."); return;
		}
		const notes = [
			`${list.text.length} entr${list.text.length === 1 ? "y" : "ies"}, ${list.order === "style" ? "in style order" : list.order === "alphabetical" ? "alphabetical" : "in citation order"} (${format.style}${format.locale ? `, ${format.locale}` : ""}).`,
			...(list.counts.cached || list.counts.fallback ? [`Zotero was not answering: ${list.counts.cached} from cache, ${list.counts.fallback} author-year fallback.`] : []),
			...(cited.skipped.length ? [`Not listed: ${cited.skipped.join(", ")}.`] : []),
			...(plan.kind === "insert" ? ["A copy of the note is kept in .cmds-zotero/backups/notes/ before the block is added."] : []),
		];
		const diff = plan.kind === "insert" ? lineDiff("", plan.text.slice(text.replace(/\s*$/, "").length).replace(/^\n+/, "")).filter(line => line.kind !== "removed") : lineDiff(text, plan.text).filter(line => line.kind !== "same");
		new SectionPreviewModal(this.plugin.app, plan.kind === "insert" ? "Insert references section" : "Update references section",
			plan.kind === "insert" ? `A plugin-owned references block is added at the end of ${file.basename}. Nothing else in the note changes.` : `The unedited references block of ${file.basename} is replaced. Nothing else in the note changes.`,
			notes, diff, plan.kind === "insert" ? "Insert" : "Update", async () => {
				if (plan.kind === "insert") await this.backupNote(file, text);
				await this.plugin.app.vault.process(file, current => {
					if (current !== text) throw new Error("The note changed since the preview; run the command again.");
					return plan.text;
				});
				new Notice(plan.kind === "insert" ? "References section inserted." : "References section updated.");
			}).open();
	}

	private async backupNote(file: TFile, text: string): Promise<void> {
		await ensureCmdsIgnore(this.plugin.app);
		const backup = `${NOTE_BACKUP_DIR}/${file.basename}-${Date.now()}.md`;
		await assertVaultBoundary(this.plugin.app, backup);
		await ensureDirectory(this.plugin.app, backup);
		await this.plugin.app.vault.adapter.write(backup, text);
	}

	// export-sanitized-copy, wikilinks-to-citations-on-export, pandoc-export-kit

	/** Wikilink targets for the copy: literature notes by identity, images, other notes; nothing resolves to a first match. */
	private linkResolver(file: TFile, index: ZoteroIndex): (linkpath: string) => LinkTarget {
		const byPath = new Map<string, ZoteroIndexEntry>();
		const byId = new Map(index.entries.map(entry => [entry.id, entry]));
		for (const [id, files] of this.plugin.links.localFilesByEntry(index)) {
			const entry = byId.get(id);
			if (entry) for (const note of files) byPath.set(note.path, entry);
		}
		return linkpath => {
			const target = this.plugin.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
			if (!target) return { kind: "missing" };
			const entry = byPath.get(target.path);
			if (entry) return { kind: "literature", citekey: entry.citekey };
			if (IMAGE_EXTENSIONS.has(target.extension.toLowerCase())) return { kind: "image", path: target.path };
			return { kind: "note", path: target.path };
		};
	}

	/** The CSL file for pandoc: the note's `csl` when it is a file, else the installed (independent) style's file. */
	private async cslPath(file: TFile, style: string, vaultRoot: string): Promise<{ path?: string; note?: string }> {
		const csl: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.csl;
		if (typeof csl === "string" && /\.csl$/i.test(csl.trim())) {
			const value = csl.trim();
			if (value.startsWith("/")) return { path: homeRelative(value) };
			if (await this.plugin.app.vault.adapter.exists(value)) return { path: `${vaultRoot}/${value}` };
		}
		let styles;
		try { styles = (await this.plugin.bibliography.installedStyles()).styles; }
		catch (error) { return { note: `No CSL file in the kit: ${error instanceof Error ? error.message : "the styles folder could not be read"}` }; }
		const installed = findStyle(styles, style);
		if (!installed) return { note: `No CSL file in the kit: the style "${style}" is not in the Zotero styles folder; pandoc uses its default (Chicago author-date).` };
		const independent = independentStyle(styles, installed);
		if (!independent) return { note: `No CSL file in the kit: "${installed.title}" is a dependent style whose parent is not installed; pandoc needs the parent style.` };
		return { path: homeRelative(independent.path), ...(independent !== installed ? { note: `"${installed.title}" is a dependent style; the kit uses its parent "${independent.title}".` } : {}) };
	}

	/** Reads the kit files of `folder` (null when absent) and the manifest. */
	private async existingKit(folder: string, names: readonly string[]): Promise<{ manifest: string | null; files: Map<string, string | null> }> {
		const adapter = this.plugin.app.vault.adapter;
		const read = async (path: string): Promise<string | null> => await adapter.exists(path) ? adapter.read(path) : null;
		const files = new Map<string, string | null>();
		for (const name of names) files.set(name, await read(`${folder}/${name}`));
		return { manifest: await read(`${folder}/${KIT_MANIFEST}`), files };
	}

	/**
	 * "Export pandoc kit": the cleaned copy, CSL-JSON of exactly the cited items (Better BibTeX `item.export`), a defaults
	 * file and the command line on the clipboard. New files only: an earlier kit is replaced only while unchanged; a
	 * changed one is kept and a fresh folder is offered. Pandoc is never run.
	 */
	async exportKit(): Promise<void> {
		const file = this.activeFile();
		const source = await this.plugin.readSaved(file);
		const { index } = await this.snapshot();
		if (!index) throw new Error("No saved index yet. Refresh the citekey index first.");
		const original = citedKeySet(withoutReferencesBlock(source));
		const cleaned = sanitizeForExport(source, { resolve: this.linkResolver(file, index), renamed: renamedKeys(original, index.entries) });
		const cited = this.resolveCited(cleaned.text, index.entries, true);
		if (!cited.entries.length) throw new Error("No resolved citations in this note; the kit needs at least one.");
		const csl = await this.plugin.bibliography.cslJsonFor(cited.entries);
		const name = kitName(file.basename.replace(/^@+/, ""));
		const kitNames = [`${name}.md`, KIT_BIBLIOGRAPHY, KIT_DEFAULTS];
		const write = async (folder: string): Promise<void> => {
			const vaultRoot = vaultRootFrom(folder);
			const format = await this.plugin.bibliography.noteFormat(file);
			const style = await this.cslPath(file, format.style, vaultRoot);
			const noteFolder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
			const contents = new Map<string, string>([
				[`${name}.md`, cleaned.text.endsWith("\n") ? cleaned.text : `${cleaned.text}\n`],
				[KIT_BIBLIOGRAPHY, csl.content],
				[KIT_DEFAULTS, defaultsYaml({ input: `${name}.md`, output: `${name}.docx`, ...(style.path ? { csl: style.path } : {}), ...(format.locale ? { lang: format.locale } : {}), vaultRoot, noteFolder, generator: `${this.plugin.manifest.name} ${this.plugin.manifest.version}` })],
			]);
			const manifest: KitManifest = { version: 1, source: file.path, createdAt: new Date().toISOString(), files: Object.fromEntries([...contents].map(([key, value]) => [key, sha256(value)])) };
			for (const [key, value] of [...contents, [KIT_MANIFEST, manifestText(manifest)] as const]) {
				const path = `${folder}/${key}`;
				await assertVaultBoundary(this.plugin.app, path);
				await ensureDirectory(this.plugin.app, path);
				await this.plugin.app.vault.adapter.write(path, value);
			}
			const adapter = this.plugin.app.vault.adapter;
			const defaults = adapter instanceof FileSystemAdapter ? `${adapter.getBasePath()}/${folder}/${KIT_DEFAULTS}` : `${folder}/${KIT_DEFAULTS}`;
			const command = pandocCommand(defaults);
			let copied = true;
			try { await navigator.clipboard.writeText(command); } catch { copied = false; }
			const missing = cited.entries.length - csl.exported.length;
			const lines = [
				`Written to ${folder}/: ${kitNames.join(", ")} and ${KIT_MANIFEST}. ${file.basename} itself was not changed.`,
				`${csl.exported.length} cited source${csl.exported.length === 1 ? "" : "s"} in ${KIT_BIBLIOGRAPHY}${missing > 0 ? ` (${missing} missing from the Better BibTeX export)` : ""}.`,
				...(cited.skipped.length ? [`Not in ${KIT_BIBLIOGRAPHY} (pandoc will warn): ${cited.skipped.join(", ")}.`] : []),
				...(style.note ? [style.note] : []),
				...sanitizeSummary(cleaned.report),
				"",
				copied ? "Command copied to the clipboard (needs pandoc 2.17 or later; the plugin never runs it):" : "Run this command (needs pandoc 2.17 or later; the plugin never runs it):",
				command,
			];
			new ReportModal(this.plugin.app, "Pandoc export kit", lines.join("\n")).open();
		};
		const root = this.plugin.settings.exportFolder;
		const first = kitFolder(root, name);
		const existing = await this.existingKit(first, kitNames);
		const decision = kitDecision(existing.manifest, existing.files);
		if (decision.kind === "write" || decision.kind === "replace") { await write(first); return; }
		let fresh: string | null = null;
		for (let attempt = 2; attempt <= MAX_KIT_ATTEMPTS && !fresh; attempt++) {
			const candidate = kitFolder(root, name, attempt);
			if (!(await this.plugin.app.vault.adapter.exists(candidate))) fresh = candidate;
		}
		if (!fresh) throw new Error(`The earlier export in ${first} was changed and no fresh folder name was free; move or delete old exports.`);
		const freshFolder = fresh;
		const why = decision.kind === "changed" ? `was changed since it was written (${decision.files.join(", ")})` : `holds files the plugin did not write (${decision.files.join(", ")})`;
		new ActionsModal(this.plugin.app, `${first} ${why}`, [
			{ name: `Export to ${freshFolder}`, description: "A new folder; the earlier export stays as it is.", action: () => write(freshFolder) },
		]).open();
	}
}
