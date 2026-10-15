import { Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import { describeRefreshFailure, formatIndexAge, refreshRefusal } from "../index-service";
import type { IngestAPI } from "../ingest-api";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndex } from "../types";
import { STARTUP_COLLECT_DELAY_MS, WarmState } from "./warm-state";

export { WARM_BACKOFF_MS } from "./warm-state";

/** How long the startup warm-up may wait for an idle moment once the layout is ready. */
const STARTUP_IDLE_TIMEOUT_MS = 2000;

/**
 * Index warm-up, human reads of the snapshot, the explicit refresh and the debounced note-map publication. The published
 * snapshot itself (`plugin.lastIndex`, `plugin.publish`) stays on the plugin; this holds the warm-up and map-timer state.
 */
export class IndexController {
	private mapTimer: number | undefined;
	/** 0.6.4: the snapshot whose map publication last failed; its Notice is shown once, later pauses retry silently. */
	private mapFailure: ZoteroIndex | null = null;
	private readonly state = new WarmState();
	/** 0.6 OPT-03: the startup warm-up's idle callback and the timer that ends the deferral of a stale collection. */
	private startupIdle: { idle: boolean; id: number } | null = null;
	private startupTimer: number | undefined;

	constructor(private readonly plugin: CMDSZoteroPlugin) {}

	/** True while an explicit (forced) warm-up is in flight, so a refresh control can be disabled meanwhile. */
	forcedWarmActive(): boolean { return this.state.forcedActive(); }

	/** True while background warm-ups are backing off after a failed refresh; UI callers may skip `warmIndex()` then. */
	warmBackoffActive(): boolean { return this.state.backoffActive(); }

	/**
	 * 0.6 OPT-03: onload does not touch the index. Once the workspace layout is ready the first warm-up waits for an idle
	 * moment; it publishes the saved snapshot (validated in chunks that yield) and, when that snapshot is stale, leaves the
	 * collection to a second warm-up `STARTUP_COLLECT_DELAY_MS` later. Anything that needs the index sooner still gets it: a
	 * missing snapshot is collected at once, and an explicit refresh is never deferred.
	 */
	startWarmUp(): void {
		this.plugin.app.workspace.onLayoutReady(() => {
			if (!this.plugin.active) return;
			this.state.deferCollection(STARTUP_COLLECT_DELAY_MS);
			const run = (): void => { this.startupIdle = null; if (this.plugin.active) void this.warmIndex(); };
			this.startupIdle = typeof window.requestIdleCallback === "function"
				? { idle: true, id: window.requestIdleCallback(run, { timeout: STARTUP_IDLE_TIMEOUT_MS }) }
				: { idle: false, id: window.setTimeout(run, 0) };
			this.startupTimer = window.setTimeout(() => {
				this.startupTimer = undefined;
				this.state.endDeferral();
				if (this.plugin.active) void this.warmIndex();
			}, STARTUP_COLLECT_DELAY_MS);
		});
	}

	private cancelStartup(): void {
		if (this.startupIdle) {
			if (this.startupIdle.idle) window.cancelIdleCallback(this.startupIdle.id);
			else window.clearTimeout(this.startupIdle.id);
			this.startupIdle = null;
		}
		if (this.startupTimer !== undefined) window.clearTimeout(this.startupTimer);
		this.startupTimer = undefined;
	}

	/** Publishes the newest validated snapshot from disk (fresh or stale) without contacting BBT; null when none exists. */
	async peekPublished(): Promise<ZoteroIndex | null> {
		const service = this.plugin.service;
		const snapshot = await service.peekIndex();
		if (snapshot && this.plugin.service === service) await this.plugin.publish(snapshot);
		return snapshot;
	}

	/**
	 * Background warm-up: peek first so `cachedEntries()` fills from disk, then refresh only a stale or missing snapshot.
	 * After a failure, non-forced warm-ups return immediately for `WARM_BACKOFF_MS`; the failure is announced once per
	 * index generation with a mapped message. A forced warm-up (explicit refresh button) never joins a non-forced flight.
	 */
	warmIndex(force = false): Promise<void> {
		return this.state.run(force, value => this.warm(value));
	}

	private async warm(force: boolean): Promise<void> {
		const service = this.plugin.service;
		try {
			const snapshot = force ? null : await this.peekPublished();
			if (snapshot && this.plugin.index.isStale(snapshot) === false) return;
			if (!force && this.state.backoffActive()) return;
			// 0.6 OPT-03: right after startup a stale snapshot keeps serving reads; the deferred warm-up collects it.
			if (!force && snapshot && this.state.collectionDeferred()) return;
			const outcome = await service.ensureIndex(force);
			// A warm-up aborted by saveSettings()/onunload() resolves as a cancelled stale-fallback; it must not report
			// against the new configuration or start its backoff.
			if (!this.plugin.active || this.plugin.service !== service) return;
			if (outcome.reason !== "stale-fallback") return;
			this.reportWarmFailure(refreshRefusal(outcome), outcome.index, force); // 0.5 R4: the Notice gets the observation wording
		} catch (error) {
			if (!this.plugin.active || this.plugin.service !== service) return;
			this.reportWarmFailure(error, this.plugin.lastIndex, force);
		}
	}

