import type { SectionDefinition } from "../model";
import { textField, toggleField } from "../fields";

/** Bibliography and references: the CSL style and the references sidebar. */
export const bibliographySection: SectionDefinition = {
	id: "bibliography",
	define(section) {
		section.setName("Bibliography and references");
		section.text(textField("bibliographyStyle")).setName("Bibliography style").setDesc("Installed Zotero CSL style identifier, for example apa.");
		section.toggle(toggleField("referencesFollowActiveNote")).setName("References sidebar follows the active note")
			.setDesc("Re-render the references sidebar whenever another note becomes active. When off, it keeps the note it shows until you press its refresh button.");
	},
};
