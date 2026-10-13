import { Editor, Notice, TFile } from "obsidian";
import { scanCitations } from "../citations/scan";
import type CMDSZoteroPlugin from "../main";
import { ActionsModal } from "../modals/actions";
import { PageJumpModal } from "../modals/page-jump";
import { PickerModal } from "../modals/picker";
import { classifyLink, resolveOpenPdfTarget } from "../protocol";
import { indexEntryFor, localDay, readLabel } from "../recent/recent-reads";
import type { ZoteroIndexEntry } from "../types";
import { pdfURI, noteDeepLink, markdownLink, obsidianOpenURI, type ParsedZoteroURI } from "../uris";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "../views/annotations-view";

/** The literature picker and actions modal, opening PDFs and notes, citing-note and cross-vault lookups, and link copies. */
export class NavigationController {
	constructor(private readonly plugin: CMDSZoteroPlugin) {}

	async pick(choose: (entry: ZoteroIndexEntry) => void): Promise<void> {
		await this.plugin.run(async () => {
			const index = await this.plugin.indexing.loadIndexForRead();
			if (!index.entries.length) throw new Error("No literature entries. Check Zotero and refresh the index.");
			// Recently read papers first, from the last Zotero answer (never awaited here, so the picker opens instantly).
			const readOn = new Map<string, string | null>();
			for (const read of this.plugin.literature.recentForPicker()) {
				const entry = indexEntryFor(read, index.entries);
				if (entry && !readOn.has(entry.id)) readOn.set(entry.id, read.readOn);
			}
			const recent = [...readOn.keys()].flatMap(id => index.entries.filter(entry => entry.id === id));
			const ordered = [...recent, ...index.entries.filter(entry => !readOn.has(entry.id))];
			const today = localDay(new Date());
			new PickerModal(this.plugin.app, ordered, entry => `${entry.title} — @${entry.citekey} · ${entry.year} · library ${entry.libraryID}${readOn.has(entry.id) ? ` · ${readLabel(readOn.get(entry.id) ?? null, today)}` : ""}`, choose).open();
		});
	}

	async requireEntry(citekey: string): Promise<ZoteroIndexEntry> {
		const result = await this.plugin.service.resolve({ citekey });
		if (result.status === "resolved") return result.entry;
		throw new Error(result.status === "ambiguous" ? "More than one entry uses this citekey. Use Search literature to select a library." : `Could not resolve citekey: ${result.status}.`);
	}

