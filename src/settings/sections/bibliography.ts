import type { SectionDefinition } from "../model";
import { choiceField, dataDirectoryField, exportFolderField, localeField, pandocPathField, textField, toggleField } from "../fields";

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
		section.toggle(toggleField("exportOutsideVault")).setName("Allow export kits outside the vault")
			.setDesc("Off: the export kits are written inside this vault only. On: the export kit folder may also be an absolute folder or one under ~/, so Word files, filters and copies stay out of the vault. The plugin then writes there and nowhere else outside the vault.");
		section.text(exportFolderField).setName("Export kit folder")
			.setDesc("Where the export kits are written, one subfolder per note: a vault folder, or an absolute folder or one under ~/ when writing outside the vault is allowed above. The source note is never changed.");
		section.toggle(toggleField("pandocAfterExport")).setName("Run pandoc after export")
			.setDesc("Off: the export commands copy the pandoc command line for you to run. On: they run pandoc on the kit and open the .docx with its default app. The Word kit needs Zotero running at that moment; pandoc then runs Better BibTeX's zotero.lua, which also checks retorque.re for a newer version of itself.");
		section.text(pandocPathField).setName("Pandoc path")
			.setDesc("The pandoc to run. Leave empty to look in /opt/homebrew/bin, /usr/local/bin and the other usual folders, then wherever the system finds it.")
			.setPlaceholder("/opt/homebrew/bin/pandoc");
		section.toggle(toggleField("hookmarkLinkExports")).setName("Link exports in Hookmark")
			.setDesc("macOS with Hookmark. After pandoc made the .docx, link it with the source note in Hookmark (one bookmark each, hooked together), so either opens the other. macOS asks once to let Obsidian control Hookmark.");
		section.toggle(toggleField("referencesFollowActiveNote")).setName("References sidebar follows the active note")
			.setDesc("Re-render the references sidebar whenever another note becomes active. When off, it keeps the note it shows until you press its refresh button.");
	},
};
