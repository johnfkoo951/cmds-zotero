import { Menu, Notice } from "obsidian";
import { formatStatus, type StatusView } from "../agent/connection";
import { describeBbtError } from "../api/transport";
import type CMDSZoteroPlugin from "../main";
import { ReportModal } from "../modals/report";
import { statusJson, statusMenuItems, statusTooltip, type StatusMenuAction } from "./status-menu-model";
import { AnnotationsView, VIEW_TYPE_ANNOTATIONS } from "../views/annotations-view";
import { ReferencesView, VIEW_TYPE_REFERENCES } from "../views/references-view";

/** 0.5 R4: the shared status line (status bar, sidebar headers, diagnostics), the connection test and the settings guard text. */
export class StatusController {
	// 0.5 R4: shared status line (index age/staleness, legacy plugin, last BBT observation). onload creates the item.
	statusBar: HTMLElement | null = null;
	/** Last rendered status text/state; a re-render with the same key is skipped. */
	private renderedStatus: string | null = null;

	constructor(private readonly plugin: CMDSZoteroPlugin) {}

	// 0.5 R4: one status line for the status bar, both sidebar headers and the diagnostics report.
	statusLine(now = new Date(), compact = false): string {
		return formatStatus(this.statusView(now), now, compact);
	}

	/** The facts behind the status line, from state the plugin holds (no BBT call). */
	statusView(now = new Date()): StatusView {
		const outcome = this.plugin.bbt.lastOutcome;
		return {
			count: this.plugin.lastIndex?.count ?? null,
			ageMinutes: this.plugin.index.ageMinutes(this.plugin.lastIndex, now.getTime()),
			stale: this.plugin.index.isStale(this.plugin.lastIndex, now.getTime()),
			legacyPluginEnabled: this.plugin.legacyPluginEnabled(),
			bbt: outcome ? { state: outcome.ok ? "ok" : "failed", at: outcome.at.toISOString(), ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.status !== undefined ? { status: outcome.status } : {}) } : { state: "untested" },
		};
	}

	/**
	 * 0.6.1 index-status-menu: the status item's click menu. Building it reads only held state; each action runs only when
	 * picked (Test connection is the only one that asks Better BibTeX directly; Refresh runs the usual refresh).
	 */
	openMenu(event: MouseEvent): void {
		const menu = new Menu();
		for (const item of statusMenuItems({ collecting: this.plugin.index.collecting, legacyPluginEnabled: this.plugin.legacyPluginEnabled() })) {
			if (item.separator) menu.addSeparator();
			menu.addItem(row => row.setTitle(item.title).setIcon(item.icon).setDisabled(item.disabled).onClick(() => { void this.runMenuAction(item.action); }));
		}
		menu.showAtMouseEvent(event);
	}

	private async runMenuAction(action: StatusMenuAction): Promise<void> {
		switch (action) {
			case "test-connection": return this.testConnection();
			case "refresh-index": return this.plugin.indexing.refreshIndex();
			case "diagnose-links": return this.showDiagnostics();
			case "open-references": return this.plugin.activateView(VIEW_TYPE_REFERENCES);
			case "open-annotations": return this.plugin.activateView(VIEW_TYPE_ANNOTATIONS);
			case "open-settings": this.openSettings(); return;
			case "copy-status": return this.copyStatusJson();
		}
	}

	/** Opens this plugin's settings tab (the app's setting modal is not in the public typings). */
	private openSettings(): void {
		const setting = (this.plugin.app as unknown as { setting?: { open(): void; openTabById(id: string): unknown } }).setting;
		if (!setting) { new Notice("Open settings from the app menu: the settings window is unavailable here."); return; }
		setting.open();
		setting.openTabById(this.plugin.manifest.id);
	}

	private async copyStatusJson(): Promise<void> {
		const now = new Date();
		const index = this.plugin.lastIndex;
		const text = statusJson({ view: this.statusView(now), pluginVersion: this.plugin.manifest.version, indexPath: this.plugin.settings.zoteroIndexPath, generatedAt: index?.generatedAt ?? null, complete: index?.complete ?? null, maxAgeMinutes: this.plugin.settings.indexMaxAgeMinutes, collecting: this.plugin.index.collecting, now });
		try { await navigator.clipboard.writeText(text); new Notice("Status JSON copied."); }
		catch { new ReportModal(this.plugin.app, "Status JSON", text).open(); }
	}

	/**
	 * Re-renders the status line everywhere it is shown; clock-only, never contacts BBT. Coalesced: a burst of BBT
	 * outcomes during a collection (one per attachment call) re-renders only when the rendered text or state changed.
	 */
	renderStatus(): void {
		if (!this.plugin.active) return;
		const now = new Date();
		const view = this.statusView(now);
		const line = formatStatus(view, now);
		const stale = this.plugin.cachedIndexStale();
		const failed = this.plugin.bbt.lastOutcome?.ok === false;
		const key = `${line}|${stale}|${failed}`;
		if (key === this.renderedStatus) return;
		this.renderedStatus = key;
		if (this.statusBar) {
			this.statusBar.setText(formatStatus(view, now, true));
			this.statusBar.setAttr("title", statusTooltip(view, this.plugin.settings.indexMaxAgeMinutes, now));
			this.statusBar.setAttr("aria-label", `${line}. Click for index and connection actions.`);
			this.statusBar.toggleClass("is-stale", stale);
			this.statusBar.toggleClass("is-failed", failed);
		}
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_REFERENCES)) if (leaf.view instanceof ReferencesView) leaf.view.renderStatus(line);
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATIONS)) if (leaf.view instanceof AnnotationsView) leaf.view.renderStatus(line);
	}

	/** One capabilities probe (the settings "Test connection" logic) with a mapped Notice; never a refresh. */
	async testConnection(): Promise<void> {
		try {
			const capabilities = await this.plugin.bbt.capabilities();
			new Notice(`Connected: Zotero ${capabilities.zotero}; Better BibTeX ${capabilities.betterbibtex}.`);
		} catch (error) { new Notice(describeBbtError(error)); }
	}

	async showDiagnostics(): Promise<void> {
		await this.plugin.run(async () => {
			const result = await this.plugin.service.diagnose();
			new ReportModal(this.plugin.app, "Index and link diagnostics", `${this.statusLine()}\nGenerated: ${result.generatedAt}\nEntries: ${result.count}\nComplete: ${result.complete}\n\n` + (result.diagnostics.map(d => `[${d.severity}] ${d.code}: ${d.message}`).join("\n") || "No issues reported.")).open();
		});
	}

	// 0.5 R13/F18: the settings guard names what is holding the write gate so a user is not told to wait for nothing.
	busyMessage(): string {
		const pending = this.plugin.service.pendingWrites();
		if (!pending.length) return "Wait for index refresh to finish before changing configuration.";
		return `Wait for the running agent request${pending.length === 1 ? "" : "s"} to finish before changing configuration: ${pending.map(job => `${job.action} (${job.id})`).join(", ")}. Each request times out on its own.`;
	}

	/** saveSettings(): the next render writes the status line even when its text is unchanged. */
	reset(): void { this.renderedStatus = null; }
}
