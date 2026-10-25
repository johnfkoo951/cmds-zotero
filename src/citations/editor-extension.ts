/**
 * 0.6.2 citations editor, CodeMirror side: citekey problem marks, author-date rendering in live preview, the hover card,
 * Mod+click, the right-click position for the editor menu, and dropped Zotero links. Only the visible lines are read;
 * lookups go through the host (the saved index snapshot, never Better BibTeX).
 */
import { StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, hoverTooltip, type DecorationSet, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, Keymap, type MarkdownFileInfo } from "obsidian";
import { maskIgnored } from "./cited-keys";
import { citationAt, citationsOnLine, parseClusters, type CitationCluster, type CitationItem } from "./cluster";
import type { CitekeyProblem } from "./problems";
import { withoutReferencesBlock } from "./references-block";

/** What the editor extension asks the plugin. */
export interface CitationEditorHost {
	marksEnabled(): boolean;
	hoverEnabled(): boolean;
	authorDateEnabled(): boolean;
	/** The problem of a citekey against the loaded snapshot, or null (no snapshot loaded: always null). */
	problem(citekey: string): { problem: CitekeyProblem; text: string } | null;
	/** The author-date text of a cluster, or null when a key does not resolve to exactly one item. */
	renderCluster(items: readonly CitationItem[]): string | null;
	/** Fills the hover card of a citation; false when there is nothing to show. */
	fillHover(dom: HTMLElement, item: CitationItem): boolean;
	/** Mod+click on a citation; true when the click was handled. */
	modClick(item: CitationItem, info: MarkdownFileInfo | null): boolean;
	/** The document offset of the last right-click, for the editor menu. */
	rememberContextMenu(info: MarkdownFileInfo | null, offset: number): void;
	/** A drop of text at `offset`; true when it was handled as Zotero links. */
	drop(text: string, info: MarkdownFileInfo | null, view: EditorView, offset: number): boolean;
	/** Live editor views, refreshed when the index or the settings change. */
	readonly views: Set<EditorView>;
}

/** Dispatched to every live editor when the index snapshot or the settings change. */
export const refreshCitations = StateEffect.define<null>();

/** The note text with frontmatter, fenced/inline code, HTML/Obsidian comments, escapes and the managed references block masked to spaces. */
export function maskCitationText(text: string): string {
	return maskIgnored(withoutReferencesBlock(text));
}

class AuthorDateWidget extends WidgetType {
	constructor(private readonly text: string, private readonly source: string) { super(); }
	eq(other: AuthorDateWidget): boolean { return other.text === this.text && other.source === this.source; }
	toDOM(): HTMLElement {
		const span = createSpan({ cls: "cmds-zotero-citation-rendered", text: this.text });
		span.setAttribute("aria-label", this.source);
		return span;
	}
	ignoreEvent(): boolean { return false; }
}

const MARK_CLASS: Record<CitekeyProblem, string> = { unknown: "cmds-zotero-citekey-unknown", ambiguous: "cmds-zotero-citekey-ambiguous", former: "cmds-zotero-citekey-former" };

export function buildDecorations(view: EditorView, host: CitationEditorHost): DecorationSet {
	const marks = host.marksEnabled();
	const livePreview = host.authorDateEnabled() && view.state.field(editorLivePreviewField, false) === true;
	if (!marks && !livePreview) return Decoration.none;
	const doc = view.state.doc;
	const ranges = view.visibleRanges;
	if (!ranges.length) return Decoration.none;
	const masked = maskCitationText(doc.toString());
	const selection = view.state.selection.ranges;
	const composing = Boolean(view.composing);
	const found: Range<Decoration>[] = [];
	let done = 0;
	for (const range of ranges) {
		for (let number = doc.lineAt(range.from).number; number <= doc.lineAt(range.to).number; number++) {
			if (number <= done) continue;
			done = number;
			const line = doc.line(number);
			const maskedLine = masked.slice(line.from, line.to);
			if (!maskedLine.includes("@")) continue;
			const replaced: { from: number; to: number }[] = [];
			if (livePreview) {
				for (const cluster of parseClusters(maskedLine)) {
					const from = line.from + cluster.start;
					const to = line.from + cluster.end;
					if (selection.some(sel => sel.to >= from && sel.from <= to)) continue; // the cursor reveals the source
					const text = host.renderCluster(cluster.items);
					if (!text) continue;
					replaced.push({ from, to });
					found.push(Decoration.replace({ widget: new AuthorDateWidget(text, line.text.slice(cluster.start, cluster.end)) }).range(from, to));
				}
			}
			if (marks) {
				for (const item of citationsOnLine(maskedLine)) {
					const from = line.from + item.keyStart - 1;
					const to = line.from + item.keyEnd;
					if (replaced.some(span => from >= span.from && to <= span.to)) continue;
					if (composing && selection.some(sel => sel.to >= from && sel.from <= to)) continue;
					const problem = host.problem(item.citekey);
					if (!problem) continue;
					found.push(Decoration.mark({ class: `cmds-zotero-citekey-problem ${MARK_CLASS[problem.problem]}`, attributes: { title: problem.text } }).range(from, to));
				}
			}
		}
	}
	return Decoration.set(found, true);
}

