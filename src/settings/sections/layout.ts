import type { SectionDefinition } from "../model";
import { splitLines, toggleField, type Field, type SettingKey } from "../fields";
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
		section.toggle(toggleField("noteLinks")).setName("Links").setDesc("Show the links to the item in Zotero and to its attachments.");
		section.toggle(toggleField("noteZoteroNotes")).setName("Zotero notes").setDesc("Show the item's child notes from Zotero.");
		section.toggle(toggleField("noteSynthesis")).setName("Synthesis scaffold").setDesc("Add the synthesis heading and callout to new notes. It belongs to you and is never updated.");
		section.textArea(synthesisLinesField).setName("Synthesis lines").setDesc("Lines of the synthesis callout in new notes, one per line. An empty list keeps the default.")
			.setPlaceholder(DEFAULT_SYNTHESIS_LINES.join("\n"));
		section.text(annotationsHeadingField).setName("Annotations heading").setDesc("Heading that new notes place annotations under. Existing notes keep their heading.").setPlaceholder("Annotations");
		section.text(calloutField("calloutAbstract")).setName("Abstract callout type").setDesc("Obsidian callout type of the abstract.").setPlaceholder(DEFAULT_CALLOUTS.abstract);
		section.text(calloutField("calloutCite")).setName("Bibliography callout type").setDesc("Obsidian callout type of the bibliography entry.").setPlaceholder(DEFAULT_CALLOUTS.cite);
		section.text(calloutField("calloutMetadata")).setName("Metadata callout type").setDesc("Obsidian callout type of the metadata fields.").setPlaceholder(DEFAULT_CALLOUTS.metadata);
		section.text(calloutField("calloutLinks")).setName("Links callout type").setDesc("Obsidian callout type of the links.").setPlaceholder(DEFAULT_CALLOUTS.links);
		section.text(calloutField("calloutSynthesis")).setName("Synthesis callout type").setDesc("Obsidian callout type of the synthesis scaffold in new notes.").setPlaceholder(DEFAULT_CALLOUTS.synthesis);
	},
};
