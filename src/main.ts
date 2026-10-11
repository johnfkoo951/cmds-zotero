import { Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, TAbstractFile, TFile, TFolder, parseYaml, stringifyYaml } from "obsidian";
import { BbtService } from "./bbt";
import { IndexService, describeRefreshFailure, formatIndexAge, refreshRefusal, type CollectPrecondition } from "./index-service";
import { ImportService } from "./importer";
import { IngestAPI } from "./ingest-api";
import type { ActionHost, AgentAction, PdfTextRequest, RefreshRequest } from "./agent/actions";
import { buildConnection, formatStatus } from "./agent/connection";
import { ObsidianVaultReader } from "./obsidian-vault";
import { PdfTextService } from "./pdf/extract";
import { applyReconcile } from "./reconcile-apply";
import { probeGit } from "./git-probe";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { readLocalFile } from "./local-file";
import { hashLocalPdf } from "./pdf/file-hash";
import { validateIndex } from "./identity";
import { describeBbtError, transportReasonOf } from "./api/transport";
import { VaultLinks } from "./vault-links";
import { ownershipSummary, partitionOwnedNotes } from "./note-ownership"; // 0.5 R14
import { VaultIndexStorage, assertVaultBoundary, ensureCmdsIgnore, ensureDirectory, relativePath } from "./vault-storage";
import { EXPORT_TRANSLATORS, defaultSidecarPath, groupEntriesByLibrary, mergeExports, type StructuredExport } from "./agent/cites-core"; // 0.5 R10
import { resolveReferenceRows } from "./citations/reference-rows"; // 0.5 R10
import { normalizeSettings, validateEndpoint } from "./settings-data";
import { citekeyAtCursor, classifyLink, parseProtocolRequest, resolveOpenPdfTarget } from "./protocol";
import { pdfURI, noteDeepLink, markdownLink, obsidianOpenURI, type ParsedZoteroURI } from "./uris";
import { CmdsZoteroSettingsTab } from "./settings";
import { ActionsModal, ImportPreviewModal, PageJumpModal, PickerModal, ReportModal } from "./modals";
import { CitekeySuggest } from "./citations/suggest";
import { scanCitations } from "./citations/scan";
import { ReferencesView, VIEW_TYPE_REFERENCES } from "./views/references-view";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "./views/annotations-view";
import type { CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";

const LEGACY_PLUGIN_ID = "cmds-link-zotero";
const LEGACY_PLUGIN_MESSAGE = "The legacy cmds-link-zotero plugin is enabled beside CMDS Zotero and shares the index path; disable it before refreshing.";
/** After a failed background refresh, UI warm-ups return immediately for this long instead of re-hitting BBT. */
const WARM_BACKOFF_MS = 60_000;

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
	private warming: { promise: Promise<void>; force: boolean } | null = null;
	private warmFailedUntil = 0;
	/** Index generation (generatedAt, or "none") for which the offline Notice was already shown. */
	private noticedGeneration: string | null = null;
	private publish!: (index: ZoteroIndex) => Promise<void>;
	private lastView: MarkdownView | null = null;
	private pdfText!: PdfTextService;
	// 0.5 R4: shared status line (index age/staleness, legacy plugin, last BBT observation).
	private statusBar: HTMLElement | null = null;
	/** Last rendered status text/state; a re-render with the same key is skipped. */
	private renderedStatus: string | null = null;

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
		this.addCommand({ id: "copy-hookmark-link", name: "Copy Zotero item link (Hookmark-compatible)", callback: () => { void this.pick(entry => { void this.copyLink(entry.title, entry.zoteroSelectURI, true); }); } });
		this.addCommand({ id: "copy-note-link", name: "Copy literature note identity link (rename-safe)", callback: () => { void this.pick(entry => { void this.run(() => this.copyNoteLink(entry)); }); } });
		this.addCommand({ id: "diagnose-links", name: "Diagnose index and links", callback: () => { void this.showDiagnostics(); } });
		this.addCommand({ id: "find-vault-links", name: "Find literature across vaults", callback: () => { void this.pick(entry => { void this.showVaultLinks(entry); }); } });
		// 0.5 R15
		this.addCommand({ id: "copy-file-link", name: "Copy Obsidian file link (Hookmark-native)", callback: () => { void this.pick(entry => { void this.run(() => this.copyFileLink(entry)); }); } });
		this.addCommand({ id: "open-link-under-cursor", name: "Open link under cursor", editorCallback: (editor: Editor) => { void this.openLinkUnderCursor(editor); } });
		// 0.5 R10: pandoc-ready bibliography for the active note (index-local citation rows, one BBT export per library).
		this.addCommand({ id: "copy-csl-json", name: "Copy CSL-JSON for cited sources", callback: () => { void this.run(() => this.copyCslJsonForActiveNote()); } });
		this.addCommand({ id: "write-bibliography-sidecar", name: "Write pandoc bibliography sidecar for current note", callback: () => { void this.run(() => this.writeBibliographySidecar()); } });
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
		// 0.5 R13/F07: only Markdown notes and folders (which may contain notes) can change the note map; attachments never do.
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (this.affectsNoteMap(file) || oldPath.endsWith(".md")) this.scheduleMap(); }));
		this.registerEvent(this.app.vault.on("delete", file => { if (this.affectsNoteMap(file)) this.scheduleMap(); }));
		// 0.5 R4: status-bar item; click probes BBT once (no refresh); the minute tick only re-renders the age text.
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("cmds-zotero-status-bar", "mod-clickable");
		this.registerDomEvent(this.statusBar, "click", () => { void this.testConnection(); });
		this.registerInterval(window.setInterval(() => this.renderStatus(), 60_000));
		this.renderStatus();
		void this.warmIndex();
	}

	/** True when the legacy plugin that shares the index path is enabled; null when the plugin registry is unavailable. */
	private legacyPluginEnabled(): boolean | null {
		const enabled = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
		return enabled ? enabled.has(LEGACY_PLUGIN_ID) : null;
	}

	private configure(): void {
		this.bbt = new BbtService(this.settings);
		const canCollect: CollectPrecondition = () => this.legacyPluginEnabled() === true ? { ok: false, reason: "legacy-plugin-enabled", message: LEGACY_PLUGIN_MESSAGE } : { ok: true };
		const indexService: IndexService = new IndexService(this.bbt, new VaultIndexStorage(this.app, this.settings.zoteroIndexPath, () => this.active && this.index === indexService), () => this.settings.indexMaxAgeMinutes, canCollect);
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
			this.renderStatus(); // 0.5 R4
		};
		const bbt = this.bbt; // 0.5 R4: every real BBT outcome re-renders the status line
		bbt.onOutcome(() => { if (this.active && this.bbt === bbt) this.renderStatus(); });
		this.publish = onIndex;
		this.service = new IngestAPI(this.app, this.bbt, this.index, this.links, onIndex, (action, request, now) => this.agentHost(action, request, now, onIndex, indexService, pdfText));
	}


	private async agentHost(action: AgentAction, request: unknown, now: Date, onIndex: (index: ZoteroIndex) => Promise<void>, indexToken: IndexService, pdfToken: PdfTextService): Promise<ActionHost> {
		const reader = new ObsidianVaultReader(this.app);
		const index = await indexToken.peek();
		const adapter = this.app.vault.adapter;
		const indexExists = await adapter.exists(this.settings.zoteroIndexPath);
		// 0.5 R13/F11: the guarded local reader requires realpath === path, so a vault opened through a symlink must join
		// vault-relative paths onto the resolved base, not the path Obsidian was given.
		const root = adapter instanceof FileSystemAdapter ? await fs.realpath(adapter.getBasePath()).catch(() => adapter.getBasePath()) : null;
		const bbtInfo = action === "connection" ? await this.bbt.capabilities().then(value => ({ reachable: true, zotero: value.zotero, betterbibtex: value.betterbibtex }), (error: unknown) => { const reason = transportReasonOf(error); return { reachable: false, error: error instanceof Error ? error.message : "BBT unreachable", ...(reason ? { reason } : {}) }; }) : { reachable: null };
		const connection = buildConnection({
			mode: "live", obsidian: "ok", pluginVersion: this.manifest.version, pluginApiVersions: [1, 2], pluginEnabled: true, bbt: bbtInfo,
			index: { source: index ? "plugin" : "none", path: this.settings.zoteroIndexPath, generatedAt: index?.generatedAt ?? null, count: index?.count ?? null, complete: index?.complete ?? null, schemaVersion: index?.schemaVersion ?? null },
			maxAgeMinutes: this.settings.indexMaxAgeMinutes, legacyPluginEnabled: this.legacyPluginEnabled(),
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
					// 0.5 R13/F08: the shared guarded reader surfaces an oversized or non-PDF file by code; boundary failures stay null.
					try { await assertVaultBoundary(this.app, path); } catch { return null; }
					return hashLocalPdf(nodePath.join(root, relativePath(path)));
				},
			},
			vaultPdfPaths: async () => this.app.vault.getFiles().filter(file => file.extension.toLowerCase() === "pdf").map(file => file.path).sort(),
			// 0.5 R10: structured bibliography export and the sidecar store (vault-bounded; the private ignore file is ensured before every write).
			exportBibliography: (citekeys, format, libraryID) => this.bbt.export(citekeys, EXPORT_TRANSLATORS[format], libraryID),
			sidecar: {
				read: async path => {
					await assertVaultBoundary(this.app, path);
					const stat = await adapter.stat(path);
					if (!stat) return null;
					if (stat.type !== "file") throw new Error(`Sidecar path is a folder: ${path}`);
					if (stat.size > 32 * 1024 * 1024) throw new Error(`Existing file is too large to inspect: ${path}`);
					return adapter.read(path);
				},
				write: async (path, content) => {
					await assertVaultBoundary(this.app, path);
					if (!this.active || this.index !== indexToken) throw new Error("The plugin was reloaded; the sidecar was not written.");
					await ensureCmdsIgnore(this.app);
					await ensureDirectory(this.app, path);
					await adapter.write(path, content);
					return Buffer.byteLength(content);
				},
			},
		};
		host.refresh = async (refresh: RefreshRequest) => {
			const outcome = await indexToken.refresh({ force: refresh.ifOlderThanMinutes === undefined, ...(refresh.ifOlderThanMinutes ? { ifOlderThanMs: refresh.ifOlderThanMinutes * 60000 } : {}) });
			const { reason } = outcome;
			// The agent refresh action is an explicit publication: a snapshot that could not be revalidated is a failure, not a result.
			if (reason === "stale-fallback") throw refreshRefusal(outcome); // 0.5 R4: carries the typed cause
			await onIndex(outcome.index);
			return { host: await this.agentHost("info", {}, new Date(), onIndex, indexToken, pdfToken), refreshed: outcome.refreshed, reason, ageMinutesBefore: outcome.ageMinutesBefore };
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
					if (this.legacyPluginEnabled() !== false) throw new Error("Legacy plugin state changed before apply.");
					change(fm);
				});
			},
			canWrite: () => this.active && this.index === indexToken && this.pdfText === pdfToken,
			snapshot: async () => {
				const current = await indexToken.peek();
				const bbtReachable = await this.bbt.isReachable();
				const pdfPaths = await host.vaultPdfPaths();
				const checked = new Date();
				return { index: current, indexValid: current !== null && validateIndex(current), indexComplete: current?.complete === true, indexFresh: indexToken.isStale(current, checked.getTime()) === false, live: this.active && this.index === indexToken && this.pdfText === pdfToken, bbtReachable, legacyPluginEnabled: this.legacyPluginEnabled(), vault: this.app.vault.getName(), pdfPaths, now: checked, expiresAt: current ? Date.parse(current.generatedAt) + (this.settings.indexMaxAgeMinutes + 1) * 60000 : 0 };
			},
			yaml: { parse: parseYaml, stringify: stringifyYaml },
		}, result);
		return host;
	}

	/**
	 * Reconfigures services. Blocked while a refresh, a writing job, or any BBT collection (a background warm-up
	 * included) is in flight; a read served from the snapshot never blocks. `bbt.dispose()` still aborts anything
	 * that slipped past the check, and the old storage's write guard rejects a late replacement.
	 */
	async saveSettings(next: CmdsZoteroSettings): Promise<void> {
		if (this.service.busy) throw new Error(this.busyMessage());
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
		this.warmFailedUntil = 0;
		this.noticedGeneration = null;
		this.warming = null;
		this.renderedStatus = null; // 0.5 R4
		this.configure();
		await this.peekPublished().catch(() => null);
		this.refreshViews();
		void this.warmIndex();
	}

	onunload(): void {
		this.active = false;
		this.service?.dispose();
		this.bbt?.dispose();
		if (this.mapTimer !== undefined) window.clearTimeout(this.mapTimer);
	}

	/** Entries from the most recently loaded index; empty until the index has been read once. */
	cachedEntries(): ZoteroIndexEntry[] { return this.lastIndex?.entries ?? []; }

	/** True once a validated snapshot has been published, even one with zero entries; UI negatives need this. */
	indexLoaded(): boolean { return this.lastIndex !== null; }

	/** True while an explicit (forced) warm-up is in flight, so a refresh control can be disabled meanwhile. */
	forcedWarmActive(): boolean { return this.warming?.force === true; }

	/** Age of the loaded snapshot in minutes, or null when none is loaded or its timestamp is unusable. */
	cachedIndexAgeMinutes(): number | null { return this.index.ageMinutes(this.lastIndex); }

	/** True when the loaded snapshot is older than the configured maximum age; false when fresh or not loaded. */
	cachedIndexStale(): boolean { return this.index.isStale(this.lastIndex) === true; }

	/** True while background warm-ups are backing off after a failed refresh; UI callers may skip `warmIndex()` then. */
	warmBackoffActive(): boolean { return Date.now() < this.warmFailedUntil; }

	/** Publishes the newest validated snapshot from disk (fresh or stale) without contacting BBT; null when none exists. */
	private async peekPublished(): Promise<ZoteroIndex | null> {
		const service = this.service;
		const snapshot = await service.peekIndex();
		if (snapshot && this.service === service) await this.publish(snapshot);
		return snapshot;
	}

	/**
	 * Background warm-up: peek first so `cachedEntries()` fills from disk, then refresh only a stale or missing snapshot.
	 * After a failure, non-forced warm-ups return immediately for `WARM_BACKOFF_MS`; the failure is announced once per
	 * index generation with a mapped message. A forced warm-up (explicit refresh button) never joins a non-forced flight.
	 */
	warmIndex(force = false): Promise<void> {
		const current = this.warming;
		if (current && (current.force || !force)) return current.promise;
		if (!force && this.warmBackoffActive()) return Promise.resolve();
		const flight = { force, promise: Promise.resolve() };
		flight.promise = (current ? current.promise.catch(() => undefined) : Promise.resolve())
			.then(() => this.warm(force))
			.finally(() => { if (this.warming === flight) this.warming = null; });
		this.warming = flight;
		return flight.promise;
	}

	private async warm(force: boolean): Promise<void> {
		const service = this.service;
		try {
			const snapshot = force ? null : await this.peekPublished();
			if (snapshot && this.index.isStale(snapshot) === false) return;
			if (!force && this.warmBackoffActive()) return;
			const outcome = await service.ensureIndex(force);
			// A warm-up aborted by saveSettings()/onunload() resolves as a cancelled stale-fallback; it must not report
			// against the new configuration or start its backoff.
			if (!this.active || this.service !== service) return;
			if (outcome.reason !== "stale-fallback") return;
			this.reportWarmFailure(refreshRefusal(outcome), outcome.index, force); // 0.5 R4: the Notice gets the observation wording
		} catch (error) {
			if (!this.active || this.service !== service) return;
			this.reportWarmFailure(error, this.lastIndex, force);
		}
	}

	/** Starts the retry backoff and shows the mapped failure once per index generation; a forced warm-up always reports. */
	private reportWarmFailure(error: unknown, snapshot: ZoteroIndex | null, force: boolean): void {
		this.warmFailedUntil = Date.now() + WARM_BACKOFF_MS;
		const generation = snapshot?.generatedAt ?? "none";
		if (!force && this.noticedGeneration === generation) return;
		this.noticedGeneration = generation;
		new Notice(describeRefreshFailure(error, this.settings.bbtEndpoint, this.index.ageMinutes(snapshot)));
	}

	/**
	 * The index for a human read: the newest validated snapshot regardless of age (BBT is not contacted; a stale snapshot
	 * is labelled once per generation and revalidated in the background), else a load that falls back on failure.
	 */
	private async loadIndexForRead(): Promise<ZoteroIndex> {
		const snapshot = await this.peekPublished();
		if (!snapshot) {
			try { return (await this.service.ensureIndex()).index; }
			catch (error) { throw new Error(describeRefreshFailure(error, this.settings.bbtEndpoint, null)); }
		}
		if (this.index.isStale(snapshot) === true) {
			if (this.noticedGeneration !== snapshot.generatedAt) {
				this.noticedGeneration = snapshot.generatedAt;
				new Notice(`Using the saved index from ${formatIndexAge(this.index.ageMinutes(snapshot))} ago; Zotero was not contacted. Refresh the index to update it.`);
			}
			void this.warmIndex();
		}
		return snapshot;
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
		// 0.5 R4: every style goes through BbtService so the call is observed (status line) and typed uniformly.
		const request = this.bbt.bibliography(entry, style).then(text => { const trimmed = text.trim(); this.bibliographyCache.set(key, trimmed); return trimmed; }).finally(() => { this.bibliographyFlights.delete(key); });
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
			let result: Awaited<ReturnType<IngestAPI["ensureIndex"]>>;
			try { result = await this.service.ensureIndex(true); }
			catch (error) { throw new Error(describeRefreshFailure(error, this.settings.bbtEndpoint, this.cachedIndexAgeMinutes())); }
			new Notice(`Index refreshed: ${result.index.count} entries. ${result.index.complete ? "Complete." : "Review diagnostics for unresolved records."}`);
		});
		notice.hide();
	}

	async pick(choose: (entry: ZoteroIndexEntry) => void): Promise<void> {
		await this.run(async () => {
			const index = await this.loadIndexForRead();
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
			{ name: "Copy Zotero item link (Hookmark-compatible)", action: () => this.copyLink(entry.title, entry.zoteroSelectURI, true) },
			{ name: "Copy literature note identity link (rename-safe)", action: () => this.copyNoteLink(entry) },
			{ name: "Copy Obsidian file link (Hookmark-native)", action: () => this.copyFileLink(entry) },
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

	/**
	 * Re-renders managed sections of every note this plugin owns; conflicts are reported and skipped, never forced.
	 * 0.5 R14: owned = resolves to an entry, lies in the output folder and carries the owner marker; other linked notes are
	 * counted once and never reach the BBT-backed preview.
	 */
	async updateAllLiteratureNotes(): Promise<void> {
		await this.run(async () => {
			const index = await this.loadIndexForRead();
			const partition = await partitionOwnedNotes(index, this.app.vault.getMarkdownFiles().map(file => ({ path: file.path, basename: file.basename, frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter })), this.settings.outputFolder, path => {
				const file = this.app.vault.getAbstractFileByPath(path);
				return file instanceof TFile ? this.app.vault.cachedRead(file) : Promise.resolve("");
			});
			const owned = partition.owned;
			if (!owned.length && !partition.linkedNotOwned.length) throw new Error("No owned literature notes were found. Import a note first.");
			// 0.5 R4: every update renders bibliography text through BBT; probe once and stop with one mapped line instead of N identical skips.
			try { await this.bbt.capabilities(); }
			catch (error) { throw new Error(`${describeBbtError(error)} Updating literature notes needs Better BibTeX for bibliography text; no note was changed.`); }
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
			new ReportModal(this.app, "Literature note batch update", [`Updated: ${updated.length}`, `Unchanged: ${unchanged.length}`, `Skipped: ${skipped.length}`, ownershipSummary(partition), "", ...updated.map(path => `updated  ${path}`), ...skipped.map(line => `skipped  ${line}`)].join("\n")).open();
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

	async openPdf(entry: ZoteroIndexEntry, page: number, annotationKey?: string, copy = false, attachmentKey?: string): Promise<void> {
		let attachments = entry.attachments.filter(a => a.path?.toLowerCase().endsWith(".pdf") || a.annotations.length > 0);
		if (attachmentKey) attachments = attachments.filter(a => a.key === attachmentKey); // 0.5 R15
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
		const index = await this.loadIndexForRead();
		const files = this.links.localFiles(entry, index);
		if (!files.length) throw new Error("No literature note exists in this vault. Preview an import first.");
		const open = (file: TFile): void => { void this.app.workspace.getLeaf(false).openFile(file); };
		if (files.length === 1) open(files[0]);
		else new PickerModal(this.app, files, file => file.path, open, "Choose a literature note…").open();
	}

	async copyNoteLink(entry: ZoteroIndexEntry): Promise<void> {
		const index = await this.loadIndexForRead();
		if (!this.links.localFiles(entry, index).length) throw new Error("Import a literature note before copying its note link.");
		await this.copyLink(entry.title, noteDeepLink(this.app.vault.getName(), entry), true);
	}

	/** `bare` drops the `<…>` around the URL; only the Hookmark copy commands use it (notes and sidebars keep the bracketed form). */
	async copyLink(title: string, uri: string, bare = false): Promise<void> {
		await navigator.clipboard.writeText(markdownLink(title, uri, { bare }));
		new Notice("Markdown link copied. Paste it into Hookmark or a note.");
	}

	async showVaultLinks(entry: ZoteroIndexEntry): Promise<void> {
		const index = await this.loadIndexForRead();
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
			new ReportModal(this.app, "Index and link diagnostics", `${this.statusLine()}\nGenerated: ${result.generatedAt}\nEntries: ${result.count}\nComplete: ${result.complete}\n\n` + (result.diagnostics.map(d => `[${d.severity}] ${d.code}: ${d.message}`).join("\n") || "No issues reported.")).open();
		});
	}

	// 0.5 R15 — Hookmark-native file link and "Open link under cursor".

	/** Copies `obsidian://open?vault=&file=` for the entry's literature note: the address Hookmark shows inside the note; breaks on rename. */
	async copyFileLink(entry: ZoteroIndexEntry): Promise<void> {
		const index = await this.loadIndexForRead();
		const files = this.links.localFiles(entry, index);
		if (!files.length) throw new Error("Import a literature note before copying its file link.");
		const copy = (file: TFile): void => { void this.copyLink(entry.title, obsidianOpenURI(this.app.vault.getName(), file.path), true); };
		if (files.length === 1) copy(files[0]);
		else new PickerModal(this.app, files, file => file.path, copy, "Choose a literature note…").open();
	}

	/** zotero://select opens Zotero; zotero://open-pdf routes through openPdf via the attachment key; @citekey opens the actions modal. */
	async openLinkUnderCursor(editor: Editor): Promise<void> {
		const cursor = editor.getCursor();
		const link = classifyLink(editor.getLine(cursor.line), cursor.ch, editor.getSelection());
		await this.run(async () => {
			if (link.kind === "select") { window.open(link.uri); return; }
			if (link.kind === "open-pdf") { await this.openPdfLink(link.parsed); return; }
			if (link.kind === "citekey") { this.showActions(await this.requireEntry(link.citekey)); return; }
			throw new Error("No Zotero link or @citekey under the cursor.");
		});
	}

	/** Resolves an open-pdf URI (attachment key, or a parent key as Zotero itself accepts) against the index and honours page/annotation. */
	private async openPdfLink(parsed: ParsedZoteroURI): Promise<void> {
		const target = resolveOpenPdfTarget(await this.loadIndexForRead(), parsed);
		if (target.kind === "not-found") throw new Error("This PDF link is not in the index. Refresh the index; the link may also belong to another library.");
		if (target.kind === "ambiguous") throw new Error("More than one entry owns this item key. Use Search literature to select a library.");
		await this.openPdf(target.entry, parsed.page ?? 1, parsed.annotationKey, false, target.kind === "attachment" ? target.attachmentKey : undefined);
	}

	// 0.5 R4: one status line for the status bar, both sidebar headers and the diagnostics report.
	statusLine(now = new Date(), compact = false): string {
		const outcome = this.bbt.lastOutcome;
		return formatStatus({
			count: this.lastIndex?.count ?? null,
			ageMinutes: this.index.ageMinutes(this.lastIndex, now.getTime()),
			stale: this.index.isStale(this.lastIndex, now.getTime()),
			legacyPluginEnabled: this.legacyPluginEnabled(),
			bbt: outcome ? { state: outcome.ok ? "ok" : "failed", at: outcome.at.toISOString(), ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.status !== undefined ? { status: outcome.status } : {}) } : { state: "untested" },
		}, now, compact);
	}

	/**
	 * Re-renders the status line everywhere it is shown; clock-only, never contacts BBT. Coalesced: a burst of BBT
	 * outcomes during a collection (one per attachment call) re-renders only when the rendered text or state changed.
	 */
	renderStatus(): void {
		if (!this.active) return;
		const now = new Date();
		const line = this.statusLine(now);
		const stale = this.cachedIndexStale();
		const failed = this.bbt.lastOutcome?.ok === false;
		const key = `${line}|${stale}|${failed}`;
		if (key === this.renderedStatus) return;
		this.renderedStatus = key;
		if (this.statusBar) {
			this.statusBar.setText(this.statusLine(now, true));
			this.statusBar.setAttr("title", line);
			this.statusBar.setAttr("aria-label", `${line}. Click to test the Better BibTeX connection.`);
			this.statusBar.toggleClass("is-stale", stale);
			this.statusBar.toggleClass("is-failed", failed);
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REFERENCES)) if (leaf.view instanceof ReferencesView) leaf.view.renderStatus(line);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS)) if (leaf.view instanceof AnnotationsView) leaf.view.renderStatus(line);
	}

	/** One capabilities probe (the settings "Test connection" logic) with a mapped Notice; never a refresh. */
	async testConnection(): Promise<void> {
		try {
			const capabilities = await this.bbt.capabilities();
			new Notice(`Connected: Zotero ${capabilities.zotero}; Better BibTeX ${capabilities.betterbibtex}.`);
		} catch (error) { new Notice(describeBbtError(error)); }
	}

	// 0.5 R13/F07: rename/delete of an attachment or image never changes which notes belong to which entry (a note renamed
	// away from `.md` is caught by the rename listener through its old path).
	private affectsNoteMap(file: TAbstractFile): boolean {
		return file instanceof TFolder || (file instanceof TFile && file.extension === "md");
	}

	// 0.5 R13/F18: the settings guard names what is holding the write gate so a user is not told to wait for nothing.
	private busyMessage(): string {
		const pending = this.service.pendingWrites();
		if (!pending.length) return "Wait for index refresh to finish before changing configuration.";
		return `Wait for the running agent request${pending.length === 1 ? "" : "s"} to finish before changing configuration: ${pending.map(job => `${job.action} (${job.id})`).join(", ")}. Each request times out on its own.`;
	}

	// 0.5 R10 — pandoc-ready bibliography from the References sidebar rows of the active note.

	/** Resolved entries the active note cites: the same index-local rows the References sidebar shows (no BBT call). */
	private async citedEntriesOfActiveNote(): Promise<{ file: TFile; entries: ZoteroIndexEntry[] }> {
		const view = this.lastMarkdownView();
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") throw new Error("Open a Markdown note first.");
		const text = view?.file === file ? view.editor.getValue() : await this.app.vault.cachedRead(file);
		await this.loadIndexForRead();
		const rows = resolveReferenceRows(text, this.cachedEntries(), this.indexLoaded());
		const entries: ZoteroIndexEntry[] = [];
		for (const row of rows) if (row.status === "resolved" && row.entry && !entries.some(entry => entry.id === row.entry?.id)) entries.push(row.entry);
		return { file, entries };
	}

	/** CSL-JSON for the entries: one BBT `item.export` per library, merged into one array with `abstract`/`note` removed. */
	async cslJsonFor(entries: readonly ZoteroIndexEntry[]): Promise<StructuredExport> {
		if (!entries.length) throw new Error("No resolved Zotero citations to export.");
		const outputs: string[] = [];
		try { for (const group of groupEntriesByLibrary(entries)) outputs.push(await this.bbt.export(group.citekeys, EXPORT_TRANSLATORS["csl-json"], group.libraryID)); }
		catch (error) { throw new Error(`${describeBbtError(error)} CSL-JSON export needs Better BibTeX.`); }
		return mergeExports("csl-json", outputs);
	}

	/** Copies merged CSL-JSON for `entries` (the References sidebar button passes its resolved rows). */
	async copyCslJson(entries: readonly ZoteroIndexEntry[]): Promise<void> {
		const result = await this.cslJsonFor(entries);
		await navigator.clipboard.writeText(result.content);
		const missing = entries.length - result.exported.length;
		new Notice(`Copied CSL-JSON for ${result.exported.length} source${result.exported.length === 1 ? "" : "s"}${missing > 0 ? ` (${missing} missing from the export)` : ""}.`);
	}

	async copyCslJsonForActiveNote(): Promise<void> {
		const { entries } = await this.citedEntriesOfActiveNote();
		await this.copyCslJson(entries);
	}

	/** Writes `.cmds-zotero/bibliography/<note>.json` (plugin-owned, gitignored) and shows the YAML line to add; the note itself is never edited. */
	async writeBibliographySidecar(): Promise<void> {
		const { file, entries } = await this.citedEntriesOfActiveNote();
		const result = await this.cslJsonFor(entries);
		const path = defaultSidecarPath(file.path, true, "csl-json");
		await assertVaultBoundary(this.app, path);
		await ensureCmdsIgnore(this.app);
		await ensureDirectory(this.app, path);
		await this.app.vault.adapter.write(path, result.content);
		new Notice(`Bibliography sidecar written: ${path} (${result.exported.length} source${result.exported.length === 1 ? "" : "s"}). Add to the note's frontmatter: bibliography: ${path}`, 15000);
	}
}
