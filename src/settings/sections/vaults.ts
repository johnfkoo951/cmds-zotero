import type { SectionDefinition } from "../model";
import { peerVaultsField } from "../fields";

/** Connected vaults and links: read-only peer note maps and the Hookmark boundary. */
export const vaultsSection: SectionDefinition = {
	id: "vaults",
	define(section) {
		section.setName("Connected vaults");
		section.textArea(peerVaultsField).setName("Peer vaults").setDesc("Opt-in, read-only access to each vault's published note map. One line: Vault name | absolute folder path. Refresh the index in each vault after importing notes.");
		section.note().setText("Hookmark-compatible links are Markdown links. This plugin does not change Hookmark settings, create bookmarks, or require Hookmark to be installed.");
	},
};
