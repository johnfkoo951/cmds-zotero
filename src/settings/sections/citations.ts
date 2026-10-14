import type { SectionDefinition } from "../model";
import { choiceField, integerField, textField, toggleField } from "../fields";
import { CITATION_FORMATS } from "../../citations/formats";

/** Citations: when citekey completion opens, the format of the Zotero citation picker and (0.6.2) the citations editor. */
export const citationsSection: SectionDefinition = {
	id: "citations",
	define(section) {
		section.setName("Citations");
		section.dropdown(choiceField("citationTrigger", ["bracket", "at", "off"])).setName("Citation trigger")
			.setDesc("When citekey completion opens: after [@, also after a bare @ at the start of a word, or never. It reads only the saved index. Enter inserts the citation, Shift+Enter a narrative @key, Mod+Enter a link to the literature note.")
			.addOption("bracket", "Bracket ([@)").addOption("at", "At sign ([@ or a bare @)").addOption("off", "Off");
		section.text(textField("caywFormat")).setName("Citation format").setDesc("CAYW format of the Zotero citation picker; pandoc inserts [@citekey].");
		section.text(integerField("pickerWaitSeconds", 30, 1800)).setName("Picker wait").setDesc("How long, in seconds, inserting a citation waits for you to choose in Zotero's picker (30–1800). Cancel stops waiting at any time.");
		// 0.6.2 WP5: citations editor.
		const formats = section.dropdown(choiceField("citationFormat", CITATION_FORMATS.map(format => format.id))).setName("Default citation format")
			.setDesc("The format of citations inserted from the literature index and of pasted Zotero links. The list is fixed; each format also has its own insert command. Author-date text is an approximation from the index, not a citation style.");
		for (const format of CITATION_FORMATS) formats.addOption(format.id, `${format.name}: ${format.example}`);
		section.toggle(toggleField("citekeyProblemMarks")).setName("Mark citekey problems")
			.setDesc("Underline citekeys in the editor that the saved index does not have, that several items carry, or that are a former key of an item. Nothing is marked before the index is loaded.");
		section.toggle(toggleField("citationHover")).setName("Citation hover preview")
			.setDesc("Hovering a citation in the editor shows its title, authors, year and bibliography entry, from the saved index and the bibliography cache.");
		section.toggle(toggleField("authorDateRendering")).setName("Show citations as author-date")
			.setDesc("Reading view and live preview show pandoc citations such as [@key, p. 3] as author-date text, for example (author & author, 2020, p. 3). An approximation from the index; the note text does not change, and the cursor reveals the source.");
		section.dropdown(choiceField("citationClickAction", ["nothing", "note", "pdf"])).setName("Mod+click on a citation")
			.setDesc("What Ctrl+click (Cmd+click on macOS) on a citation in the editor opens. Wikilink citations keep Obsidian's own behaviour.")
			.addOption("nothing", "Nothing").addOption("note", "Literature note").addOption("pdf", "PDF (at the locator page)");
		section.toggle(toggleField("pasteZoteroLinks")).setName("Paste Zotero links as citations")
			.setDesc("Pasting or dropping Zotero item links (select links) of indexed items inserts a citation in the default format instead. Items are matched by library and item key, never by a first match; undo takes the citation out again.");
	},
};
