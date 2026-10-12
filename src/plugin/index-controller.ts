import { Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import { describeRefreshFailure, formatIndexAge, refreshRefusal } from "../index-service";
import type { IngestAPI } from "../ingest-api";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndex } from "../types";

/** After a failed background refresh, UI warm-ups return immediately for this long instead of re-hitting BBT. */
export const WARM_BACKOFF_MS = 60_000;

/**
 * Index warm-up, human reads of the snapshot, the explicit refresh and the debounced note-map publication. The published
 * snapshot itself (`plugin.lastIndex`, `plugin.publish`) stays on the plugin; this holds the warm-up and map-timer state.
 */
export class IndexController {
	private mapTimer: number | undefined;
	private warming: { promise: Promise<void>; force: boolean } | null = null;
	private warmFailedUntil = 0;
	/** Index generation (generatedAt, or "none") for which the offline Notice was already shown. */
	private noticedGeneration: string | null = null;

	constructor(private readonly plugin: CMDSZoteroPlugin) {}

	/** True while an explicit (forced) warm-up is in flight, so a refresh control can be disabled meanwhile. */
	forcedWarmActive(): boolean { return this.warming?.force === true; }

	/** True while background warm-ups are backing off after a failed refresh; UI callers may skip `warmIndex()` then. */
	warmBackoffActive(): boolean { return Date.now() < this.warmFailedUntil; }

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
		const current = this.warming;
		if (current && (current.force || !force)) return current.promise;
		if (!force && this.warmBackoffActive()) return Promise.resolve();
		const flight = { force, promise: Promise.resolve() };
		flight.promise = (current ? current.promise.catch(() => undefined) : Promise.resolve())
			.then(() => this.warm(force))
			.finally(() => { if (this.warming === flight) this.warming = null; });
		this.warming = flight;
		return flight.promise;
	}

	private async warm(force: boolean): Promise<void> {
		const service = this.plugin.service;
		try {
			const snapshot = force ? null : await this.peekPublished();
			if (snapshot && this.plugin.index.isStale(snapshot) === false) return;
			if (!force && this.warmBackoffActive()) return;
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
		this.warmFailedUntil = Date.now() + WARM_BACKOFF_MS;
		const generation = snapshot?.generatedAt ?? "none";
		if (!force && this.noticedGeneration === generation) return;
		this.noticedGeneration = generation;
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
			if (this.noticedGeneration !== snapshot.generatedAt) {
				this.noticedGeneration = snapshot.generatedAt;
				new Notice(`Using the saved index from ${formatIndexAge(this.plugin.index.ageMinutes(snapshot))} ago; Zotero was not contacted. Refresh the index to update it.`);
			}
			void this.warmIndex();
		}
		return snapshot;
	}

	scheduleMap(): void {
		if (this.mapTimer !== undefined) window.clearTimeout(this.mapTimer);
		this.mapTimer = window.setTimeout(() => {
			if (this.plugin.active && this.plugin.lastIndex) void this.plugin.links.publish(this.plugin.lastIndex).catch(() => { new Notice("Could not update cross-vault note map. Refresh the index to retry."); });
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

	/** saveSettings(): the new configuration starts without a warm-up backoff, a noticed generation or a joined flight. */
	reset(): void {
		this.warmFailedUntil = 0;
		this.noticedGeneration = null;
		this.warming = null;
	}

	/** onunload(): a pending note-map publication is dropped. */
	dispose(): void {
		if (this.mapTimer !== undefined) window.clearTimeout(this.mapTimer);
	}
}
