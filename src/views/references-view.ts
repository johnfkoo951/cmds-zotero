import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndexEntry } from "../types";
import { bibliographySourceTag, fallbackCitation, referenceHeader, referenceRowText, resolvedEntries, type ReferenceRow, type SnapshotState } from "../citations/reference-rows";
import type { BibliographyDetail } from "../bibliography-store"; // 0.5 R12
import { citedKeySet } from "../citations/cited-keys"; // 0.6.2
import { referenceRowsFromSet } from "../citations/check";
import { withoutReferencesBlock } from "../citations/references-block";
import { formatLabel, type NoteFormat } from "../bibliography/format";

export const VIEW_TYPE_REFERENCES = "cmds-zotero-references";

/**
 * Sidebar bibliography for the citekeys in the active note. Resolution is index-local; bibliography text comes from the
 * plugin's memory → sidecar → BBT path in one batch per render (0.5 R12), so a closed or hung Zotero costs one short probe,
 * and none at all while it was just found not answering (0.6 OPT-13).
 */
export class ReferencesView extends ItemView {
	private file: TFile | null = null;
	private rows: ReferenceRow[] = [];
	/** 0.6.2: keys listed only in nocite, and the note's style/locale of the last render. */
	private nocite = new Set<string>();
	private format: NoteFormat | null = null;
	private generation = 0;
	private status: HTMLElement | null = null; // 0.5 R4
	private readonly refresh = debounce(() => { void this.render(); }, 600, true);

	constructor(leaf: WorkspaceLeaf, private plugin: CMDSZoteroPlugin) { super(leaf); }
	getViewType(): string { return VIEW_TYPE_REFERENCES; }
	getDisplayText(): string { return "Zotero references"; }
	// 0.6: "book-open" is the ribbon icon of "Send recently read papers to notes".
	getIcon(): string { return "list-ordered"; }

