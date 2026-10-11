import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndexEntry } from "../types";
import { bibliographySourceTag, copyBibliographyNotice, countBibliographySources, fallbackCitation, referenceHeader, referenceRowText, resolveReferenceRows, type ReferenceRow, type SnapshotState } from "../citations/reference-rows";
import { markdownLink } from "../uris";
import type { BibliographyDetail } from "../bibliography-store"; // 0.5 R12

export const VIEW_TYPE_REFERENCES = "cmds-zotero-references";

/**
 * Sidebar bibliography for the citekeys in the active note. Resolution is index-local; bibliography text comes from the
 * plugin's memory → sidecar → BBT path in one batch per render (0.5 R12), so a closed or hung Zotero costs one short probe.
 */
export class ReferencesView extends ItemView {
	private file: TFile | null = null;
	private rows: ReferenceRow[] = [];
	private generation = 0;
	private status: HTMLElement | null = null; // 0.5 R4
	private readonly refresh = debounce(() => { void this.render(); }, 600, true);

	constructor(leaf: WorkspaceLeaf, private plugin: CMDSZoteroPlugin) { super(leaf); }
	getViewType(): string { return VIEW_TYPE_REFERENCES; }
	getDisplayText(): string { return "Zotero references"; }
	getIcon(): string { return "book-open"; }

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

	async render(): Promise<void> {
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
		this.rows = resolveReferenceRows(text, this.plugin.cachedEntries(), state.loaded);
		header.createEl("div", { cls: "cmds-zotero-sidebar-title", text: file.basename });
		const toolbar = header.createDiv({ cls: "cmds-zotero-sidebar-toolbar" });
		toolbar.createSpan({ text: referenceHeader(this.rows.length, state) });
		const copy = toolbar.createEl("button", { text: "Copy bibliography", attr: { "aria-label": "Copy the resolved bibliography as text" } });
		copy.addEventListener("click", () => { void this.copyBibliography(); });
		// 0.5 R10
		const csl = toolbar.createEl("button", { text: "Copy CSL-JSON", attr: { "aria-label": "Copy CSL-JSON for the resolved references (pandoc bibliography)" } });
		csl.addEventListener("click", () => { void this.plugin.run(() => this.plugin.copyCslJson(this.resolvedEntries())); });
		const refresh = toolbar.createEl("button", { attr: { "aria-label": "Refresh references" } });
		setIcon(refresh, "refresh-cw");
		refresh.disabled = this.plugin.forcedWarmActive();
		refresh.addEventListener("click", () => {
			// Re-render at once so the current snapshot and its age stay visible while a forced collection runs, then again when it settles.
			const warm = this.plugin.warmIndex(true);
			this.refresh();
			void warm.finally(() => { this.refresh(); });
		});
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
		if (slots.length) void this.plugin.bibliographyBatch(slots.map(slot => slot.entry)).then(details => {
			if (generation !== this.generation) return;
			details.forEach((detail, index) => { this.showBibliography(slots[index].text, slots[index].entry, detail); });
		}).catch(() => undefined);
	}

	private renderRow(item: HTMLElement, row: ReferenceRow, state: SnapshotState): HTMLElement {
		const text = item.createDiv({ cls: "cmds-zotero-reference-text", attr: { role: "button", tabindex: "0" } });
		text.addEventListener("click", () => this.jump(row.line));
		text.addEventListener("keydown", event => { if (event.key === "Enter") this.jump(row.line); });
		if (row.status === "resolved" && row.entry) {
			const entry = row.entry;
			text.setText(fallbackCitation(entry));
			const actions = item.createDiv({ cls: "cmds-zotero-reference-actions" });
			this.action(actions, "file-text", "Open literature note", () => this.plugin.openNote(entry));
			this.action(actions, "external-link", "Open in Zotero", () => { window.open(entry.zoteroSelectURI); });
			this.action(actions, "file", "Open PDF", () => this.plugin.openPdf(entry, 1));
			this.action(actions, "link", "Copy Zotero link", () => this.plugin.copyLink(entry.title, entry.zoteroSelectURI));
		} else {
			text.setText(referenceRowText(row, state));
		}
		return text;
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
		const resolved = this.rows.filter((row): row is ReferenceRow & { entry: ZoteroIndexEntry } => row.status === "resolved" && !!row.entry);
		if (!resolved.length) { new Notice("No resolved references to copy."); return; }
		// 0.5 R12: same detail as the rows (joins the current render generation instead of aborting it); the Notice names the sources.
		const details = await this.plugin.bibliographyBatch(resolved.map(row => row.entry), undefined, { fresh: false });
		const lines = details.map((detail, index) => detail.text || markdownLink(fallbackCitation(resolved[index].entry), resolved[index].entry.zoteroSelectURI));
		await navigator.clipboard.writeText(lines.join("\n\n"));
		new Notice(copyBibliographyNotice(countBibliographySources(details)));
	}

	onClose(): Promise<void> { this.contentEl.empty(); this.status = null; return Promise.resolve(); }

	// 0.5 R10: the resolved entries of the current rows, each once.
	private resolvedEntries(): ZoteroIndexEntry[] {
		const entries: ZoteroIndexEntry[] = [];
		for (const row of this.rows) if (row.status === "resolved" && row.entry && !entries.some(entry => entry.id === row.entry?.id)) entries.push(row.entry);
		return entries;
	}

	// 0.5 R4: the shared status line in the header, updated by the plugin without a full re-render.
	renderStatus(line: string): void { this.status?.setText(line); }

	// 0.5 R12: live text replaces the author-year line; cached and fallback answers carry a small provenance tag.
	private showBibliography(text: HTMLElement, entry: ZoteroIndexEntry, detail: BibliographyDetail): void {
		text.setText(detail.text || fallbackCitation(entry));
		const tag = bibliographySourceTag(detail);
		if (tag) text.createSpan({ cls: "cmds-zotero-reference-tag", text: tag, attr: { title: detail.source === "cached" ? "Rendered earlier by Better BibTeX and stored in .cmds-zotero/bibliography.json" : "Zotero did not answer; no cached rendering exists for this item" } });
	}
}
