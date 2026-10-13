import type { SectionDefinition } from "../model";
import { tagsField, vaultPathField } from "../fields";

/** Literature notes: where imported notes and annotation images go and what they leave out. */
export const notesSection: SectionDefinition = {
	id: "notes",
	define(section) {
		section.setName("Literature notes");
		section.text(vaultPathField("outputFolder")).setName("Output folder").setDesc("New notes use the built-in preservation-aware template. Existing unowned files are never overwritten.");
		section.text(vaultPathField("imageFolder")).setName("Image folder").setDesc("Vault-relative destination for explicitly imported annotation images.");
		section.textArea(tagsField("excludedTags")).setName("Excluded tags").setDesc("Zotero tags left out of imported literature notes, one per line (case-insensitive). An empty list keeps every tag; the default is obscite.");
	},
};
