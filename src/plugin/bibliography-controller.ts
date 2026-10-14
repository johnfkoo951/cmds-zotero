import { Editor, Notice, TFile } from "obsidian";
import { EXPORT_TRANSLATORS, defaultSidecarPath, groupEntriesByLibrary, mergeExports, type StructuredExport } from "../agent/cites-core"; // 0.5 R10
import { describeBbtError, mapBounded } from "../api/transport";
import { BibliographyStore, type BibliographyDetail } from "../bibliography-store"; // 0.5 R12
import { resolveReferenceRows, resolvedEntries, countBibliographySources, fallbackCitation, type BibliographySourceCounts } from "../citations/reference-rows"; // 0.5 R10
import { listInstalledStyles, type InstalledStyle, type StyleListing } from "../bibliography/csl-styles"; // 0.6.2
import { entriesHtml, formatKey, noteFormat, orderEntries, probeProblem, splitTextBibliography, type BibliographyFormat, type BibliographyOrder, type NoteFormat } from "../bibliography/format"; // 0.6.2
import { markdownLink } from "../uris";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndexEntry } from "../types";
import { assertVaultBoundary, bibliographySidecarStorage, ensureCmdsIgnore, ensureDirectory } from "../vault-storage";
import { unreachableRecently } from "./warm-state";

// 0.5 R12: a sidebar render probes `api.ready` once with this bound before any live bibliography call of that generation.
const BIBLIOGRAPHY_PROBE_MS = 2500;

/** 0.6.2: the copy Notice: how many entries, in which order, and whether they came live, from cache or as fallbacks. */
export function copyListNotice(list: { text: string[]; order: BibliographyOrder; counts: BibliographySourceCounts; libraries: number; error?: unknown }, rich: boolean): string {
	const total = list.text.length;
	const parts = [`Copied ${total} entr${total === 1 ? "y" : "ies"}${rich ? " as formatted text" : " as plain text"}`];
	if (list.order === "style") parts.push(list.libraries > 1 ? `in style order, library by library (${list.libraries} libraries)` : "in style order");
	else parts.push(list.order === "alphabetical" ? "alphabetically" : "in citation order");
	const offline = [list.counts.cached ? `${list.counts.cached} from cache` : "", list.counts.fallback ? `${list.counts.fallback} fallback` : ""].filter(Boolean).join(", ");
	return `${parts.join(" ")}${offline ? ` (${offline}; Zotero offline)` : ""}${list.error !== undefined ? ". Better BibTeX could not render the list in style order" : ""}.`;
}

/** Bibliography text (memory, sidecar, BBT) for the sidebars, the importer and agents, and the pandoc CSL-JSON exports. */
export class BibliographyController {
	// 0.5 R12: memory holds live and sidecar-served details (never a fallback); flights carry the render generation that started them.
	private bibliographyCache = new Map<string, BibliographyDetail>();
	private bibliographyFlights = new Map<string, { generation: number; promise: Promise<BibliographyDetail> }>();
	private bibliographyStore!: BibliographyStore;
	private bibliographyGeneration = 0;
	private bibliographyController: AbortController | null = null;
	/**
	 * 0.6 OPT-13: within one render generation, the offline verdict (a failed probe, or a recent "Zotero is not answering"
	 * failure that stood in for it) and the fallback answers it produced, so a copy that joins the generation neither probes
	 * again nor recomputes them. Both are dropped when the next generation starts.
	 */
	private generationOffline: { generation: number; error: unknown } | null = null;
	private generationFallbacks = new Map<string, BibliographyDetail>();

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
	 * an earlier render generation is not joined because that generation may be aborted. A fallback answer is remembered
	 * for the rest of its render generation only (0.6 OPT-13).
	 */
	bibliographyDetail(entry: ZoteroIndexEntry, style = this.plugin.settings.bibliographyStyle, options: { offline?: boolean; offlineError?: unknown; signal?: AbortSignal; generation?: number; locale?: string } = {}): Promise<BibliographyDetail> {
		// 0.6.2 per-note-style-locale: the cache key carries style and locale (the style alone without a locale, as before).
		const locale = options.locale ?? this.defaultLocale();
		const key = `${entry.id}|${formatKey({ style, locale })}`;
		const cached = this.bibliographyCache.get(key);
		if (cached) return Promise.resolve(cached);
		const generation = options.generation ?? 0;
		const current = (): boolean => generation !== 0 && generation === this.bibliographyGeneration;
		const fallback = current() ? this.generationFallbacks.get(key) : undefined;
		if (fallback) return Promise.resolve(fallback);
		const flight = this.bibliographyFlights.get(key);
		if (flight && (flight.generation === 0 || flight.generation === generation)) return flight.promise;
		const store = this.bibliographyStore;
		const promise = this.renderBibliography(entry, { style, locale }, options, store)
			.then(detail => {
				if (detail.source !== "fallback") { if (this.bibliographyStore === store) this.bibliographyCache.set(key, detail); }
				else if (current()) this.generationFallbacks.set(key, detail);
				return detail;
			})
			.finally(() => { if (this.bibliographyFlights.get(key)?.promise === promise) this.bibliographyFlights.delete(key); });
		this.bibliographyFlights.set(key, { generation, promise });
		return promise;
	}