export function citationAtOffset(view: EditorView, offset: number): { item: CitationItem; cluster: CitationCluster | null } | null {
	const doc = view.state.doc;
	if (offset < 0 || offset > doc.length) return null;
	const masked = maskCitationText(doc.toString());
	const line = doc.lineAt(offset);
	const maskedLine = masked.slice(line.from, line.to);
	const column = offset - line.from;
	const found = citationAt(maskedLine, column);
	if (!found) return null;
	if (found.cluster && (column < found.item.start || column > found.item.end)) {
		return { item: found.cluster.items[0], cluster: found.cluster };
	}
	return found;
}

const info = (view: EditorView): MarkdownFileInfo | null => view.state.field(editorInfoField, false) ?? null;

/** The extensions `registerEditorExtension` installs. */
export function citationEditorExtension(host: CitationEditorHost): Extension[] {
	const decorations = ViewPlugin.fromClass(class implements PluginValue {
		decorations: DecorationSet;
		private wasComposing: boolean;
		constructor(private readonly view: EditorView) {
			host.views.add(view);
			this.wasComposing = Boolean(view.composing);
			this.decorations = buildDecorations(view, host);
		}
		update(update: ViewUpdate): void {
			const refresh = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshCitations)));
			const preview = update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false);
			const composingChanged = this.wasComposing !== Boolean(update.view.composing);
			this.wasComposing = Boolean(update.view.composing);
			if (refresh || preview || composingChanged || update.docChanged || update.viewportChanged || (update.selectionSet && (host.authorDateEnabled() || (host.marksEnabled() && this.wasComposing)))) {
				this.decorations = buildDecorations(update.view, host);
			}
		}
		destroy(): void { host.views.delete(this.view); }
	}, { decorations: value => value.decorations });

	const hover = hoverTooltip((view, pos) => {
		if (!host.hoverEnabled()) return null;
		const found = citationAtOffset(view, pos);
		if (!found) return null;
		const { item, cluster } = found;
		const line = view.state.doc.lineAt(pos);
		const start = cluster && (pos - line.from < item.start || pos - line.from > item.end) ? cluster.start : item.start;
		const end = cluster && (pos - line.from < item.start || pos - line.from > item.end) ? cluster.end : item.end;
		return {
			pos: line.from + start, end: line.from + end, above: true,
			create: () => {
				const dom = createDiv({ cls: "cmds-zotero-citation-hover" });
				if (!host.fillHover(dom, item)) dom.setText(`@${item.citekey}`);
				return { dom };
			},
		};
	}, { hoverTime: 400 });

	const events = EditorView.domEventHandlers({
		compositionend(_event, view) {
			try { view.dispatch({ effects: refreshCitations.of(null) }); }
			catch { queueMicrotask(() => { if (host.views.has(view)) view.dispatch({ effects: refreshCitations.of(null) }); }); }
			return false;
		},
		mousedown(event, view) {
			if (event.button === 2) {
				const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
				if (offset !== null) host.rememberContextMenu(info(view), offset);
				return false;
			}
			if (event.button !== 0 || !Keymap.isModifier(event, "Mod")) return false;
			const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (offset === null) return false;
			const found = citationAtOffset(view, offset);
			if (!found || found.item.form === "wikilink") return false;
			if (!host.modClick(found.item, info(view))) return false;
			event.preventDefault();
			return true;
		},
		contextmenu(event, view) {
			const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (offset !== null) host.rememberContextMenu(info(view), offset);
			return false;
		},
		drop(event, view) {
			const text = event.dataTransfer?.getData("text/plain") || event.dataTransfer?.getData("text/uri-list") || "";
			if (!text.includes("zotero://")) return false;
			const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (offset === null || !host.drop(text, info(view), view, offset)) return false;
			event.preventDefault();
			return true;
		},
	});

	return [decorations, hover, events];
}
