/**
 * The index refresh (0.6 index-refresh-resilience, collection-membership-index, retraction-flags-from-zotero,
 * group-library-validation, OPT-07, OPT-10). One bad item never aborts a refresh: it is skipped with a typed diagnostic and
 * its previous entry is kept; only faults that end the conversation with Zotero (unreachable, timed out, HTTP errors, the
 * plugin's own abort) end the refresh, so the host falls back to the saved snapshot. Transport is injected; no `obsidian`
 * import.
 */
import type { Capabilities, Diagnostic, IndexCollection, IndexLibrary, ZoteroIndex, ZoteroIndexEntry } from "../types";
import { describeBbtError, isBbtTransportError, mapBounded, zoteroMajor, type RpcCall, type RpcSettled } from "../api/transport";
import { normalizeAttachments, normalizeEntryUnhashed, parseItemURI, primaryPdfPath, text } from "../api/normalize";
import { record, sealEntry, verifyIndex } from "../identity";
import { collectionsUnavailableDiagnostic, indexDiagnostics, libraryDiagnostics, retractedDiagnostics, retractionUnavailableDiagnostic, skippedItemDiagnostic, type LibraryReport } from "../diagnostics";
import { collectionTerms, groupRowsByLibraryName, legacyParentTerms, parentTerms, parseGroups, planLibraryRows, type LibraryInfo, type Scope, type SearchedItem, type SkippedItem } from "./collect-plan";
import { collectionId, collectionPaths, entryCollectionPaths, type CollectionNode } from "../library/collections";
import { retractedIdsFromRows, retractedTerms } from "../library/retraction";
import { positiveInteger } from "../uris";

/** Parent items per `item.export` call (unchanged since 0.3). */
export const EXPORT_BATCH = 50;

export interface CollectorTransport {
	call: (method: string, params: unknown[], timeoutMs?: number) => Promise<unknown>;
	batch: (calls: readonly RpcCall[], timeoutMs: number) => Promise<RpcSettled[]>;
	signal: AbortSignal;
}

export interface CollectorSettings { concurrency: number; collectConcurrency: number; attachmentTimeoutMs: number }

/**
 * A fault that ends the refresh: the plugin's own abort, or a transport fault that is not about one request (refused,
 * timed out, HTTP 404/other). A JSON-RPC error or an unusable answer concerns one request and is handled where it occurs.
 */
export function endsRefresh(error: unknown, signal: AbortSignal): boolean {
	if (signal.aborted) return true;
	return isBbtTransportError(error) && error.reason !== "rpc" && error.reason !== "invalid-response";
}

/**
 * A fault that ends the refresh even in its optional steps (collection membership, retraction flags): the plugin's own
 * abort, or Zotero no longer answering at all (refused connection, HTTP 404). A slow or failing optional search is reported
 * and the refresh goes on without that data.
 */
export function zoteroGone(error: unknown, signal: AbortSignal): boolean {
	if (signal.aborted) return true;
	return isBbtTransportError(error) && (error.reason === "connection-refused" || error.reason === "http-404" || error.reason === "aborted");
}

/** Short reason text for a diagnostic: BBT's own message for RPC faults, else the error message. */
function reasonText(error: unknown): string {
	if (isBbtTransportError(error) && error.reason === "rpc" && error.rpcMessage) return error.rpcMessage.replace(/\s+/g, " ").trim().slice(0, 200);
	return (error instanceof Error ? describeBbtError(error) : String(error)).replace(/\.$/, "").slice(0, 200);
}

class ExportMismatchError extends Error { readonly name = "ExportMismatchError"; }

interface LibraryPlan {
	name: string;
	/** Local library ID: known from `user.groups`, or learned from the first export in the 0.5 name-based fallback. */
	libraryID?: number;
	/** What `item.export` addresses the library by: its ID, or its name in the fallback. */
	handle: number | string;
	listed: boolean;
	collections: CollectionNode[] | null;
	rows: number;
	accepted: SearchedItem[];
	skipped: SkippedItem[];
	scope: Scope | null;
	kind: IndexLibrary["kind"];
	/** Why the library's search failed; its previous entries are kept. */
	unreadable?: string;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
	return result;
}

