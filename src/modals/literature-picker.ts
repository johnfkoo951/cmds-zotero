import { App, FuzzySuggestModal, type FuzzyMatch } from "obsidian";
import { filterEntries, needsNotes, parseQuery, type QueryContext } from "../search/query";
import type { ZoteroIndexEntry } from "../types";

/**
 * The literature picker (0.6.1 R18): fielded terms (`col:`, `tag:`, `author:`, `year:`, `lib:`, `type:`, `has:`) narrow
 * the entries first, then the remaining free text is ranked by Obsidian's fuzzy search exactly as before. A query without
 * fielded terms takes the unchanged fuzzy path. Reads the loaded index only; never calls Better BibTeX.
 */
export class LiteraturePickerModal extends FuzzySuggestModal<ZoteroIndexEntry> {
	private current: ZoteroIndexEntry[];

	constructor(app: App, private readonly entries: ZoteroIndexEntry[], private readonly label: (entry: ZoteroIndexEntry) => string, private readonly choose: (entry: ZoteroIndexEntry) => void, private readonly context: (withNotes: boolean) => QueryContext) {
		super(app);
		this.current = entries;
		this.setPlaceholder("Search literature… (author:, year:, tag:, col:, lib:, type:, has:)");
		this.setInstructions([{ command: "-tag:x", purpose: "exclude" }, { command: "\"a b\"", purpose: "phrase" }]);
	}

	getItems(): ZoteroIndexEntry[] { return this.current; }
	getItemText(entry: ZoteroIndexEntry): string { return this.label(entry); }
	onChooseItem(entry: ZoteroIndexEntry): void { this.choose(entry); }

	getSuggestions(query: string): FuzzyMatch<ZoteroIndexEntry>[] {
		const parsed = parseQuery(query);
		if (!parsed.terms.length) { this.current = this.entries; return super.getSuggestions(query); }
		this.current = filterEntries(this.entries, parsed.terms, this.context(needsNotes(parsed.terms)));
		if (parsed.text.trim()) return super.getSuggestions(parsed.text);
		return this.current.map(item => ({ item, match: { score: 0, matches: [] } }));
	}
}
