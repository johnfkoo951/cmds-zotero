import { App, Keymap, SuggestModal } from "obsidian";
import { searchAnnotations, type AnnotationSearchRow, type InsertMode } from "../annotations/search";

/** What choosing a row does: insert in one of the formats, or pin the item in the annotations sidebar. */
export type AnnotationSearchAction = InsertMode | "pin";

/**
 * 0.6.1 annotation-search-insert: every indexed annotation, searched word by word. Enter inserts the callout, Shift+Enter
 * a quote with its citation, Mod+Enter only the link, Alt+Enter pins the item in the annotations sidebar.
 */
export class AnnotationSearchModal extends SuggestModal<AnnotationSearchRow> {
	constructor(app: App, private readonly rows: readonly AnnotationSearchRow[], empty: string, source: string, private readonly choose: (row: AnnotationSearchRow, action: AnnotationSearchAction) => void) {
		super(app);
		this.limit = 100;
		this.emptyStateText = empty;
		this.setPlaceholder(`Search annotations: text, comment, tag, page, citekey (${source.toLowerCase()})`);
		this.setInstructions([
			{ command: "↵", purpose: "insert callout" },
			{ command: "shift ↵", purpose: "insert quote with citation" },
			{ command: "mod ↵", purpose: "insert link" },
			{ command: "alt ↵", purpose: "pin in annotations sidebar" },
		]);
		for (const modifier of ["Shift", "Mod", "Alt"] as const) {
			this.scope.register([modifier], "Enter", event => { this.selectActiveSuggestion(event); return false; });
		}
	}

	getSuggestions(query: string): AnnotationSearchRow[] { return searchAnnotations(this.rows, query, this.limit); }

	renderSuggestion(row: AnnotationSearchRow, el: HTMLElement): void {
		el.createDiv({ text: row.snippet.length > 240 ? `${row.snippet.slice(0, 240)}…` : row.snippet });
		if (row.annotation.text && row.annotation.comment) el.createEl("small", { cls: "cmds-zotero-annotation-comment", text: row.annotation.comment });
		el.createEl("small", { cls: "setting-item-description", text: `${row.label} · ${row.entry.title}` });
	}

	onChooseSuggestion(row: AnnotationSearchRow, event: MouseEvent | KeyboardEvent): void {
		const action: AnnotationSearchAction = Keymap.isModifier(event, "Alt") ? "pin" : Keymap.isModifier(event, "Shift") ? "quote" : Keymap.isModifier(event, "Mod") ? "link" : "callout";
		this.choose(row, action);
	}
}
