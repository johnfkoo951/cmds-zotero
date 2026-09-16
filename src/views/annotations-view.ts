import { ItemView, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { Annotation, Attachment, ZoteroIndexEntry } from "../types";
import { buildAliasIndex, noteIdentity } from "../note-aliases";
import { annotationBody, annotationURI } from "../note-writer";
import { colorName } from "../annotations/colors";
import { markdownLink } from "../uris";

export const VIEW_TYPE_ANNOTATIONS = "cmds-zotero-annotations";

/** Sidebar listing the indexed annotations of the active literature note, or of a pinned item. */
export class AnnotationsView extends ItemView {
	private pinned: ZoteroIndexEntry | null = null;
	private entry: ZoteroIndexEntry | null = null;
	private filter = "";
	private readonly refresh = debounce(() => this.render(), 300, true);

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
		const id = noteIdentity(file.basename, fm, buildAliasIndex(entries));
		return id ? entries.find(entry => entry.id === id) ?? null : null;
	}

	render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("cmds-zotero-sidebar");
		this.entry = this.followedEntry();
		const header = container.createDiv({ cls: "cmds-zotero-sidebar-header" });
		const toolbar = header.createDiv({ cls: "cmds-zotero-sidebar-toolbar" });
		const choose = toolbar.createEl("button", { text: this.pinned ? "Unpin" : "Choose item…", attr: { "aria-label": this.pinned ? "Follow the active note again" : "Pin the sidebar to a Zotero item" } });
		choose.addEventListener("click", () => { if (this.pinned) this.pin(null); else void this.plugin.pick(entry => this.pin(entry)); });
		const search = toolbar.createEl("input", { type: "search", placeholder: "Filter text, comment, tag, page", attr: { "aria-label": "Filter annotations" } });
		search.value = this.filter;
		search.addEventListener("input", () => { this.filter = search.value; this.renderList(list); });
		// One warm-up per render; skipped while the plugin backs off after a failed refresh.
		if (!this.plugin.indexLoaded() && !this.plugin.warmBackoffActive()) void this.plugin.warmIndex();
		const list = container.createDiv({ cls: "cmds-zotero-annotation-list" });
		if (!this.entry) { list.createEl("p", { cls: "setting-item-description", text: "Open a literature note, or pin a Zotero item, to see its annotations." }); return; }
		header.createEl("div", { cls: "cmds-zotero-sidebar-title", text: this.entry.title });
		header.createEl("div", { cls: "setting-item-description", text: `@${this.entry.citekey} · ${this.entry.attachments.reduce((n, a) => n + a.annotations.length, 0)} annotations` });
		this.renderList(list);
	}

	private renderList(list: HTMLElement): void {
		list.empty();
		const entry = this.entry;
		if (!entry) return;
		const query = this.filter.trim().toLowerCase();
		let shown = 0;
		for (const attachment of entry.attachments) {
			const annotations = [...attachment.annotations].sort((a, b) => a.page - b.page).filter(a => !query || `${a.text} ${a.comment} ${a.tags.join(" ")} ${a.pageLabel} ${a.page}`.toLowerCase().includes(query));
			if (!annotations.length) continue;
			if (entry.attachments.length > 1) list.createEl("h6", { text: attachment.title || attachment.key });
			for (const annotation of annotations) { this.renderAnnotation(list, entry, attachment, annotation); shown++; }
		}
		if (!shown) list.createEl("p", { cls: "setting-item-description", text: query ? "No annotations match the filter." : entry.attachmentStatus === "unavailable" ? "Attachment lookup failed at the last refresh. Refresh the index." : "No annotations are indexed for this item." });
	}

	private renderAnnotation(list: HTMLElement, entry: ZoteroIndexEntry, attachment: Attachment, annotation: Annotation): void {
		const color = colorName(annotation.color);
		const card = list.createDiv({ cls: `cmds-zotero-annotation${color ? ` cmds-zotero-annotation-${color}` : ""}` });
		const head = card.createDiv({ cls: "cmds-zotero-annotation-head" });
		head.createSpan({ cls: "cmds-zotero-annotation-chip" });
		head.createSpan({ text: `${annotation.type || "highlight"} · p. ${annotation.pageLabel || annotation.page}` });
		if (annotation.imagePath) head.createSpan({ cls: "cmds-zotero-annotation-image", text: "image" });
		if (annotation.text) card.createDiv({ cls: "cmds-zotero-annotation-text", text: annotation.text });
		if (annotation.comment) card.createDiv({ cls: "cmds-zotero-annotation-comment", text: annotation.comment });
		if (annotation.tags.length) card.createDiv({ cls: "setting-item-description", text: annotation.tags.join(", ") });
		const actions = card.createDiv({ cls: "cmds-zotero-reference-actions" });
		const uri = annotationURI(annotation, entry);
		this.action(actions, "external-link", "Open in Zotero PDF reader", () => { window.open(uri); });
		this.action(actions, "text-cursor-input", "Insert at cursor", () => this.insert(entry, attachment, annotation));
		this.action(actions, "link", "Copy annotation link", () => this.plugin.copyLink(`${entry.title} — p. ${annotation.pageLabel || annotation.page}`, uri));
		this.action(actions, "clipboard-copy", "Copy annotation text", async () => { await navigator.clipboard.writeText(annotation.text || annotation.comment); new Notice("Annotation text copied."); });
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

	onClose(): Promise<void> { this.contentEl.empty(); return Promise.resolve(); }
}