	private async renderBibliography(entry: ZoteroIndexEntry, format: BibliographyFormat, options: { offline?: boolean; offlineError?: unknown; signal?: AbortSignal }, store: BibliographyStore): Promise<BibliographyDetail> {
		await store.load();
		const version = this.knownBbtVersion();
		const stored = formatKey(format);
		const hit = store.get(stored, entry, version);
		if (hit) return { text: hit.text, source: "cached", renderedAt: hit.renderedAt };
		const stale = (error: unknown): BibliographyDetail => {
			const older = store.get(stored, entry);
			return older ? { text: older.text, source: "cached", renderedAt: older.renderedAt, error } : { text: "", source: "fallback", error };
		};
		if (options.offline) return stale(options.offlineError ?? this.plugin.bbt.lastOutcome?.message ?? "Zotero offline");
		let text: string;
		try { text = (await this.plugin.bbt.bibliography(entry, format.style, options.signal, format.locale ? { locale: format.locale } : undefined)).trim(); }
		catch (error) { return stale(error); }
		if (text && this.bibliographyStore === store) store.set(stored, entry, text, version);
		return { text, source: "live" };
	}

	/** The configured locale ("" when unset or when a partial host has no such setting). */
	private defaultLocale(): string { return this.plugin.settings.bibliographyLocale ?? ""; }

	/**
	 * One render generation for a list of entries: the previous generation's live flights are aborted, memory and sidecar
	 * hits are served without BBT, and when anything is left BBT is probed once (`api.ready`, 2.5 s) — a failed probe turns
	 * the whole generation offline instead of N parallel 20 s requests. Live calls run under `settings.concurrency`.
	 * `fresh: false` joins the current generation (a copy while a render is in flight must not abort it).
	 * 0.6 OPT-13: while Zotero was found not answering within the warm-up backoff window, the generation is offline without
	 * a probe, so a closed Zotero costs no connection attempt per edit; a generation decides offline once. `refresh` (the
	 * sidebar's Refresh button) starts a generation that always probes and forgets the remembered texts of these entries
	 * that did not come live from BBT, so they are read again from the sidecar or BBT.
	 */
	async bibliographyBatch(entries: ZoteroIndexEntry[], style = this.plugin.settings.bibliographyStyle, options: { fresh?: boolean; refresh?: boolean; locale?: string } = {}): Promise<BibliographyDetail[]> {
		const refresh = options.refresh === true;
		const locale = options.locale ?? this.defaultLocale();
		const stored = formatKey({ style, locale });
		if (refresh || options.fresh !== false || !this.bibliographyController) {
			this.bibliographyController?.abort();
			const generation = ++this.bibliographyGeneration;
			for (const [key, flight] of this.bibliographyFlights) if (flight.generation !== 0 && flight.generation !== generation) this.bibliographyFlights.delete(key);
			this.bibliographyController = new AbortController();
			this.generationOffline = null;
			this.generationFallbacks.clear();
		}
		const generation = this.bibliographyGeneration;
		const controller = this.bibliographyController;
		if (refresh) for (const entry of entries) {
			const key = `${entry.id}|${stored}`;
			if (this.bibliographyCache.get(key)?.source !== "live") this.bibliographyCache.delete(key);
		}
		const store = this.bibliographyStore;
		await store.load();
		const version = this.knownBbtVersion();
		const pending = entries.some(entry => !this.bibliographyCache.has(`${entry.id}|${stored}`) && !store.get(stored, entry, version));
		const offlineError = pending ? await this.offlineVerdict(generation, controller.signal, refresh) : null;
		return mapBounded(entries, this.plugin.settings.concurrency, entry => this.bibliographyDetail(entry, style, { generation, locale, signal: controller.signal, ...(offlineError ? { offline: true, offlineError } : {}) })
			.catch((error: unknown): BibliographyDetail => ({ text: "", source: "fallback", error })));
	}

