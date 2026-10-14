import type { SectionDefinition } from "../model";
import { linesField } from "../fields";

/** Agent command line: keys only the agent CLI reads (shown under Advanced). */
export const agentsSection: SectionDefinition = {
	id: "agents",
	advanced: true,
	define(section) {
		section.setName("Agent command line");
		section.textArea(linesField("referencesHeadings")).setName("References headings")
			.setDesc("One heading title per line. For the agent CLI's cites and citing actions, a ##–###### heading with one of these titles (case-insensitive, spaces optional, an optional short qualifier in parentheses) marks a note's references section: keys listed under it are reported as listed references instead of being checked as citations, and the Markdown references block reuses that heading. The references sidebar and the commands that copy CSL-JSON or write the pandoc bibliography sidecar do not read this list. An empty list restores the defaults.");
	},
};
