import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, debounce, setIcon, type ViewStateResult } from "obsidian";
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
import { citekeyAtCursor } from "../protocol";
import { PickerModal } from "../modals/picker";
import {
	cursorTarget, emptySourceText, entryForRef, itemRef, parseViewState, selectionTarget, serializeViewState,
	type AnnotationsViewState, type CursorTarget, type ItemRef, type SidebarMode,
} from "../annotations/view-state";
import { LiveOverlay, sourceLabel } from "../annotations/overlay";
import { CARD_ACTIONS, annotationDataText, citationFor, identityLinkFor, scopedKey, type CardActionId } from "../annotations/card-actions";
import { ReportModal } from "../modals/report";

export const VIEW_TYPE_ANNOTATIONS = "cmds-zotero-annotations";
/** Hides a card, section heading or message the filter does not show (0.6 PERF-15). */
const FILTERED_OUT = "cmds-zotero-filtered-out";

const SORT_LABELS: Record<AnnotationSort, string> = { page: "Page", reading: "Reading order", modified: "Last modified", color: "Color" };
const GROUP_LABELS: Record<AnnotationGroup, string> = { attachment: "Group by attachment", page: "Group by page", color: "Group by color" };
const MODE_LABELS: Record<SidebarMode, string> = { note: "Follow active note", selection: "Follow Zotero selection", cursor: "Follow citekey at cursor", pinned: "Pinned item" };
const COMMENT_LABELS: Record<CommentFacet, string> = { any: "With or without comment", with: "With comment", without: "Without comment" };

/** One section's heading and cards in display order. */
interface CardGroup { heading: HTMLElement | null; cards: HTMLElement[] }

/**
 * Sidebar listing the indexed annotations of the item it follows (0.6.1 annotation-sidebar-modes): the active literature
 * note, the item last read from the Zotero selection, the citekey under the cursor, or a pinned item. The mode, the pinned
 * and selected identities, the facets, sort and grouping are view state, so the workspace layout restores them.
 */
export class AnnotationsView extends ItemView {
	private mode: SidebarMode = "note";
	private pinned: ItemRef | null = null;
	private selected: ItemRef | null = null;
	/** The in-place message of the last selection read that showed nothing (not persisted). */
	private selectionMessage: string | null = null;
	private reading = false;
	/** The citekey under the cursor the last render resolved (cursor mode only). */
	private shownCursorKey = "";
	/** The shown item: the live entry when one was fetched for this index generation, else the indexed one. */
	private entry: ZoteroIndexEntry | null = null;
	/** The indexed entry the mode names (fresh reads start from it). */
	private baseEntry: ZoteroIndexEntry | null = null;
	// 0.6.1 annotation-sidebar-live-read: fresh reads live here, in memory; the saved index is never rewritten.
	private readonly overlay = new LiveOverlay();
	private fetching = false;
	/** The card last clicked or focused (attachment and annotation keys), for the palette's card commands. */
	private focused: { attachmentKey: string; annotationKey: string } | null = null;
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
	private readonly filterSoon = debounce(() => { this.applyFilter(); this.saveState(); }, 100, true);
	private readonly cursorSoon = debounce(() => { if (this.mode === "cursor" && this.cursorKey() !== this.shownCursorKey) this.render(); }, 250, true);

	constructor(leaf: WorkspaceLeaf, private plugin: CMDSZoteroPlugin) { super(leaf); }
	getViewType(): string { return VIEW_TYPE_ANNOTATIONS; }
	getDisplayText(): string { return "Zotero annotations"; }
	getIcon(): string { return "highlighter"; }

