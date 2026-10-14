import type { SectionDefinition } from "../model";
import { tagsField, vaultPathField, type Field } from "../fields";
import { DEFAULT_FILENAME_PATTERN, NOTE_PATH_TOKENS, notePatternProblem } from "../../note-path";

const TOKENS = NOTE_PATH_TOKENS.map(token => `{${token}}`).join(", ");

/** 0.6.3 filename-folder-pattern: a pattern from the fixed token set; an empty file name pattern is saved as the default. */
export function notePatternField(key: "noteFilenamePattern" | "noteFolderPattern"): Field<string> {
	const folder = key === "noteFolderPattern";
	return {
		key, read: draft => draft[key],
		write: (draft, input) => {
			const value = input.trim() || (folder ? "" : DEFAULT_FILENAME_PATTERN);
			const problem = notePatternProblem(value, folder);
			if (problem) return problem;
			draft[key] = value;
			return null;
		},
	};
}

/** Literature notes: where imported notes and annotation images go and what they leave out. */
export const notesSection: SectionDefinition = {
	id: "notes",
	define(section) {
		section.setName("Literature notes");
		section.text(vaultPathField("outputFolder")).setName("Output folder").setDesc("New notes use the built-in preservation-aware template. Existing unowned files are never overwritten.");
		section.text(notePatternField("noteFilenamePattern")).setName("New note file name")
			.setDesc(`File name of new literature notes, from the tokens ${TOKENS}. Characters that cannot be in file names are replaced and long names are shortened. Existing notes keep their names. The default is @{citekey}.`)
			.setPlaceholder(DEFAULT_FILENAME_PATTERN);
		section.text(notePatternField("noteFolderPattern")).setName("New note subfolder")
			.setDesc("Subfolder of the output folder for new literature notes, from the same tokens, with / between levels (for example {itemType} or {collection}). Empty puts new notes directly in the output folder.")
			.setPlaceholder("{collection}");
		section.text(vaultPathField("imageFolder")).setName("Image folder").setDesc("Vault-relative destination for explicitly imported annotation images.");
		section.textArea(tagsField("excludedTags")).setName("Excluded tags").setDesc("Zotero tags left out of imported literature notes, one per line (case-insensitive). An empty list keeps every tag; the default is obscite.");
	},
};
