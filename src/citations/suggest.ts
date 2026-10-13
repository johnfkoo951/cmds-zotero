import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndexEntry } from "../types";
import { indexDerived } from "../index-derived";
import { rankCompletions } from "./score";

const KEY_CHARS = /^[A-Za-z0-9_:.+/-]*$/;

/** Inline `[@` / `@` citekey completion backed by the local index; never calls BBT while typing. */
export class CitekeySuggest extends EditorSuggest<ZoteroIndexEntry> {
	constructor(private plugin: CMDSZoteroPlugin) { super(plugin.app); }

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
		return rankCompletions(indexDerived(entries).completionRows, context.query);
	}

	renderSuggestion(entry: ZoteroIndexEntry, el: HTMLElement): void {
		el.createDiv({ cls: "cmds-zotero-suggest-title", text: entry.title || entry.citekey });
		el.createDiv({ cls: "cmds-zotero-suggest-meta", text: `@${entry.citekey} · ${entry.authors.slice(0, 2).join("; ")}${entry.authors.length > 2 ? " et al." : ""} · ${entry.year}${entry.libraryType === "group" ? ` · group ${entry.groupID}` : ""}` });
	}

	selectSuggestion(entry: ZoteroIndexEntry, event: MouseEvent | KeyboardEvent): void {
		const context = this.context;
		if (!context) return;
		const editor = context.editor;
		const before = editor.getLine(context.start.line).slice(0, context.start.ch);
		const after = editor.getLine(context.end.line).slice(context.end.ch);
		const wiki = before.endsWith("[[");
		const insideBracket = !wiki && before.endsWith("[");
		let text: string;
		let closer = "";
		if (wiki) { text = `@${entry.citekey}`; closer = after.startsWith("]]") ? "" : "]]"; }
		else if (insideBracket) { text = `@${entry.citekey}`; closer = after.startsWith("]") ? "" : "]"; }
		else if (event.shiftKey) text = `@${entry.citekey}`;
		else text = /[[;]\s*-?$/.test(before) ? `@${entry.citekey}` : `[@${entry.citekey}]`;
		editor.replaceRange(text + closer, context.start, context.end);
		const ch = context.start.ch + text.length + (closer ? closer.length : 0);
		editor.setCursor({ line: context.start.line, ch });
	}
}