	onOpen(): Promise<void> {
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => { if (this.mode === "note" || this.mode === "cursor") this.refresh(); }));
		this.registerEvent(this.app.metadataCache.on("changed", file => { if (this.mode === "note" && file === this.app.workspace.getActiveFile()) this.refresh(); }));
		// Cursor mode: the editor moves its DOM selection with the cursor; the check is cheap and re-renders only on a new citekey.
		this.registerDomEvent(document, "selectionchange", () => { if (this.mode === "cursor") this.cursorSoon(); });
		this.render();
		return Promise.resolve();
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), ...serializeViewState(this.viewState()) };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		this.applyViewState(parseViewState(state));
		await super.setState(state, result);
		this.render();
	}

	private viewState(): AnnotationsViewState {
		return { mode: this.mode, pinned: this.pinned, selected: this.selected, facets: this.facets, sort: this.sort, group: this.group };
	}

	private applyViewState(state: AnnotationsViewState): void {
		({ mode: this.mode, pinned: this.pinned, selected: this.selected, facets: this.facets, sort: this.sort, group: this.group } = state);
	}

	private saveState(): void { this.app.workspace.requestSaveLayout(); }

	/** The mode now in effect. */
	currentMode(): SidebarMode { return this.mode; }

	/** The item the sidebar shows, if any. */
	shownEntry(): ZoteroIndexEntry | null { return this.entry; }

	/** Pins `entry`; null follows the active note again. */
	pin(entry: ZoteroIndexEntry | null): void {
		if (entry) { this.mode = "pinned"; this.pinned = itemRef(entry); } else this.mode = "note";
		this.saveState();
		this.render();
	}

	/** Switches the source. Pinned mode without a pinned item pins the shown item, or asks for one. */
	follow(mode: SidebarMode): void {
		if (mode === "pinned" && !this.pinned) {
			if (this.entry) { this.pin(this.entry); return; }
			void this.plugin.pick(entry => this.pin(entry));
			this.render();
			return;
		}
		this.mode = mode;
		this.selectionMessage = null;
		this.saveState();
		this.render();
	}

	/**
	 * Reads Zotero's library-pane selection once (an explicit action; never a listener or a render) and follows it. Several
	 * indexed items are offered as a choice; an empty or unindexed selection is explained in place and the mode stays.
	 */
	async readSelection(): Promise<void> {
		if (this.reading) return;
		this.mode = "selection";
		this.reading = true;
		this.saveState();
		this.render();
		try {
			const items = await this.plugin.bbt.selectedItems();
			const target = selectionTarget(this.plugin.cachedEntries(), items);
			if (target.kind === "resolved") { this.selected = itemRef(target.entry); this.selectionMessage = null; }
			else if (target.kind === "several") {
				new PickerModal(this.app, target.entries, entry => `${entry.title} — @${entry.citekey} · library ${entry.libraryID}`, entry => {
					this.selected = itemRef(entry);
					this.selectionMessage = null;
					this.saveState();
					this.render();
				}, "Several items are selected in Zotero. Choose one…").open();
			} else {
				this.selected = null;
				this.selectionMessage = target.kind === "empty" ? "Nothing is selected in Zotero. Select an item there, then read the selection again."
					: `The ${target.count === 1 ? "item" : `${target.count} items`} selected in Zotero ${target.count === 1 ? "is" : "are"} not in the index. Refresh the index, or select another item.`;
			}
		} catch (error) {
			new Notice(`Could not read the Zotero selection: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.reading = false;
		}
		this.saveState();
		this.render();
	}

	/** The index generation the sidebar shows (the saved snapshot's timestamp). */
	private generation(): string { return this.plugin.lastIndex?.generatedAt ?? ""; }

	/**
	 * Reads the shown item from Zotero now (one identity-pinned export plus its attachments) and shows that until the
	 * index changes. Never rewrites the saved index; on failure the snapshot stays and a Notice says why.
	 */
	async fetchLatest(): Promise<void> {
		const base = this.baseEntry;
		if (!base) { new Notice("The annotations sidebar shows no item to fetch."); return; }
		if (this.fetching) return;
		const generation = this.generation();
		this.fetching = true;
		this.render();
		try {
			const result = await this.plugin.literature.freshEntry(base);
			if (!result.fresh) new Notice(`Zotero did not answer, so the sidebar keeps the saved snapshot: ${result.error instanceof Error ? result.error.message : "unknown error"}`);
			else if (generation !== this.generation()) new Notice("The index changed while Zotero answered; fetch again to see the latest annotations.");
			else if (!this.overlay.put(generation, base, result.entry, Date.now())) new Notice("Zotero answered with another item, so the sidebar keeps the saved snapshot.");
		} catch (error) {
			new Notice(`Could not fetch the latest annotations: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.fetching = false;
		}
		this.render();
	}

	/** The citekey under the cursor of the last Markdown editor, or "". */
	private cursorKey(): string {
		const editor = this.plugin.lastMarkdownView()?.editor;
		if (!editor) return "";
		const cursor = editor.getCursor();
		return citekeyAtCursor(editor.getLine(cursor.line), cursor.ch, editor.getSelection());
	}

	/** The entry the current mode names, or why there is none (shown in place). */
	private followedEntry(): { entry: ZoteroIndexEntry | null; empty: string } {
		const entries = this.plugin.cachedEntries();
		if (this.mode === "note") return { entry: this.noteEntry(entries), empty: emptySourceText("note") };
		// UI negatives only with a loaded snapshot.
		if (!this.plugin.indexLoaded()) return { entry: null, empty: "The index is not loaded yet." };
		if (this.mode === "pinned") return { entry: entryForRef(entries, this.pinned), empty: emptySourceText("pinned") };
		if (this.mode === "selection") return { entry: entryForRef(entries, this.selected), empty: this.reading ? "Reading the Zotero selection…" : this.selectionMessage ?? emptySourceText("selection", { selected: this.selected !== null }) };
		const key = this.cursorKey();
		this.shownCursorKey = key;
		const target: CursorTarget = cursorTarget(entries, key);
		return { entry: target.kind === "resolved" ? target.entry : null, empty: emptySourceText("cursor", { cursor: target }) };
	}

	private noteEntry(entries: ZoteroIndexEntry[]): ZoteroIndexEntry | null {
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
		const followed = this.followedEntry();
		this.baseEntry = followed.entry;
		// The first render uses the cached snapshot (and any live entry already fetched); it never waits for Zotero.
		const live = followed.entry ? this.overlay.get(this.generation(), followed.entry.id) : null;
		this.entry = live?.entry ?? followed.entry;
		// Attachment keys belong to one item: another item starts without an attachment facet.
		if (previous?.id !== this.entry?.id) this.facets.attachments = [];
		const header = container.createDiv({ cls: "cmds-zotero-sidebar-header" });
		this.status = header.createDiv({ cls: "cmds-zotero-sidebar-status", text: this.plugin.statusLine() }); // 0.5 R4
		const toolbar = header.createDiv({ cls: "cmds-zotero-sidebar-toolbar" });
		const mode = toolbar.createEl("select", { cls: "dropdown", attr: { "aria-label": "What the sidebar follows" } });
		for (const value of ["note", "selection", "cursor", "pinned"] as const) mode.createEl("option", { text: MODE_LABELS[value], value });
		mode.value = this.mode;
		mode.addEventListener("change", () => { const next = mode.value as SidebarMode; if (next === "selection") void this.readSelection(); else this.follow(next); });
		const choose = toolbar.createEl("button", { text: "Choose item…", attr: { "aria-label": "Pin the sidebar to a Zotero item" } });
		choose.addEventListener("click", () => { void this.plugin.pick(entry => this.pin(entry)); });
		if (this.baseEntry) {
			const fetch = toolbar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": this.fetching ? "Fetching the latest annotations from Zotero…" : "Fetch the latest annotations from Zotero" } });
			setIcon(fetch, "refresh-cw");
			fetch.disabled = this.fetching;
			fetch.addEventListener("click", () => { void this.fetchLatest(); });
		}
		if (this.mode === "selection") {
			const read = toolbar.createEl("button", { text: "Read selection", attr: { "aria-label": "Read the item selected in Zotero now" } });
			read.disabled = this.reading;
			read.addEventListener("click", () => { void this.readSelection(); });
		}
		const search = toolbar.createEl("input", { type: "search", placeholder: "Filter text, comment, tag, page", attr: { "aria-label": "Filter annotations" } });
		search.value = this.facets.query;
		search.addEventListener("input", () => { this.facets.query = search.value; this.filterSoon(); });
		// One warm-up per render; skipped while the plugin backs off after a failed refresh.
		if (!this.plugin.indexLoaded() && !this.plugin.warmBackoffActive()) void this.plugin.warmIndex();
		const list = container.createDiv({ cls: "cmds-zotero-annotation-list" });
		this.list = list;
		if (!this.entry) { list.createEl("p", { cls: "setting-item-description", text: followed.empty }); return; }
		header.createDiv({ cls: "cmds-zotero-sidebar-title", text: this.entry.title });
		header.createDiv({ cls: "setting-item-description", text: `@${this.entry.citekey} · ${this.entry.attachments.reduce((n, a) => n + a.annotations.length, 0)} annotations` });
		header.createDiv({ cls: "setting-item-description cmds-zotero-annotation-source", text: sourceLabel(live?.at ?? null, this.plugin.cachedIndexAgeMinutes()) });
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
		clear.addEventListener("click", () => { this.facets = noFacets(); search.value = ""; this.facetsChanged(); });
		const sort = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": "Sort annotations" } });
		for (const value of ANNOTATION_SORTS) sort.createEl("option", { text: SORT_LABELS[value], value });
		sort.value = this.sort;
		sort.addEventListener("change", () => { this.sort = sort.value as AnnotationSort; this.relist(rows); this.saveState(); });
		const group = bar.createEl("select", { cls: "dropdown", attr: { "aria-label": "Group annotations" } });
		for (const value of ANNOTATION_GROUPS) group.createEl("option", { text: GROUP_LABELS[value], value });
		group.value = this.group;
		group.addEventListener("change", () => { this.group = group.value as AnnotationGroup; this.relist(rows); this.saveState(); });
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
		card.setAttribute("tabindex", "0");
		if (this.focused?.attachmentKey === attachment.key && this.focused.annotationKey === annotation.key) card.addClass("is-focused");
		const focus = (): void => {
			this.focused = { attachmentKey: attachment.key, annotationKey: annotation.key };
			for (const other of this.groups.flatMap(group => group.cards)) other.toggleClass("is-focused", other === card);
			card.toggleClass("is-focused", true);
		};
		card.addEventListener("focusin", focus);
		card.addEventListener("click", focus);
		card.addEventListener("contextmenu", (event: MouseEvent) => { event.preventDefault(); focus(); this.cardMenu(entry, attachment, annotation).showAtMouseEvent(event); });
		const actions = card.createDiv({ cls: "cmds-zotero-reference-actions" });
		const uri = annotationURI(annotation, entry);
		this.action(actions, "external-link", "Open in Zotero PDF reader", () => { window.open(uri); });
		this.action(actions, "text-cursor-input", "Insert at cursor", () => this.insert(entry, attachment, annotation));
		this.action(actions, "link", "Copy annotation link", () => this.plugin.copyLink(`${entry.title} — p. ${annotation.pageLabel || annotation.page}`, uri));
		this.action(actions, "clipboard-copy", "Copy annotation text", async () => { await navigator.clipboard.writeText(annotation.text || annotation.comment); new Notice("Annotation text copied."); });
		const more = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "More actions" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (event: MouseEvent) => { focus(); this.cardMenu(entry, attachment, annotation).showAtMouseEvent(event); });
		return card;
	}

	/** 0.6.1 annotation-card-actions: citation, callout, bibliography, keys, identity link and the annotation's data. */
	private cardMenu(entry: ZoteroIndexEntry, attachment: Attachment, annotation: Annotation): Menu {
		const menu = new Menu();
		for (const action of CARD_ACTIONS) menu.addItem(item => item.setTitle(action.name).onClick(() => { void this.plugin.run(() => this.runCardAction(action.id, entry, attachment, annotation)); }));
		return menu;
	}

	/** The focused card, if it is still shown. */
	focusedCard(): { entry: ZoteroIndexEntry; attachment: Attachment; annotation: Annotation } | null {
		const entry = this.entry;
		const focused = this.focused;
		if (!entry || !focused) return null;
		const attachment = entry.attachments.find(item => item.key === focused.attachmentKey);
		const annotation = attachment?.annotations.find(item => item.key === focused.annotationKey);
		return attachment && annotation ? { entry, attachment, annotation } : null;
	}

	/** Runs a card action on the focused card (the palette's card commands). */
	async runFocusedAction(id: CardActionId): Promise<void> {
		const card = this.focusedCard();
		if (!card) throw new Error("Click an annotation card in the annotations sidebar first.");
		await this.runCardAction(id, card.entry, card.attachment, card.annotation);
	}

	private async runCardAction(id: CardActionId, entry: ZoteroIndexEntry, attachment: Attachment, annotation: Annotation): Promise<void> {
		const copy = async (text: string, what: string): Promise<void> => { await navigator.clipboard.writeText(text); new Notice(`${what} copied.`); };
		switch (id) {
			case "copy-citation": return copy(citationFor(annotation, entry), "Citation");
			case "copy-citation-link": return copy(citationFor(annotation, entry, { link: true }), "Citation");
			case "copy-callout": return copy(this.callout(entry, annotation), "Callout");
			case "copy-bibliography": {
				const text = await this.plugin.bibliographyFor(entry);
				if (!text.trim()) throw new Error("No bibliography entry is available for this item.");
				return copy(text, "Bibliography entry");
			}
			case "copy-annotation-key": return copy(scopedKey(annotation.key, entry), "Annotation key");
			case "copy-item-key": return copy(scopedKey(entry.itemKey, entry), "Item key");
			case "copy-identity-link": return this.plugin.copyLink(`${entry.title} — p. ${annotation.pageLabel || annotation.page}`, identityLinkFor(this.app.vault.getName(), annotation, entry));
			case "show-data": new ReportModal(this.app, "Annotation data", annotationDataText(annotation, attachment, entry)).open(); return;
		}
	}

	/** The callout Insert at cursor writes; image annotations are linked, not copied (the import copies images). */
	private callout(entry: ZoteroIndexEntry, annotation: Annotation): string {
		return annotation.imagePath ? markdownLink(`Image annotation, p. ${annotation.pageLabel || annotation.page}`, annotationURI(annotation, entry)) : annotationBody(annotation, undefined, entry, this.plugin.settings);
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
		view.editor.replaceSelection(`${this.callout(entry, annotation)}\n`);
		void this.app.workspace.revealLeaf(view.leaf);
	}

	onClose(): Promise<void> {
		this.filterSoon.cancel();
		this.cursorSoon.cancel();
		this.refresh.cancel();
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