	onOpen(): Promise<void> {
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => { if (this.plugin.settings.referencesFollowActiveNote) this.refresh(); }));
		this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => { if (info.file && info.file === this.file) this.refresh(); }));
		this.refresh();
		return Promise.resolve();
	}

	private activeFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) return view.file;
		const file = this.app.workspace.getActiveFile();
		return file instanceof TFile && file.extension === "md" ? file : this.file;
	}

	private async noteText(file: TFile): Promise<string> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.file === file ? view.editor.getValue() : this.app.vault.cachedRead(file);
	}

	/** The published snapshot as the pure row/header helpers see it. */
	private snapshotState(): SnapshotState {
		return { loaded: this.plugin.indexLoaded(), stale: this.plugin.cachedIndexStale(), ageMinutes: this.plugin.cachedIndexAgeMinutes() };
	}

	/**
	 * Rebuilds the list from the active note and the published snapshot, then fills in the bibliography text.
	 * `refetch` (the Refresh button, 0.6 OPT-13) asks for the text again: BBT is probed even after a recent failure and
	 * texts that did not come live from BBT are read again from the sidecar or BBT.
	 */
	async render(options: { refetch?: boolean } = {}): Promise<void> {
		const generation = ++this.generation;
		const file = this.activeFile();
		this.file = file;
		const container = this.contentEl;
		container.empty();
		container.addClass("cmds-zotero-sidebar");
		const header = container.createDiv({ cls: "cmds-zotero-sidebar-header" });
		this.status = header.createDiv({ cls: "cmds-zotero-sidebar-status", text: this.plugin.statusLine() }); // 0.5 R4
		if (!file) { header.createEl("p", { text: "Open a Markdown note to list its references." }); return; }
		const text = await this.noteText(file);
		if (generation !== this.generation) return;
		const state = this.snapshotState();
		// 0.6.2 cited-key-set-pandoc-semantics: the rows are the keys pandoc would cite (code, comments and the managed
		// references section are skipped; nocite keys are listed after the body keys). The note's csl/lang apply.
		const set = citedKeySet(withoutReferencesBlock(text));
		this.nocite = new Set(set.nocite.map(item => item.citekey).filter(key => !set.occurrences.some(item => item.citekey === key)));
		this.rows = referenceRowsFromSet(set, this.plugin.cachedEntries(), state.loaded);
		this.format = await this.plugin.bibliography.noteFormat(file);
		if (generation !== this.generation) return;
		header.createDiv({ cls: "cmds-zotero-sidebar-title", text: file.basename });
		const toolbar = header.createDiv({ cls: "cmds-zotero-sidebar-toolbar" });
		toolbar.createSpan({ text: referenceHeader(this.rows.length, state) });
		header.createDiv({ cls: "cmds-zotero-sidebar-format", text: `Style: ${formatLabel(this.format)}${set.nociteAll ? " · nocite @*" : ""}`, attr: this.format.problems.length ? { title: this.format.problems.join(" ") } : {} });
		const copy = toolbar.createEl("button", { text: "Copy bibliography", attr: { "aria-label": "Copy the bibliography as formatted and plain text" } });
		copy.addEventListener("click", () => { void this.copyBibliography(); });
		// 0.5 R10
		const csl = toolbar.createEl("button", { text: "Copy CSL-JSON", attr: { "aria-label": "Copy CSL-JSON for the resolved references (pandoc bibliography)" } });
		csl.addEventListener("click", () => { void this.plugin.run(() => this.plugin.copyCslJson(resolvedEntries(this.rows))); });
		// 0.6 OPT-13/references-refresh-rerender: Refresh renders the rows again and fetches their text again; it never
		// rebuilds the index (that is the "Refresh citekey index" command). A stale snapshot still starts the warm-up below.
		const refresh = toolbar.createEl("button", { attr: { "aria-label": "Refresh references and their bibliography text" } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => { this.refresh.cancel(); void this.render({ refetch: true }); });
		// At most one warm-up per render generation; the plugin backs off after a failure, so this never re-hits BBT per render.
		if ((!state.loaded || state.stale) && !this.plugin.warmBackoffActive()) void this.plugin.warmIndex();
		const list = container.createEl("ol", { cls: "cmds-zotero-reference-list" });
		if (!this.rows.length) container.createEl("p", { cls: "setting-item-description", text: "No [@citekey], @citekey, or [[@citekey]] citations found." });
		const slots: { entry: ZoteroIndexEntry; text: HTMLElement }[] = [];
		for (const row of this.rows) {
			const text = this.renderRow(list.createEl("li", { cls: `cmds-zotero-reference cmds-zotero-reference-${row.status}` }), row, state);
			if (row.status === "resolved" && row.entry) slots.push({ entry: row.entry, text });
		}
		// 0.5 R12: one batch per render generation; rows keep the author-year line until their text arrives, then carry a provenance tag.
		const format = this.format;
		const batch = { ...(options.refetch ? { refresh: true } : {}), ...(format?.locale ? { locale: format.locale } : {}) };
		if (slots.length) void this.plugin.bibliographyBatch(slots.map(slot => slot.entry), format?.style, Object.keys(batch).length ? batch : undefined).then(details => {
			if (generation !== this.generation) return;
			details.forEach((detail, index) => { this.showBibliography(slots[index].text, slots[index].entry, detail); });
		}).catch(() => undefined);
	}

	private renderRow(item: HTMLElement, row: ReferenceRow, state: SnapshotState): HTMLElement {
		const text = item.createDiv({ cls: "cmds-zotero-reference-text", attr: { role: "button", tabindex: "0" } });
		text.addEventListener("click", () => this.jump(row.line));
		text.addEventListener("keydown", event => { if (event.key === "Enter") this.jump(row.line); });
		if (this.nocite.has(row.citekey)) item.createSpan({ cls: "cmds-zotero-reference-tag", text: "nocite" });
		if (row.status === "resolved" && row.entry) {
			const entry = row.entry;
			text.setText(fallbackCitation(entry));
			const actions = item.createDiv({ cls: "cmds-zotero-reference-actions" });
			// 0.6.2 citation-occurrence-navigation
			if (!this.nocite.has(row.citekey)) {
				this.action(actions, "chevron-up", "Previous occurrence in the note", () => this.occurrence(row.citekey, "previous"));
				this.action(actions, "chevron-down", "Next occurrence in the note", () => this.occurrence(row.citekey, "next"));
			}
			this.action(actions, "file-text", "Open literature note", () => this.plugin.openNote(entry));
			this.action(actions, "external-link", "Open in Zotero", () => { window.open(entry.zoteroSelectURI); });
			this.action(actions, "file", "Open PDF", () => this.plugin.openPdf(entry));
			this.action(actions, "link", "Copy Zotero link", () => this.plugin.copyLink(entry.title, entry.zoteroSelectURI));
		} else {
			text.setText(referenceRowText(row, state));
			if (!this.nocite.has(row.citekey)) {
				const actions = item.createDiv({ cls: "cmds-zotero-reference-actions" });
				this.action(actions, "chevron-up", "Previous occurrence in the note", () => this.occurrence(row.citekey, "previous"));
				this.action(actions, "chevron-down", "Next occurrence in the note", () => this.occurrence(row.citekey, "next"));
			}
		}
		return text;
	}

	private async occurrence(citekey: string, direction: "next" | "previous"): Promise<void> {
		if (this.file) await this.plugin.references.goToOccurrenceIn(this.file, citekey, direction);
	}

	private action(parent: HTMLElement, icon: string, label: string, run: () => Promise<void> | void): void {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", () => { void this.plugin.run(async () => { await run(); }); });
	}

	private jump(line: number): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file !== this.file) return;
		view.editor.setCursor({ line, ch: 0 });
		view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
	}

	private async copyBibliography(): Promise<void> {
		const resolved = resolvedEntries(this.rows);
		if (!resolved.length) { new Notice("No resolved references to copy."); return; }
		// 0.6.2: formatted and plain text in the configured order, with the note's style and locale; the Notice names the sources.
		await this.plugin.run(() => this.plugin.bibliography.copyBibliography(resolved, this.format ?? { style: this.plugin.settings.bibliographyStyle, locale: this.plugin.settings.bibliographyLocale }));
	}

	onClose(): Promise<void> { this.contentEl.empty(); this.status = null; return Promise.resolve(); }

	// 0.5 R4: the shared status line in the header, updated by the plugin without a full re-render.
	renderStatus(line: string): void { this.status?.setText(line); }

	// 0.5 R12: live text replaces the author-year line; cached and fallback answers carry a small provenance tag.
	private showBibliography(text: HTMLElement, entry: ZoteroIndexEntry, detail: BibliographyDetail): void {
		text.setText(detail.text || fallbackCitation(entry));
		const tag = bibliographySourceTag(detail);
		if (tag) text.createSpan({ cls: "cmds-zotero-reference-tag", text: tag, attr: { title: detail.source === "cached" ? "Rendered earlier by Better BibTeX and stored in .cmds-zotero/bibliography.json" : "Zotero did not answer; no cached rendering exists for this item" } });
	}
}
