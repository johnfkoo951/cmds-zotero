import { Editor, Notice, TFile } from "obsidian";
import { EXPORT_TRANSLATORS, defaultSidecarPath, groupEntriesByLibrary, mergeExports, type StructuredExport } from "../agent/cites-core"; // 0.5 R10
import { describeBbtError, mapBounded } from "../api/transport";
import { BibliographyStore, type BibliographyDetail } from "../bibliography-store"; // 0.5 R12
import { resolveReferenceRows } from "../citations/reference-rows"; // 0.5 R10
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndexEntry } from "../types";
import { assertVaultBoundary, bibliographySidecarStorage, ensureCmdsIgnore, ensureDirectory } from "../vault-storage";

// 0.5 R12: a sidebar render probes `api.ready` once with this bound before any live bibliography call of that generation.
const BIBLIOGRAPHY_PROBE_MS = 2500;

/** Bibliography text (memory, sidecar, BBT) for the sidebars, the importer and agents, and the pandoc CSL-JSON exports. */
export class BibliographyController {
	// 0.5 R12: memory holds live and sidecar-served details (never a fallback); flights carry the render generation that started them.
	private bibliographyCache = new Map<string, BibliographyDetail>();
	private bibliographyFlights = new Map<string, { generation: number; promise: Promise<BibliographyDetail> }>();
	private bibliographyStore!: BibliographyStore;
	private bibliographyGeneration = 0;
	private bibliographyController: AbortController | null = null;

	constructor(private readonly plugin: CMDSZoteroPlugin) {}

	/** Called from the plugin's configure(): a new sidecar store whose writes stop once it is replaced or the plugin unloads. */
	configure(): void {
		const store: BibliographyStore = new BibliographyStore(bibliographySidecarStorage(this.plugin.app, () => this.plugin.active && this.bibliographyStore === store));
		this.bibliographyStore = store;
	}

	/** Drops the memory-cached renderings (a new index generation or configuration); sidecar records stay. */
	clearCache(): void { this.bibliographyCache.clear(); }

	/** String form for existing callers: live or sidecar text; a `fallback` answer rethrows the BBT fault so agents keep `bbtError`. */
	bibliographyForStyle(entry: ZoteroIndexEntry, style: string): Promise<string> {
		return this.bibliographyDetail(entry, style).then(detail => {
			if (detail.source === "fallback") throw detail.error instanceof Error ? detail.error : new Error("Bibliography unavailable.");
			return detail.text;
		});
	}

	// 0.5 R12 — offline bibliography: memory → sidecar → BBT, write-through sidecar, per-render abort, one probe per batch.

	/** Better BibTeX version the sidecar records are keyed against: the one the loaded index was collected with, else unknown. */
	private knownBbtVersion(): string { return this.plugin.lastIndex?.capabilities.betterbibtex ?? ""; }

	/**
	 * Bibliography text with its provenance. Memory first, then a sidecar record whose content hash (and BBT version, when
	 * known) matches, then one BBT call whose result is written through to the sidecar. A BBT fault never throws here: it
	 * returns the sidecar text of an older BBT version when one exists, else a `fallback` carrying the fault. `offline`
	 * skips the BBT call (the caller already probed). Concurrent requests for one item share a flight; a flight started by
	 * an earlier render generation is not joined because that generation may be aborted.
	 */
	bibliographyDetail(entry: ZoteroIndexEntry, style = this.plugin.settings.bibliographyStyle, options: { offline?: boolean; offlineError?: unknown; signal?: AbortSignal; generation?: number } = {}): Promise<BibliographyDetail> {
		const key = `${entry.id}|${style}`;
		const cached = this.bibliographyCache.get(key);
		if (cached) return Promise.resolve(cached);
		const generation = options.generation ?? 0;
		const flight = this.bibliographyFlights.get(key);
		if (flight && (flight.generation === 0 || flight.generation === generation)) return flight.promise;
		const store = this.bibliographyStore;
		const promise = this.renderBibliography(entry, style, options, store)
			.then(detail => { if (detail.source !== "fallback" && this.bibliographyStore === store) this.bibliographyCache.set(key, detail); return detail; })
			.finally(() => { if (this.bibliographyFlights.get(key)?.promise === promise) this.bibliographyFlights.delete(key); });
		this.bibliographyFlights.set(key, { generation, promise });
		return promise;
	}

	private async renderBibliography(entry: ZoteroIndexEntry, style: string, options: { offline?: boolean; offlineError?: unknown; signal?: AbortSignal }, store: BibliographyStore): Promise<BibliographyDetail> {
		await store.load();
		const version = this.knownBbtVersion();
		const hit = store.get(style, entry, version);
		if (hit) return { text: hit.text, source: "cached", renderedAt: hit.renderedAt };
		const stale = (error: unknown): BibliographyDetail => {
			const older = store.get(style, entry);
			return older ? { text: older.text, source: "cached", renderedAt: older.renderedAt, error } : { text: "", source: "fallback", error };
		};
		if (options.offline) return stale(options.offlineError ?? this.plugin.bbt.lastOutcome?.message ?? "Zotero offline");
		let text: string;
		try { text = (await this.plugin.bbt.bibliography(entry, style, options.signal)).trim(); }
		catch (error) { return stale(error); }
		if (text && this.bibliographyStore === store) store.set(style, entry, text, version);
		return { text, source: "live" };
	}

