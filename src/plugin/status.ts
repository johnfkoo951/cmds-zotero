import { Notice } from "obsidian";
import { formatStatus } from "../agent/connection";
import { describeBbtError } from "../api/transport";
import type CMDSZoteroPlugin from "../main";
import { ReportModal } from "../modals";
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
		const outcome = this.plugin.bbt.lastOutcome;
		return formatStatus({
			count: this.plugin.lastIndex?.count ?? null,
			ageMinutes: this.plugin.index.ageMinutes(this.plugin.lastIndex, now.getTime()),
			stale: this.plugin.index.isStale(this.plugin.lastIndex, now.getTime()),
			legacyPluginEnabled: this.plugin.legacyPluginEnabled(),
			bbt: outcome ? { state: outcome.ok ? "ok" : "failed", at: outcome.at.toISOString(), ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.status !== undefined ? { status: outcome.status } : {}) } : { state: "untested" },
		}, now, compact);
	}

	/**
	 * Re-renders the status line everywhere it is shown; clock-only, never contacts BBT. Coalesced: a burst of BBT
	 * outcomes during a collection (one per attachment call) re-renders only when the rendered text or state changed.
	 */
	renderStatus(): void {
		if (!this.plugin.active) return;
		const now = new Date();
		const line = this.statusLine(now);
		const stale = this.plugin.cachedIndexStale();
		const failed = this.plugin.bbt.lastOutcome?.ok === false;
		const key = `${line}|${stale}|${failed}`;
		if (key === this.renderedStatus) return;
		this.renderedStatus = key;
		if (this.statusBar) {
			this.statusBar.setText(this.statusLine(now, true));
			this.statusBar.setAttr("title", line);
			this.statusBar.setAttr("aria-label", `${line}. Click to test the Better BibTeX connection.`);
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
