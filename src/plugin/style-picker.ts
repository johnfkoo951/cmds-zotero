import { Notice } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { InstalledStyle } from "../bibliography/csl-styles";
import { PickerModal } from "../modals/picker";

/**
 * 0.6.2 installed-csl-style-picker and probe-validated-style-picker: lists the Zotero styles folder (read-only), then
 * probes the chosen style once with `locale` and hands it to `use` only when Better BibTeX renders it. A refused style is
 * a Notice; nothing is saved here.
 */
export async function chooseInstalledStyle(plugin: CMDSZoteroPlugin, use: (style: InstalledStyle) => Promise<void> | void, locale = plugin.settings.bibliographyLocale): Promise<void> {
	const listing = await plugin.bibliography.installedStyles(true);
	if (!listing.styles.length) throw new Error(`No usable CSL styles in ${listing.directory}.`);
	const label = (style: InstalledStyle): string => `${style.title} · ${style.key}${style.parent ? " (dependent)" : ""}`;
	new PickerModal(plugin.app, listing.styles, label, style => {
		void plugin.run(async () => {
			const problem = await plugin.bibliography.probeFormat({ style: style.key, locale });
			if (problem) { new Notice(problem, 12000); return; }
			await use(style);
		});
	}, listing.truncated ? "Choose a style… (only the first 2000 files were read)" : "Choose a style…").open();
}

/** Command: choose an installed style and save it as the bibliography style. */
export async function chooseAndSaveStyle(plugin: CMDSZoteroPlugin): Promise<void> {
	await chooseInstalledStyle(plugin, async style => {
		await plugin.saveSettings({ ...plugin.settings, bibliographyStyle: style.key });
		new Notice(`Bibliography style set to ${style.title} (${style.key}).`);
	});
}