	/** Starts the retry backoff and shows the mapped failure once per index generation; a forced warm-up always reports. */
	private reportWarmFailure(error: unknown, snapshot: ZoteroIndex | null, force: boolean): void {
		this.state.failed();
		if (!this.state.announce(snapshot?.generatedAt ?? "none", force)) return;
		new Notice(describeRefreshFailure(error, this.plugin.settings.bbtEndpoint, this.plugin.index.ageMinutes(snapshot)));
	}

	/**
	 * The index for a human read: the newest validated snapshot regardless of age (BBT is not contacted; a stale snapshot
	 * is labelled once per generation and revalidated in the background), else a load that falls back on failure.
	 */
	async loadIndexForRead(): Promise<ZoteroIndex> {
		const snapshot = await this.peekPublished();
		if (!snapshot) {
			try { return (await this.plugin.service.ensureIndex()).index; }
			catch (error) { throw new Error(describeRefreshFailure(error, this.plugin.settings.bbtEndpoint, null)); }
		}
		if (this.plugin.index.isStale(snapshot) === true) {
			if (this.state.announce(snapshot.generatedAt)) new Notice(`Using the saved index from ${formatIndexAge(this.plugin.index.ageMinutes(snapshot))} ago; Zotero was not contacted. Refresh the index to update it.`);
			void this.warmIndex();
		}
		return snapshot;
	}

	/**
	 * 0.6 OPT-05: a Markdown note changed or was written by the plugin. After the 500 ms pause only that note is resolved
	 * again, and the note map is published only when a note's identity or path changed.
	 */
	noteChanged(path: string): void {
		this.plugin.links.noteChanged(path);
		this.publishMapSoon();
	}

	/** Vault rename or delete: a note is resolved again under its old and new path; a folder change resolves every note. */
	noteMoved(file: TAbstractFile, oldPath?: string): void {
		if (file instanceof TFolder) this.plugin.links.allNotesChanged();
		else {
			this.plugin.links.noteChanged(file.path);
			if (oldPath !== undefined) this.plugin.links.noteChanged(oldPath);
		}
		this.publishMapSoon();
	}

	/** For callers that do not know which notes changed: every note is resolved again after the pause (published only if changed). */
	scheduleMap(): void {
		this.plugin.links.allNotesChanged();
		this.publishMapSoon();
	}

	private publishMapSoon(): void {
		if (this.mapTimer !== undefined) window.clearTimeout(this.mapTimer);
		this.mapTimer = window.setTimeout(() => {
			const index = this.plugin.lastIndex;
			if (!this.plugin.active || !index) return;
			void this.plugin.links.publishIfChanged(index).catch(() => {
				if (this.mapFailure === index) return;
				this.mapFailure = index;
				new Notice("Could not update cross-vault note map. Refresh the index to retry.");
			});
		}, 500);
	}

	async refreshIndex(): Promise<void> {
		const notice = new Notice("Refreshing literature index…", 0);
		await this.plugin.run(async () => {
			let result: Awaited<ReturnType<IngestAPI["ensureIndex"]>>;
			try { result = await this.plugin.service.ensureIndex(true); }
			catch (error) { throw new Error(describeRefreshFailure(error, this.plugin.settings.bbtEndpoint, this.plugin.cachedIndexAgeMinutes())); }
			new Notice(`Index refreshed: ${result.index.count} entries. ${result.index.complete ? "Complete." : "Review diagnostics for unresolved records."}`);
		});
		notice.hide();
	}

	// 0.5 R13/F07: rename/delete of an attachment or image never changes which notes belong to which entry (a note renamed
	// away from `.md` is caught by the rename listener through its old path).
	affectsNoteMap(file: TAbstractFile): boolean {
		return file instanceof TFolder || (file instanceof TFile && file.extension === "md");
	}

	/** saveSettings(): the new configuration starts without a warm-up backoff, a noticed generation, a joined flight or a startup deferral. */
	reset(): void {
		this.state.reset();
		this.cancelStartup();
	}

	/** onunload(): a pending note-map publication and the startup warm-up are dropped. */
	dispose(): void {
		if (this.mapTimer !== undefined) window.clearTimeout(this.mapTimer);
		this.cancelStartup();
	}
}
