import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, Keymap, Notice, TFile } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndexEntry } from "../types";
import { indexDerived } from "../index-derived";
import { rankCompletions } from "./score";
import { matchesQuery, queryContext, rankingQuery } from "../search/query";
import { PickerModal } from "../modals/picker";
import { authorDateLabel } from "./author-date";
import { acceptEdit, bracketSpan, type LineEdit } from "./cluster";

/** 0.6.2 suggester-unicode-query: letters, marks and digits of any script (Korean in NFC or NFD, accented Latin) besides citekey characters. */
const KEY_CHARS = /^[\p{L}\p{M}\p{N}_:.+/-]*$/u;

interface ImeEvent { isComposing?: boolean; keyCode?: number }

const isComposingEvent = (event: MouseEvent | KeyboardEvent | null | undefined): boolean =>
	Boolean(event && ((event as ImeEvent).isComposing || (event as ImeEvent).keyCode === 229));

/** The suggester's internal list; Shift+Enter and Mod+Enter accept the highlighted row through it. */
interface SuggestList { useSelectedItem?(event: KeyboardEvent): boolean }

/** Inline `[@` / `@` citekey completion backed by the local index; never calls BBT while typing. */
export class CitekeySuggest extends EditorSuggest<ZoteroIndexEntry> {
	constructor(private plugin: CMDSZoteroPlugin) {
		super(plugin.app);
		// 0.6.2 suggester-alternate-insert: modifier keys insert the alternate forms; the hints show under the list.
		this.setInstructions([
			{ command: "↵", purpose: "cite" },
			{ command: "shift ↵", purpose: "narrative @key" },
			{ command: "mod ↵", purpose: "link the literature note" },
		]);
		for (const modifiers of [[], ["Shift"], ["Mod"]] as const) {
			this.scope.register([...modifiers], "Enter", event => {
				if (isComposingEvent(event)) return true;
				const list = (this as unknown as { suggestions?: SuggestList }).suggestions;
				if (!list?.useSelectedItem) return true;
				list.useSelectedItem(event);
				return false;
			});
		}
	}

	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const mode = this.plugin.settings.citationTrigger;
		if (mode === "off") return null;
		const line = editor.getLine(cursor.line).slice(0, cursor.ch);
		const at = line.lastIndexOf("@");
		if (at < 0) return null;
		const query = line.slice(at + 1);
		if (!KEY_CHARS.test(query) || query.length > 80) return null;
		const before = line.slice(0, at);
		const bracket = before.endsWith("[") || before.endsWith("[[") || /[[;]\s*-?$/.test(before);
		if (!bracket) {
			if (mode !== "at") return null;
			if (before && !/[\s(]$/.test(before)) return null;
		}
		return { start: { line: cursor.line, ch: at }, end: cursor, query };
	}

	getSuggestions(context: EditorSuggestContext): ZoteroIndexEntry[] {
		const entries = this.plugin.cachedEntries();
		// Empty means "not loaded", never "no matches": warm up (peek-first, no BBT call while backing off) and offer nothing yet.
		if (!entries.length) { if (!this.plugin.warmBackoffActive()) void this.plugin.warmIndex(); return []; }
		// 0.6 PERF-04: the lower-cased rows are prepared once per index generation; a keystroke is one pass over them.
		const rows = indexDerived(entries).completionRows;
		// 0.6.1 R18: a known field prefix (`[@tag:method`, `[@col:Thesis/Methods`) narrows the rows first; `has:note` is not offered here.
		const plan = rankingQuery(context.query);
		if (!plan.fielded) return rankCompletions(rows, context.query);
		if (!plan.terms.length) return rankCompletions(rows, plan.text); // `[@tag:` while typing: the empty field is ignored
		const query = queryContext(this.plugin.lastIndex);
		return rankCompletions(rows.filter(row => matchesQuery(row.entry, plan.terms, query)), plan.text);
	}

	renderSuggestion(entry: ZoteroIndexEntry, el: HTMLElement): void {
		el.createDiv({ cls: "cmds-zotero-suggest-title", text: entry.title || entry.citekey });
		el.createDiv({ cls: "cmds-zotero-suggest-meta", text: `@${entry.citekey} · ${entry.authors.slice(0, 2).join("; ")}${entry.authors.length > 2 ? " et al." : ""} · ${entry.year}${entry.libraryType === "group" ? ` · group ${entry.groupID}` : ""}` });
	}

	/**
	 * Enter cites (`[@key]`, or `@key` inside a bracket); typing `[@` right after a cluster adds the key to it (0.6.2
	 * multi-source-citation-cluster). Shift inserts a narrative `@key`; Mod links the literature note.
	 */
	selectSuggestion(entry: ZoteroIndexEntry, event: MouseEvent | KeyboardEvent): void {
		if (isComposingEvent(event)) return;
		const context = this.context;
		if (!context) return;
		const editor = context.editor;
		const line = editor.getLine(context.start.line);
		if (Keymap.isModifier(event, "Mod") && this.insertNoteLink(entry, editor, context.file, context.start, context.end, line)) return;
		apply(editor, context.start.line, acceptEdit(line, context.start.ch, context.end.ch, entry.citekey, event.shiftKey ? "narrative" : "default"));
	}

	/**
	 * Mod+Enter: a link to the entry's literature note in place of the typed `[@query]`. False (the citation is inserted
	 * instead) inside a multi-key cluster or when the vault has no note for the entry; several notes are offered to choose.
	 */
	private insertNoteLink(entry: ZoteroIndexEntry, editor: Editor, file: TFile | null, start: EditorPosition, end: EditorPosition, line: string): boolean {
		const span = bracketSpan(line, start.ch, end.ch);
		const index = this.plugin.lastIndex;
		if (!span || !index) return false;
		const files = this.plugin.links.localFiles(entry, index);
		if (!files.length) { new Notice(`No literature note for @${entry.citekey} in this vault yet; inserted the citation instead.`); return false; }
		const insert = (note: TFile): void => {
			if (editor.getLine(start.line) !== line) { new Notice("The line changed while choosing; nothing was inserted."); return; }
			const link = this.plugin.app.fileManager.generateMarkdownLink(note, file?.path ?? "", undefined, authorDateLabel(entry));
			apply(editor, start.line, { from: span.from, to: span.to, text: link, cursor: span.from + link.length });
		};
		if (files.length === 1) insert(files[0]);
		else new PickerModal(this.plugin.app, files, note => note.path, insert, `Choose the literature note of @${entry.citekey}…`).open();
		return true;
	}
}

function apply(editor: Editor, line: number, edit: LineEdit): void {
	editor.replaceRange(edit.text, { line, ch: edit.from }, { line, ch: edit.to });
	editor.setCursor({ line, ch: edit.cursor });
}