	showActions(entry: ZoteroIndexEntry): void {
		new ActionsModal(this.plugin.app, entry.title, [
			{ name: "Open in Zotero", action: () => { window.open(entry.zoteroSelectURI); } },
			{ name: "Open literature note", action: () => this.openNote(entry) },
			{ name: "Preview literature import", action: () => this.plugin.literature.previewImport(entry) },
			{ name: "Open PDF page", action: () => this.openPdf(entry, 1) },
			{ name: "Show annotations in sidebar", action: async () => { await this.plugin.activateView(VIEW_TYPE_ANNOTATIONS); for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS)) if (leaf.view instanceof AnnotationsView) leaf.view.pin(entry); } },
			{ name: "Find notes citing this source", action: () => this.showCitingNotes(entry) },
			{ name: "Copy Zotero item link (Hookmark-compatible)", action: () => this.copyLink(entry.title, entry.zoteroSelectURI, true) },
			{ name: "Copy literature note identity link (rename-safe)", action: () => this.copyNoteLink(entry) },
			{ name: "Copy Obsidian file link (Hookmark-native)", action: () => this.copyFileLink(entry) },
			{ name: "Copy PDF page link", action: () => { new PageJumpModal(this.plugin.app, entry.citekey, (_key, page) => { void this.plugin.run(() => this.openPdf(entry, page, undefined, true)); }).open(); } },
			{ name: "Find notes across vaults", action: () => this.showVaultLinks(entry) },
		]).open();
	}

	/** Vault-wide scan for notes citing an entry's citekey or one of its previous citekeys. */
	async showCitingNotes(entry: ZoteroIndexEntry): Promise<void> {
		const keys = new Set([entry.citekey, ...entry.citekeyHistory]);
		const hits: { file: TFile; line: number; count: number }[] = [];
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const text = await this.plugin.app.vault.cachedRead(file);
			if (![...keys].some(key => text.includes(`@${key}`))) continue;
			const occurrences = scanCitations(text).filter(item => keys.has(item.citekey));
			if (occurrences.length) hits.push({ file, line: occurrences[0].line, count: occurrences.length });
		}
		hits.sort((a, b) => b.count - a.count || a.file.path.localeCompare(b.file.path));
		new ActionsModal(this.plugin.app, `Notes citing @${entry.citekey}`, hits.length ? hits.map(hit => ({
			name: hit.file.path, description: `${hit.count} citation${hit.count === 1 ? "" : "s"}`,
			action: async () => { const leaf = this.plugin.app.workspace.getLeaf(false); await leaf.openFile(hit.file, { eState: { line: hit.line } }); },
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
		else new PickerModal(this.plugin.app, attachments, a => a.title || a.key, open, "Choose a PDF attachment…").open();
	}

	async openNote(entry: ZoteroIndexEntry): Promise<void> {
		const index = await this.plugin.indexing.loadIndexForRead();
		const files = this.plugin.links.localFiles(entry, index);
		if (!files.length) throw new Error("No literature note exists in this vault. Preview an import first.");
		const open = (file: TFile): void => { void this.plugin.app.workspace.getLeaf(false).openFile(file); };
		if (files.length === 1) open(files[0]);
		else new PickerModal(this.plugin.app, files, file => file.path, open, "Choose a literature note…").open();
	}

	async copyNoteLink(entry: ZoteroIndexEntry): Promise<void> {
		const index = await this.plugin.indexing.loadIndexForRead();
		if (!this.plugin.links.localFiles(entry, index).length) throw new Error("Import a literature note before copying its note link.");
		await this.copyLink(entry.title, noteDeepLink(this.plugin.app.vault.getName(), entry), true);
	}

	/** `bare` drops the `<…>` around the URL; only the Hookmark copy commands use it (notes and sidebars keep the bracketed form). */
	async copyLink(title: string, uri: string, bare = false): Promise<void> {
		await navigator.clipboard.writeText(markdownLink(title, uri, { bare }));
		new Notice("Markdown link copied. Paste it into Hookmark or a note.");
	}

	async showVaultLinks(entry: ZoteroIndexEntry): Promise<void> {
		const index = await this.plugin.indexing.loadIndexForRead();
		const report = await this.plugin.links.find(entry, index);
		new ActionsModal(this.plugin.app, "Linked literature notes", [
			...report.links.map(link => ({ name: `${link.vault}: ${link.path}`, action: () => { window.open(link.uri); } })),
			...(report.warnings.length ? [{ name: "Unavailable vaults", description: report.warnings.join("\n"), action: () => {} }] : []),
			...(!report.links.length ? [{ name: "No linked notes", description: "Import a note, or refresh the index in each registered vault.", action: () => {} }] : []),
		]).open();
	}

	// 0.5 R15 — Hookmark-native file link and "Open link under cursor".

	/** Copies `obsidian://open?vault=&file=` for the entry's literature note: the address Hookmark shows inside the note; breaks on rename. */
	async copyFileLink(entry: ZoteroIndexEntry): Promise<void> {
		const index = await this.plugin.indexing.loadIndexForRead();
		const files = this.plugin.links.localFiles(entry, index);
		if (!files.length) throw new Error("Import a literature note before copying its file link.");
		const copy = (file: TFile): void => { void this.copyLink(entry.title, obsidianOpenURI(this.plugin.app.vault.getName(), file.path), true); };
		if (files.length === 1) copy(files[0]);
		else new PickerModal(this.plugin.app, files, file => file.path, copy, "Choose a literature note…").open();
	}

	/** zotero://select opens Zotero; zotero://open-pdf routes through openPdf via the attachment key; @citekey opens the actions modal. */
	async openLinkUnderCursor(editor: Editor): Promise<void> {
		const cursor = editor.getCursor();
		const link = classifyLink(editor.getLine(cursor.line), cursor.ch, editor.getSelection());
		await this.plugin.run(async () => {
			if (link.kind === "select") { window.open(link.uri); return; }
			if (link.kind === "open-pdf") { await this.openPdfLink(link.parsed); return; }
			if (link.kind === "citekey") { this.showActions(await this.requireEntry(link.citekey)); return; }
			throw new Error("No Zotero link or @citekey under the cursor.");
		});
	}

	/** Resolves an open-pdf URI (attachment key, or a parent key as Zotero itself accepts) against the index and honours page/annotation. */
	private async openPdfLink(parsed: ParsedZoteroURI): Promise<void> {
		const target = resolveOpenPdfTarget(await this.plugin.indexing.loadIndexForRead(), parsed);
		if (target.kind === "not-found") throw new Error("This PDF link is not in the index. Refresh the index; the link may also belong to another library.");
		if (target.kind === "ambiguous") throw new Error("More than one entry owns this item key. Use Search literature to select a library.");
		await this.openPdf(target.entry, parsed.page ?? 1, parsed.annotationKey, false, target.kind === "attachment" ? target.attachmentKey : undefined);
	}
}
