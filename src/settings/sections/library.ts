import type { SectionDefinition } from "../model";
import { integerField, vaultPathField } from "../fields";

/** Literature index: where the validated snapshot lives and when it counts as stale. */
export const librarySection: SectionDefinition = {
	id: "library",
	define(section) {
		section.setName("Literature index");
		section.text(vaultPathField("zoteroIndexPath")).setName("Index path").setDesc("Vault-relative JSON path. A validated snapshot replaces the previous file only after collection succeeds; the three most recent previous snapshots are kept as backups in the plugin's private folder.");
		section.text(integerField("indexMaxAgeMinutes", 1, 10080)).setName("Maximum index age").setDesc("Minutes before a query refreshes the snapshot (1–10080). Refresh is a full scan, not a server-side incremental cursor. The saved index is still used for reading when Zotero is unreachable; refresh is explicit.");
		section.button(actions => actions.refreshIndex()).setName("Refresh saved index").setDesc("Collects the index from Zotero now with the saved configuration.").setButtonText("Refresh");
	},
};
