import { Notice, TFile } from "obsidian";
import type { ImportRequest } from "../agent/actions";
import { bbtErrorPayload, describeBbtError, transportReasonOf } from "../api/transport";
import { batchProgressText, runBatch, type BatchRun } from "../batch/batch-run";
import type { IdentityMap } from "../batch/identity-map";
import { formatIndexAge, resolveInIndex } from "../index-service";
import type CMDSZoteroPlugin from "../main";
import { ImportPreviewModal } from "../modals/import-preview";
import { ReportModal } from "../modals/report";
import { ownershipSummary, partitionOwnedNotes } from "../note-ownership"; // 0.5 R14
import { freshTargetOf, freshTargetOfRead, indexEntryFor, literatureNoteStatus, readNoteTexts, sendOutcome, type ImportNoteResult, type RecentRead, type SendOutcome } from "../recent/recent-reads";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import { RecentReadsModal } from "../views/recent-reads-modal";
import { NoteBatch } from "./note-batch";
import { WARM_BACKOFF_MS } from "./warm-state";

/** The picker lists recently read papers first from the last Zotero answer; an older answer is refreshed in the background. */
const RECENT_CACHE_MS = 10 * 60_000;

/** Literature notes: import preview/apply (UI and agent), the batch update, and Zotero's reading history. */
export class LiteratureController {
	// Recently read (Zotero's reading history): the last answer, for ordering the picker without waiting on Zotero, and one shared flight.
	private recentCache: { at: number; reads: RecentRead[] } | null = null;
	private recentFlight: { days: number; promise: Promise<RecentRead[]> } | null = null;
	/** After a failed background refresh the picker does not ask Zotero again until this time (Zotero is likely closed). */
	private recentRetryAt = 0;
	/** True while "Update all owned literature notes" runs; a second run is refused. */
	private updateAllActive = false;

	constructor(private readonly plugin: CMDSZoteroPlugin) {}

	openRecentReads(): void { new RecentReadsModal(this.plugin.app, this.plugin).open(); }

	/**
	 * Papers whose PDF Zotero opened within `days` (its reading history), newest first. Concurrent callers for one window
	 * share a flight; the answer is remembered so the literature picker can list recent reads first without waiting.
	 */
	recentReads(days = this.plugin.settings.recentReadsDays): Promise<RecentRead[]> {
		if (this.recentFlight?.days === days) return this.recentFlight.promise;
		const bbt = this.plugin.bbt;
		const promise = bbt.recentlyRead(days).then(reads => {
			if (this.plugin.bbt === bbt) this.recentCache = { at: Date.now(), reads };
			return reads;
		}).finally(() => { if (this.recentFlight?.promise === promise) this.recentFlight = null; });
		this.recentFlight = { days, promise };
		return promise;
	}

	/** The last recent-reads answer; an answer older than RECENT_CACHE_MS (or none) is refreshed in the background. */
	recentForPicker(): RecentRead[] {
		const cache = this.recentCache;
		if ((!cache || Date.now() - cache.at > RECENT_CACHE_MS) && Date.now() >= this.recentRetryAt) void this.recentReads().catch(() => { this.recentRetryAt = Date.now() + WARM_BACKOFF_MS; });
		return cache?.reads ?? [];
	}

	/** True for faults that mean Zotero is not answering (so other BBT calls in this action should not wait on it). */
	private isOfflineError(error: unknown): boolean {
		const reason = transportReasonOf(error);
		return reason === "connection-refused" || reason === "timeout" || reason === "http-404";
	}

	/**
	 * The item as Zotero has it now (fresh export + attachments), so annotations made since the index was saved are
	 * included. Falls back to the saved entry when Zotero cannot answer; `error` says why.
	 */
	async freshEntry(entry: ZoteroIndexEntry): Promise<{ entry: ZoteroIndexEntry; fresh: boolean; error?: unknown }> {
		try { return { entry: await this.plugin.bbt.collectEntry(freshTargetOf(entry), entry), fresh: true }; }
		catch (error) { return { entry, fresh: false, error }; }
	}

	/** A recent read as an entry: fresh from Zotero when possible, else the saved one; a paper added since the last refresh is read from Zotero only. */
	async entryForRecent(read: RecentRead, index: ZoteroIndex | null): Promise<{ entry: ZoteroIndexEntry | null; fresh: boolean; error?: unknown }> {
		const known = index ? indexEntryFor(read, index.entries) : null;
		if (known) return this.freshEntry(known);
		try { return { entry: await this.plugin.bbt.collectEntry(freshTargetOfRead(read, index?.entries ?? [])), fresh: true }; }
		catch (error) { return { entry: null, fresh: false, error }; }
	}

