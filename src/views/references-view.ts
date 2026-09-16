import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndexEntry } from "../types";
import { scanCitations } from "../citations/scan";
import { formatIndexAge } from "../index-service";
import { markdownLink } from "../uris";

export const VIEW_TYPE_REFERENCES = "cmds-zotero-references";

/** `unchecked`: no index snapshot is loaded, so the row makes no claim about the citekey. */
interface ReferenceRow {
	citekey: string;
	line: number;
	status: "resolved" | "ambiguous" | "not-found" | "unchecked";
	entry?: ZoteroIndexEntry;
	candidates?: ZoteroIndexEntry[];
}

/** Sidebar bibliography for the citekeys in the active note. Resolution is index-local; bibliography text is fetched from BBT and cached. */
export class ReferencesView extends ItemView {
	private file: TFile | null = null;
	private rows: ReferenceRow[] = [];
	private generation = 0;
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

	private resolveRows(text: string): ReferenceRow[] {
		const entries = this.plugin.cachedEntries();
		const loaded = entries.length > 0;
		const byKey = new Map<string, ZoteroIndexEntry[]>();
		for (const entry of entries) for (const alias of new Set([entry.citekey, ...entry.citekeyHistory])) (byKey.get(alias) ?? byKey.set(alias, []).get(alias))?.push(entry);
		const rows: ReferenceRow[] = [];
		const seen = new Set<string>();
		for (const occurrence of scanCitations(text)) {
			if (seen.has(occurrence.citekey)) continue;
			seen.add(occurrence.citekey);
			const matches = byKey.get(occurrence.citekey) ?? [];
			if (matches.length === 1) rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: "resolved", entry: matches[0] });
			else if (matches.length > 1) rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: "ambiguous", candidates: matches });
			else rows.push({ citekey: occurrence.citekey, line: occurrence.line, status: loaded ? "not-found" : "unchecked" });
		}
		return rows;
	}

	/** Header count with the snapshot age when it is stale; "index not loaded" when no snapshot is loaded. */
	private headerText(): string {
		const count = `${this.rows.length} reference${this.rows.length === 1 ? "" : "s"}`;
		if (!this.plugin.cachedEntries().length) return `${count} · index not loaded`;
		if (this.plugin.cachedIndexStale()) return `${count} · index ${formatIndexAge(this.plugin.cachedIndexAgeMinutes())} old`;
		return count;
	}

	async render(): Promise<void> {
		const generation = ++this.generation;
		const file = this.activeFile();
		this.file = file;
		const container = this.contentEl;
		container.empty();
		container.addClass("cmds-zotero-sidebar");
		const header = container.createDiv({ cls: "cmds-zotero-sidebar-header" });
		if (!file) { header.createEl("p", { text: "Open a Markdown note to list its references." }); return; }
		this.rows = this.resolveRows(await this.noteText(file));
		if (generation !== this.generation) return;
		header.createEl("div", { cls: "cmds-zotero-sidebar-title", text: file.basename });
		const toolbar = header.createDiv({ cls: "cmds-zotero-sidebar-toolbar" });
		toolbar.createSpan({ text: this.headerText() });
		const copy = toolbar.createEl("button", { text: "Copy bibliography", attr: { "aria-label": "Copy the resolved bibliography as text" } });
		copy.addEventListener("click", () => { void this.copyBibliography(); });
		const refresh = toolbar.createEl("button", { attr: { "aria-label": "Refresh references" } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => { void this.plugin.warmIndex(true).then(() => { this.refresh(); }); });
		// At most one warm-up per render generation; the plugin backs off after a failure, so this never re-hits BBT per render.
		if ((!this.plugin.cachedEntries().length || this.plugin.cachedIndexStale()) && !this.plugin.warmBackoffActive()) void this.plugin.warmIndex();
		const list = container.createEl("ol", { cls: "cmds-zotero-reference-list" });
		if (!this.rows.length) container.createEl("p", { cls: "setting-item-description", text: "No [@citekey], @citekey, or [[@citekey]] citations found." });
		for (const row of this.rows) this.renderRow(list.createEl("li", { cls: `cmds-zotero-reference cmds-zotero-reference-${row.status}` }), row, generation);
	}

	private renderRow(item: HTMLElement, row: ReferenceRow, generation: number): void {
		const text = item.createDiv({ cls: "cmds-zotero-reference-text", attr: { role: "button", tabindex: "0" } });
		text.addEventListener("click", () => this.jump(row.line));
		text.addEventListener("keydown", event => { if (event.key === "Enter") this.jump(row.line); });
		if (row.status === "resolved" && row.entry) {
			const entry = row.entry;
			text.setText(this.fallbackCitation(entry));
			void this.plugin.bibliographyFor(entry).then(bibliography => { if (generation === this.generation && bibliography) text.setText(bibliography); }).catch(() => undefined);
			const actions = item.createDiv({ cls: "cmds-zotero-reference-actions" });
			this.action(actions, "file-text", "Open literature note", () => this.plugin.openNote(entry));
			this.action(actions, "external-link", "Open in Zotero", () => { window.open(entry.zoteroSelectURI); });
			this.action(actions, "file", "Open PDF", () => this.plugin.openPdf(entry, 1));
			this.action(actions, "link", "Copy Zotero link", () => this.plugin.copyLink(entry.title, entry.zoteroSelectURI));
		} else if (row.status === "ambiguous") {
			text.setText(`@${row.citekey} matches ${row.candidates?.length ?? 0} items across libraries. Change the citekey in Zotero or narrow the library.`);
		} else if (row.status === "unchecked") {
			text.setText(`@${row.citekey} — index not loaded; refresh to check`);
		} else if (this.plugin.cachedIndexStale()) {
			text.setText(`@${row.citekey} is not in the saved index (${formatIndexAge(this.plugin.cachedIndexAgeMinutes())} old); refresh to confirm.`);
		} else {
			text.setText(`@${row.citekey} is not in the literature index. Refresh the index or check the key.`);
		}
	}

	private action(parent: HTMLElement, icon: string, label: string, run: () => Promise<void> | void): void {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", () => { void this.plugin.run(async () => { await run(); }); });
	}

	private fallbackCitation(entry: ZoteroIndexEntry): string {
		return `${entry.authors.slice(0, 3).join(", ")}${entry.authors.length > 3 ? " et al." : ""} (${entry.year || "n.d."}). ${entry.title}`;
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
		const lines: string[] = [];
		for (const row of resolved) {
			const bibliography = await this.plugin.bibliographyFor(row.entry).catch(() => "");
			lines.push(bibliography || markdownLink(this.fallbackCitation(row.entry), row.entry.zoteroSelectURI));
		}
		await navigator.clipboard.writeText(lines.join("\n\n"));
		new Notice(`Copied ${lines.length} bibliography entr${lines.length === 1 ? "y" : "ies"}.`);
	}

	onClose(): Promise<void> { this.contentEl.empty(); return Promise.resolve(); }
}
