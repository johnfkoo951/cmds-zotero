import { Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, parseYaml, stringifyYaml } from "obsidian";
import { BbtService } from "./bbt";
import { IndexService } from "./index-service";
import { ImportService } from "./importer";
import { IngestAPI } from "./ingest-api";
import type { ActionHost, AgentAction, PdfTextRequest, RefreshRequest } from "./agent/actions";
import { buildConnection } from "./agent/connection";
import { ObsidianVaultReader } from "./obsidian-vault";
import { PdfTextService } from "./pdf/extract";
import { applyReconcile } from "./reconcile-apply";
import { probeGit } from "./git-probe";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { readLocalFile } from "./local-file";
import { validateIndex } from "./identity";
import { rpc } from "./api/transport";
import { VaultLinks } from "./vault-links";
import { VaultIndexStorage, assertVaultBoundary, relativePath } from "./vault-storage";
import { normalizeSettings, validateEndpoint } from "./settings-data";
import { citekeyAtCursor, parseProtocolRequest } from "./protocol";
import { pdfURI, noteDeepLink, markdownLink } from "./uris";
import { CmdsZoteroSettingsTab } from "./settings";
import { ActionsModal, ImportPreviewModal, PageJumpModal, PickerModal, ReportModal } from "./modals";
import { CitekeySuggest } from "./citations/suggest";
import { scanCitations } from "./citations/scan";
import { ReferencesView, VIEW_TYPE_REFERENCES } from "./views/references-view";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "./views/annotations-view";
import type { CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";

export default class CMDSZoteroPlugin extends Plugin {
	settings!: CmdsZoteroSettings;
	bbt!: BbtService;
	index!: IndexService;
	importer!: ImportService;
	service!: IngestAPI;
	links!: VaultLinks;
	private active = false;
	private lastIndex: ZoteroIndex | null = null;
	private mapTimer: number | undefined;
	private bibliographyCache = new Map<string, string>();
	private bibliographyFlights = new Map<string, Promise<string>>();
	private warming: Promise<void> | null = null;
	private lastView: MarkdownView | null = null;
	private pdfText!: PdfTextService;

	async onload(): Promise<void> {
		const stored: unknown = await this.loadData();
		this.settings = normalizeSettings(stored);
		this.settings.bbtEndpoint = validateEndpoint(this.settings.bbtEndpoint);
		this.active = true;
		this.configure();
		this.addSettingTab(new CmdsZoteroSettingsTab(this.app, this));
		this.registerView(VIEW_TYPE_REFERENCES, leaf => new ReferencesView(leaf, this));
		this.registerView(VIEW_TYPE_ANNOTATIONS, leaf => new AnnotationsView(leaf, this));
		this.registerEditorSuggest(new CitekeySuggest(this));

		this.addCommand({ id: "insert-citation", name: "Insert citation from Zotero", editorCallback: (editor: Editor) => {
			void this.run(async () => { editor.replaceSelection(await this.bbt.cayw()); });
		} });
		this.addCommand({ id: "refresh-index", name: "Refresh citekey index", callback: () => { void this.refreshIndex(); } });
		this.addCommand({ id: "search-library", name: "Search literature", callback: () => { void this.pick(entry => this.showActions(entry)); } });
		this.addCommand({ id: "open-pdf-at-page", name: "Open source PDF at page", editorCallback: (editor: Editor) => {
			const cursor = editor.getCursor();
			new PageJumpModal(this.app, citekeyAtCursor(editor.getLine(cursor.line), cursor.ch, editor.getSelection()), (key, page) => {
				void this.run(async () => { await this.openPdf(await this.requireEntry(key), page); });
			}).open();
		} });
		this.addCommand({ id: "import-literature-note", name: "Import literature note", callback: () => { void this.pick(entry => { void this.previewImport(entry); }); } });
		this.addCommand({ id: "update-all-literature-notes", name: "Update all owned literature notes", callback: () => { void this.updateAllLiteratureNotes(); } });
		this.addCommand({ id: "insert-bibliography", name: "Insert bibliography", editorCallback: (editor: Editor) => {
			void this.pick(entry => { void this.run(async () => { editor.replaceSelection(await this.bbt.bibliography(entry)); }); });
		} });
		this.addCommand({ id: "open-references", name: "Open references sidebar", callback: () => { void this.activateView(VIEW_TYPE_REFERENCES); } });
		this.addCommand({ id: "open-annotations", name: "Open annotations sidebar", callback: () => { void this.activateView(VIEW_TYPE_ANNOTATIONS); } });
		this.addCommand({ id: "find-citing-notes", name: "Find notes citing a source", callback: () => { void this.pick(entry => { void this.showCitingNotes(entry); }); } });
		this.addCommand({ id: "copy-hookmark-link", name: "Copy Hookmark-compatible link", callback: () => { void this.pick(entry => { void this.copyLink(entry.title, entry.zoteroSelectURI); }); } });
		this.addCommand({ id: "copy-note-link", name: "Copy stable literature note link", callback: () => { void this.pick(entry => { void this.run(() => this.copyNoteLink(entry)); }); } });
		this.addCommand({ id: "diagnose-links", name: "Diagnose index and links", callback: () => { void this.showDiagnostics(); } });
		this.addCommand({ id: "find-vault-links", name: "Find literature across vaults", callback: () => { void this.pick(entry => { void this.showVaultLinks(entry); }); } });
		this.addRibbonIcon("library", "Search literature", () => { void this.pick(entry => this.showActions(entry)); });
		this.addRibbonIcon("highlighter", "Zotero annotations", () => { void this.activateView(VIEW_TYPE_ANNOTATIONS); });

		this.registerObsidianProtocolHandler("cmds-zotero", params => {
			void this.run(async () => {
				const request = parseProtocolRequest(params, this.app.vault.getName());
				const result = await this.service.resolve({ itemKey: request.itemKey, libraryID: request.libraryID });
				if (result.status !== "resolved") throw new Error(`Could not resolve this source: ${result.status}. Refresh the index and retry.`);
				if (request.target === "pdf") await this.openPdf(result.entry, request.page ?? 1, request.annotation);
				else if (request.target === "import") await this.previewImport(result.entry);
				else await this.openNote(result.entry);
			});
		});
		this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
			const view = leaf?.view;
			if (view instanceof MarkdownView) this.lastView = view;
		}));
		this.registerEvent(this.app.metadataCache.on("changed", file => { if (file.extension === "md") this.scheduleMap(); }));
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleMap()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleMap()));
	}

	private configure(): void {
		this.bbt = new BbtService(this.settings);
		const indexService: IndexService = new IndexService(this.bbt, new VaultIndexStorage(this.app, this.settings.zoteroIndexPath, () => this.active && this.index === indexService), () => this.settings.indexMaxAgeMinutes);
		this.index = indexService;
		const links: VaultLinks = new VaultLinks(this.app, () => this.settings, () => this.active && this.links === links);
		this.links = links;
		this.importer = new ImportService(this.app, this.bbt, () => this.settings);
		const pdfText: PdfTextService = new PdfTextService(this.app, undefined, (): boolean => this.active && this.index === indexService && this.pdfText === pdfText);
		this.pdfText = pdfText;
		const onIndex = async (index: ZoteroIndex): Promise<void> => {
			if (!this.active || this.index !== indexService) return;
			const changed = this.lastIndex?.generatedAt !== index.generatedAt;
			this.lastIndex = index;
			if (changed) { this.bibliographyCache.clear(); await this.links.publish(index); this.refreshViews(); }
		};
		this.service = new IngestAPI(this.app, this.bbt, this.index, this.links, onIndex, (action, request, now) => this.agentHost(action, request, now, onIndex, indexService, pdfText));
	}


	private async agentHost(action: AgentAction, request: unknown, now: Date, onIndex: (index: ZoteroIndex) => Promise<void>, indexToken: IndexService, pdfToken: PdfTextService): Promise<ActionHost> {
		const reader = new ObsidianVaultReader(this.app);
		const index = await indexToken.peek();
		const adapter = this.app.vault.adapter;
		const indexExists = await adapter.exists(this.settings.zoteroIndexPath);
		const root = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
		const bbtInfo = action === "connection" ? await this.bbt.capabilities().then(value => ({ reachable: true, zotero: value.zotero, betterbibtex: value.betterbibtex }), error => ({ reachable: false, error: error instanceof Error ? error.message : "BBT unreachable" })) : { reachable: null };
		const enabled = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
		const connection = buildConnection({
			mode: "live", obsidian: "ok", pluginVersion: this.manifest.version, pluginApiVersions: [1, 2], pluginEnabled: true, bbt: bbtInfo,
			index: { source: index ? "plugin" : "none", path: this.settings.zoteroIndexPath, generatedAt: index?.generatedAt ?? null, count: index?.count ?? null, complete: index?.complete ?? null, schemaVersion: index?.schemaVersion ?? null },
			maxAgeMinutes: this.settings.indexMaxAgeMinutes, legacyPluginEnabled: enabled ? enabled.has("cmds-link-zotero") : null,
			git: root ? await probeGit(root, this.settings.zoteroIndexPath) : null, now,
		});
		const host: ActionHost = {
			vault: this.app.vault.getName(), now, connection, settings: this.settings,
			indexView: index ? { index, ageMinutes: connection.index.ageMinutes ?? Number.POSITIVE_INFINITY, stale: connection.index.stale !== false } : null,
			indexFailure: index ? null : indexExists ? { reason: "index-invalid", message: "The index file exists but failed validation; run refresh explicitly." } : { reason: "index-missing", message: "No validated Zotero index is available; run refresh explicitly." }, reader,
			bibliography: (entry, style) => this.bibliographyForStyle(entry, style), bibliographyReason: null,
			vaultLinks: (entry, current) => this.links.find(entry, current),
			pdfCache: {
				list: async dir => { await assertVaultBoundary(this.app, dir); return (await adapter.exists(dir)) ? (await adapter.list(dir)).files.map(path => path.split("/").pop() ?? path) : []; },
				read: async path => {
					if (!root) return null;
					try {
						await assertVaultBoundary(this.app, path);
						const bytes = (await readLocalFile(nodePath.join(root, relativePath(path)), { maxBytes: 32 * 1024 * 1024, minBytes: 0, magic: () => true })).bytes;
						return Buffer.from(bytes).toString("utf8");
					} catch { return null; }
				},
				statLocal: async path => { try { if (await fs.realpath(path) !== path) return null; const stat = await fs.lstat(path); return stat.isFile() && !stat.isSymbolicLink() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null; } catch { return null; } },
				fileHash: async path => {
					if (!root) return null;
					try { await assertVaultBoundary(this.app, path); const full = nodePath.join(root, relativePath(path)); const bytes = (await readLocalFile(full, { maxBytes: 64 * 1024 * 1024, minBytes: 5, magic: ["255044462d"], label: "PDF" })).bytes; return { sha256: createHash("sha256").update(bytes).digest("hex"), absolutePath: full }; } catch { return null; }
				},
			},
			vaultPdfPaths: async () => this.app.vault.getFiles().filter(file => file.extension.toLowerCase() === "pdf").map(file => file.path).sort(),
		};
		host.refresh = async (refresh: RefreshRequest) => {
			const outcome = await indexToken.refresh({ force: refresh.ifOlderThanMinutes === undefined, ...(refresh.ifOlderThanMinutes ? { ifOlderThanMs: refresh.ifOlderThanMinutes * 60000 } : {}) });
			await onIndex(outcome.index);
			return { host: await this.agentHost("info", {}, new Date(), onIndex, indexToken, pdfToken), refreshed: outcome.refreshed, reason: outcome.reason, ageMinutesBefore: outcome.ageMinutesBefore };
		};
		host.extractPdf = async (target, pdfRequest: PdfTextRequest) => {
			if (!target.localPath) throw new Error("The PDF file is unavailable.");
			if (target.item && target.attachment.key) {
				const entry = index?.entries.find(candidate => candidate.id === target.item?.id);
				if (!entry) throw new Error("The PDF parent item is no longer in the index.");
				return pdfToken.extract({ kind: "attachment", libraryType: entry.libraryType, libraryID: entry.libraryID, attachmentKey: target.attachment.key, id: entry.id, path: target.localPath }, { force: pdfRequest.force });
			}
			return pdfToken.extract({ kind: "file", path: target.attachment.path ?? "", absolutePath: target.localPath }, { force: pdfRequest.force });
		};
		host.applyReconcile = async result => applyReconcile({
			read: async path => { await assertVaultBoundary(this.app, path); const file = this.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error(`Hub not found: ${path}`); return this.app.vault.read(file); },
			file: path => { const file = this.app.vault.getAbstractFileByPath(path); return file instanceof TFile ? file : null; },
			processFrontMatter: async (file, change) => {
				await assertVaultBoundary(this.app, file.path);
				const current = this.app.vault.getAbstractFileByPath(file.path);
				if (!(current instanceof TFile)) return Promise.reject(new Error(`Hub not found: ${file.path}`));
				return this.app.fileManager.processFrontMatter(current, (fm: Record<string, unknown>) => {
					const currentEnabled = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
					if (!currentEnabled || currentEnabled.has("cmds-link-zotero")) throw new Error("Legacy plugin state changed before apply.");
					change(fm);
				});
			},
			canWrite: () => this.active && this.index === indexToken && this.pdfText === pdfToken,
			snapshot: async () => {
				const current = await indexToken.peek();
				const bbtReachable = await this.bbt.isReachable();
				const pdfPaths = await host.vaultPdfPaths();
				const checked = new Date();
				const currentEnabled = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
				return { index: current, indexValid: current !== null && validateIndex(current), indexComplete: current?.complete === true, indexFresh: indexToken.isStale(current, checked.getTime()) === false, live: this.active && this.index === indexToken && this.pdfText === pdfToken, bbtReachable, legacyPluginEnabled: currentEnabled ? currentEnabled.has("cmds-link-zotero") : null, vault: this.app.vault.getName(), pdfPaths, now: checked, expiresAt: current ? Date.parse(current.generatedAt) + (this.settings.indexMaxAgeMinutes + 1) * 60000 : 0 };
			},
			yaml: { parse: parseYaml, stringify: stringifyYaml },
		}, result);
		return host;
	}

	async saveSettings(next: CmdsZoteroSettings): Promise<void> {
		if (this.service.busy) throw new Error("Wait for index refresh to finish before changing configuration.");
		const settings = normalizeSettings(next);
		settings.bbtEndpoint = validateEndpoint(settings.bbtEndpoint);
		relativePath(settings.zoteroIndexPath);
		relativePath(settings.outputFolder);
		relativePath(settings.imageFolder);
		await this.saveData(settings);
		this.service.dispose();
		this.bbt.dispose();
		this.settings = settings;
		this.lastIndex = null;
		this.bibliographyCache.clear();
		this.configure();
		this.refreshViews();
	}

	onunload(): void {
		this.active = false;
		this.service?.dispose();
		this.bbt?.dispose();
		if (this.mapTimer !== undefined) window.clearTimeout(this.mapTimer);
	}

	/** Entries from the most recently loaded index; empty until the index has been read once. */
	cachedEntries(): ZoteroIndexEntry[] { return this.lastIndex?.entries ?? []; }

	/** Loads (or refreshes) the index in the background without surfacing a modal; errors become a single notice. */
	warmIndex(force = false): Promise<void> {
		if (this.warming) return this.warming;
		this.warming = this.run(async () => { await this.service.ensureIndex(force); }).finally(() => { this.warming = null; });
		return this.warming;
	}

	lastMarkdownView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;
		return this.lastView && this.lastView.leaf.view === this.lastView ? this.lastView : null;
	}

	/** CSL bibliography text for one entry, cached per index generation and style; concurrent requests share one flight. */
	bibliographyFor(entry: ZoteroIndexEntry): Promise<string> { return this.bibliographyForStyle(entry, this.settings.bibliographyStyle); }

	private bibliographyForStyle(entry: ZoteroIndexEntry, style: string): Promise<string> {
		const key = `${entry.id}|${style}`;
		const cached = this.bibliographyCache.get(key);
		if (cached !== undefined) return Promise.resolve(cached);
		const flight = this.bibliographyFlights.get(key);
		if (flight) return flight;
		const rendered = style === this.settings.bibliographyStyle
			? this.bbt.bibliography(entry)
			: rpc(this.settings.bbtEndpoint, "item.bibliography", [[entry.citekey], { id: style, contentType: "text" }, entry.libraryID], this.settings.requestTimeoutMs).then(value => {
				if (typeof value !== "string") throw new Error("Invalid BBT bibliography response");
				return value;
			});
		const request = rendered.then(text => { const trimmed = text.trim(); this.bibliographyCache.set(key, trimmed); return trimmed; }).finally(() => { this.bibliographyFlights.delete(key); });
		this.bibliographyFlights.set(key, request);
		return request;
	}

	private refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REFERENCES)) if (leaf.view instanceof ReferencesView) void leaf.view.render();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS)) if (leaf.view instanceof AnnotationsView) leaf.view.render();
	}

	async activateView(type: string): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(type)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) throw new Error("No sidebar is available for this view.");
		if (!existing) await leaf.setViewState({ type, active: true });
		await this.app.workspace.revealLeaf(leaf);
		void this.warmIndex();
	}

	private scheduleMap(): void {
		if (this.mapTimer !== undefined) window.clearTimeout(this.mapTimer);
		this.mapTimer = window.setTimeout(() => {
			if (this.active && this.lastIndex) void this.links.publish(this.lastIndex).catch(() => { new Notice("Could not update cross-vault note map. Refresh the index to retry."); });
		}, 500);
	}

	async run(action: () => Promise<void>): Promise<void> {
		try { await action(); }
		catch (error) { new Notice(error instanceof Error ? error.message : "Operation failed."); }
	}

	async refreshIndex(): Promise<void> {
		const notice = new Notice("Refreshing literature index…", 0);
		await this.run(async () => {
			const result = await this.service.ensureIndex(true);
			new Notice(`Index refreshed: ${result.index.count} entries. ${result.index.complete ? "Complete." : "Review diagnostics for unresolved records."}`);
		});
		notice.hide();
	}

	async pick(choose: (entry: ZoteroIndexEntry) => void): Promise<void> {
		await this.run(async () => {
			const { index } = await this.service.ensureIndex();
			if (!index.entries.length) throw new Error("No literature entries. Check Zotero and refresh the index.");
			new PickerModal(this.app, index.entries, entry => `${entry.title} — @${entry.citekey} · ${entry.year} · library ${entry.libraryID}`, choose).open();
		});
	}

	private async requireEntry(citekey: string): Promise<ZoteroIndexEntry> {
		const result = await this.service.resolve({ citekey });
		if (result.status === "resolved") return result.entry;
		throw new Error(result.status === "ambiguous" ? "More than one entry uses this citekey. Use Search literature to select a library." : `Could not resolve citekey: ${result.status}.`);
	}

	private showActions(entry: ZoteroIndexEntry): void {
		new ActionsModal(this.app, entry.title, [
			{ name: "Open in Zotero", action: () => { window.open(entry.zoteroSelectURI); } },
			{ name: "Open literature note", action: () => this.openNote(entry) },
			{ name: "Preview literature import", action: () => this.previewImport(entry) },
			{ name: "Open PDF page", action: () => this.openPdf(entry, 1) },
			{ name: "Show annotations in sidebar", action: async () => { await this.activateView(VIEW_TYPE_ANNOTATIONS); for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS)) if (leaf.view instanceof AnnotationsView) leaf.view.pin(entry); } },
			{ name: "Find notes citing this source", action: () => this.showCitingNotes(entry) },
			{ name: "Copy Hookmark-compatible link", action: () => this.copyLink(entry.title, entry.zoteroSelectURI) },
			{ name: "Copy stable note link", action: () => this.copyNoteLink(entry) },
			{ name: "Copy PDF page link", action: () => { new PageJumpModal(this.app, entry.citekey, (_key, page) => { void this.run(() => this.openPdf(entry, page, undefined, true)); }).open(); } },
			{ name: "Find notes across vaults", action: () => this.showVaultLinks(entry) },
		]).open();
	}

	async previewImport(entry: ZoteroIndexEntry): Promise<void> {
		await this.run(async () => {
			const { index } = await this.service.ensureIndex();
			const preview = await this.importer.preview(entry, index);
			new ImportPreviewModal(this.app, preview, async () => {
				const result = await this.importer.apply(preview);
				if (result.conflicts.length) throw new Error(result.conflicts.join("; "));
				await this.app.workspace.openLinkText(result.path, "", true);
				this.scheduleMap();
				new Notice("Literature note imported. User-written sections were preserved.");
			}).open();
		});
	}

	/** Re-renders managed sections of every note this plugin owns; conflicts are reported and skipped, never forced. */
	async updateAllLiteratureNotes(): Promise<void> {
		await this.run(async () => {
			const { index } = await this.service.ensureIndex();
			const owned = index.entries.filter(entry => this.links.localFiles(entry, index).length > 0);
			if (!owned.length) throw new Error("No owned literature notes were found. Import a note first.");
			const notice = new Notice(`Updating ${owned.length} literature notes…`, 0);
			const updated: string[] = [];
			const unchanged: string[] = [];
			const skipped: string[] = [];
			try {
				for (const entry of owned) {
					try {
						const preview = await this.importer.preview(entry, index);
						if (preview.conflicts.length) { skipped.push(`@${entry.citekey}: ${preview.conflicts.join("; ")}`); continue; }
						if (!preview.exists) { skipped.push(`@${entry.citekey}: note was not created by this plugin; use Import literature note`); continue; }
						const result = await this.importer.apply(preview);
						if (result.conflicts.length) skipped.push(`@${entry.citekey}: ${result.conflicts.join("; ")}`);
						else (result.changed ? updated : unchanged).push(result.path);
					} catch (error) { skipped.push(`@${entry.citekey}: ${error instanceof Error ? error.message : "failed"}`); }
				}
			} finally { notice.hide(); }
			this.scheduleMap();
			new ReportModal(this.app, "Literature note batch update", [`Updated: ${updated.length}`, `Unchanged: ${unchanged.length}`, `Skipped: ${skipped.length}`, "", ...updated.map(path => `updated  ${path}`), ...skipped.map(line => `skipped  ${line}`)].join("\n")).open();
		});
	}

	/** Vault-wide scan for notes citing an entry's citekey or one of its previous citekeys. */
	async showCitingNotes(entry: ZoteroIndexEntry): Promise<void> {
		const keys = new Set([entry.citekey, ...entry.citekeyHistory]);
		const hits: { file: TFile; line: number; count: number }[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const text = await this.app.vault.cachedRead(file);
			if (![...keys].some(key => text.includes(`@${key}`))) continue;
			const occurrences = scanCitations(text).filter(item => keys.has(item.citekey));
			if (occurrences.length) hits.push({ file, line: occurrences[0].line, count: occurrences.length });
		}
		hits.sort((a, b) => b.count - a.count || a.file.path.localeCompare(b.file.path));
		new ActionsModal(this.app, `Notes citing @${entry.citekey}`, hits.length ? hits.map(hit => ({
			name: hit.file.path, description: `${hit.count} citation${hit.count === 1 ? "" : "s"}`,
			action: async () => { const leaf = this.app.workspace.getLeaf(false); await leaf.openFile(hit.file, { eState: { line: hit.line } }); },
		})) : [{ name: "No citing notes", description: "No [@citekey], @citekey, or [[@citekey]] occurrences were found in this vault.", action: () => {} }]).open();
	}

	async openPdf(entry: ZoteroIndexEntry, page: number, annotationKey?: string, copy = false): Promise<void> {
		let attachments = entry.attachments.filter(a => a.path?.toLowerCase().endsWith(".pdf") || a.annotations.length > 0);
		if (annotationKey) attachments = attachments.filter(a => a.annotations.some(annotation => annotation.key === annotationKey));
		if (!attachments.length) throw new Error(entry.attachmentStatus === "unavailable" ? "Attachment lookup failed. Refresh the index before opening this PDF." : "No matching PDF attachment is indexed.");
		const open = (attachment: typeof attachments[number]): void => {
			const uri = pdfURI(attachment.openURI, page, annotationKey);
			if (copy) void this.copyLink(`${entry.title} — page ${page}`, uri);
			else window.open(uri);
		};
		if (attachments.length === 1) open(attachments[0]);
		else new PickerModal(this.app, attachments, a => a.title || a.key, open, "Choose a PDF attachment…").open();
	}

	async openNote(entry: ZoteroIndexEntry): Promise<void> {
		const { index } = await this.service.ensureIndex();
		const files = this.links.localFiles(entry, index);
		if (!files.length) throw new Error("No literature note exists in this vault. Preview an import first.");
		const open = (file: TFile): void => { void this.app.workspace.getLeaf(false).openFile(file); };
		if (files.length === 1) open(files[0]);
		else new PickerModal(this.app, files, file => file.path, open, "Choose a literature note…").open();
	}

	async copyNoteLink(entry: ZoteroIndexEntry): Promise<void> {
		const { index } = await this.service.ensureIndex();
		if (!this.links.localFiles(entry, index).length) throw new Error("Import a literature note before copying its note link.");
		await this.copyLink(entry.title, noteDeepLink(this.app.vault.getName(), entry));
	}

	async copyLink(title: string, uri: string): Promise<void> {
		await navigator.clipboard.writeText(markdownLink(title, uri));
		new Notice("Markdown link copied. Paste it into Hookmark or a note.");
	}

	async showVaultLinks(entry: ZoteroIndexEntry): Promise<void> {
		const { index } = await this.service.ensureIndex();
		const report = await this.links.find(entry, index);
		new ActionsModal(this.app, "Linked literature notes", [
			...report.links.map(link => ({ name: `${link.vault}: ${link.path}`, action: () => { window.open(link.uri); } })),
			...(report.warnings.length ? [{ name: "Unavailable vaults", description: report.warnings.join("\n"), action: () => {} }] : []),
			...(!report.links.length ? [{ name: "No linked notes", description: "Import a note, or refresh the index in each registered vault.", action: () => {} }] : []),
		]).open();
	}

	async showDiagnostics(): Promise<void> {
		await this.run(async () => {
			const result = await this.service.diagnose();
			new ReportModal(this.app, "Index and link diagnostics", `Generated: ${result.generatedAt}\nEntries: ${result.count}\nComplete: ${result.complete}\n\n` + (result.diagnostics.map(d => `[${d.severity}] ${d.code}: ${d.message}`).join("\n") || "No issues reported.")).open();
		});
	}
}
