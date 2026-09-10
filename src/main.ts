import { Editor, Notice, Plugin, TFile } from "obsidian";
import { BbtService } from "./bbt";
import { IndexService } from "./index-service";
import { ImportService } from "./importer";
import { IngestAPI } from "./ingest-api";
import { VaultLinks } from "./vault-links";
import { VaultIndexStorage, relativePath } from "./vault-storage";
import { normalizeSettings, validateEndpoint } from "./settings-data";
import { citekeyAtCursor, parseProtocolRequest } from "./protocol";
import { pdfURI, noteDeepLink, markdownLink } from "./uris";
import { CmdsZoteroSettingsTab } from "./settings";
import { ActionsModal, ImportPreviewModal, PageJumpModal, PickerModal, ReportModal } from "./modals";
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

	async onload(): Promise<void> {
		const stored: unknown = await this.loadData();
		this.settings = normalizeSettings(stored);
		this.settings.bbtEndpoint = validateEndpoint(this.settings.bbtEndpoint);
		this.active = true;
		this.configure();
		this.addSettingTab(new CmdsZoteroSettingsTab(this.app, this));
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
		this.addCommand({ id: "insert-bibliography", name: "Insert bibliography", editorCallback: (editor: Editor) => {
			void this.pick(entry => { void this.run(async () => { editor.replaceSelection(await this.bbt.bibliography(entry)); }); });
		} });
		this.addCommand({ id: "copy-hookmark-link", name: "Copy Hookmark-compatible link", callback: () => { void this.pick(entry => { void this.copyLink(entry.title, entry.zoteroSelectURI); }); } });
		this.addCommand({ id: "copy-note-link", name: "Copy stable literature note link", callback: () => { void this.pick(entry => { void this.run(() => this.copyNoteLink(entry)); }); } });
		this.addCommand({ id: "diagnose-links", name: "Diagnose index and links", callback: () => { void this.showDiagnostics(); } });
		this.addCommand({ id: "find-vault-links", name: "Find literature across vaults", callback: () => { void this.pick(entry => { void this.showVaultLinks(entry); }); } });
		this.addRibbonIcon("library", "Search literature", () => { void this.pick(entry => this.showActions(entry)); });
		this.registerObsidianProtocolHandler("cmds-zotero", params => {
			void this.run(async () => {
				const request = parseProtocolRequest(params, this.app.vault.getName());
				const result = await this.service.resolve({ itemKey: request.itemKey, libraryID: request.libraryID });
				if (result.status !== "resolved") throw new Error(`Could not resolve this source: ${result.status}. Refresh the index and retry.`);
				if (request.target === "pdf") await this.openPdf(result.entry, request.page ?? 1, request.annotation);
				else await this.openNote(result.entry);
			});
		});
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
		this.service = new IngestAPI(this.app, this.bbt, this.index, this.links, async index => {
			if (!this.active || this.index !== indexService) return;
			const changed = this.lastIndex?.generatedAt !== index.generatedAt;
			this.lastIndex = index;
			if (changed) await this.links.publish(index);
		});
	}

	async saveSettings(next: CmdsZoteroSettings): Promise<void> {
		if (this.service.busy) throw new Error("Wait for index refresh to finish before changing configuration.");
		const settings = normalizeSettings(next);
		settings.bbtEndpoint = validateEndpoint(settings.bbtEndpoint);
		relativePath(settings.zoteroIndexPath);
		relativePath(settings.outputFolder);
		relativePath(settings.imageFolder);
		await this.saveData(settings);
		this.bbt.dispose();
		this.settings = settings;
		this.lastIndex = null;
		this.configure();
	}

	onunload(): void {
		this.active = false;
		this.bbt?.dispose();
		if (this.mapTimer !== undefined) window.clearTimeout(this.mapTimer);
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

	private async pick(choose: (entry: ZoteroIndexEntry) => void): Promise<void> {
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
			{ name: "Copy Hookmark-compatible link", action: () => this.copyLink(entry.title, entry.zoteroSelectURI) },
			{ name: "Copy stable note link", action: () => this.copyNoteLink(entry) },
			{ name: "Copy PDF page link", action: () => { new PageJumpModal(this.app, entry.citekey, (_key, page) => { void this.run(() => this.openPdf(entry, page, undefined, true)); }).open(); } },
			{ name: "Find notes across vaults", action: () => this.showVaultLinks(entry) },
		]).open();
	}

	async previewImport(entry: ZoteroIndexEntry): Promise<void> {
		await this.run(async () => {
			const preview = await this.importer.preview(entry);
			new ImportPreviewModal(this.app, preview, async () => {
				const result = await this.importer.apply(preview);
				if (result.conflicts.length) throw new Error(result.conflicts.join("; "));
				await this.app.workspace.openLinkText(result.path, "", true);
				this.scheduleMap();
				new Notice("Literature note imported. User-written sections were preserved.");
			}).open();
		});
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
