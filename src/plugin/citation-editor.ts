import { Notice, type Editor, type MarkdownFileInfo, type MarkdownView, type Menu, type TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { renderCluster } from "../citations/author-date";
import { citationAt, isPageLocator, locatorEdit, parseClusters, type CitationCluster, type CitationItem } from "../citations/cluster";
import { refreshCitations, type CitationEditorHost } from "../citations/editor-extension";
import { formatCitation, type CitationFormat } from "../citations/formats";
import { firstPageLabel, locatorPageIn, pageSourceText } from "../citations/locator-page";
import { parsePastedLinks, resolvePastedRef, type PastedRef } from "../citations/paste";
import { citekeyProblem, problemText, renamePlan } from "../citations/problems";
import { copyBibliographyNotice, countBibliographySources, fallbackCitation } from "../citations/reference-rows";
import { indexDerived } from "../index-derived";
import type CMDSZoteroPlugin from "../main";
import { ActionsModal, type ModalAction } from "../modals/actions";
import { candidateLabel, requireChoice } from "../modals/choose-entry";
import { LocatorModal } from "../modals/locator";
import { PageJumpModal } from "../modals/page-jump";
import { PickerModal } from "../modals/picker";
import { RenamePreviewModal } from "../modals/rename-preview";
import { pdfTargets, type PdfTarget } from "../protocol";
import type { ZoteroIndexEntry } from "../types";
import { copyOrShow, placeCitation, unchanged } from "./picker";

/** The citation at a position of an editor: its line (0-based), the line text then, the item and its cluster. */
export interface CitationTarget { line: number; text: string; item: CitationItem; cluster: CitationCluster | null }

/** How long a right-click position is used for the editor menu that follows it. */
const CONTEXT_MENU_MS = 1500;

/**
 * 0.6.2 citations editor (WP5): the host of the editor extension (marks, hover, author-date rendering, Mod+click, drop)
 * and the citation-at-cursor actions. Every lookup reads the loaded snapshot (`plugin.cachedEntries()`); bibliography text
 * goes through the bibliography cache and never blocks the editor.
 */
export class CitationEditorController implements CitationEditorHost {
	readonly views = new Set<EditorView>();
	private contextTarget: { info: MarkdownFileInfo | null; offset: number; at: number } | null = null;

	constructor(private readonly plugin: CMDSZoteroPlugin) {}

	// Editor extension host.

	marksEnabled(): boolean { return this.plugin.settings.citekeyProblemMarks && this.plugin.indexLoaded(); }
	hoverEnabled(): boolean { return this.plugin.settings.citationHover; }
	authorDateEnabled(): boolean { return this.plugin.settings.authorDateRendering && this.plugin.indexLoaded(); }

	private matches(citekey: string): readonly ZoteroIndexEntry[] { return indexDerived(this.plugin.cachedEntries()).entriesWithCitekey(citekey); }

	/** The one entry carrying `citekey` in the loaded snapshot, or null (none, several, or no snapshot). */
	private unique(citekey: string): ZoteroIndexEntry | null {
		const matches = this.matches(citekey);
		return matches.length === 1 ? matches[0] : null;
	}

	problem(citekey: string): ReturnType<CitationEditorHost["problem"]> {
		const derived = indexDerived(this.plugin.cachedEntries());
		const problem = citekeyProblem(citekey, derived, this.plugin.indexLoaded(), this.plugin.indexComplete());
		return problem ? { problem, text: problemText(problem, citekey, derived.entriesWithCitekey(citekey)) } : null;
	}

	renderCluster(items: readonly CitationItem[]): string | null {
		return this.plugin.indexLoaded() ? renderCluster(items, key => this.unique(key)) : null;
	}

	fillHover(dom: HTMLElement, item: CitationItem): boolean {
		const key = item.citekey;
		if (!this.plugin.indexLoaded()) { dom.createDiv({ cls: "cmds-zotero-hover-meta", text: `@${key} · the literature index is not loaded yet` }); return true; }
		const matches = this.matches(key);
		if (!matches.length) { dom.createDiv({ cls: "cmds-zotero-hover-problem", text: problemText("unknown", key) }); return true; }
		if (matches.length > 1) {
			dom.createDiv({ cls: "cmds-zotero-hover-problem", text: problemText("ambiguous", key, matches) });
			const list = dom.createEl("ul", { cls: "cmds-zotero-hover-candidates" });
			for (const entry of matches) list.createEl("li", { text: candidateLabel(entry, this.plugin.lastIndex, key) });
			return true;
		}
		const entry = matches[0];
		dom.createDiv({ cls: "cmds-zotero-hover-title", text: entry.title || entry.citekey });
		const authors = entry.authors.slice(0, 4).join("; ") + (entry.authors.length > 4 ? " et al." : "");
		dom.createDiv({ cls: "cmds-zotero-hover-meta", text: [authors, entry.year || "n.d.", `@${entry.citekey}`].filter(Boolean).join(" · ") });
		if (entry.citekey !== key) dom.createDiv({ cls: "cmds-zotero-hover-problem", text: problemText("former", key, matches) });
		if (item.locator) dom.createDiv({ cls: "cmds-zotero-hover-meta", text: `Locator: ${item.locator.label ? `${item.locator.label} ` : "page "}${item.locator.value}` });
		const bibliography = dom.createDiv({ cls: "cmds-zotero-hover-bibliography", text: fallbackCitation(entry) });
		void this.bibliographyText(entry).then(text => { if (text.trim()) bibliography.setText(text); }, () => { /* the fallback stays */ });
		return true;
	}

	/** Bibliography text from the cache; while Better BibTeX is being backed off, only the cache and the fallback are read. */
	private async bibliographyText(entry: ZoteroIndexEntry): Promise<string> {
		if (this.plugin.warmBackoffActive()) return (await this.plugin.bibliography.bibliographyDetail(entry, this.plugin.settings.bibliographyStyle, { offline: true })).text;
		return this.plugin.bibliographyFor(entry);
	}

	modClick(item: CitationItem): boolean {
		const action = this.plugin.settings.citationClickAction;
		if (action === "nothing") return false;
		void this.plugin.run(() => action === "note" ? this.openNoteFor(item.citekey) : this.openPdfAt(item, false));
		return true;
	}

	rememberContextMenu(info: MarkdownFileInfo | null, offset: number): void { this.contextTarget = { info, offset, at: Date.now() }; }

	/** The right-click offset for the editor menu that follows it, else null (use the cursor). */
	private takeContextOffset(info: MarkdownView | MarkdownFileInfo, editor: Editor): number | null {
		const target = this.contextTarget;
		this.contextTarget = null;
		if (!target || Date.now() - target.at > CONTEXT_MENU_MS) return null;
		if (target.info && target.info !== info && target.info.file !== info.file) return null;
		const length = editor.getValue().length;
		return target.offset <= length ? target.offset : null;
	}

	drop(text: string, _info: MarkdownFileInfo | null, view: EditorView, offset: number): boolean {
		if (!this.plugin.settings.pasteZoteroLinks) return false;
		const refs = this.pastedRefs(text);
		if (!refs) return false;
		const doc = view.state.doc;
		void this.plugin.run(async () => {
			const entries = await this.resolvePasted(refs);
			const citation = this.pasteText(entries);
			if (view.state.doc !== doc) { await copyOrShow(citation, "The note changed while choosing, so the citation was copied to the clipboard instead.", "The note changed while choosing. Copy the citation from here:"); return; }
			view.dispatch({ changes: { from: offset, insert: citation }, selection: { anchor: offset + citation.length }, userEvent: "input.drop" });
			new Notice(pastedNotice(entries.length));
		});
		return true;
	}

	/** Re-reads every live editor (index snapshot or settings changed). */
	refreshEditors(): void {
		for (const view of this.views) view.dispatch({ effects: refreshCitations.of(null) });
	}

	// Reading view (author-date rendering).

	/** Replaces pandoc citations in rendered text with author-date approximations; code, links and unresolved keys stay. */
	renderReadingView(element: HTMLElement): void {
		if (!this.authorDateEnabled()) return;
		const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node as Text;
			if (!text.data.includes("@") || !text.data.includes("[")) continue;
			if (text.parentElement?.closest("code, pre, a, .cmds-zotero-citation-rendered")) continue;
			nodes.push(text);
		}
		for (const node of nodes) {
			const data = node.data;
			const rendered = parseClusters(data).map(cluster => ({ cluster, text: this.renderCluster(cluster.items) })).filter((row): row is { cluster: CitationCluster; text: string } => row.text !== null);
			if (!rendered.length) continue;
			const fragment = createFragment();
			let at = 0;
			for (const { cluster, text } of rendered) {
				fragment.append(data.slice(at, cluster.start));
				const span = fragment.createSpan({ cls: "cmds-zotero-citation-rendered", text });
				span.setAttribute("aria-label", data.slice(cluster.start, cluster.end));
				at = cluster.end;
			}
			fragment.append(data.slice(at));
			node.replaceWith(fragment);
		}
	}

	// Citation at the cursor (or the right-click position).

	citationAt(editor: Editor, offset?: number): CitationTarget | null {
		const position = offset === undefined ? editor.getCursor() : editor.offsetToPos(offset);
		const text = editor.getLine(position.line);
		const found = citationAt(text, position.ch);
		return found ? { line: position.line, text, ...found } : null;
	}

	private requireCitation(editor: Editor, offset?: number): CitationTarget {
		const target = this.citationAt(editor, offset);
		if (!target) throw new Error("No citation under the cursor.");
		return target;
	}

	/** Open literature note at cursor (0.6.2 open-note-at-cursor): a chooser when several items carry the key, an import offer when there is no note. */
	async openNoteFor(citekey: string): Promise<void> {
		const entry = await this.plugin.navigation.requireEntry(citekey);
		const index = await this.plugin.indexing.loadIndexForRead();
		if (this.plugin.links.localFiles(entry, index).length) { await this.plugin.navigation.openNote(entry); return; }
		new ActionsModal(this.plugin.app, `No literature note for @${entry.citekey} yet`, [
			{ name: "Preview literature import", description: `${entry.title} — nothing is written until you confirm the preview.`, action: () => this.plugin.literature.previewImport(entry) },
		]).open();
	}

	/**
	 * Opens (or, with `copy`, copies a link to) the PDF at the page of the citation's locator. The PDF is chosen first when
	 * the item has several; the page comes from that attachment's page labels when annotations name them (locator-page.ts),
	 * else the number is read as a 1-based PDF page and the Notice says so. Without a page locator the PDF opens where
	 * reading stopped (or, for a copy, the page is asked).
	 */
	async openPdfAt(item: CitationItem, copy: boolean): Promise<void> {
		const entry = await this.plugin.navigation.requireEntry(item.citekey);
		const targets = pdfTargets(entry);
		if (!targets.length) throw new Error(entry.attachmentStatus === "unavailable" ? "Attachment lookup failed. Refresh the index before opening this PDF." : "No matching PDF attachment is indexed.");
		const locator = item.locator;
		if (!locator || !isPageLocator(locator)) {
			if (locator) new Notice(`${locator.label} ${locator.value} is not a page, so no page was derived from it.`);
			if (copy) { new PageJumpModal(this.plugin.app, entry.citekey, (_key, page) => { void this.plugin.run(() => this.plugin.navigation.openPdf(entry, page, undefined, true)); }).open(); return; }
			await this.plugin.navigation.openPdf(entry);
			return;
		}
		const open = (target: PdfTarget): void => {
			const page = locatorPageIn(target.attachment, locator);
			const label = firstPageLabel(locator.value);
			if (!page) { new Notice(`Page ${label} could not be found in this PDF; it opens where you stopped reading.`); void this.plugin.run(() => this.plugin.navigation.openPdf(entry, undefined, undefined, copy, target.attachment.key)); return; }
			void this.plugin.run(async () => {
				await this.plugin.navigation.openPdf(entry, page.page, undefined, copy, target.attachment.key);
				if (page.source !== "label") new Notice(pageSourceText(page, label));
			});
		};
		if (targets.length === 1) open(targets[0]);
		else new PickerModal(this.plugin.app, targets, target => target.attachment.title || target.attachment.key, open, "Choose a PDF attachment…").open();
	}

	async copyBibliography(entry: ZoteroIndexEntry): Promise<void> {
		const detail = await this.plugin.bibliography.bibliographyDetail(entry);
		await navigator.clipboard.writeText(detail.text);
		new Notice(copyBibliographyNotice(countBibliographySources([detail])));
	}

	/** Edit locator (0.6.2 citation-locators-affixes): the modal, then the item rewritten if its line did not change meanwhile. */
	editLocator(editor: Editor, offset?: number): void {
		const target = this.requireCitation(editor, offset);
		if (target.item.form === "wikilink") throw new Error("A [[@citekey]] wikilink has no locator. Use [@citekey, p. 3] for a citation with a page.");
		new LocatorModal(this.plugin.app, target.item.citekey, target.item.locator, locator => {
			if (editor.getLine(target.line) !== target.text) { new Notice("The line changed. Run the command again."); return; }
			const edit = locatorEdit(target.item, locator);
			if (!edit) return;
			editor.replaceRange(edit.text, { line: target.line, ch: edit.from }, { line: target.line, ch: edit.to });
		}).open();
	}

	/**
	 * Fix renamed citekey (0.6.2): when the key at the cursor is a former key, every citation of it in this note (not other
	 * notes, not the frontmatter or code) is shown before and after, and replaced in one undoable step only if the note is
	 * still exactly as previewed.
	 */
	async fixRenamedCitekey(editor: Editor, context: MarkdownView | MarkdownFileInfo, offset?: number): Promise<void> {
		const target = this.requireCitation(editor, offset);
		const oldKey = target.item.citekey;
		const entry = await this.plugin.navigation.requireEntry(oldKey);
		if (entry.citekey === oldKey) { new Notice(`@${oldKey} is the current citekey of “${entry.title}”; nothing to fix.`); return; }
		const file: TFile | null = context.file;
		const text = editor.getValue();
		const plan = renamePlan(text, oldKey, entry.citekey);
		if (!plan.count) throw new Error(`No citation of @${oldKey} was found in the body of this note.`);
		new RenamePreviewModal(this.plugin.app, plan, () => {
			if (context.file !== file || editor.getValue() !== text) throw new Error("The note changed since the preview. Run the command again.");
			editor.transaction({ changes: plan.lines.map(row => ({ from: { line: row.line, ch: 0 }, to: { line: row.line, ch: row.before.length }, text: row.after })) });
			new Notice(`Replaced ${plan.count} citation${plan.count === 1 ? "" : "s"} of @${oldKey} with @${entry.citekey}.`);
		}).open();
	}

	/** Citation actions (0.6.2 context-aware-citing-actions) for the citation at the cursor or the right-click position. */
	async showCitationActions(editor: Editor, context: MarkdownView | MarkdownFileInfo, offset?: number): Promise<void> {
		const target = this.requireCitation(editor, offset);
		const { item } = target;
		const resolution = await this.plugin.service.resolve({ citekey: item.citekey });
		const editLocator: ModalAction[] = item.form === "wikilink" ? [] : [{ name: "Edit locator", description: item.locator ? `Now ${item.locator.label ? `${item.locator.label} ` : ""}${item.locator.value}` : "Add a page, chapter, section, figure or paragraph.", action: () => this.editLocator(editor, editor.posToOffset({ line: target.line, ch: item.start })) }];
		if (resolution.status !== "resolved" && resolution.status !== "ambiguous") {
			new ActionsModal(this.plugin.app, `@${item.citekey} is not in the literature index`, [
				...editLocator,
				{ name: "Refresh citekey index", description: "Read Zotero again; the key may be new or renamed.", action: () => this.plugin.refreshIndex() },
			]).open();
			return;
		}
		const entry = resolution.status === "resolved" ? resolution.entry : await requireChoice(this.plugin.app, resolution.candidates ?? [], this.plugin.lastIndex, item.citekey);
		const page = item.locator && isPageLocator(item.locator) ? ` at ${item.locator.label || "p."} ${item.locator.value}` : "";
		const actions: ModalAction[] = [
			{ name: "Open literature note", action: () => this.openNoteFor(entry.citekey) },
			{ name: `Open PDF${page}`, action: () => this.openPdfAt({ ...item, citekey: entry.citekey }, false) },
			{ name: "Copy PDF page link", description: "A Zotero link to the attachment (by its key) and page.", action: () => this.openPdfAt({ ...item, citekey: entry.citekey }, true) },
			{ name: "Copy bibliography entry", action: () => this.copyBibliography(entry) },
			{ name: "Find notes citing this source", action: () => this.plugin.navigation.showCitingNotes(entry) },
			{ name: "Show in Zotero", action: () => { window.open(entry.zoteroSelectURI); } },
			...editLocator,
		];
		if (entry.citekey !== item.citekey) actions.push({ name: `Fix renamed citekey (@${item.citekey} → @${entry.citekey})`, description: "Preview every citation of the old key in this note, then replace them.", action: () => this.fixRenamedCitekey(editor, context, editor.posToOffset({ line: target.line, ch: item.start })) });
		new ActionsModal(this.plugin.app, `${entry.title || entry.citekey} — @${item.citekey}`, actions).open();
	}

	/** Editor-menu entries for the citation under the right-click position (0.6.2 context-menus-active-target). */
	addEditorMenuItems(menu: Menu, editor: Editor, context: MarkdownView | MarkdownFileInfo): void {
		const offset = this.takeContextOffset(context, editor) ?? editor.posToOffset(editor.getCursor());
		const target = this.citationAt(editor, offset);
		if (!target) return;
		const { item } = target;
		const start = editor.posToOffset({ line: target.line, ch: item.start });
		menu.addItem(entry => entry.setTitle(`Open literature note for @${item.citekey}`).setIcon("file-text").setSection("cmds-zotero").onClick(() => { void this.plugin.run(() => this.openNoteFor(item.citekey)); }));
		menu.addItem(entry => entry.setTitle(item.locator && isPageLocator(item.locator) ? `Open PDF at ${item.locator.label || "p."} ${item.locator.value}` : "Open PDF").setIcon("file-text").setSection("cmds-zotero").onClick(() => { void this.plugin.run(() => this.openPdfAt(item, false)); }));
		if (item.form !== "wikilink") menu.addItem(entry => entry.setTitle("Edit citation locator").setIcon("pencil").setSection("cmds-zotero").onClick(() => { void this.plugin.run(async () => { this.editLocator(editor, start); }); }));
		if (this.problem(item.citekey)?.problem === "former") menu.addItem(entry => entry.setTitle(`Fix renamed citekey @${item.citekey}`).setIcon("replace").setSection("cmds-zotero").onClick(() => { void this.plugin.run(() => this.fixRenamedCitekey(editor, context, start)); }));
		menu.addItem(entry => entry.setTitle("Citation actions…").setIcon("quote").setSection("cmds-zotero").onClick(() => { void this.plugin.run(() => this.showCitationActions(editor, context, start)); }));
	}

	// Citations in a named format (0.6.2 named-citation-formats) and pasted Zotero links (zotero-drop-paste-citation).

	/** The citation of `entries` in `format`; the literature-note link asks which note when an item has several. */
	async formatted(format: CitationFormat, entries: readonly ZoteroIndexEntry[], sourcePath: string): Promise<string> {
		if (format !== "note-link") return formatCitation(format, entries);
		const index = await this.plugin.indexing.loadIndexForRead();
		const notes = new Map<string, TFile>();
		for (const entry of entries) {
			const files = this.plugin.links.localFiles(entry, index);
			if (files.length === 1) notes.set(entry.id, files[0]);
			else if (files.length > 1) {
				const file = await new Promise<TFile | null>(resolve => { new PickerModal(this.plugin.app, files, candidate => candidate.path, resolve, `Choose the literature note of @${entry.citekey}…`).open(); });
				if (file) notes.set(entry.id, file);
			}
		}
		return formatCitation(format, entries, (entry, alias) => {
			const file = notes.get(entry.id);
			return file ? this.plugin.app.fileManager.generateMarkdownLink(file, sourcePath, undefined, alias) : null;
		});
	}

	/** Inserts a citation at the cursor (replacing a selection); a pandoc citation at a cluster joins that cluster. */
	async insertFormatted(editor: Editor, context: MarkdownView | MarkdownFileInfo, entries: readonly ZoteroIndexEntry[], format: CitationFormat): Promise<void> {
		const text = await this.formatted(format, entries, context.file?.path ?? "");
		placeCitation(editor, editor.getCursor("from"), editor.getCursor("to"), text);
	}

	/** The pasted refs when `text` is only Zotero item links and the setting is on; null leaves the paste alone. */
	private pastedRefs(text: string): PastedRef[] | null {
		if (!this.plugin.settings.pasteZoteroLinks || !this.plugin.indexLoaded()) return null;
		const refs = parsePastedLinks(text);
		if (!refs) return null;
		const entries = this.plugin.cachedEntries();
		const missing = refs.filter(ref => resolvePastedRef(ref, entries).status === "not-found");
		if (missing.length) { new Notice(`Kept the Zotero link${refs.length === 1 ? "" : "s"} as pasted: ${missing.length === 1 ? "one item is" : `${missing.length} items are`} not in the saved index. Refresh the index to cite ${missing.length === 1 ? "it" : "them"}.`); return null; }
		return refs;
	}

	/** Entries of the pasted refs, a chooser for each ref several items match (never the first match). */
	private async resolvePasted(refs: readonly PastedRef[]): Promise<ZoteroIndexEntry[]> {
		const entries: ZoteroIndexEntry[] = [];
		for (const ref of refs) {
			const resolution = resolvePastedRef(ref, this.plugin.cachedEntries());
			if (resolution.status === "resolved") entries.push(resolution.entry);
			else if (resolution.status === "ambiguous") entries.push(await requireChoice(this.plugin.app, resolution.candidates, this.plugin.lastIndex, ref.kind === "citekey" ? ref.citekey : undefined));
			else throw new Error("A pasted Zotero item is no longer in the saved index.");
		}
		return [...new Map(entries.map(entry => [entry.id, entry])).values()];
	}

	/** Pasted links become a citation in the default format; the literature-note link needs a note, so it falls back to pandoc. */
	private pasteText(entries: readonly ZoteroIndexEntry[]): string {
		const format = this.plugin.settings.citationFormat;
		if (format === "note-link") return formatCitation("pandoc", entries);
		return formatCitation(format, entries);
	}

	/**
	 * `editor-paste`: when the pasted text is only Zotero item links of indexed items (and the setting is on), starts
	 * inserting them as a citation and returns true; the caller then prevents the default paste. False leaves it alone.
	 */
	takePaste(text: string, editor: Editor): boolean {
		if (!text.includes("zotero://")) return false;
		const refs = this.pastedRefs(text);
		if (!refs) return false;
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const selected = editor.getSelection();
		void this.plugin.run(async () => {
			const entries = await this.resolvePasted(refs);
			const citation = this.pasteText(entries);
			if (!unchanged(editor, from, to, selected)) { await copyOrShow(citation, "The note changed while choosing, so the citation was copied to the clipboard instead.", "The note changed while choosing. Copy the citation from here:"); return; }
			placeCitation(editor, from, to, citation);
			new Notice(pastedNotice(entries.length));
		});
		return true;
	}

	/** The literature picker, then the chosen item cited at the cursor in `format`. */
	insertFromPicker(editor: Editor, context: MarkdownView | MarkdownFileInfo, format: CitationFormat): void {
		void this.plugin.navigation.pick(entry => { void this.plugin.run(() => this.insertFormatted(editor, context, [entry], format)); });
	}
}

function pastedNotice(count: number): string {
	return `Pasted ${count === 1 ? "a Zotero link" : `${count} Zotero links`} as a citation. Undo takes it out again.`;
}
