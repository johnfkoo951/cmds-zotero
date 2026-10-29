import { FileSystemAdapter, MarkdownView, Notice, TFile, type Editor } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import type { SnapshotState } from "../citations/reference-rows";
import { adjacentOccurrence, citedKeyAt, citedKeySet } from "../citations/cited-keys";
import { checkCitations, referenceRowsFromSet, renamedKeys } from "../citations/check";
import { planReferencesSection, referencesBody, withoutReferencesBlock } from "../citations/references-block";
import { markdownEntry } from "../bibliography/format";
import { randomBytes } from "crypto";
import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import { dirname, normalize } from "path";
import { findStyle, homeRelative, independentStyle, wordStyleFacts } from "../bibliography/csl-styles";
import { CITEPROC_KEYS, DOCUMENT_KEYS, documentFrontmatter, frontmatterSummary, sanitizeForExport, sanitizeSummary, type LinkTarget } from "../export/sanitize";
import { KIT_BIBLIOGRAPHY, KIT_DEFAULTS, KIT_DOCX_FILTER, KIT_MANIFEST, defaultsYaml, docxFilterLua, kitDecision, kitFolder, kitName, manifestText, pandocCommand, sha256, vaultRootFrom, type KitManifest } from "../export/kit";
import { WORD_FILTER, bibliographyWithoutReferencesSection, hasRefsPlace, preferenceChunks, sessionId, wordDefaultsYaml, wordFilterLua, zoteroDocumentData, zoteroLuaInstallCommand, zoteroLuaLocations } from "../export/word-kit";
import { resolveKitRoot } from "../export/location";
import { obsidianOpenURI } from "../uris";
import { linkInHookmark, openWithDefaultApp, runPandoc, type PandocRun } from "./export-runner";
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

	/**
	 * 0.6.6 export-outside-vault: the store the kits are written to. The vault (the default), or a folder outside it when
	 * "Allow export kits outside the vault" is on. `vaultRoot` is how a kit folder's defaults file reaches the vault root.
	 */
	private kitTarget(): { root: string; store: KitStore; vaultRoot: (folder: string) => string } {
		const app = this.plugin.app;
		const adapter = app.vault.adapter;
		const vaultBase = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
		const target = resolveKitRoot(this.plugin.settings.exportFolder, { allowOutside: this.plugin.settings.exportOutsideVault, home: homedir(), vaultBase });
		if (target.kind === "vault") {
			const store: KitStore = {
				label: folder => `${folder}/`,
				read: async path => await adapter.exists(path) ? adapter.read(path) : null,
				exists: path => adapter.exists(path),
				write: async (path, text) => { await assertVaultBoundary(app, path); await ensureDirectory(app, path); await adapter.write(path, text); },
				absolute: path => vaultBase ? `${vaultBase}/${path}` : null,
			};
			return { root: target.folder, store, vaultRoot: vaultRootFrom };
		}
		if (!vaultBase) throw new Error("Export kits outside the vault need the vault on this computer's file system.");
		const store: KitStore = {
			label: folder => `${folder}/`,
			read: async path => { try { return await fs.readFile(path, "utf8"); } catch { return null; } },
			exists: async path => { try { await fs.access(path); return true; } catch { return false; } },
			write: async (path, text) => { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, text, "utf8"); },
			absolute: path => path,
		};
		return { root: target.path, store, vaultRoot: () => homeRelative(vaultBase) };
	}

	/** Reads the kit files of `folder` (null when absent) and the manifest. */
	private async existingKit(store: KitStore, folder: string, names: readonly string[]): Promise<{ manifest: string | null; files: Map<string, string | null> }> {
		const files = new Map<string, string | null>();
		for (const name of names) files.set(name, await store.read(`${folder}/${name}`));
		return { manifest: await store.read(`${folder}/${KIT_MANIFEST}`), files };
	}

	/**
	 * "Export pandoc kit": the cleaned copy, CSL-JSON of exactly the cited items (Better BibTeX `item.export`), a defaults
	 * file and the kit's filter. New files only: an earlier kit is replaced only while unchanged; a changed one is kept and a
	 * fresh folder is offered. 0.6.6: with "Run pandoc after export" on, pandoc runs and the `.docx` opens.
	 */
	async exportKit(): Promise<void> {
		const file = this.activeFile();
		const source = await this.plugin.readSaved(file);
		const { index } = await this.snapshot();
		if (!index) throw new Error("No saved index yet. Refresh the citekey index first.");
		const original = citedKeySet(withoutReferencesBlock(source));
		const cleaned = sanitizeForExport(source, { resolve: this.linkResolver(file, index), renamed: renamedKeys(original, index.entries) });
		const copy = documentFrontmatter(cleaned.text, [...DOCUMENT_KEYS, ...CITEPROC_KEYS]);
		const cited = this.resolveCited(cleaned.text, index.entries, true);
		if (!cited.entries.length) throw new Error("No resolved citations in this note; the kit needs at least one.");
		const target = this.kitTarget();
		const csl = await this.plugin.bibliography.cslJsonFor(cited.entries);
		const name = kitName(file.basename.replace(/^@+/, ""));
		const kitNames = [`${name}.md`, KIT_BIBLIOGRAPHY, KIT_DEFAULTS, KIT_DOCX_FILTER];
		const generator = `${this.plugin.manifest.name} ${this.plugin.manifest.version}`;
		const write = async (folder: string): Promise<void> => {
			const vaultRoot = target.vaultRoot(folder);
			const format = await this.plugin.bibliography.noteFormat(file);
			const style = await this.cslPath(file, format.style, vaultRoot);
			const noteFolder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
			const contents = new Map<string, string>([
				[`${name}.md`, copy.text.endsWith("\n") ? copy.text : `${copy.text}\n`],
				[KIT_BIBLIOGRAPHY, csl.content],
				[KIT_DEFAULTS, defaultsYaml({ input: `${name}.md`, output: `${name}.docx`, ...(style.path ? { csl: style.path } : {}), ...(format.locale ? { lang: format.locale } : {}), vaultRoot, noteFolder, generator })],
				[KIT_DOCX_FILTER, docxFilterLua(generator)],
			]);
			const defaultsPath = await this.writeKitFiles(target.store, folder, file, contents);
			const missing = cited.entries.length - csl.exported.length;
			const lines = [
				`Written to ${target.store.label(folder)}: ${kitNames.join(", ")} and ${KIT_MANIFEST}. ${file.basename} itself was not changed.`,
				`${csl.exported.length} cited source${csl.exported.length === 1 ? "" : "s"} in ${KIT_BIBLIOGRAPHY}${missing > 0 ? ` (${missing} missing from the Better BibTeX export)` : ""}.`,
				...(cited.skipped.length ? [`Not in ${KIT_BIBLIOGRAPHY} (pandoc will warn): ${cited.skipped.join(", ")}.`] : []),
				...(style.note ? [style.note] : []),
				...sanitizeSummary(cleaned.report),
				...frontmatterSummary(copy.removed),
			];
			await this.finishKit({ title: "Pandoc export kit", lines, store: target.store, folder, defaultsPath, docx: `${name}.docx`, file, word: false });
		};
		await this.writeKitFolder(target.store, target.root, name, kitNames, write);
	}

	/** Writes `contents` and the manifest into `folder`; returns the defaults file's absolute path when known. */
	private async writeKitFiles(store: KitStore, folder: string, source: TFile, contents: ReadonlyMap<string, string>): Promise<string> {
		const manifest: KitManifest = { version: 1, source: source.path, createdAt: new Date().toISOString(), files: Object.fromEntries([...contents].map(([key, value]) => [key, sha256(value)])) };
		for (const [key, value] of [...contents, [KIT_MANIFEST, manifestText(manifest)] as const]) await store.write(`${folder}/${key}`, value);
		return store.absolute(`${folder}/${KIT_DEFAULTS}`) ?? `${folder}/${KIT_DEFAULTS}`;
	}

	/**
	 * The kit folder `<export folder>/<name>`: written when empty or still the plugin's unchanged export; otherwise a fresh
	 * `<name> <n>` is offered and the earlier export stays as it is.
	 */
	private async writeKitFolder(store: KitStore, root: string, name: string, kitNames: readonly string[], write: (folder: string) => Promise<void>): Promise<void> {
		const first = kitFolder(root, name);
		const existing = await this.existingKit(store, first, kitNames);
		const decision = kitDecision(existing.manifest, existing.files);
		if (decision.kind === "write" || decision.kind === "replace") { await write(first); return; }
		let fresh: string | null = null;
		for (let attempt = 2; attempt <= MAX_KIT_ATTEMPTS && !fresh; attempt++) {
			const candidate = kitFolder(root, name, attempt);
			if (!(await store.exists(candidate))) fresh = candidate;
		}
		if (!fresh) throw new Error(`The earlier export in ${first} was changed and no fresh folder name was free; move or delete old exports.`);
		const freshFolder = fresh;
		const why = decision.kind === "changed" ? `was changed since it was written (${decision.files.join(", ")})` : `holds files the plugin did not write (${decision.files.join(", ")})`;
		new ActionsModal(this.plugin.app, `${first} ${why}`, [
			{ name: `Export to ${freshFolder}`, description: "A new folder; the earlier export stays as it is.", action: () => write(freshFolder) },
		]).open();
	}

	/**
	 * The end of an export. Without "Run pandoc after export": the command goes to the clipboard and the report. With it:
	 * pandoc runs (for the Word kit only while Zotero answers), the `.docx` opens with its default app and, with "Link
	 * exports in Hookmark", the `.docx` and the note are hooked together. Any step that cannot run says why and leaves
	 * the command to run by hand.
	 */
	private async finishKit(kit: { title: string; lines: string[]; store: KitStore; folder: string; defaultsPath: string; docx: string; file: TFile; word: boolean }): Promise<void> {
		const settings = this.plugin.settings;
		const command = pandocCommand(kit.defaultsPath, process.platform);
		const show = (lines: string[]): void => { new ReportModal(this.plugin.app, kit.title, lines.join("\n")).open(); };
		const handOver = async (why: string[]): Promise<void> => {
			let copied = true;
			try { await navigator.clipboard.writeText(command); } catch { copied = false; }
			show([...kit.lines, "", ...why, copied ? "Command copied to the clipboard (pandoc 2.17 or later):" : "Run this command (pandoc 2.17 or later):", command,
				...(kit.word ? ["", "Run it while Zotero is open. In Word, press Refresh in the Zotero tab once; the citations and the bibliography are then Zotero's."] : [])]);
		};
		const folderPath = kit.store.absolute(kit.folder);
		if (!settings.pandocAfterExport || !folderPath) { await handOver([]); return; }
		if (kit.word && !(await this.plugin.bbt.isReachable())) { await handOver(["Zotero is not answering, so pandoc was not run (the Word kit asks Zotero for the cited items). Start Zotero and export again, or run the command yourself."]); return; }
		const notice = new Notice("Running pandoc…", 0);
		let run: PandocRun;
		try { run = await runPandoc(settings.pandocPath, kit.defaultsPath, folderPath); } finally { notice.hide(); }
		const issues = run.summary ? [
			...(run.summary.missing.length ? [`Not found in Zotero, left as text in the .docx: ${run.summary.missing.map(key => `@${key}`).join(", ")}.`] : []),
			...(run.summary.ambiguous.length ? [`Found more than once in Zotero, left as text: ${run.summary.ambiguous.map(key => `@${key}`).join(", ")}.`] : []),
			...run.summary.other.map(line => `pandoc: ${line}`),
		] : [];
		if (run.kind === "failed") { await handOver([`pandoc did not finish: ${run.message}`, ...issues, ""]); return; }
		const docxPath = normalize(`${folderPath}/${kit.docx}`);
		const result = [`pandoc (${run.pandoc}) wrote ${docxPath}.`, ...issues];
		const openProblem = await openWithDefaultApp(docxPath);
		result.push(openProblem ? `The .docx could not be opened: ${openProblem}` : `Opened the .docx.${kit.word ? " In Word, press Refresh in the Zotero tab once." : ""}`);
		if (settings.hookmarkLinkExports) {
			const linkProblem = await linkInHookmark(docxPath, obsidianOpenURI(this.plugin.app.vault.getName(), kit.file.path), kit.docx, kit.file.basename);
			result.push(linkProblem ?? "Linked the .docx and the note in Hookmark.");
		}
		show([...kit.lines, "", ...result, "", "To run pandoc again yourself:", command]);
	}

	/**
	 * 0.6.6 word-zotero-fields, "Export Word kit with live Zotero citations": the cleaned copy, a defaults file that runs
	 * this kit's filter and Better BibTeX's `zotero.lua`, and the filter. Word gets live Zotero fields in the note's style,
	 * so the bibliography is made (and the style changed) in Word with the Zotero plugin. The style must be installed in
	 * Zotero, because Word's Zotero plugin formats with Zotero's styles. No Better BibTeX request is made while writing the
	 * kit; pandoc asks Zotero for the cited items when it runs (by the person, or by the plugin with "Run pandoc after export").
	 */
	async exportWordKit(): Promise<void> {
		const file = this.activeFile();
		const source = await this.plugin.readSaved(file);
		const { index, state } = await this.snapshot();
		if (!index) throw new Error("No saved index yet. Refresh the citekey index first.");
		const original = citedKeySet(withoutReferencesBlock(source));
		const cleaned = sanitizeForExport(source, { resolve: this.linkResolver(file, index), renamed: renamedKeys(original, index.entries) });
		const cited = this.resolveCited(cleaned.text, index.entries, state.loaded);
		if (!cited.entries.length) throw new Error("No resolved citations in this note; the kit needs at least one.");
		const format = await this.plugin.bibliography.noteFormat(file);
		const styles = (await this.plugin.bibliography.installedStyles()).styles;
		const style = findStyle(styles, format.style);
		if (!style) throw new Error(`The style "${format.style}" is not installed in Zotero. Word's Zotero plugin formats with Zotero's installed styles: install it in Zotero (Settings → Cite → +) or choose an installed style for this note.`);
		const target = this.kitTarget();
		const facts = wordStyleFacts(styles, style);
		const locale = format.locale || style.defaultLocale || "en-US";
		const copy = documentFrontmatter(cleaned.text);
		const refsPlace = hasRefsPlace(copy.text);
		const withoutRefs = refsPlace ? "none" : bibliographyWithoutReferencesSection(facts);
		const heading = this.plugin.settings.referencesHeadings[0]?.trim() || "References";
		const prefs = preferenceChunks(zoteroDocumentData({ styleId: style.id, locale, ...facts, sessionId: sessionId(randomBytes(8)) }));
		const name = `${kitName(file.basename.replace(/^@+/, ""))} (Word)`;
		const copyName = `${kitName(file.basename.replace(/^@+/, ""))}.md`;
		const kitNames = [copyName, KIT_DEFAULTS, WORD_FILTER];
		const generator = `${this.plugin.manifest.name} ${this.plugin.manifest.version}`;
		const found = zoteroLuaLocations(homedir(), { XDG_DATA_HOME: process.env.XDG_DATA_HOME, APPDATA: process.env.APPDATA }, process.platform).find(path => existsSync(path)) ?? null;
		const write = async (folder: string): Promise<void> => {
			const noteFolder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
			const contents = new Map<string, string>([
				[copyName, copy.text.endsWith("\n") ? copy.text : `${copy.text}\n`],
				[KIT_DEFAULTS, wordDefaultsYaml({ input: copyName, output: copyName.replace(/\.md$/, ".docx"), style: style.key, ...(format.locale ? { lang: format.locale } : {}), vaultRoot: target.vaultRoot(folder), noteFolder, generator })],
				[WORD_FILTER, wordFilterLua({ generator, prefs, ...facts, withoutRefs, heading })],
			]);
			const defaultsPath = await this.writeKitFiles(target.store, folder, file, contents);
			const placement = !facts.hasBibliography ? `"${style.title}" has no bibliography, so none is added.`
				: refsPlace ? "The bibliography field takes the place of the references section."
				: withoutRefs === "end" ? `The note has no references section; the bibliography field is added at the end under a "${heading}" heading (the first line of References headings, under Advanced in the plugin settings).`
				: "The note has no references section, so no bibliography field is added (Zotero → Add/Edit Bibliography in Word).";
			const lines = [
				`Written to ${target.store.label(folder)}: ${kitNames.join(", ")} and ${KIT_MANIFEST}. ${file.basename} itself was not changed.`,
				`Style: ${style.title}${facts.noteStyle ? " (footnotes)" : ""} · ${locale}. ${placement}`,
				...(cited.skipped.length ? [`Not in the index (zotero.lua leaves them as text): ${cited.skipped.join(", ")}.`] : []),
				...(format.problems.length ? format.problems : []),
				...sanitizeSummary(cleaned.report),
				...frontmatterSummary(copy.removed),
				found ? `zotero.lua: ${found}` : `zotero.lua was not found in pandoc's filters folder. Install Better BibTeX's filter once:\n${zoteroLuaInstallCommand(process.platform)}`,
			];
			await this.finishKit({ title: "Word export kit (live Zotero citations)", lines, store: target.store, folder, defaultsPath, docx: copyName.replace(/\.md$/, ".docx"), file, word: true });
		};
		await this.writeKitFolder(target.store, target.root, name, kitNames, write);
	}
}

/** 0.6.6: where a kit's files are read and written (the vault, or a folder outside it). Paths are `<folder>/<name>`. */
interface KitStore {
	/** The folder as the report names it. */
	label(folder: string): string;
	read(path: string): Promise<string | null>;
	exists(path: string): Promise<boolean>;
	/** Creates parent folders as needed. */
	write(path: string, text: string): Promise<void>;
	/** The path on disk, or null when the vault is not on a file system. */
	absolute(path: string): string | null;
}
