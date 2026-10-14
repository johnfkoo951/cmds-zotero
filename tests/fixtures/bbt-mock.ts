// A synthetic Better BibTeX JSON-RPC server for collect-level tests (synthetic records only; no real library data).
// It follows the BBT 9.0.71 behaviour the refresh relies on (scratchpad bbt.json and BBT's json-rpc.ts): errors come back
// as HTTP 200 with id null, a batch array is answered in request order, item.search takes Zotero condition arrays (the
// subset the plugin sends), and item.export / item.attachments resolve citekeys inside one library.
import * as http from "node:http";

export interface MockAttachment { key: string; path: string | false; title?: string; mimeType?: string; annotations?: unknown[] }
export interface MockItem { itemKey: string; citekey: string; title?: string; itemType?: string; attachments?: MockAttachment[]; collections?: string[]; retracted?: boolean; lastRead?: string }
export interface MockCollection { key: string; name: string; parent?: string; deleted?: boolean }
export interface MockLibrary { id: number; name: string; groupID?: number; feed?: boolean; items: MockItem[]; collections?: MockCollection[] }
export interface MockCall { method: string; params: unknown[] }
export interface MockOptions {
	zotero?: string;
	/** Answer `method` with a JSON-RPC error (the thrown message) or a custom result; return undefined to fall through. */
	override?: (call: MockCall) => unknown;
	/** HTTP status for whole requests of a method (a batch fails when any of its requests matches). */
	httpStatus?: (call: MockCall) => number | undefined;
}

export class RpcFault extends Error { constructor(readonly code: number, message: string) { super(message); } }

export function itemURI(library: MockLibrary, itemKey: string): string {
	return library.groupID ? `http://zotero.org/groups/${library.groupID}/items/${itemKey}` : `http://zotero.org/users/local/Example/items/${itemKey}`;
}
function scope(library: MockLibrary): string { return library.groupID ? `groups/${library.groupID}` : "library"; }

function bbtJson(library: MockLibrary, item: MockItem): Record<string, unknown> {
	return {
		libraryID: library.id, itemKey: item.itemKey, uri: itemURI(library, item.itemKey), select: `zotero://select/${scope(library)}/items/${item.itemKey}`,
		citationKey: item.citekey, itemType: item.itemType ?? "journalArticle", title: item.title ?? `Synthetic ${item.itemKey}`, date: "2026-03-01",
		creators: [{ firstName: "Example", lastName: "Author" }], tags: [], notes: [],
		// BBT JSON lists the keys of the item's collections; membership searches turn them into paths.
		...(item.collections ? { collections: item.collections } : {}),
		attachments: (item.attachments ?? []).map(attachment => ({ select: `zotero://select/${scope(library)}/items/${attachment.key}`, title: attachment.title ?? "Synthetic attachment", ...(attachment.path ? { path: attachment.path } : {}), ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) })),
	};
}

function searchRow(library: MockLibrary, item: MockItem): Record<string, unknown> {
	return { id: itemURI(library, item.itemKey), type: "article-journal", title: item.title ?? `Synthetic ${item.itemKey}`, citekey: library.feed ? "" : item.citekey, library: library.name };
}

