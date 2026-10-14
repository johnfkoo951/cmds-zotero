import type { SectionDefinition } from "../model";
import { choiceField, integerField, textField } from "../fields";

/** Citations: when citekey completion opens and the format of the Zotero citation picker. */
export const citationsSection: SectionDefinition = {
	id: "citations",
	define(section) {
		section.setName("Citations");
		section.dropdown(choiceField("citationTrigger", ["bracket", "at", "off"])).setName("Citation trigger")
			.setDesc("When citekey completion opens: after [@, also after a bare @ at the start of a word, or never. It reads only the saved index.")
			.addOption("bracket", "Bracket ([@)").addOption("at", "At sign ([@ or a bare @)").addOption("off", "Off");
		section.text(textField("caywFormat")).setName("Citation format").setDesc("CAYW format of the Zotero citation picker; pandoc inserts [@citekey].");
		section.text(integerField("pickerWaitSeconds", 30, 1800)).setName("Picker wait").setDesc("How long, in seconds, inserting a citation waits for you to choose in Zotero's picker (30–1800). Cancel stops waiting at any time.");
	},
};
