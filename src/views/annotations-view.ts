import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { Annotation, Attachment, ZoteroIndexEntry } from "../types";
import { noteIdentity } from "../note-aliases";
import { indexDerived } from "../index-derived";
import { annotationBody, annotationURI } from "../note-writer";
import { colorName } from "../annotations/colors";
import {
	ANNOTATION_GROUPS, ANNOTATION_SORTS, NO_COLOR, annotationRows, emptyListText, facetCounts, facetsActive, groupAnnotations, noFacets, sectionVisibility, sortAnnotations,
	type AnnotationFacets, type AnnotationGroup, type AnnotationRow, type AnnotationSection, type AnnotationSort, type CommentFacet,
} from "../annotations/filter";
import { markdownLink } from "../uris";

export const VIEW_TYPE_ANNOTATIONS = "cmds-zotero-annotations";
/** Hides a card, section heading or message the filter does not show (0.6 PERF-15). */
const FILTERED_OUT = "cmds-zotero-filtered-out";

const SORT_LABELS: Record<AnnotationSort, string> = { page: "Page", reading: "Reading order", modified: "Last modified", color: "Color" };
const GROUP_LABELS: Record<AnnotationGroup, string> = { attachment: "Group by attachment", page: "Group by page", color: "Group by color" };
const COMMENT_LABELS: Record<CommentFacet, string> = { any: "With or without comment", with: "With comment", without: "Without comment" };

/** One section's heading and cards in display order. */
interface CardGroup { heading: HTMLElement | null; cards: HTMLElement[] }