	/** Literature notes in the output folder keyed by their frontmatter `zoteroID` (metadata cache; no file reads). */
	literatureNoteFiles(): Map<string, TFile[]> {
		const prefix = `${this.plugin.settings.outputFolder.replace(/\/+$/, "")}/`;
		const notes = new Map<string, TFile[]>();
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(prefix)) continue;
			const id: unknown = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.zoteroID;
			if (typeof id !== "string") continue;
			notes.set(id, [...(notes.get(id) ?? []), file]);
		}
		return notes;
	}

	/**
	 * 0.6 batch-performance-progress: a batch session — the output folder's identity map, read once and kept current by the
	 * batch's writes and by vault events, and the progress Notice with Cancel. The caller closes it.
	 */
	async openNoteBatch(message: string): Promise<NoteBatch> {
		return new NoteBatch(this.plugin.app, await this.plugin.importer.identityMap(), message);
	}

	/**
	 * Creates the literature note or refreshes its managed sections (new annotations included). Edited generated sections
	 * stay as they are (0.5 R5); hard conflicts (unowned note, damaged markers, several notes with one identity) refuse.
	 * `identities` is the batch's identity map (0.6 OPT-02); without it the preview reads the output folder itself.
	 */
	async sendToNote(entry: ZoteroIndexEntry, index: ZoteroIndex | null, options: { offline?: boolean; identities?: IdentityMap } = {}): Promise<SendOutcome> {
		const preview = await this.plugin.importer.preview(entry, index ?? undefined, { ...(options.offline ? { offline: true } : {}), ...(options.identities ? { identities: options.identities } : {}) });
		if (preview.conflicts.length) return sendOutcome(preview, { path: preview.path, conflicts: preview.conflicts, changed: false, preserved: [] });
		const outcome = sendOutcome(preview, await this.plugin.importer.apply(preview));
		if (outcome.status !== "refused") this.plugin.indexing.noteChanged(outcome.path);
		return outcome;
	}

	/** An item the saved index does not know yet, found in Zotero by its exact citekey and read fresh. */
	private async entryByCitekey(citekey: string, index: ZoteroIndex | null): Promise<{ entry: ZoteroIndexEntry | null; fresh: boolean; error?: unknown; ambiguous?: string[] }> {
		try {
			const rows = await this.plugin.bbt.findByCitekey(citekey);
			if (rows.length > 1) return { entry: null, fresh: false, ambiguous: rows.map(row => `${row.library}: ${row.itemKey}`) };
			if (!rows.length) return { entry: null, fresh: false, error: new Error(`Zotero has no item with citekey @${citekey}.`) };
			return { entry: await this.plugin.bbt.collectEntry(freshTargetOfRead({ ...rows[0], readOn: null }, index?.entries ?? [])), fresh: true };
		} catch (error) { return { entry: null, fresh: false, error }; }
	}

	/**
	 * Agent `import`: the same preview/apply path as the UI. Writes only with `apply`; without a fresh Zotero read the
	 * request is refused unless `allowStale` (then the saved index is used and the payload warns).
	 */
	async importForAgent(request: ImportRequest, index: ZoteroIndex | null): Promise<ImportNoteResult> {
		let entry: ZoteroIndexEntry | null = null;
		if (index) {
			const resolution = resolveInIndex(index, request.itemKey ?? request.citekey ?? "", request.itemKey ? { itemKey: request.itemKey, libraryID: request.libraryID } : undefined);
			if (resolution.status === "ambiguous") return { failure: { reason: "invalid-request", message: "More than one item matches; pass --item-key with --library.", candidates: resolution.candidates.map(candidate => ({ id: candidate.id, citekey: candidate.citekey, title: candidate.title, libraryID: candidate.libraryID })) } };
			if (resolution.status === "resolved") entry = resolution.entry;
		}
		let found: { entry: ZoteroIndexEntry | null; fresh: boolean; error?: unknown; ambiguous?: string[] };
		if (entry) found = await this.freshEntry(entry);
		else if (request.citekey) found = await this.entryByCitekey(request.citekey, index);
		else return { failure: { reason: "invalid-request", message: `Item ${request.itemKey ?? ""} in library ${request.libraryID ?? ""} is not in the saved index; run refresh, or import by citekey.` } };
		if (found.ambiguous) return { failure: { reason: "invalid-request", message: `Several Zotero libraries use @${request.citekey ?? ""} (${found.ambiguous.join("; ")}); refresh the index and pass --item-key with --library.` } };
		const bbtError = bbtErrorPayload(found.error);
		if (!found.entry) return { failure: { reason: bbtError ? "bbt-unreachable" : "invalid-request", message: `${describeBbtError(found.error)} The item is not in the saved index and could not be read from Zotero.`, ...(bbtError ? { bbtError } : {}) } };
		if (!found.fresh && request.allowStale !== true) return { failure: { reason: bbtError ? "bbt-unreachable" : "invalid-request", message: `${describeBbtError(found.error)} The item could not be read fresh from Zotero; pass --allow-stale to import from the saved index (annotations made since it was saved are missing).`, ...(bbtError ? { bbtError } : {}) } };
		const target = found.entry;
		// 0.6 OPT-02: one identity map serves the note state before the import and the preview, so both see the same notes.
		const identities = await this.plugin.importer.identityMap();
		const before = literatureNoteStatus(target, await readNoteTexts((await identities.pathsFor(target.id)).map(path => ({ path })), note => this.readNote(note.path)));
		const preview = await this.plugin.importer.preview(target, index ?? undefined, { identities, ...(found.fresh || !this.isOfflineError(found.error) ? {} : { offline: true }) });
		const existing = this.plugin.app.vault.getAbstractFileByPath(preview.path);
		const original = existing instanceof TFile ? await this.plugin.app.vault.read(existing) : null;
		const report = { path: preview.path, exists: preview.exists, conflicts: [...preview.conflicts], softConflicts: [...preview.softConflicts], sections: preview.sections.map(section => ({ id: section.id, state: section.state })), changes: original !== preview.content };
		const item = { id: target.id, citekey: target.citekey, title: target.title, year: target.year, libraryID: target.libraryID, itemKey: target.itemKey };
		const warnings = found.fresh ? [] : [`${describeBbtError(found.error)} Imported from the saved index (${formatIndexAge(this.plugin.index.ageMinutes(index))} old); annotations made since then are missing.`];
		if (request.apply !== true || preview.conflicts.length) return { item, fresh: found.fresh, before, preview: report, outcome: null, warnings };
		const result = await this.plugin.importer.apply(preview);
		const outcome = sendOutcome(preview, result);
		if (outcome.status !== "refused") this.plugin.indexing.noteChanged(outcome.path);
		const written = this.plugin.app.vault.getAbstractFileByPath(result.path);
		const after = outcome.status !== "refused" && written instanceof TFile ? literatureNoteStatus(target, await readNoteTexts([written], file => this.plugin.app.vault.read(file))) : undefined;
		return { item, fresh: found.fresh, before, preview: report, outcome, ...(after ? { after } : {}), warnings };
	}

	/** The text of the note at `path`; "" when no note is there any more. */
	private async readNote(path: string): Promise<string> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? this.plugin.app.vault.read(file) : "";
	}

	async previewImport(entry: ZoteroIndexEntry): Promise<void> {
		await this.plugin.run(async () => {
			// Related items come from the saved snapshot (no full refresh); the item itself is read fresh from Zotero so
			// annotations made since the index was saved are included.
			const index = await this.plugin.indexing.loadIndexForRead();
			const current = await this.freshEntry(entry);
			if (!current.fresh) new Notice(`${describeBbtError(current.error)} Previewing from the saved index (${formatIndexAge(this.plugin.index.ageMinutes(index))} old); annotations made since then are not included.`);
			const preview = await this.plugin.importer.preview(current.entry, index, current.fresh || !this.isOfflineError(current.error) ? {} : { offline: true });
			new ImportPreviewModal(this.plugin.app, preview, async choices => {
				// 0.5 R5: detach/reset choices travel with the apply; edited sections no longer block the note.
				const result = await this.plugin.importer.apply(preview, choices);
				if (result.conflicts.length) throw new Error(result.conflicts.join("; "));
				await this.plugin.app.workspace.openLinkText(result.path, "", true);
				this.plugin.indexing.noteChanged(result.path);
				new Notice(result.preserved.length ? `Literature note imported. Edited sections kept: ${result.preserved.join(", ")}.` : "Literature note imported. User-written sections were preserved.");
			}).open();
		});
	}

	/**
	 * Re-renders managed sections of every note this plugin owns; conflicts are reported and skipped, never forced.
	 * 0.5 R14: owned = resolves to an entry, lies in the output folder and carries the owner marker; other linked notes are
	 * counted once and never reach the BBT-backed preview.
	 * 0.6 batch-performance-progress: the output folder is read once for the whole batch (identity map); the fresh Zotero
	 * reads (and bibliography renderings) of the next notes run `settings.concurrency` ahead while the writes stay one at a
	 * time; a progress Notice counts the results and offers Cancel, which stops before the next note and reports the rest
	 * as not run.
	 */
	async updateAllLiteratureNotes(): Promise<void> {
		await this.plugin.run(async () => {
			if (this.updateAllActive) throw new Error("Literature notes are already being updated.");
			this.updateAllActive = true;
			try { await this.updateAll(); }
			finally { this.updateAllActive = false; }
		});
	}

	private async updateAll(): Promise<void> {
		const index = await this.plugin.indexing.loadIndexForRead();
		const partition = await partitionOwnedNotes(index, this.plugin.app.vault.getMarkdownFiles().map(file => ({ path: file.path, basename: file.basename, frontmatter: this.plugin.app.metadataCache.getFileCache(file)?.frontmatter })), this.plugin.settings.outputFolder, path => {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			return file instanceof TFile ? this.plugin.app.vault.cachedRead(file) : Promise.resolve("");
		});
		const owned = partition.owned;
		if (!owned.length && !partition.linkedNotOwned.length) throw new Error("No owned literature notes were found. Import a note first.");
		// 0.5 R4: probe BBT once before the loop. 0.5 R12: when it fails, owned notes are still updated from the index and the
		// sidecar — a note whose bibliography is not cached keeps its `citation` section byte-identical, and no note waits on BBT.
		const offline = await this.plugin.bbt.capabilities().then(() => null, (error: unknown) => error);
		const updated: string[] = [];
		const partial: string[] = [];
		const unchanged: string[] = [];
		const skipped: string[] = [];
		const label = "Updating literature notes";
		const progress = (done: number): string => batchProgressText(label, done, owned.length, [["updated", updated.length], ["partial", partial.length], ["unchanged", unchanged.length], ["skipped", skipped.length]]);
		const batch = await this.openNoteBatch(progress(0));
		let run: BatchRun<ZoteroIndexEntry, void>;
		try {
			run = await runBatch(owned, {
				concurrency: this.plugin.settings.concurrency,
				// Online, each note is rendered from the item as Zotero has it now (new annotations included); its bibliography is
				// rendered here too, so the preview below finds it in memory instead of waiting on BBT one note at a time.
				prepare: async entry => {
					if (offline) return entry;
					const current = (await this.freshEntry(entry)).entry;
					await this.plugin.bibliography.bibliographyDetail(current).catch(() => undefined);
					return current;
				},
				cancelled: () => batch.cancelled,
				onItem: (entry, position) => { batch.update(progress(position), `@${entry.citekey}`); },
				apply: async (entry, prepared) => {
					try {
						const current = prepared.ok ? prepared.value : entry;
						const preview = await this.plugin.importer.preview(current, index, { identities: batch.identities, ...(offline ? { offline: true } : {}) }); // 0.5 R12
						if (preview.conflicts.length) { skipped.push(`@${entry.citekey}: ${preview.conflicts.join("; ")}`); return; }
						if (!preview.exists) { skipped.push(`@${entry.citekey}: note was not created by this plugin; use Import literature note`); return; }
						const result = await this.plugin.importer.apply(preview);
						if (!result.conflicts.length) this.plugin.indexing.noteChanged(result.path);
						// 0.5 R5: edited sections are preserved while the rest of the note is refreshed (partial), never skipped.
						if (result.conflicts.length) skipped.push(`@${entry.citekey}: ${result.conflicts.join("; ")}`);
						else if (result.preserved.length) partial.push(`${result.path}: preserved ${result.preserved.join(", ")}${result.changed ? "" : " (no other changes)"}`);
						else (result.changed ? updated : unchanged).push(result.path);
					} catch (error) { skipped.push(`@${entry.citekey}: ${error instanceof Error ? error.message : "failed"}`); }
				},
			});
		} finally { batch.close(); }
		const notRun = run.notRun.map(entry => `@${entry.citekey}`);
		new ReportModal(this.plugin.app, "Literature note batch update", [
			...(run.cancelled ? [`Cancelled after ${owned.length - notRun.length} of ${owned.length} notes; the rest were not run.`] : []),
			`Updated: ${updated.length}`, `Partial (edited sections preserved): ${partial.length}`, `Unchanged: ${unchanged.length}`, `Skipped: ${skipped.length}`,
			...(notRun.length ? [`Not run: ${notRun.length}`] : []),
			ownershipSummary(partition),
			...(offline ? [`Zotero offline: ${describeBbtError(offline)} Citation sections were kept as they are unless a cached rendering existed.`] : []),
			"", ...updated.map(path => `updated  ${path}`), ...partial.map(line => `partial  ${line}`), ...skipped.map(line => `skipped  ${line}`), ...notRun.map(key => `not run  ${key}`),
		].join("\n")).open(); // 0.5 R5 + R12
	}
}
