import type { Capabilities, CmdsZoteroSettings, ZoteroIndex, ZoteroIndexEntry } from "./types";
import { httpRequest, mapBounded, rpc } from "./api/transport";
import { normalizeAttachments, normalizeEntry, parseItemURI, text } from "./api/normalize";
import { entryHash, record, validateEntry, validateIndex } from "./identity";
import { indexDiagnostics } from "./diagnostics";
import { positiveInteger } from "./uris";

export class BbtService {
	private controller = new AbortController();
	constructor(private settings: CmdsZoteroSettings) {}
	updateSettings(settings: CmdsZoteroSettings): void {
		this.controller.abort();
		this.controller = new AbortController();
		this.settings = settings;
	}
	dispose(): void { this.controller.abort(); }

	private call(method: string, params: unknown[] = [], timeout = this.settings.requestTimeoutMs): Promise<unknown> {
		return rpc(this.settings.bbtEndpoint, method, params, timeout, this.controller.signal);
	}

	async capabilities(): Promise<Capabilities> {
		return this.readCapabilities(this.settings);
	}

	private async readCapabilities(settings: CmdsZoteroSettings, signal = this.controller.signal): Promise<Capabilities> {
		const ready = await rpc(settings.bbtEndpoint, "api.ready", [], settings.requestTimeoutMs, signal);
		if (!record(ready) || !text(ready.zotero) || !text(ready.betterbibtex)) throw new Error("Invalid BBT readiness response");
		return { zotero: text(ready.zotero), betterbibtex: text(ready.betterbibtex), metadata: true, attachments: true, annotations: true, bibliography: true };
	}

	async isReachable(): Promise<boolean> {
		try { await this.capabilities(); return true; } catch { return false; }
	}

	async cayw(): Promise<string> {
		const params = new URLSearchParams({ format: this.settings.caywFormat, brackets: "true" });
		const response = await httpRequest(`${this.settings.bbtEndpoint.replace(/\/$/, "")}/cayw?${params.toString()}`, this.settings.requestTimeoutMs, undefined, this.controller.signal);
		if (response.status !== 200) throw new Error(`BBT picker HTTP ${response.status}`);
		return response.text.trim();
	}

	async collect(previous?: ZoteroIndex): Promise<ZoteroIndex> {
		const settings = { ...this.settings };
		const signal = this.controller.signal;
		const call = (method: string, params: unknown[], timeout = settings.requestTimeoutMs): Promise<unknown> => rpc(settings.bbtEndpoint, method, params, timeout, signal);
		const capabilities = await this.readCapabilities(settings, signal);
		const result = await call("item.search", [[["itemType", "isNot", "attachment"], ["itemType", "isNot", "annotation"], ["itemType", "isNot", "note"]], "*"]);
		if (!Array.isArray(result)) throw new Error("Invalid BBT parent search response");
		const libraries = new Map<string, Map<string, ReturnType<typeof parseItemURI>>>();
		for (const item of result) {
			if (!record(item)) throw new Error("Malformed BBT search item");
			const citekey = text(item.citekey) || text(item.citationKey) || text(item["citation-key"]);
			const library = text(item.library);
			if (!citekey || !library) throw new Error("Search item lacks named library citation identity");
			const scope = parseItemURI(text(item.id));
			const keys = libraries.get(library) ?? new Map<string, ReturnType<typeof parseItemURI>>();
			if (keys.has(citekey)) throw new Error("Duplicate citation key inside a named library cannot be exported unambiguously");
			for (const prior of keys.values()) if (prior.libraryType !== scope.libraryType || prior.groupID !== scope.groupID) throw new Error("Library name maps to multiple URI scopes");
			keys.set(citekey, scope);
			libraries.set(library, keys);
		}
		const batches: { library: string; keys: string[] }[] = [];
		for (const [library, scoped] of libraries) {
			const keys = [...scoped.keys()];
			for (let offset = 0; offset < keys.length; offset += 50) batches.push({ library, keys: keys.slice(offset, offset + 50) });
		}
		const libraryIDs = new Map<string, number>();
		const validPrevious = previous && validateIndex(previous) ? new Map(previous.entries.map(entry => [entry.id, entry])) : new Map<string, ZoteroIndexEntry>();
		const exports = await mapBounded(batches, settings.concurrency, async ({ library, keys }) => {
			const serialized = await call("item.export", [keys, "BetterBibTeX JSON", library]);
			if (typeof serialized !== "string") throw new Error("BBT export must return a JSON string");
			const exported: unknown = JSON.parse(serialized);
			if (!record(exported) || !Array.isArray(exported.items)) throw new Error("Invalid BetterBibTeX JSON export envelope");
			const entries = exported.items.map(item => {
				if (!record(item) || !positiveInteger(item.libraryID)) throw new Error("Exported library identity mismatch");
				const priorID = libraryIDs.get(library);
				if (priorID !== undefined && priorID !== item.libraryID) throw new Error("Named library has inconsistent local IDs");
				libraryIDs.set(library, item.libraryID);
				const id = `${item.libraryID}:${text(item.itemKey)}`;
				const entry = normalizeEntry(item, validPrevious.get(id));
				const searched = libraries.get(library)?.get(entry.citekey);
				if (!keys.includes(entry.citekey) || !searched || searched.itemKey !== entry.itemKey || searched.libraryType !== entry.libraryType || searched.groupID !== entry.groupID) throw new Error("Export differs from searched item identity");
				return entry;
			});
			if (entries.length !== keys.length || new Set(entries.map(entry => entry.citekey)).size !== keys.length) throw new Error("BBT export did not cover the requested parents");
			return entries;
		});
		const entries = await mapBounded(exports.flat(), settings.concurrency, async entry => {
			try {
				const attachments = await call("item.attachments", [entry.citekey, entry.libraryID], settings.attachmentTimeoutMs);
				entry.attachments = normalizeAttachments(attachments, entry);
				entry.attachmentPath = entry.attachments.find(attachment => attachment.path?.toLowerCase().endsWith(".pdf"))?.path ?? "";
				entry.contentHash = entryHash(entry);
				if (!validateEntry(entry)) throw new Error("Invalid enriched attachment data");
			} catch (error) {
				if (signal.aborted) throw error;
				const old = validPrevious.get(entry.id);
				entry.attachments = old && old.libraryType === entry.libraryType && old.groupID === entry.groupID ? old.attachments : [];
				entry.attachmentPath = old && entry.attachments === old.attachments ? old.attachmentPath : "";
				entry.attachmentStatus = "unavailable";
			}
			entry.contentHash = entryHash(entry);
			if (!validateEntry(entry)) throw new Error("Invalid normalized parent item");
			return entry;
		});
		if (signal.aborted) throw new Error("BBT collection cancelled");
		entries.sort((left, right) => left.id.localeCompare(right.id));
		const index: ZoteroIndex = { schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: entries.length, entries, capabilities, diagnostics: indexDiagnostics(entries), complete: entries.every(entry => entry.attachmentStatus === "complete") };
		if (!validateIndex(index)) throw new Error("Invalid collected Zotero index");
		return index;
	}

	async bibliography(entry: ZoteroIndexEntry): Promise<string> {
		if (!validateEntry(entry)) throw new Error("Bibliography requires a validated item");
		const output = await this.call("item.bibliography", [[entry.citekey], { id: this.settings.bibliographyStyle, contentType: "text" }, entry.libraryID]);
		if (typeof output !== "string") throw new Error("Invalid BBT bibliography response");
		return output;
	}
}
