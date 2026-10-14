import type { SectionDefinition } from "../model";
import { endpointField } from "../fields";

/** Connection: the local Better BibTeX endpoint and a connection test. */
export const connectionSection: SectionDefinition = {
	id: "connection",
	define(section) {
		section.setName("Connection");
		section.text(endpointField).setName("Server endpoint").setDesc("Local Better BibTeX base URL. Zotero must be running; no cloud account or local API preference changes are needed.");
		section.button(actions => actions.testConnection()).setName("Test connection").setDesc("Tests the saved connection, without opening the citation picker.").setButtonText("Test");
	},
};