	/**
	 * Why the render `generation` must stay offline, or null when BBT may be asked. Decided once per generation: a recent
	 * "Zotero is not answering" failure (`unreachableRecently`) stands in for the probe unless `probe` is set (Refresh);
	 * otherwise BBT is probed once with the short bound.
	 */
	private async offlineVerdict(generation: number, signal: AbortSignal, probe: boolean): Promise<unknown> {
		if (this.generationOffline?.generation === generation) return this.generationOffline.error;
		const last = this.plugin.bbt.lastOutcome;
		let error: unknown = null;
		if (!probe && last && unreachableRecently(last, Date.now())) error = new Error(last.message ?? "Zotero did not answer.");
		else {
			try { await this.plugin.bbt.capabilities({ timeoutMs: BIBLIOGRAPHY_PROBE_MS, signal }); }
			catch (caught) { error = caught; }
		}
		if (error && generation === this.bibliographyGeneration) this.generationOffline = { generation, error };
		return error;
	}

	/** "Insert bibliography": live or cached text goes into the editor; without any text the BBT fault is the message. */
	async insertBibliography(editor: Editor, entry: ZoteroIndexEntry, file?: TFile | null): Promise<void> {
		const format = await this.noteFormat(file ?? null); // 0.6.2: the note's csl/lang apply
		const detail = await this.bibliographyDetail(entry, format.style, { locale: format.locale });
		if (detail.source === "fallback") throw new Error(`${describeBbtError(detail.error)} No cached bibliography exists for this item.`);
		editor.replaceSelection(detail.text);
		if (detail.source === "cached") new Notice(`Inserted the bibliography cached on ${detail.renderedAt?.slice(0, 10) ?? "an earlier date"}; Zotero was not contacted.`);
	}

	// 0.6.2 WP6 — installed styles, per-note style and locale, the ordered rich-text bibliography and the style probe.

	private styleListing: { directory: string; promise: Promise<StyleListing> } | null = null;
	/** The last style and locale one probe rendered, so Save after the picker does not ask Better BibTeX twice. */
	private verified: string | null = null;

	/** The installed styles of the configured data directory, read once per directory setting (Refresh: `reload`). */
	installedStyles(reload = false): Promise<StyleListing> {
		const directory = this.plugin.settings.zoteroDataDirectory ?? "";
		if (reload || !this.styleListing || this.styleListing.directory !== directory) {
			const promise = listInstalledStyles(directory);
			promise.catch(() => { if (this.styleListing?.promise === promise) this.styleListing = null; });
			this.styleListing = { directory, promise };
		}
		return this.styleListing.promise;
	}

	/** Installed styles when the folder can be read, else none (the per-note lookup never fails because of it). */
	private async stylesOrNone(): Promise<InstalledStyle[]> {
		try { return (await this.installedStyles()).styles; } catch { return []; }
	}

	/**
	 * The style and locale for a note: its `csl`/`lang` frontmatter (pandoc's keys) over the settings. Reads Obsidian's
	 * metadata cache and, only when `csl` names a file, the installed styles; never Better BibTeX.
	 */
	async noteFormat(file: TFile | null): Promise<NoteFormat> {
		const frontmatter = file ? this.plugin.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		const csl: unknown = frontmatter?.csl;
		const styles = typeof csl === "string" && csl.trim() ? await this.stylesOrNone() : [];
		return noteFormat(frontmatter, this.plugin.settings, styles);
	}