/** Sidebar listing the indexed annotations of the active literature note, or of a pinned item. */
export class AnnotationsView extends ItemView {
	private pinned: ZoteroIndexEntry | null = null;
	private entry: ZoteroIndexEntry | null = null;
	// 0.6.1 annotation-sidebar-facets: the filter box text is `facets.query`.
	private facets: AnnotationFacets = noFacets();
	private sort: AnnotationSort = "page";
	private group: AnnotationGroup = "attachment";
	private status: HTMLElement | null = null; // 0.5 R4
	// 0.6 PERF-15: cards are built once per render; the facets and filter text only toggle their visibility, debounced.
	private list: HTMLElement | null = null;
	private facetBar: HTMLElement | null = null;
	private sections: AnnotationSection[] = [];
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
		this.sections = [];
		this.message = null;
		this.facetBar = null;
		const container = this.contentEl;
		container.empty();
		container.addClass("cmds-zotero-sidebar");
		const previous = this.entry;
		this.entry = this.followedEntry();
		// Attachment keys belong to one item: another item starts without an attachment facet.
		if (previous?.id !== this.entry?.id) this.facets.attachments = [];
		const header = container.createDiv({ cls: "cmds-zotero-sidebar-header" });
		this.status = header.createDiv({ cls: "cmds-zotero-sidebar-status", text: this.plugin.statusLine() }); // 0.5 R4
		const toolbar = header.createDiv({ cls: "cmds-zotero-sidebar-toolbar" });
		const choose = toolbar.createEl("button", { text: this.pinned ? "Unpin" : "Choose item…", attr: { "aria-label": this.pinned ? "Follow the active note again" : "Pin the sidebar to a Zotero item" } });
		choose.addEventListener("click", () => { if (this.pinned) this.pin(null); else void this.plugin.pick(entry => this.pin(entry)); });
		const search = toolbar.createEl("input", { type: "search", placeholder: "Filter text, comment, tag, page", attr: { "aria-label": "Filter annotations" } });
		search.value = this.facets.query;
		search.addEventListener("input", () => { this.facets.query = search.value; this.filterSoon(); });
		// One warm-up per render; skipped while the plugin backs off after a failed refresh.
		if (!this.plugin.indexLoaded() && !this.plugin.warmBackoffActive()) void this.plugin.warmIndex();
		const list = container.createDiv({ cls: "cmds-zotero-annotation-list" });
		this.list = list;
		if (!this.entry) { list.createEl("p", { cls: "setting-item-description", text: "Open a literature note, or pin a Zotero item, to see its annotations." }); return; }
		header.createDiv({ cls: "cmds-zotero-sidebar-title", text: this.entry.title });
		header.createDiv({ cls: "setting-item-description", text: `@${this.entry.citekey} · ${this.entry.attachments.reduce((n, a) => n + a.annotations.length, 0)} annotations` });
		const rows = annotationRows(this.entry);
		if (rows.length) this.renderFacetBar(header, rows, search);
		this.renderList(list, rows);
	}

	/** Colour chips with counts, the filter menu (type, tag, attachment, comment), Clear, and the sort and group selects. */
	private renderFacetBar(header: HTMLElement, rows: AnnotationRow[], search: HTMLInputElement): void {
		const bar = header.createDiv({ cls: "cmds-zotero-annotation-facets" });
		this.facetBar = bar;
		const counts = facetCounts(rows);
		for (const [color, count] of counts.colors) {
			const name = color === NO_COLOR ? "no color" : color;
			const chip = bar.createEl("button", { cls: `cmds-zotero-facet-chip${color === NO_COLOR ? "" : ` cmds-zotero-annotation-${color}`}`, attr: { "aria-label": `Show ${name} annotations`, "data-facet": color } });
			chip.createSpan({ cls: "cmds-zotero-annotation-chip" });
			chip.createSpan({ text: String(count) });
			chip.addEventListener("click", () => { this.facets.colors = toggled(this.facets.colors, color); this.facetsChanged(); });
		}
		const more = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Filter by type, tag, attachment or comment" } });
		setIcon(more, "filter");
		more.addEventListener("click", event => {
			const menu = new Menu();
			const item = (title: string, checked: boolean, run: () => void): void => { menu.addItem(entry => entry.setTitle(title).setChecked(checked).onClick(() => { run(); this.facetsChanged(); })); };
			for (const [type, count] of counts.types) item(`Type: ${type} (${count})`, this.facets.types.includes(type), () => { this.facets.types = toggled(this.facets.types, type); });
			if (counts.tags.length) menu.addSeparator();
			for (const [tag, count] of counts.tags) item(`Tag: ${tag} (${count})`, this.facets.tags.includes(tag), () => { this.facets.tags = toggled(this.facets.tags, tag); });
			if (counts.attachments.length > 1) {
				menu.addSeparator();
				const titles = new Map(rows.map(row => [row.attachment.key, row.attachment.title || row.attachment.key]));
				for (const [key, count] of counts.attachments) item(`Attachment: ${titles.get(key) ?? key} (${count})`, this.facets.attachments.includes(key), () => { this.facets.attachments = toggled(this.facets.attachments, key); });
			}
			menu.addSeparator();
			for (const value of ["any", "with", "without"] as const) item(COMMENT_LABELS[value], this.facets.comment === value, () => { this.facets.comment = value; });
			menu.showAtMouseEvent(event);
		});
		const clear = bar.createEl("button", { cls: "cmds-zotero-facet-clear", text: "Clear", attr: { "aria-label": "Clear the filters" } });
		clear.addEventListener("click", () => { this.facets = { ...noFacets() }; search.value = ""; this.facetsChanged(); });
		const sort = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": "Sort annotations" } });
		for (const value of ANNOTATION_SORTS) sort.createEl("option", { text: SORT_LABELS[value], value });
		sort.value = this.sort;
		sort.addEventListener("change", () => { this.sort = sort.value as AnnotationSort; this.relist(rows); });
		const group = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": "Group annotations" } });
		for (const value of ANNOTATION_GROUPS) group.createEl("option", { text: GROUP_LABELS[value], value });
		group.value = this.group;
		group.addEventListener("change", () => { this.group = group.value as AnnotationGroup; this.relist(rows); });
		this.renderFacetState();
	}

	/** Chip and Clear states for the current facets. */
	private renderFacetState(): void {
		const bar = this.facetBar;
		if (!bar) return;
		for (const chip of Array.from(bar.querySelectorAll<HTMLElement>("[data-facet]"))) {
			const active = this.facets.colors.includes(chip.getAttribute("data-facet") ?? "");
			chip.toggleClass("is-active", active);
			chip.setAttribute("aria-pressed", String(active));
		}
		bar.querySelector(".cmds-zotero-facet-clear")?.toggleClass(FILTERED_OUT, !facetsActive(this.facets));
	}

	private facetsChanged(): void {
		this.renderFacetState();
		this.filterSoon();
	}

	/** Rebuilds the list (a new sort or grouping) without rebuilding the header. */
	private relist(rows: AnnotationRow[]): void {
		const list = this.list;
		if (!list) return;
		this.filterSoon.cancel();
		list.empty();
		this.groups = [];
		this.sections = [];
		this.renderList(list, rows);
	}

	/** Every card of the entry in its section, in the chosen order, then the list's message; the facets decide what shows. */
	private renderList(list: HTMLElement, rows: AnnotationRow[]): void {
		const entry = this.entry;
		if (!entry) return;
		this.sections = groupAnnotations(sortAnnotations(rows, this.sort), this.group, entry.attachments.length);
		for (const section of this.sections) {
			const heading = section.heading === null ? null : list.createEl("h6", { text: section.heading });
			this.groups.push({ heading, cards: section.rows.map(row => this.renderAnnotation(list, entry, row.attachment, row.annotation)) });
		}
		this.message = list.createEl("p", { cls: "setting-item-description" });
		this.applyFilter();
	}

	/** Shows the cards (and section headings) the facets match, or the list's message when none is shown. */
	private applyFilter(): void {
		const list = this.list;
		if (!list) return;
		const entry = this.entry;
		// Unchanged from 0.5: typing in the filter while no item is followed clears the list, hint included.
		if (!entry || !this.message) { list.empty(); return; }
		const visibility = sectionVisibility(this.sections, this.facets);
		this.groups.forEach((group, index) => {
			group.heading?.toggleClass(FILTERED_OUT, !visibility.headings[index]);
			group.cards.forEach((card, position) => card.toggleClass(FILTERED_OUT, !visibility.cards[index][position]));
		});
		this.message.setText(emptyListText(this.facets, entry.attachmentStatus));
		this.message.toggleClass(FILTERED_OUT, visibility.shown > 0);
	}

	private renderAnnotation(list: HTMLElement, entry: ZoteroIndexEntry, attachment: Attachment, annotation: Annotation): HTMLElement {
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
		this.facetBar = null;
		this.groups = [];
		this.sections = [];
		this.message = null;
		return Promise.resolve();
	}

	// 0.5 R4: the shared status line in the header, updated by the plugin without a full re-render.
	renderStatus(line: string): void { this.status?.setText(line); }
}

/** `values` with `value` added, or removed when present. */
function toggled(values: readonly string[], value: string): string[] {
	return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}
