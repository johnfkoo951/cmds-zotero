import { App, FuzzySuggestModal } from "obsidian";
import { libraryName } from "../library/collections";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";

/** Thrown when the person closes a chooser without choosing; `plugin.run` ends the action quietly. */
export class ChoiceCancelled extends Error {
	constructor() { super("No item was chosen."); this.name = "ChoiceCancelled"; }
}

/** `Title — @key · 2020 · My Library` (with `former key @old` when the item carries `citekey` only as a previous key). */
export function candidateLabel(entry: ZoteroIndexEntry, index: Pick<ZoteroIndex, "libraries"> | null, citekey?: string): string {
	const library = libraryName(index, entry.libraryID) ?? (entry.libraryType === "group" ? `group ${entry.groupID ?? entry.libraryID}` : "My Library");
	const former = citekey && entry.citekey !== citekey ? ` · former key @${citekey}` : "";
	return `${entry.title || entry.citekey} — @${entry.citekey} · ${entry.year || "n.d."} · ${library}${former}`;
}

class EntryChooser extends FuzzySuggestModal<ZoteroIndexEntry> {
	private chosen = false;
	constructor(app: App, private readonly candidates: readonly ZoteroIndexEntry[], private readonly label: (entry: ZoteroIndexEntry) => string, placeholder: string, private readonly done: (entry: ZoteroIndexEntry | null) => void) {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems(): ZoteroIndexEntry[] { return [...this.candidates]; }
	getItemText(entry: ZoteroIndexEntry): string { return this.label(entry); }
	onChooseItem(entry: ZoteroIndexEntry): void { this.chosen = true; this.done(entry); }
	// A suggest modal closes before it reports the choice, so a close only counts as a cancel once the choice had its turn.
	onClose(): void { window.setTimeout(() => { if (!this.chosen) this.done(null); }, 0); }
}

/**
 * 0.6.2 ambiguous-citekey-chooser: the person picks one of `candidates` (several items carrying one citekey); never the
 * first match. Resolves null when the chooser is closed without a choice.
 */
export function chooseEntry(app: App, candidates: readonly ZoteroIndexEntry[], index: Pick<ZoteroIndex, "libraries"> | null, citekey?: string): Promise<ZoteroIndexEntry | null> {
	return new Promise(resolve => {
		const placeholder = citekey ? `${candidates.length} items carry @${citekey}; choose one…` : `Choose one of ${candidates.length} items…`;
		new EntryChooser(app, candidates, entry => candidateLabel(entry, index, citekey), placeholder, resolve).open();
	});
}

/** `chooseEntry`, but a close without a choice throws `ChoiceCancelled`. */
export async function requireChoice(app: App, candidates: readonly ZoteroIndexEntry[], index: Pick<ZoteroIndex, "libraries"> | null, citekey?: string): Promise<ZoteroIndexEntry> {
	if (!candidates.length) throw new Error("More than one item matches, but the candidates are not known. Refresh the index and try again.");
	const entry = await chooseEntry(app, candidates, index, citekey);
	if (!entry) throw new ChoiceCancelled();
	return entry;
}