	/**
	 * One render generation for a list of entries: the previous generation's live flights are aborted, memory and sidecar
	 * hits are served without BBT, and when anything is left BBT is probed once (`api.ready`, 2.5 s) — a failed probe turns
	 * the whole generation offline instead of N parallel 20 s requests. Live calls run under `settings.concurrency`.
	 * `fresh: false` joins the current generation (a copy while a render is in flight must not abort it).
	 */
	async bibliographyBatch(entries: ZoteroIndexEntry[], style = this.plugin.settings.bibliographyStyle, options: { fresh?: boolean } = {}): Promise<BibliographyDetail[]> {
		if (options.fresh !== false || !this.bibliographyController) {
			this.bibliographyController?.abort();
			const generation = ++this.bibliographyGeneration;
			for (const [key, flight] of this.bibliographyFlights) if (flight.generation !== 0 && flight.generation !== generation) this.bibliographyFlights.delete(key);
			this.bibliographyController = new AbortController();
		}
		const generation = this.bibliographyGeneration;
		const controller = this.bibliographyController;
		const store = this.bibliographyStore;
		await store.load();
		const version = this.knownBbtVersion();
		const pending = entries.some(entry => !this.bibliographyCache.has(`${entry.id}|${style}`) && !store.get(style, entry, version));
		let offlineError: unknown = null;
		if (pending) {
			try { await this.plugin.bbt.capabilities({ timeoutMs: BIBLIOGRAPHY_PROBE_MS, signal: controller.signal }); }
			catch (error) { offlineError = error; }
		}
		return mapBounded(entries, this.plugin.settings.concurrency, entry => this.bibliographyDetail(entry, style, { generation, signal: controller.signal, ...(offlineError ? { offline: true, offlineError } : {}) })
			.catch((error: unknown): BibliographyDetail => ({ text: "", source: "fallback", error })));
	}

	/** "Insert bibliography": live or cached text goes into the editor; without any text the BBT fault is the message. */
	async insertBibliography(editor: Editor, entry: ZoteroIndexEntry): Promise<void> {
		const detail = await this.bibliographyDetail(entry);
		if (detail.source === "fallback") throw new Error(`${describeBbtError(detail.error)} No cached bibliography exists for this item.`);
		editor.replaceSelection(detail.text);
		if (detail.source === "cached") new Notice(`Inserted the bibliography cached on ${detail.renderedAt?.slice(0, 10) ?? "an earlier date"}; Zotero was not contacted.`);
	}

	/** Aborts the current render generation's flights and writes any pending sidecar records. */
	disposeBibliography(): Promise<void> {
		this.bibliographyController?.abort();
		this.bibliographyController = null;
		this.bibliographyFlights.clear();
		const store: BibliographyStore | undefined = this.bibliographyStore;
		return store ? store.flush() : Promise.resolve();
	}

	// 0.5 R10 — pandoc-ready bibliography from the References sidebar rows of the active note.

	/** Resolved entries the active note cites: the same index-local rows the References sidebar shows (no BBT call). */
	private async citedEntriesOfActiveNote(): Promise<{ file: TFile; entries: ZoteroIndexEntry[] }> {
		const view = this.plugin.lastMarkdownView();
		const file = view?.file ?? this.plugin.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== "md") throw new Error("Open a Markdown note first.");
		const text = view?.file === file ? view.editor.getValue() : await this.plugin.app.vault.cachedRead(file);
		await this.plugin.indexing.loadIndexForRead();
		const rows = resolveReferenceRows(text, this.plugin.cachedEntries(), this.plugin.indexLoaded());
		const entries: ZoteroIndexEntry[] = [];
		for (const row of rows) if (row.status === "resolved" && row.entry && !entries.some(entry => entry.id === row.entry?.id)) entries.push(row.entry);
		return { file, entries };
	}

	/** CSL-JSON for the entries: one BBT `item.export` per library, merged into one array with `abstract`/`note` removed. */
	async cslJsonFor(entries: readonly ZoteroIndexEntry[]): Promise<StructuredExport> {
		if (!entries.length) throw new Error("No resolved Zotero citations to export.");
		const outputs: string[] = [];
		try { for (const group of groupEntriesByLibrary(entries)) outputs.push(await this.plugin.bbt.export(group.citekeys, EXPORT_TRANSLATORS["csl-json"], group.libraryID)); }
		catch (error) { throw new Error(`${describeBbtError(error)} CSL-JSON export needs Better BibTeX.`); }
		return mergeExports("csl-json", outputs);
	}

	/** Copies merged CSL-JSON for `entries` (the References sidebar button passes its resolved rows). */
	async copyCslJson(entries: readonly ZoteroIndexEntry[]): Promise<void> {
		const result = await this.cslJsonFor(entries);
		await navigator.clipboard.writeText(result.content);
		const missing = entries.length - result.exported.length;
		new Notice(`Copied CSL-JSON for ${result.exported.length} source${result.exported.length === 1 ? "" : "s"}${missing > 0 ? ` (${missing} missing from the export)` : ""}.`);
	}

	async copyCslJsonForActiveNote(): Promise<void> {
		const { entries } = await this.citedEntriesOfActiveNote();
		await this.copyCslJson(entries);
	}

	/** Writes `.cmds-zotero/bibliography/<note>.json` (plugin-owned, gitignored) and shows the YAML line to add; the note itself is never edited. */
	async writeBibliographySidecar(): Promise<void> {
		const { file, entries } = await this.citedEntriesOfActiveNote();
		const result = await this.cslJsonFor(entries);
		const path = defaultSidecarPath(file.path, true, "csl-json");
		await assertVaultBoundary(this.plugin.app, path);
		await ensureCmdsIgnore(this.plugin.app);
		await ensureDirectory(this.plugin.app, path);
		await this.plugin.app.vault.adapter.write(path, result.content);
		new Notice(`Bibliography sidecar written: ${path} (${result.exported.length} source${result.exported.length === 1 ? "" : "s"}). Add to the note's frontmatter: bibliography: ${path}`, 15000);
	}
}
