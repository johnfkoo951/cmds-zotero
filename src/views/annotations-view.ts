import { ItemView, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { Annotation, Attachment, ZoteroIndexEntry } from "../types";
import { noteIdentity } from "../note-aliases";
import { indexDerived } from "../index-derived";
import { annotationBody, annotationURI } from "../note-writer";
import { richTextPlain } from "../annotations/rich-text";
import { colorName } from "../annotations/colors";
import { annotationHaystack, annotationQuery, annotationsByPage, annotationVisibility, emptyAnnotationsText } from "../annotations/filter";
import { markdownLink } from "../uris";

export const VIEW_TYPE_ANNOTATIONS = "cmds-zotero-annotations";
/** Hides a card, attachment heading or message the filter does not show (0.6 PERF-15). */
const FILTERED_OUT = "cmds-zotero-filtered-out";

/** One attachment's cards in display order, with the lower-cased text the filter matches. */
interface CardGroup { heading: HTMLElement | null; cards: HTMLElement[]; haystacks: string[] }

/** Sidebar listing the indexed annotations of the active literature note, or of a pinned item. */
export class AnnotationsView extends ItemView {
	private pinned: ZoteroIndexEntry | null = null;
	private entry: ZoteroIndexEntry | null = null;
	private filter = "";
	private status: HTMLElement | null = null; // 0.5 R4
	// 0.6 PERF-15: cards are built once per render; typing in the filter only toggles their visibility, debounced.
	private list: HTMLElement | null = null;
	private groups: CardGroup[] = [];
	private message: HTMLElement | null = null;
	private readonly refresh = debounce(() => this.render(), 300, true);
	private readonly filterSoon = debounce(() => this.applyFilter(), 100, true);

	constructor(leaf: WorkspaceLeaf, private plugin: CMDSZoteroPlugin) { super(leaf); }
	getViewType(): string { return VIEW_TYPE_ANNOTATIONS; }
	getDisplayText(): string { return "Zotero annotations"; }
	getIcon(): string { return "highlighter"; }

	onOpen(): Promise<void> {
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => { if (!this.pinned) this.refresh(); }));
		this.registerEvent(this.app.metadataCache.on("changed", file => { if (!this.pinned && file === this.app.workspace.getActiveFile()) this.refresh(); }));
		this.render();
		return Promise.resolve();
	}

	pin(entry: ZoteroIndexEntry | null): void { this.pinned = entry; this.render(); }

	private followedEntry(): ZoteroIndexEntry | null {
		if (this.pinned) return this.pinned;
		const entries = this.plugin.cachedEntries();
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md" || !entries.length) return null;
		const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
		// 0.6 PERF-05: the alias index and id map are built once per index generation, not on every render.
		const derived = indexDerived(entries);
		const id = noteIdentity(file.basename, fm, derived.aliasIndex);
		return id ? derived.entryById(id) : null;
	}

	render(): void {
		this.filterSoon.cancel();
		this.groups = [];
		this.message = null;
		const container = this.contentEl;
		container.empty();
		container.addClass("cmds-zotero-sidebar");
		this.entry = this.followedEntry();
		const header = container.createDiv({ cls: "cmds-zotero-sidebar-header" });
		this.status = header.createDiv({ cls: "cmds-zotero-sidebar-status", text: this.plugin.statusLine() }); // 0.5 R4
		const toolbar = header.createDiv({ cls: "cmds-zotero-sidebar-toolbar" });
		const choose = toolbar.createEl("button", { text: this.pinned ? "Unpin" : "Choose item…", attr: { "aria-label": this.pinned ? "Follow the active note again" : "Pin the sidebar to a Zotero item" } });
		choose.addEventListener("click", () => { if (this.pinned) this.pin(null); else void this.plugin.pick(entry => this.pin(entry)); });
		const search = toolbar.createEl("input", { type: "search", placeholder: "Filter text, comment, tag, page", attr: { "aria-label": "Filter annotations" } });
		search.value = this.filter;
		search.addEventListener("input", () => { this.filter = search.value; this.filterSoon(); });
		// One warm-up per render; skipped while the plugin backs off after a failed refresh.
		if (!this.plugin.indexLoaded() && !this.plugin.warmBackoffActive()) void this.plugin.warmIndex();
		const list = container.createDiv({ cls: "cmds-zotero-annotation-list" });
		this.list = list;
		if (!this.entry) { list.createEl("p", { cls: "setting-item-description", text: "Open a literature note, or pin a Zotero item, to see its annotations." }); return; }
		header.createDiv({ cls: "cmds-zotero-sidebar-title", text: this.entry.title });
		header.createDiv({ cls: "setting-item-description", text: `@${this.entry.citekey} · ${this.entry.attachments.reduce((n, a) => n + a.annotations.length, 0)} annotations` });
		this.renderList(list);
	}

	/** Every card of the entry, in page order per attachment, then the list's message; the filter decides what shows. */
	private renderList(list: HTMLElement): void {
		const entry = this.entry;
		if (!entry) return;
		for (const attachment of entry.attachments) {
			const annotations = annotationsByPage(attachment);
			if (!annotations.length) continue;
			const heading = entry.attachments.length > 1 ? list.createEl("h6", { text: attachment.title || attachment.key }) : null;
			this.groups.push({ heading, cards: annotations.map(annotation => this.renderAnnotation(list, entry, attachment, annotation)), haystacks: annotations.map(annotationHaystack) });
		}
		this.message = list.createEl("p", { cls: "setting-item-description" });
		this.applyFilter();
	}

	/** Shows the cards (and attachment headings) the current filter matches, or the list's message when none is shown. */
	private applyFilter(): void {
		const list = this.list;
		if (!list) return;
		const entry = this.entry;
		// Unchanged from 0.5: typing in the filter while no item is followed clears the list, hint included.
		if (!entry || !this.message) { list.empty(); return; }
		const query = annotationQuery(this.filter);
		const visibility = annotationVisibility(this.groups.map(group => group.haystacks), query);
		this.groups.forEach((group, index) => {
			group.heading?.toggleClass(FILTERED_OUT, !visibility.headings[index]);
			group.cards.forEach((card, position) => card.toggleClass(FILTERED_OUT, !visibility.cards[index][position]));
		});
		this.message.setText(emptyAnnotationsText(query, entry.attachmentStatus));
		this.message.toggleClass(FILTERED_OUT, visibility.shown > 0);
	}

	private renderAnnotation(list: HTMLElement, entry: ZoteroIndexEntry, attachment: Attachment, annotation: Annotation): HTMLElement {
		const color = colorName(annotation.color);
		const card = list.createDiv({ cls: `cmds-zotero-annotation${color ? ` cmds-zotero-annotation-${color}` : ""}` });
		const head = card.createDiv({ cls: "cmds-zotero-annotation-head" });
		head.createSpan({ cls: "cmds-zotero-annotation-chip" });
		head.createSpan({ text: `${annotation.type || "highlight"} · p. ${annotation.pageLabel || annotation.page}` });
		if (annotation.imagePath) head.createSpan({ cls: "cmds-zotero-annotation-image", text: "image" });
		// 0.6.1 RICH-TEXT: Zotero's rich-text tags are read, not shown (their text stays; the DOM gets text only).
		if (annotation.text) card.createDiv({ cls: "cmds-zotero-annotation-text", text: richTextPlain(annotation.text) });
		if (annotation.comment) card.createDiv({ cls: "cmds-zotero-annotation-comment", text: richTextPlain(annotation.comment) });
		if (annotation.tags.length) card.createDiv({ cls: "setting-item-description", text: annotation.tags.join(", ") });
		const actions = card.createDiv({ cls: "cmds-zotero-reference-actions" });
		const uri = annotationURI(annotation, entry);
		this.action(actions, "external-link", "Open in Zotero PDF reader", () => { window.open(uri); });
		this.action(actions, "text-cursor-input", "Insert at cursor", () => this.insert(entry, attachment, annotation));
		this.action(actions, "link", "Copy annotation link", () => this.plugin.copyLink(`${entry.title} — p. ${annotation.pageLabel || annotation.page}`, uri));
		this.action(actions, "clipboard-copy", "Copy annotation text", async () => { await navigator.clipboard.writeText(annotation.text || annotation.comment); new Notice("Annotation text copied."); });
		return card;
	}

	private action(parent: HTMLElement, icon: string, label: string, run: () => Promise<void> | void): void {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", () => { void this.plugin.run(async () => { await run(); }); });
	}

	private insert(entry: ZoteroIndexEntry, _attachment: Attachment, annotation: Annotation): void {
		const view = this.plugin.lastMarkdownView();
		if (!view) throw new Error("Open a Markdown note in edit mode to insert an annotation.");
		// Images are not copied by the sidebar; the import command performs validated image copies. Link the PDF location instead.
		const body = annotation.imagePath ? `${markdownLink(`Image annotation, p. ${annotation.pageLabel || annotation.page}`, annotationURI(annotation, entry))}` : annotationBody(annotation, undefined, entry, this.plugin.settings);
		view.editor.replaceSelection(`${body}\n`);
		void this.app.workspace.revealLeaf(view.leaf);
	}

	onClose(): Promise<void> {
		this.filterSoon.cancel();
		this.contentEl.empty();
		this.status = null;
		this.list = null;
		this.groups = [];
		this.message = null;
		return Promise.resolve();
	}

	// 0.5 R4: the shared status line in the header, updated by the plugin without a full re-render.
	renderStatus(line: string): void { this.status?.setText(line); }
}