export async function startMockBbt(libraries: MockLibrary[], options: MockOptions = {}): Promise<{ endpoint: string; calls: MockCall[]; posts: number; close: () => Promise<void>; libraries: MockLibrary[] }> {
	const calls: MockCall[] = [];
	const state = { posts: 0 };
	const byId = (value: unknown): MockLibrary | undefined => libraries.find(library => library.id === value || (typeof value === "string" && library.name === value) || (typeof value === "number" && library.groupID === value && !libraries.some(other => other.id === value)));
	const resolveLibrary = (value: unknown): MockLibrary => {
		if (value === undefined) return libraries.find(library => library.id === 1) ?? libraries[0];
		const named = typeof value === "string" ? libraries.filter(library => library.name === value) : [];
		if (named.length > 1) throw new RpcFault(-32603, `library.get: ${JSON.stringify(value)} is not unique`);
		const library = byId(value);
		if (!library) throw new RpcFault(-32603, `could not find library ${String(value)}`);
		return library;
	};
	const search = (terms: unknown): unknown[] => {
		if (!Array.isArray(terms)) throw new RpcFault(-32602, "string search is not mocked");
		const conditions = terms as unknown[][];
		const has = (name: string) => conditions.filter(term => term[0] === name);
		for (const term of conditions) {
			if (!["libraryID", "itemType", "ignore_feeds", "collection", "retracted", "resultLevel", "lastRead", "key", "citationKey"].includes(String(term[0]))) throw new RpcFault(-32603, `Error: Invalid condition '${String(term[0])}' in hasOperator()`);
			if ((term[0] === "resultLevel" || term[0] === "lastRead") && Number((options.zotero ?? "10.0.6").split(".")[0]) < 10) throw new RpcFault(-32603, `Error: Invalid condition '${String(term[0])}' in hasOperator()`);
		}
		const libraryTerm = has("libraryID")[0];
		let scoped = libraries;
		if (libraryTerm) scoped = [resolveLibrary(libraryTerm[2])];
		if (has("ignore_feeds").length) scoped = scoped.filter(library => !library.feed);
		const collection = has("collection")[0]?.[2];
		const rows: unknown[] = [];
		for (const library of scoped) {
			for (const item of library.items) {
				if (collection !== undefined && !(item.collections ?? []).includes(String(collection))) continue;
				if (has("retracted").length && !item.retracted) continue;
				const key = has("key")[0]?.[2];
				if (key !== undefined && item.itemKey !== key) continue;
				const citekey = has("citationKey")[0]?.[2];
				if (citekey !== undefined && item.citekey !== citekey) continue;
				rows.push(searchRow(library, item));
			}
		}
		// Collection searches without a libraryID condition return nothing in Zotero (bbt.json, live).
		if (collection !== undefined && !libraryTerm) return [];
		return rows;
	};
	const handle = (call: MockCall): unknown => {
		const overridden = options.override?.(call);
		if (overridden !== undefined) return overridden;
		const params = call.params;
		switch (call.method) {
			case "api.ready": return { zotero: options.zotero ?? "10.0.6", betterbibtex: "9.0.71" };
			case "user.groups": return libraries.map(library => ({ id: library.id, name: library.name, collections: params[0] ? (library.collections ?? []).map(collection => ({ key: collection.key, name: collection.name, parentCollection: collection.parent ?? false, version: 1, relations: {}, ...(collection.deleted ? { deleted: true } : {}) })) : null }));
			case "item.search": return search(params[0]);
			case "item.export": {
				const library = resolveLibrary(params[2]);
				const keys = params[0] as string[];
				const missing = keys.filter(key => !library.items.some(item => item.citekey === key));
				const duplicates = keys.filter(key => library.items.filter(item => item.citekey === key).length > 1);
				if (missing.length || duplicates.length) throw new RpcFault(-32602, [missing.length ? `not found: ${missing.join(", ")}` : "", duplicates.length ? `duplicates found: ${duplicates.join(", ")}` : ""].filter(Boolean).join("\n"));
				return JSON.stringify({ items: keys.map(key => bbtJson(library, library.items.find(item => item.citekey === key)!)) });
			}
			case "item.attachments": {
				const library = resolveLibrary(params[1]);
				const citekey = String(params[0]).replace(/^@/, "");
				const item = library.items.find(candidate => candidate.citekey === citekey);
				if (!item) throw new RpcFault(-32602, `${citekey} not found`);
				return (item.attachments ?? []).map(attachment => ({ open: `zotero://open-pdf/${scope(library)}/items/${attachment.key}`, path: attachment.path, ...(attachment.annotations?.length ? { annotations: attachment.annotations } : {}) }));
			}
			default: throw new RpcFault(-32601, `Method not found: ${call.method}`);
		}
	};
	const reply = (request: { id?: unknown; method: string; params?: unknown[] }): unknown => {
		const call = { method: request.method, params: request.params ?? [] };
		calls.push(call);
		try { return { jsonrpc: "2.0", result: handle(call), id: request.id || null }; }
		catch (error) { return { jsonrpc: "2.0", error: { code: error instanceof RpcFault ? error.code : -32603, message: error instanceof Error ? error.message : String(error) }, id: null }; }
	};
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", chunk => { body += String(chunk); });
		request.on("end", () => {
			state.posts++;
			const parsed = JSON.parse(body) as unknown;
			const requests = (Array.isArray(parsed) ? parsed : [parsed]) as { id?: unknown; method: string; params?: unknown[] }[];
			const status = requests.map(item => options.httpStatus?.({ method: item.method, params: item.params ?? [] })).find(code => code !== undefined);
			if (status !== undefined) { response.statusCode = status; response.end("synthetic failure"); return; }
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(Array.isArray(parsed) ? requests.map(reply) : reply(requests[0])));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Mock did not expose a port");
	return {
		endpoint: `http://127.0.0.1:${address.port}/better-bibtex`, calls, libraries,
		get posts() { return state.posts; },
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}

/** A PDF attachment with `count` highlight annotations (0-based page indexes). */
export function pdfAttachment(key: string, annotationKeys: string[] = []): MockAttachment {
	return { key, path: `/synthetic/${key}.pdf`, title: "Synthetic PDF", annotations: annotationKeys.map((annotation, index) => ({ key: annotation, parentItem: key, annotationType: "highlight", annotationText: `Synthetic text ${annotation}`, annotationComment: "", annotationColor: "#ffd400", annotationPageLabel: String(index + 1), annotationPosition: { pageIndex: index, rects: [] }, tags: [], dateModified: "2026-03-01T10:00:00Z", version: 1 })) };
}

/** An EPUB attachment whose annotations carry a FragmentSelector (EPUB CFI) and no page index. */
export function epubAttachment(key: string, annotationKeys: string[] = []): MockAttachment {
	return { key, path: `/synthetic/${key}.epub`, title: "Synthetic EPUB", annotations: annotationKeys.map((annotation, index) => ({ key: annotation, parentItem: key, annotationType: "highlight", annotationText: `EPUB text ${annotation}`, annotationComment: "", annotationColor: "#5fb236", annotationPageLabel: "", annotationSortIndex: `00002|${String(index).padStart(8, "0")}`, annotationPosition: { type: "FragmentSelector", conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html", value: `epubcfi(/6/4!/4/2/${index + 1},/1:0,/1:12)` }, tags: [], dateModified: "2026-03-02T10:00:00Z", version: 2 })) };
}

/** A web snapshot whose annotations carry a CssSelector refined by a text position. */
export function snapshotAttachment(key: string, annotationKeys: string[] = []): MockAttachment {
	return { key, path: `/synthetic/${key}/Snapshot.html`, title: "Snapshot", annotations: annotationKeys.map(annotation => ({ key: annotation, parentItem: key, annotationType: "underline", annotationText: `Snapshot text ${annotation}`, annotationComment: "A comment", annotationColor: "#2ea8e5", annotationPageLabel: "", annotationPosition: { type: "CssSelector", value: "body > div:nth-child(2) > p:nth-child(3)", refinedBy: { type: "TextPositionSelector", start: 10, end: 42 } }, tags: [{ tag: "web" }], dateModified: "2026-03-03T10:00:00Z", version: 1 })) };
}
