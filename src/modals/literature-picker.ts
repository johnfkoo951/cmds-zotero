import { App, FuzzySuggestModal, type FuzzyMatch } from "obsidian";
import { filterEntries, needsNotes, rankingQuery, type QueryContext } from "../search/query";
import type { ZoteroIndexEntry } from "../types";

/**
 * The literature picker (0.6.1 R18): fielded terms (`col:`, `tag:`, `author:`, `year:`, `lib:`, `type:`, `has:`) narrow
 * the entries first, then the remaining free text is ranked by Obsidian's fuzzy search exactly as before. A query without
 * fielded terms takes the unchanged fuzzy path; an empty field still being typed (`tag:`) is ignored, not searched as text. Reads the loaded index only; never calls Better BibTeX.
 */
export class LiteraturePickerModal extends FuzzySuggestModal<ZoteroIndexEntry> {
	private current: ZoteroIndexEntry[];

	constructor(app: App, private readonly entries: ZoteroIndexEntry[], private readonly label: (entry: ZoteroIndexEntry) => string, private readonly choose: (entry: ZoteroIndexEntry) => void, private readonly context: (withNotes: boolean) => QueryContext) {
		super(app);
		this.current = entries;
		this.setPlaceholder("Search literature… (author:, year:, tag:, col:, lib:, type:, has:)");
		this.setInstructions([{ command: "-tag:x", purpose: "exclude" }, { command: "\"a b\"", purpose: "phrase" }]);
		this.scope?.register([], "Enter", event => {
			if (event.isComposing || (event as { keyCode?: number }).keyCode === 229) return true;
			this.selectActiveSuggestion(event);
			return false;
		});
		this.inputEl?.addEventListener("compositionend", () => {
			const modal = this as unknown as { onInput?: () => void };
			if (typeof modal.onInput === "function") modal.onInput();
			else this.inputEl?.dispatchEvent(new Event("input"));
		});
	}

	getItems(): ZoteroIndexEntry[] { return this.current; }
	getItemText(entry: ZoteroIndexEntry): string { return this.label(entry); }
	onChooseItem(entry: ZoteroIndexEntry): void { this.choose(entry); }

	getSuggestions(query: string): FuzzyMatch<ZoteroIndexEntry>[] {
		const plan = rankingQuery(query);
		if (!plan.fielded) { this.current = this.entries; return super.getSuggestions(query); }
		this.current = filterEntries(this.entries, plan.terms, this.context(needsNotes(plan.terms)));
		if (plan.text.trim()) return super.getSuggestions(plan.text);
		return this.current.map(item => ({ item, match: { score: 0, matches: [] } }));
	}
}