function scopeKey(scope: { libraryType: string; groupID?: number }, itemKey: string): string { return `${scope.libraryType}:${scope.groupID ?? 0}:${itemKey}`; }

/** Code-unit order (locale-independent), for deterministic stored bytes. */
function byCodeUnit(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

/**
 * Collects a new index. `previous` holds the validated entries of the last snapshot by id: skipped items and libraries
 * that could not be read keep them, attachments that could not be read keep theirs, and citekey history carries over.
 */
export async function collectIndex(transport: CollectorTransport, settings: CollectorSettings, capabilities: Capabilities, previous: ReadonlyMap<string, ZoteroIndexEntry>): Promise<ZoteroIndex> {
	const { call, batch, signal } = transport;
	const fatal = (error: unknown): boolean => endsRefresh(error, signal);
	const extra: Diagnostic[] = [];

	// 1. Libraries: user.groups lists every library (feeds included) with its collection tree. Without it (an old Better
	// BibTeX), the 0.5 search across libraries by name is used, with its ambiguities skipped instead of thrown.
	let listed: LibraryInfo[] | null = null;
	try {
		const libraries = parseGroups(await call("user.groups", [true]));
		// Zotero always has the user library; an empty list is not evidence that every library is gone.
		if (libraries.length) listed = libraries;
	} catch (error) { if (fatal(error)) throw error; }
	const plans = listed ? await planListed(listed) : await planByName();

	async function planListed(libraries: LibraryInfo[]): Promise<LibraryPlan[]> {
		return mapBounded(libraries, settings.collectConcurrency, async library => {
			const plan: LibraryPlan = { name: library.name, libraryID: library.libraryID, handle: library.libraryID, listed: true, collections: library.collections, rows: 0, accepted: [], skipped: [], scope: library.libraryID === 1 ? { libraryType: "user" } : null, kind: library.libraryID === 1 ? "user" : "unknown" };
			let rows: unknown;
			try {
				rows = await call("item.search", [parentTerms(library.libraryID)]);
				if (!Array.isArray(rows)) throw new Error("the search answer is not a list");
			} catch (error) {
				if (fatal(error)) throw error;
				plan.unreadable = reasonText(error);
				return plan;
			}
			const planned = planLibraryRows({ libraryID: library.libraryID, name: library.name }, rows);
			Object.assign(plan, { rows: planned.rows, accepted: planned.accepted, skipped: planned.skipped, scope: planned.scope ?? plan.scope });
			if (planned.scope?.libraryType === "group") plan.kind = "group";
			// A library without rows is a feed when its items appear once the feed filter is dropped; else empty.
			if (!rows.length && library.libraryID !== 1) {
				try {
					const probe = await call("item.search", [parentTerms(library.libraryID, { feeds: true })]);
					if (Array.isArray(probe) && probe.length) plan.kind = "feed";
				} catch (error) { if (fatal(error)) throw error; }
			}
			return plan;
		});
	}

	async function planByName(): Promise<LibraryPlan[]> {
		const rows = await call("item.search", [legacyParentTerms(), "*"]);
		if (!Array.isArray(rows)) throw new Error("Invalid BBT parent search response");
		const grouped = groupRowsByLibraryName(rows);
		const plans = [...grouped.libraries].map(([name, libraryRows]): LibraryPlan => {
			const planned = planLibraryRows({ name }, libraryRows);
			return { name, handle: name, listed: false, collections: null, rows: planned.rows, accepted: planned.accepted, skipped: planned.skipped, scope: planned.scope, kind: planned.scope?.libraryType ?? "unknown" };
		});
		if (grouped.skipped.length) plans.push({ name: "", handle: "", listed: false, collections: null, rows: 0, accepted: [], skipped: grouped.skipped, scope: null, kind: "unknown" });
		return plans;
	}

	// 2. Exports, batched per library; a batch that fails with an RPC error or answers with other identities is retried item
	// by item, and an item that still fails is skipped.
	const readExport = (plan: LibraryPlan, items: readonly SearchedItem[], serialized: unknown): ZoteroIndexEntry[] => {
		if (typeof serialized !== "string") throw new ExportMismatchError("BBT export must return a JSON string");
		const exported: unknown = JSON.parse(serialized);
		if (!record(exported) || !Array.isArray(exported.items)) throw new ExportMismatchError("Invalid BetterBibTeX JSON export envelope");
		const wanted = new Map(items.map(item => [item.citekey, item]));
		const entries = exported.items.map(item => {
			if (!record(item) || !positiveInteger(item.libraryID) || (plan.libraryID !== undefined && item.libraryID !== plan.libraryID)) throw new ExportMismatchError("Exported library identity mismatch");
			const entry = normalizeEntryUnhashed(item, previous.get(`${item.libraryID}:${text(item.itemKey)}`));
			const searched = wanted.get(entry.citekey);
			if (!searched || searched.itemKey !== entry.itemKey || searched.libraryType !== entry.libraryType || searched.groupID !== entry.groupID) throw new ExportMismatchError("Export differs from searched item identity");
			return entry;
		});
		if (entries.length !== items.length || new Set(entries.map(entry => entry.citekey)).size !== items.length) throw new ExportMismatchError("BBT export did not cover the requested parents");
		// The name-based fallback learns the library's local ID from its first export.
		if (plan.libraryID === undefined && entries.length) plan.libraryID = entries[0].libraryID;
		return entries;
	};
	const skipExport = (plan: LibraryPlan, item: SearchedItem, error: unknown): void => {
		const duplicate = isBbtTransportError(error) && error.reason === "rpc" && /duplicates found/i.test(error.rpcMessage ?? "");
		const reason: SkippedItem["reason"] = duplicate ? "duplicate-citekey" : error instanceof ExportMismatchError ? "export-mismatch" : isBbtTransportError(error) || error instanceof SyntaxError ? "export-failed" : "invalid-item";
		plan.skipped.push({ reason, library: plan.name, ...(plan.libraryID !== undefined ? { libraryID: plan.libraryID } : {}), itemKey: item.itemKey, citekey: item.citekey, detail: duplicate ? "more than one item" : reasonText(error) });
	};
	const exportItems = async (plan: LibraryPlan, items: readonly SearchedItem[]): Promise<ZoteroIndexEntry[]> => {
		try { return readExport(plan, items, await call("item.export", [items.map(item => item.citekey), "BetterBibTeX JSON", plan.handle])); }
		catch (error) {
			if (fatal(error)) throw error;
			if (items.length === 1) { skipExport(plan, items[0], error); return []; }
			const entries: ZoteroIndexEntry[] = [];
			for (const item of items) entries.push(...await exportItems(plan, [item]));
			return entries;
		}
	};
	const exportBatches = plans.flatMap(plan => chunks(plan.accepted, EXPORT_BATCH).map(items => ({ plan, items })));
	const exported = await mapBounded(exportBatches, settings.concurrency, ({ plan, items }) => exportItems(plan, items));
	const fresh = exported.flat();
	const freshIds = new Set(fresh.map(entry => entry.id));

	// 3. Previous entries kept for skipped items and for libraries that could not be read (sealed snapshots, not re-hashed).
	const previousByScope = new Map([...previous.values()].map(entry => [scopeKey(entry, entry.itemKey), entry]));
	const kept = new Map<string, ZoteroIndexEntry>();
	const keptBySkip = new Set<SkippedItem>();
	for (const plan of plans) {
		if (plan.unreadable !== undefined) {
			for (const entry of previous.values()) if (entry.libraryID === plan.libraryID && !freshIds.has(entry.id)) kept.set(entry.id, entry);
			continue;
		}
		for (const item of plan.skipped) {
			if (!item.itemKey) continue;
			const scope = plan.scope ?? item.scope ?? null;
			const candidate = plan.libraryID !== undefined ? previous.get(`${plan.libraryID}:${item.itemKey}`) : scope ? previousByScope.get(scopeKey(scope, item.itemKey)) : undefined;
			if (!candidate || freshIds.has(candidate.id) || (scope && scopeKey(candidate, candidate.itemKey) !== scopeKey(scope, item.itemKey))) continue;
			kept.set(candidate.id, candidate);
			keptBySkip.add(item);
		}
	}
	const finalIds = new Set([...freshIds, ...kept.keys()]);

	// 4. Collection membership: one search per collection of each listed library that has entries. A failure keeps the
	// previous collections of that library's entries and is reported; it never ends the refresh.
	const collections: IndexCollection[] = [];
	const freshByLibrary = new Map<number, ZoteroIndexEntry[]>();
	for (const entry of fresh) freshByLibrary.set(entry.libraryID, [...(freshByLibrary.get(entry.libraryID) ?? []), entry]);
	// Without membership searches an entry keeps what its own export says (collection keys, the 0.5 value), turned into
	// "Parent/Child" paths when the library's tree is known; a previous refresh's value is never carried forward, so keys
	// and paths are not mixed and new items are not emptied (0.6 review).
	const keepCollections = (entries: readonly ZoteroIndexEntry[], nodes: readonly CollectionNode[] | null = null, libraryID?: number): void => {
		const paths = nodes && libraryID !== undefined ? collectionPaths(nodes) : null;
		for (const entry of entries) {
			if (!paths || libraryID === undefined) continue;
			const resolved = entry.collections.flatMap(key => { const path = paths.get(collectionId(libraryID, key)); return path === undefined ? [] : [path]; });
			entry.collections = [...new Set(resolved)].sort(byCodeUnit);
		}
	};
	for (const plan of plans) {
		const libraryID = plan.libraryID;
		const libraryEntries = libraryID !== undefined ? freshByLibrary.get(libraryID) ?? [] : [];
		if (!plan.listed || libraryID === undefined || plan.collections === null) { keepCollections(libraryEntries); continue; }
		const nodes = plan.collections;
		// A library whose search failed: its tree is known, its membership is not (`items` stays absent).
		if (plan.unreadable !== undefined) { collections.push(...nodes.map(node => ({ libraryID, key: node.key, name: node.name, parentKey: node.parentKey }))); continue; }
		const hasEntries = [...finalIds].some(id => id.startsWith(`${libraryID}:`));
		if (!nodes.length || !hasEntries || plan.kind === "feed") {
			collections.push(...nodes.map(node => ({ libraryID, key: node.key, name: node.name, parentKey: node.parentKey, items: [] })));
			continue;
		}
		const members = new Map<string, string[]>();
		try {
			await mapBounded(nodes, settings.collectConcurrency, async node => {
				const rows = await call("item.search", [collectionTerms(libraryID, node.key)]);
				if (!Array.isArray(rows)) throw new Error("the collection search answer is not a list");
				const ids = new Set<string>();
				for (const row of rows) {
					if (!record(row)) continue;
					try {
						const scope = parseItemURI(text(row.id));
						if (plan.scope && scopeKey(scope, scope.itemKey) !== scopeKey(plan.scope, scope.itemKey)) continue;
						const id = `${libraryID}:${scope.itemKey}`;
						if (finalIds.has(id)) ids.add(id);
					} catch { /* rows without a verifiable item URI cannot be members of an indexed item */ }
				}
				members.set(collectionId(libraryID, node.key), [...ids].sort(byCodeUnit));
			});
		} catch (error) {
			if (zoteroGone(error, signal)) throw error;
			extra.push(collectionsUnavailableDiagnostic(plan.name, libraryID, reasonText(error)));
			keepCollections(libraryEntries, nodes, libraryID);
			collections.push(...nodes.map(node => ({ libraryID, key: node.key, name: node.name, parentKey: node.parentKey })));
			continue;
		}
		const paths = entryCollectionPaths(nodes, members);
		for (const entry of libraryEntries) entry.collections = paths.get(entry.id) ?? [];
		collections.push(...nodes.map(node => ({ libraryID, key: node.key, name: node.name, parentKey: node.parentKey, items: members.get(collectionId(libraryID, node.key)) ?? [] })));
	}

	// 5. Retraction flags (Zotero's own data); a failure is reported and leaves the flag out.
	let retracted: string[] | undefined;
	try {
		const rows = await call("item.search", [retractedTerms(zoteroMajor(capabilities.zotero))]);
		if (!Array.isArray(rows)) throw new Error("the search answer is not a list");
		retracted = retractedIdsFromRows(rows, [...fresh, ...kept.values()]);
	} catch (error) {
		if (zoteroGone(error, signal)) throw error;
		extra.push(retractionUnavailableDiagnostic(reasonText(error)));
	}

	// 6. Attachments in JSON-RPC batches; each entry is structure-checked and hashed once, after its last change (sealEntry):
	// with attachments, or with the previous attachments (or none) when its own request failed. A batch whose POST failed
	// is retried one request at a time, so one slow or broken item never costs the others their attachments.
	const apply = (entry: ZoteroIndexEntry, settled: { ok: true; result: unknown } | { ok: false; error: unknown }): void => {
		try {
			if (!settled.ok) throw settled.error;
			entry.attachments = normalizeAttachments(settled.result, entry);
			entry.attachmentPath = primaryPdfPath(entry.attachments);
			if (!sealEntry(entry)) throw new Error("Invalid enriched attachment data");
		} catch {
			const old = previous.get(entry.id);
			entry.attachments = old && old.libraryType === entry.libraryType && old.groupID === entry.groupID ? old.attachments : [];
			entry.attachmentPath = old && entry.attachments === old.attachments ? old.attachmentPath : "";
			entry.attachmentStatus = "unavailable";
			if (!sealEntry(entry)) throw new Error("Invalid normalized parent item");
		}
	};
	// Better BibTeX runs the requests of one batch POST at once, so a batch holds `collectConcurrency` requests and only one
	// batch is in flight: Zotero works on exactly as many attachment reads as the setting says (0.6 review of OPT-10).
	await mapBounded(chunks(fresh, settings.collectConcurrency), 1, async group => {
		let settled: RpcSettled[] | null = null;
		let timedOut: unknown = null;
		try { settled = await batch(group.map(entry => ({ method: "item.attachments", params: [entry.citekey, entry.libraryID] })), settings.attachmentTimeoutMs); }
		catch (error) {
			if (signal.aborted) throw error;
			// Zotero is still working on a batch that timed out: sending its requests again one by one would only add load.
			if (isBbtTransportError(error) && error.reason === "timeout") timedOut = error;
		}
		for (const [index, entry] of group.entries()) {
			if (settled) { apply(entry, settled[index]); continue; }
			if (timedOut) { apply(entry, { ok: false, error: timedOut }); continue; }
			try { apply(entry, { ok: true, result: await call("item.attachments", [entry.citekey, entry.libraryID], settings.attachmentTimeoutMs) }); }
			catch (error) {
				if (signal.aborted) throw error;
				apply(entry, { ok: false, error });
			}
		}
	});
	if (signal.aborted) throw new Error("BBT collection cancelled");

	const entries = [...fresh, ...kept.values()].sort((left, right) => left.id.localeCompare(right.id));
	const skipped = plans.flatMap(plan => plan.skipped).sort((left, right) => (left.libraryID ?? 0) - (right.libraryID ?? 0) || byCodeUnit(left.library, right.library) || byCodeUnit(left.itemKey ?? "", right.itemKey ?? "") || byCodeUnit(left.citekey ?? "", right.citekey ?? "") || byCodeUnit(left.reason, right.reason));
	const libraries: IndexLibrary[] | undefined = listed ? plans.map(plan => {
		const libraryID = plan.libraryID as number;
		const kind: IndexLibrary["kind"] = plan.kind;
		return { libraryID, name: plan.name, kind, ...(plan.scope?.libraryType === "group" && plan.scope.groupID !== undefined ? { groupID: plan.scope.groupID } : {}), items: plan.rows, indexed: entries.filter(entry => entry.libraryID === libraryID).length };
	}) : undefined;
	const reports: LibraryReport[] = libraries ? libraries.map((library, index) => ({ library, ...(plans[index].unreadable !== undefined ? { unreadable: plans[index].unreadable } : {}), keptEntries: [...kept.values()].filter(entry => entry.libraryID === library.libraryID).length })) : [];
	const diagnostics: Diagnostic[] = [
		...indexDiagnostics(entries),
		...skipped.map(item => skippedItemDiagnostic(item, keptBySkip.has(item))),
		...libraryDiagnostics(reports),
		...extra,
		...retractedDiagnostics(retracted ?? [], entries),
	];
	const complete = entries.every(entry => entry.attachmentStatus === "complete") && !skipped.length && !plans.some(plan => plan.unreadable !== undefined);
	const index: ZoteroIndex = {
		schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: entries.length, entries, capabilities, diagnostics, complete,
		...(libraries ? { libraries, collections } : {}),
		...(retracted ? { retracted } : {}),
	};
	if (!verifyIndex(index)) throw new Error("Invalid collected Zotero index");
	return index;
}
