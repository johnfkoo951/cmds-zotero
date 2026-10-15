import { MarkdownView, Notice, Plugin, TFile, htmlToMarkdown } from "obsidian";
import { BbtService } from "./bbt";
import { IndexService, type CollectPrecondition } from "./index-service";
import { ImportService } from "./importer";
import { IngestAPI } from "./ingest-api";
import { PdfTextService } from "./pdf/extract";
import type { BibliographyDetail } from "./bibliography-store"; // 0.5 R12
import { VaultLinks } from "./vault-links";
import { VaultIndexStorage, relativePath } from "./vault-storage";
import { LEGACY_DEFAULT_INDEX_PATH, normalizeSettings, storesIndexPath, validateEndpoint } from "./settings-data";
import { CmdsZoteroSettingsTab } from "./settings/tab";
import { ReferencesView, VIEW_TYPE_REFERENCES } from "./views/references-view";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "./views/annotations-view";
import type { RecentRead, SendOutcome } from "./recent/recent-reads";
import type { CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { agentHost } from "./plugin/agent-host";
import { BibliographyController } from "./plugin/bibliography-controller";
import { registerCommands } from "./plugin/commands";
import { IndexController } from "./plugin/index-controller";
import { LiteratureController } from "./plugin/literature-controller";
import { NavigationController } from "./plugin/navigation";
import { ReferencesController } from "./plugin/references-controller";
import type { NoteBatch } from "./plugin/note-batch";
import { StatusController } from "./plugin/status";
import { cachedGitProbe, type GitProbe } from "./git-probe";
import { OutcomeLog } from "./doctor/outcome-log";
import { ChoiceCancelled } from "./modals/choose-entry";
import { CitationEditorController } from "./plugin/citation-editor";

const LEGACY_PLUGIN_ID = "cmds-link-zotero";
const LEGACY_PLUGIN_MESSAGE = "The legacy cmds-link-zotero plugin is enabled beside CMDS Zotero and shares the index path; disable it before refreshing.";

export default class CMDSZoteroPlugin extends Plugin {
	settings!: CmdsZoteroSettings;
	bbt!: BbtService;
	index!: IndexService;
	importer!: ImportService;
	service!: IngestAPI;
	links!: VaultLinks;
	// Host state shared with the controllers in src/plugin (views and modals use the methods below instead).
	active = false;
	lastIndex: ZoteroIndex | null = null;
	/** True while "Send recently read papers to notes" writes notes; a second run is refused. */
	recentSendActive = false;
	publish!: (index: ZoteroIndex) => Promise<void>;
	private lastView: MarkdownView | null = null;
	pdfText!: PdfTextService;
	/** PERF-09: the Git probe of this configuration, cached while the Git inputs keep their lstat signature; replaced on reconfigure. */
	gitProbe!: GitProbe;
	// Host controllers: created with the plugin, they keep their own state across configure(); host code calls them directly.
	readonly indexing = new IndexController(this);
	readonly bibliography = new BibliographyController(this);
	readonly literature = new LiteratureController(this);
	readonly navigation = new NavigationController(this);
	readonly references = new ReferencesController(this); // 0.6.2 WP6
	readonly status = new StatusController(this);
	/** 0.6.2 citations editor: marks, hover, author-date rendering, citation actions, paste and drop. */
	readonly citations = new CitationEditorController(this);
	/** 0.6.1 doctor: the last 50 Better BibTeX outcomes of this session, in memory only (kept across reconfiguration). */
	readonly outcomes = new OutcomeLog();

	async onload(): Promise<void> {
		const stored: unknown = await this.loadData();
		// 0.6.5: settings that store no Index path keep an index already at the pre-0.6.5 default (no second index).
		const legacyIndex = !storesIndexPath(stored) && await this.app.vault.adapter.exists(LEGACY_DEFAULT_INDEX_PATH);
		this.settings = normalizeSettings(stored, { legacyIndex });
		this.settings.bbtEndpoint = validateEndpoint(this.settings.bbtEndpoint);
		this.active = true;
		this.configure();
		this.addSettingTab(new CmdsZoteroSettingsTab(this.app, this));
		registerCommands(this); // views, citekey suggester, commands, ribbon icons and the protocol handler

		this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
			const view = leaf?.view;
			if (view instanceof MarkdownView) this.lastView = view;
		}));
		// 0.6 OPT-05: the note map re-resolves only the notes these events name (a folder event: every note).
		this.registerEvent(this.app.metadataCache.on("changed", file => { if (file.extension === "md") this.indexing.noteChanged(file.path); }));
		// 0.5 R13/F07: only Markdown notes and folders (which may contain notes) can change the note map; attachments never do.
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (this.indexing.affectsNoteMap(file) || oldPath.endsWith(".md")) this.indexing.noteMoved(file, oldPath); }));
		this.registerEvent(this.app.vault.on("delete", file => { if (this.indexing.affectsNoteMap(file)) this.indexing.noteMoved(file); }));
		// 0.5 R4: status-bar item; the minute tick only re-renders the age text. 0.6.1: a click opens the actions menu (no BBT call until an action is picked).
		this.status.statusBar = this.addStatusBarItem();
		this.status.statusBar.addClass("cmds-zotero-status-bar", "mod-clickable");
		this.registerDomEvent(this.status.statusBar, "click", event => { this.status.openMenu(event); });
		this.registerInterval(window.setInterval(() => this.status.renderStatus(), 60_000));
		this.status.renderStatus();
		this.indexing.startWarmUp(); // 0.6 OPT-03: after the layout is ready, at an idle moment
	}

	/** True when the legacy plugin that shares the index path is enabled; null when the plugin registry is unavailable. */
	legacyPluginEnabled(): boolean | null {
		const enabled = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
		return enabled ? enabled.has(LEGACY_PLUGIN_ID) : null;
	}

	private configure(): void {
		this.bbt = new BbtService(this.settings);
		this.gitProbe = cachedGitProbe();
		const canCollect: CollectPrecondition = () => this.legacyPluginEnabled() === true ? { ok: false, reason: "legacy-plugin-enabled", message: LEGACY_PLUGIN_MESSAGE } : { ok: true };
		const indexService: IndexService = new IndexService(this.bbt, new VaultIndexStorage(this.app, this.settings.zoteroIndexPath, () => this.active && this.index === indexService), () => this.settings.indexMaxAgeMinutes, canCollect);
		this.index = indexService;
		const links: VaultLinks = new VaultLinks(this.app, () => this.settings, () => this.active && this.links === links);
		this.links = links;
		// 0.5 R12: the sidecar is loaded lazily on the first bibliography read; the importer receives text through the same path.
		this.bibliography.configure();
		// Zotero child notes are HTML: Obsidian's converter keeps their headings, lists and links (made marker-safe in note-writer).
		this.importer = new ImportService(this.app, this.bbt, () => this.settings, (entry, options) => this.bibliography.bibliographyDetail(entry, this.settings.bibliographyStyle, { offline: options?.offline === true }).then(detail => detail.text), html => htmlToMarkdown(html));
		const pdfText: PdfTextService = new PdfTextService(this.app, undefined, (): boolean => this.active && this.index === indexService && this.pdfText === pdfText);
		this.pdfText = pdfText;
		const onIndex = async (index: ZoteroIndex): Promise<void> => {
			if (!this.active || this.index !== indexService) return;
			const changed = this.lastIndex?.generatedAt !== index.generatedAt;
			this.lastIndex = index;
			if (changed) { this.bibliography.clearCache(); await this.links.publish(index); this.refreshViews(); }
			this.status.renderStatus(); // 0.5 R4
		};
		const bbt = this.bbt; // 0.5 R4: every real BBT outcome re-renders the status line
		bbt.onOutcome(outcome => { if (this.active && this.bbt === bbt) { this.outcomes.push(outcome); this.status.renderStatus(); } });
		this.publish = onIndex;
		this.service = new IngestAPI(this.app, this.bbt, this.index, this.links, onIndex, (action, request, now) => agentHost(this, action, request, now, onIndex, indexService, pdfText));
	}

	/**
	 * Reconfigures services. Blocked while a refresh, a writing job, or any BBT collection (a background warm-up
	 * included) is in flight; a read served from the snapshot never blocks. `bbt.dispose()` still aborts anything
	 * that slipped past the check, and the old storage's write guard rejects a late replacement.
	 */
	async saveSettings(next: CmdsZoteroSettings): Promise<void> {
		if (this.service.busy) throw new Error(this.status.busyMessage());
		const settings = normalizeSettings(next);
		settings.bbtEndpoint = validateEndpoint(settings.bbtEndpoint);
		relativePath(settings.zoteroIndexPath);
		relativePath(settings.outputFolder);
		relativePath(settings.imageFolder);
		await this.saveData(settings);
		this.service.dispose();
		this.bbt.dispose();
		await this.bibliography.disposeBibliography(); // 0.5 R12: pending sidecar records land before the store is replaced
		this.settings = settings;
		this.lastIndex = null;
		this.bibliography.clearCache();
		this.indexing.reset();
		this.status.reset(); // 0.5 R4
		this.configure();
		await this.indexing.peekPublished().catch(() => null);
		this.refreshViews();
		void this.indexing.warmIndex();
	}

	onunload(): void {
		this.active = false;
		this.service?.dispose();
		this.bbt?.dispose();
		void this.bibliography.disposeBibliography(); // 0.5 R12: `active` is already false, so at most the last debounce window of renderings is dropped
		this.indexing.dispose();
	}

	/** Entries from the most recently loaded index; empty until the index has been read once. */
	cachedEntries(): ZoteroIndexEntry[] { return this.lastIndex?.entries ?? []; }

	/** True once a validated snapshot has been published, even one with zero entries; UI negatives need this. */
	indexLoaded(): boolean { return this.lastIndex !== null; }

	/** True when the loaded snapshot says it is complete; an incomplete one cannot prove that a citekey is absent. */
	indexComplete(): boolean { return this.lastIndex?.complete === true; }

	/** Age of the loaded snapshot in minutes, or null when none is loaded or its timestamp is unusable. */
	cachedIndexAgeMinutes(): number | null { return this.index.ageMinutes(this.lastIndex); }

	/** True when the loaded snapshot is older than the configured maximum age; false when fresh or not loaded. */
	cachedIndexStale(): boolean { return this.index.isStale(this.lastIndex) === true; }

	lastMarkdownView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;
		return this.lastView && this.lastView.leaf.view === this.lastView ? this.lastView : null;
	}

	/** The note the current-note commands act on: the active or last Markdown view's file, else the active Markdown file. */
	currentNote(): TFile | null {
		const file = this.lastMarkdownView()?.file ?? this.app.workspace.getActiveFile();
		return file instanceof TFile && file.extension === "md" ? file : null;
	}

	/**
	 * 0.6.4: a note's text as its editor shows it. Open editors of the file are saved first (what autosave would write a
	 * moment later), so a preview built from the disk text includes what was just typed.
	 */
	async readSaved(file: TFile): Promise<string> {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) if (leaf.view instanceof MarkdownView && leaf.view.file === file) await leaf.view.save();
		return this.app.vault.read(file);
	}

	private refreshViews(): void {
		this.citations.refreshEditors(); // 0.6.2: citekey marks and rendered citations follow the index and the settings
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REFERENCES)) if (leaf.view instanceof ReferencesView) void leaf.view.render();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS)) if (leaf.view instanceof AnnotationsView) leaf.view.render();
	}

	async activateView(type: string): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(type)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) throw new Error("No sidebar is available for this view.");
		if (!existing) await leaf.setViewState({ type, active: true });
		await this.app.workspace.revealLeaf(leaf);
		void this.indexing.warmIndex();
	}

	async run(action: () => Promise<void>): Promise<void> {
		try { await action(); }
		catch (error) {
			if (error instanceof ChoiceCancelled) return; // 0.6.2: a chooser closed without a choice ends the action quietly
			new Notice(error instanceof Error ? error.message : "Operation failed.");
		}
	}

	// Delegators: the plugin API that views, modals, the settings tab and the suggester call. The behaviour lives in the
	// controllers; add a delegator here only when a file outside src/plugin needs the member.

	/** True while an explicit (forced) warm-up is in flight, so a refresh control can be disabled meanwhile. */
	forcedWarmActive(): boolean { return this.indexing.forcedWarmActive(); }

	/** True while background warm-ups are backing off after a failed refresh; UI callers may skip `warmIndex()` then. */
	warmBackoffActive(): boolean { return this.indexing.warmBackoffActive(); }

	/** Background warm-up (see IndexController.warmIndex); a forced warm-up never joins a non-forced flight. */
	warmIndex(force = false): Promise<void> { return this.indexing.warmIndex(force); }

	refreshIndex(): Promise<void> { return this.indexing.refreshIndex(); }

	/** The newest validated snapshot from disk without contacting BBT, or null when none exists. */
	savedIndex(): Promise<ZoteroIndex | null> { return this.indexing.peekPublished().catch(() => null); }

	/** CSL bibliography text for one entry, cached per index generation and style; concurrent requests share one flight. */
	bibliographyFor(entry: ZoteroIndexEntry): Promise<string> { return this.bibliography.bibliographyForStyle(entry, this.settings.bibliographyStyle); }

	/** `fresh: false` joins the current render generation; `refresh` is the References sidebar's Refresh (0.6 OPT-13). */
	bibliographyBatch(entries: ZoteroIndexEntry[], style?: string, options?: { fresh?: boolean; refresh?: boolean; locale?: string }): Promise<BibliographyDetail[]> { return this.bibliography.bibliographyBatch(entries, style, options); }

	copyCslJson(entries: readonly ZoteroIndexEntry[]): Promise<void> { return this.bibliography.copyCslJson(entries); }

	recentReads(days?: number): Promise<RecentRead[]> { return this.literature.recentReads(days); }

	entryForRecent(read: RecentRead, index: ZoteroIndex | null): Promise<{ entry: ZoteroIndexEntry | null; fresh: boolean; error?: unknown }> { return this.literature.entryForRecent(read, index); }

	literatureNoteFiles(): Map<string, TFile[]> { return this.literature.literatureNoteFiles(); }

	sendToNote(entry: ZoteroIndexEntry, index: ZoteroIndex | null, options?: Parameters<LiteratureController["sendToNote"]>[2]): Promise<SendOutcome> { return this.literature.sendToNote(entry, index, options); }

	/** 0.6: a literature-note batch session (identity map read once, progress Notice with Cancel); the caller closes it. */
	openNoteBatch(message: string): Promise<NoteBatch> { return this.literature.openNoteBatch(message); }

	pick(choose: (entry: ZoteroIndexEntry) => void): Promise<void> { return this.navigation.pick(choose); }

	openPdf(entry: ZoteroIndexEntry, page?: number, annotationKey?: string, copy?: boolean, attachmentKey?: string): Promise<void> { return this.navigation.openPdf(entry, page, annotationKey, copy, attachmentKey); }

	openNote(entry: ZoteroIndexEntry): Promise<void> { return this.navigation.openNote(entry); }

	/** `bare` drops the `<…>` around the URL; only the Hookmark copy commands use it (notes and sidebars keep the bracketed form). */
	copyLink(title: string, uri: string, bare?: boolean): Promise<void> { return this.navigation.copyLink(title, uri, bare); }

	statusLine(now?: Date, compact?: boolean): string { return this.status.statusLine(now, compact); }
}
