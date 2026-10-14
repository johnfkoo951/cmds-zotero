import type { SectionDefinition } from "../model";
import { choiceField, dataDirectoryField, localeField, textField, toggleField, vaultPathField } from "../fields";

/** Bibliography and references: the CSL style and locale, the bibliography order, installed styles, the references sidebar and the export kit. */
export const bibliographySection: SectionDefinition = {
	id: "bibliography",
	define(section) {
		section.setName("Bibliography and references");
		section.text(textField("bibliographyStyle")).setName("Bibliography style")
			.setDesc("Installed Zotero CSL style identifier, for example apa. A style named in a note's frontmatter overrides it for that note. Saving a new style first checks once that Better BibTeX renders it.");
		section.button(actions => actions.chooseStyle()).setName("Choose an installed style")
			.setDesc("Lists the styles in the Zotero data directory's styles folder (read-only) and checks the one you pick with Better BibTeX before it goes into the style field.")
			.setButtonText("Choose style");
		section.text(localeField).setName("Bibliography locale")
			.setDesc("Language and region code for bibliography terms and dates. Leave empty for the style's default. A language named in a note's frontmatter overrides it for that note.");
		section.dropdown(choiceField("bibliographyOrder", ["style", "citation", "alphabetical"])).setName("Bibliography order")
			.setDesc("Order of a copied bibliography and of the references section. Style order asks Better BibTeX for the whole list, so the style sorts (and disambiguates); citation order and alphabetical are for styles that do not sort.")
			.addOption("style", "As the style orders it").addOption("citation", "Order of first citation").addOption("alphabetical", "Alphabetical");
		section.text(dataDirectoryField).setName("Zotero data directory")
			.setDesc("Folder that holds Zotero's styles folder, read only; Zotero shows it among its advanced settings under files and folders. Absolute, or starting with ~/.")
			.setPlaceholder("~/Zotero");
		section.text(vaultPathField("exportFolder")).setName("Export kit folder")
			.setDesc("Vault folder the pandoc export kit writes into, one subfolder per note. The source note is never changed.");
		section.toggle(toggleField("referencesFollowActiveNote")).setName("References sidebar follows the active note")
			.setDesc("Re-render the references sidebar whenever another note becomes active. When off, it keeps the note it shows until you press its refresh button.");
	},
};
