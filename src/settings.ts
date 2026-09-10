import { App, PluginSettingTab, Setting } from "obsidian";
import type CMDSZoteroPlugin from "./main";

export class CmdsZoteroSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: CMDSZoteroPlugin) { super(app, plugin); }

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const draft = { ...this.plugin.settings, peerVaults: this.plugin.settings.peerVaults.map(peer => ({ ...peer })) };
		new Setting(containerEl).setName("Connection").setHeading();
		new Setting(containerEl).setName("Server endpoint").setDesc("Local Better BibTeX base URL. Zotero must be running; no cloud account or local API preference changes are needed.")
			.addText(text => text.setValue(draft.bbtEndpoint).onChange(value => { draft.bbtEndpoint = value.trim(); }));
		new Setting(containerEl).setName("Test connection").setDesc("Tests the saved connection, without opening the citation picker.")
			.addButton(button => button.setButtonText("Test").onClick(async () => {
				button.setDisabled(true);
				try {
					const result = await this.plugin.service.connection();
					status.setText(`Connected: Zotero ${result.capabilities.zotero}; Better BibTeX ${result.capabilities.betterbibtex}.`);
				} catch (error) { status.setText(error instanceof Error ? error.message : "Connection failed."); }
				finally { button.setDisabled(false); }
			}));
		new Setting(containerEl).setName("Request timeout").setDesc("Seconds for metadata requests (1–180).")
			.addText(text => text.setValue(String(draft.requestTimeoutMs / 1000)).onChange(value => { draft.requestTimeoutMs = Number(value) * 1000; }));
		new Setting(containerEl).setName("Attachment timeout").setDesc("Seconds for PDF and annotation requests (1–180); uncached images may take longer.")
			.addText(text => text.setValue(String(draft.attachmentTimeoutMs / 1000)).onChange(value => { draft.attachmentTimeoutMs = Number(value) * 1000; }));

		new Setting(containerEl).setName("Literature index").setHeading();
		new Setting(containerEl).setName("Index path").setDesc("Vault-relative JSON path. A validated snapshot replaces the previous file only after collection succeeds.")
			.addText(text => text.setValue(draft.zoteroIndexPath).onChange(value => { draft.zoteroIndexPath = value.trim(); }));
		new Setting(containerEl).setName("Maximum index age").setDesc("Minutes before a query refreshes the snapshot (1–10080). Refresh is a full scan, not a server-side incremental cursor.")
			.addText(text => text.setValue(String(draft.indexMaxAgeMinutes)).onChange(value => { draft.indexMaxAgeMinutes = Number(value); }));
		new Setting(containerEl).setName("Parallel requests").setDesc("Bounded attachment request concurrency (1–8).")
			.addText(text => text.setValue(String(draft.concurrency)).onChange(value => { draft.concurrency = Number(value); }));
		new Setting(containerEl).setName("Refresh saved index").addButton(button => button.setButtonText("Refresh").onClick(async () => {
			button.setDisabled(true); try { await this.plugin.refreshIndex(); } finally { button.setDisabled(false); }
		}));

		new Setting(containerEl).setName("Literature notes").setHeading();
		new Setting(containerEl).setName("Output folder").setDesc("New notes use the built-in preservation-aware template. Existing unowned files are never overwritten.")
			.addText(text => text.setValue(draft.outputFolder).onChange(value => { draft.outputFolder = value.trim(); }));
		new Setting(containerEl).setName("Image folder").setDesc("Vault-relative destination for explicitly imported annotation images.")
			.addText(text => text.setValue(draft.imageFolder).onChange(value => { draft.imageFolder = value.trim(); }));
		new Setting(containerEl).setName("Bibliography style").setDesc("Installed Zotero CSL style identifier, for example apa.")
			.addText(text => text.setValue(draft.bibliographyStyle).onChange(value => { draft.bibliographyStyle = value.trim(); }));
		new Setting(containerEl).setName("Citation format").setDesc("CAYW format; pandoc inserts [@citekey].")
			.addText(text => text.setValue(draft.caywFormat).onChange(value => { draft.caywFormat = value.trim(); }));

		new Setting(containerEl).setName("Connected vaults").setHeading();
		new Setting(containerEl).setName("Peer vaults").setDesc("Opt-in, read-only access to each vault's published note map. One line: Vault name | absolute folder path. Refresh the index in each vault after importing notes.")
			.addTextArea(text => text.setValue(draft.peerVaults.map(peer => `${peer.name} | ${peer.path}`).join("\n")).onChange(value => {
				draft.peerVaults = value.split("\n").filter(line => line.trim()).map(line => {
					const separator = line.indexOf("|");
					return { name: separator < 0 ? "" : line.slice(0, separator).trim(), path: separator < 0 ? line.trim() : line.slice(separator + 1).trim() };
				});
			}));
		containerEl.createEl("p", { text: "Hookmark-compatible links are Markdown links. This plugin does not change Hookmark settings, create bookmarks, or require Hookmark to be installed." });
		const status = containerEl.createDiv({ cls: "cmds-zotero-status", attr: { role: "status", "aria-live": "polite" } });
		new Setting(containerEl).addButton(button => button.setButtonText("Save configuration").setCta().onClick(async () => {
			button.setDisabled(true);
			try {
				if (draft.peerVaults.some(peer => !peer.name || !peer.path)) throw new Error("Each peer vault requires a name and absolute path separated by |.");
				if (!Number.isInteger(draft.requestTimeoutMs) || draft.requestTimeoutMs < 1000 || draft.requestTimeoutMs > 180000 || !Number.isInteger(draft.attachmentTimeoutMs) || draft.attachmentTimeoutMs < 1000 || draft.attachmentTimeoutMs > 180000) throw new Error("Timeouts must be between 1 and 180 seconds.");
				if (!Number.isInteger(draft.concurrency) || draft.concurrency < 1 || draft.concurrency > 8 || !Number.isInteger(draft.indexMaxAgeMinutes) || draft.indexMaxAgeMinutes < 1 || draft.indexMaxAgeMinutes > 10080) throw new Error("Check the concurrency and maximum-age ranges.");
				await this.plugin.saveSettings(draft); status.setText("Configuration saved.");
			} catch (error) { status.setText(error instanceof Error ? error.message : "Configuration could not be saved."); }
			finally { button.setDisabled(false); }
		}));
		containerEl.createEl("p", { text: `${this.plugin.manifest.name} ${this.plugin.manifest.version}`, cls: "setting-item-description" });
	}
}
