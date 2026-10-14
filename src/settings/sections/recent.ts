import type { SectionDefinition } from "../model";
import { RECENT_WINDOW_CHOICES } from "../../recent/recent-reads";
import { numberChoiceField } from "../fields";

/** Recently read: how far back Zotero's reading history is listed. */
export const recentSection: SectionDefinition = {
	id: "recent",
	define(section) {
		section.setName("Recently read");
		const days = section.dropdown(numberChoiceField("recentReadsDays", 1, 365)).setName("Recently read window")
			.setDesc("How far back the recently read list looks in Zotero's reading history (the day a PDF was last opened in Zotero's reader). The literature picker also lists these papers first.");
		// A stored value outside the fixed choices (data.json allows 1–365) stays selectable, in numeric order.
		days.addOptionsFrom(draft => [...new Set([...RECENT_WINDOW_CHOICES, draft.recentReadsDays])].sort((a, b) => a - b).map(choice => [String(choice), `${choice} days`]));
	},
};
