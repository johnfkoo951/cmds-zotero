import type { SectionDefinition } from "../model";
import { choiceField, splitLines, toggleField, type Field, type SettingKey } from "../fields";
import { annotationsHeadingProblem, calloutTypeProblem, DEFAULT_CALLOUTS, DEFAULT_SYNTHESIS_LINES, synthesisLineProblem } from "../../layout";

type CalloutKey = Extract<SettingKey, "calloutAbstract" | "calloutCite" | "calloutMetadata" | "calloutLinks" | "calloutSynthesis">;

/** An Obsidian callout type; empty means the default (normalizeSettings). */
export function calloutField(key: CalloutKey): Field<string> {
	return {
		key, read: draft => draft[key],
		write: (draft, input) => { const problem = calloutTypeProblem(input); if (problem) return problem; draft[key] = input.trim(); return null; },
	};
}

/** Synthesis callout lines, one per line; an empty list is saved as the default scaffold. */
export const synthesisLinesField: Field<string> = {
	key: "synthesisLines", read: draft => draft.synthesisLines.join("\n"),
	write: (draft, input) => {
		const lines = splitLines(input);
		for (const [index, line] of lines.entries()) { const problem = synthesisLineProblem(line); if (problem) return `Line ${index + 1}: ${problem}`; }
		draft.synthesisLines = lines;
		return null;
	},
};

/** The annotations heading text; leading `#`s are dropped, empty means the default. */
export const annotationsHeadingField: Field<string> = {
	key: "annotationsHeading", read: draft => draft.annotationsHeading,
	write: (draft, input) => { const problem = annotationsHeadingProblem(input); if (problem) return problem; draft.annotationsHeading = input.trim().replace(/^#+\s*/, ""); return null; },
};

/** Note layout (0.6.1 R17): which parts of the built-in literature note are filled and what its callouts are called. */
export const layoutSection: SectionDefinition = {
	id: "layout",
	define(section) {
		section.setName("Note layout");
		section.note().setText("A part that is switched off keeps its place in the note with an empty generated block, so it can be switched on again later. Unedited parts of existing notes follow these choices on the next update; edited parts stay as they are.");
		section.toggle(toggleField("noteAbstract")).setName("Abstract").setDesc("Show the abstract under the title.");
		section.toggle(toggleField("noteCitation")).setName("Bibliography entry").setDesc("Show the formatted bibliography entry. Off, a first import no longer needs Zotero for bibliography text.");
		section.toggle(toggleField("noteMetadata")).setName("Metadata fields").setDesc("Show the authors, title, year, citekey and other fields.");
		section.toggle(toggleField("noteItemTypeFields")).setName("Fields by item type")
			.setDesc("Choose the metadata fields per item type (for example university and thesis type for a thesis, institution and report number for a report) and add the date, short title, language, access date, the key: value lines of the extra field and the dates the item was added and modified. Off keeps the fixed list of earlier versions.");
		section.toggle(toggleField("noteLinks")).setName("Links").setDesc("Show the links to the item in Zotero and to its attachments.");
		section.toggle(toggleField("joinContinuations")).setName("Join continued highlights")
			.setDesc("A highlight whose Zotero comment starts with + is added to the highlight before it in the same attachment: one block with both texts, the page span and the comments without the +. Off keeps every highlight separate.");
		section.toggle(toggleField("noteRichText")).setName("Zotero rich text")
			.setDesc("Show italics, bold, superscript and subscript from Zotero titles, annotation texts and comments as Markdown (<i> becomes *italics*), and drop nocase spans. Off shows the tags as text, as earlier versions did.");
		section.dropdown(choiceField("annotationTagStyle", ["plain", "hashtag"])).setName("Annotation tags")
			.setDesc("Write the Zotero tags of an annotation as Zotero has them, or as Obsidian tags (#method, spaces become -) that show up in the tag pane and in search. Excluded tags are left out either way.")
			.addOption("plain", "As in Zotero").addOption("hashtag", "Obsidian tags");
		section.toggle(toggleField("noteZoteroNotes")).setName("Zotero notes").setDesc("Show the item's child notes from Zotero.");
		section.toggle(toggleField("noteSynthesis")).setName("Synthesis scaffold").setDesc("Add the synthesis heading and callout to new notes. It belongs to you and is never updated.");
		section.textArea(synthesisLinesField).setName("Synthesis lines").setDesc("Lines of the synthesis callout in new notes, one per line. An empty list keeps the default.")
			.setPlaceholder(DEFAULT_SYNTHESIS_LINES.join("\n"));
		section.text(annotationsHeadingField).setName("Annotations heading").setDesc("Heading that new notes place annotations under. Existing notes keep their heading. A heading the note already uses for another section is refused.").setPlaceholder("Annotations");
		section.text(calloutField("calloutAbstract")).setName("Abstract callout type").setDesc("Obsidian callout type of the abstract.").setPlaceholder(DEFAULT_CALLOUTS.abstract);
		section.text(calloutField("calloutCite")).setName("Bibliography callout type").setDesc("Obsidian callout type of the bibliography entry.").setPlaceholder(DEFAULT_CALLOUTS.cite);
		section.text(calloutField("calloutMetadata")).setName("Metadata callout type").setDesc("Obsidian callout type of the metadata fields.").setPlaceholder(DEFAULT_CALLOUTS.metadata);
		section.text(calloutField("calloutLinks")).setName("Links callout type").setDesc("Obsidian callout type of the links.").setPlaceholder(DEFAULT_CALLOUTS.links);
		section.text(calloutField("calloutSynthesis")).setName("Synthesis callout type").setDesc("Obsidian callout type of the synthesis scaffold in new notes.").setPlaceholder(DEFAULT_CALLOUTS.synthesis);
	},
};