	/**
	 * Bibliography entries for `entries` in `order`. Style order asks Better BibTeX for the whole list of each library once
	 * (text and HTML), so the style sorts; any failure, a recent "not answering" or another order uses the per-entry texts
	 * (memory → sidecar → BBT) in citation or alphabetical order. Fallback lines carry a Zotero link.
	 */
	async renderList(entries: readonly ZoteroIndexEntry[], format: BibliographyFormat, order: BibliographyOrder = this.plugin.settings.bibliographyOrder ?? "style"): Promise<{ text: string[]; html: string; order: BibliographyOrder; counts: BibliographySourceCounts; libraries: number; error?: unknown }> {
		const groups = groupEntriesByLibrary(entries);
		let error: unknown;
		if (order === "style" && entries.length) {
			const last = this.plugin.bbt.lastOutcome;
			if (!(last && unreachableRecently(last, Date.now()))) {
				try {
					const options = format.locale ? { locale: format.locale } : {};
					const parts = await Promise.all(groups.map(group => Promise.all([
						this.plugin.bbt.bibliographyList(group.citekeys, group.libraryID, format.style, options),
						this.plugin.bbt.bibliographyList(group.citekeys, group.libraryID, format.style, { ...options, contentType: "html" }),
					])));
					const text = parts.flatMap(([plain]) => splitTextBibliography(plain));
					if (text.length) return { text, html: parts.map(([, html]) => html.trim()).join("\n"), order, counts: { live: entries.length, cached: 0, fallback: 0 }, libraries: groups.length };
				} catch (caught) { error = caught; }
			}
		}
		const details = await this.bibliographyBatch([...entries], format.style, { fresh: false, locale: format.locale });
		const rows = entries.map((entry, index) => ({ entry, text: details[index].text || markdownLink(fallbackCitation(entry), entry.zoteroSelectURI) }));
		const effective: BibliographyOrder = order === "alphabetical" ? "alphabetical" : "citation";
		const text = orderEntries(rows, effective, row => row.text).map(row => row.text);
		return { text, html: entriesHtml(text), order: effective, counts: countBibliographySources(details), libraries: groups.length, ...(error !== undefined ? { error } : {}) };
	}

	/**
	 * 0.6.2 rich-text-bibliography-copy: the bibliography of `entries` as HTML and plain text on the clipboard, so it pastes
	 * formatted into Word or Google Docs and as text elsewhere. Falls back to plain text when rich copy is unavailable.
	 */
	async copyBibliography(entries: readonly ZoteroIndexEntry[], format: BibliographyFormat): Promise<void> {
		if (!entries.length) { new Notice("No resolved references to copy."); return; }
		const list = await this.renderList(entries, format);
		const plain = list.text.join("\n\n");
		let rich = true;
		try {
			await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([plain], { type: "text/plain" }), "text/html": new Blob([list.html], { type: "text/html" }) })]);
		} catch {
			rich = false;
			await navigator.clipboard.writeText(plain);
		}
		new Notice(copyListNotice(list, rich));
	}

	/**
	 * One probe rendering of `format` with an item of the saved index (no index read from Better BibTeX); the problem that
	 * refuses the style, or null. A format already verified in this session is not probed again.
	 */
	async probeFormat(format: BibliographyFormat): Promise<string | null> {
		const key = formatKey(format);
		if (this.verified === key) return null;
		const sample = this.plugin.cachedEntries()[0] ?? (await this.plugin.savedIndex())?.entries[0];
		if (!sample) return "The style can only be checked with an item from the saved index. Refresh the citekey index first; the style was not saved.";
		let problem: string | null;
		try { problem = probeProblem(format, { text: await this.plugin.bbt.bibliography(sample, format.style, undefined, format.locale ? { locale: format.locale } : undefined) }); }
		catch (error) { problem = probeProblem(format, { error }); }
		if (!problem) this.verified = key;
		return problem;
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
		return { file, entries: resolvedEntries(resolveReferenceRows(text, this.plugin.cachedEntries(), this.plugin.indexLoaded())) };
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
