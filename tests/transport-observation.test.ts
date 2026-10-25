import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { BbtService } from "../src/bbt";
import { isBbtTransportError, transportReasonOf } from "../src/api/transport";
import { classifyRefreshError } from "../src/index-service";
import { DEFAULT_SETTINGS, type ZoteroIndexEntry } from "../src/types";
import { normalizeEntry } from "../src/api/normalize";

// 0.5 R4 fix pass: the recorded BBT observation is one truth — a remote drop is Zotero's fault (never the plugin's
// cancellation), a failure is not overwritten by a slower in-flight success, and every bibliography style is observed.

async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ endpoint: string; close: () => Promise<void> }> {
	const server = http.createServer(handler);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Server did not expose a port");
	return { endpoint: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try { await promise; } catch (error) { return error; }
	throw new Error("Expected a rejection");
}

function parent(): ZoteroIndexEntry {
	return normalizeEntry({ libraryID: 1, citationKey: "Example2026", itemKey: "ABCD2345", uri: "http://zotero.org/users/local/Example/items/ABCD2345", itemType: "journalArticle", title: "Synthetic example", date: "2026", creators: [{ firstName: "Example", lastName: "Author" }], tags: [], attachments: [], notes: [] });
}

function service(endpoint: string, timeoutMs = 1000): BbtService {
	return new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: endpoint, requestTimeoutMs: timeoutMs });
}

test("a Node ECONNRESET whose message is 'aborted' is a connection fault; only the plugin's own AbortError is 'aborted'", () => {
	const reset = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
	assert.equal(transportReasonOf(reset), "connection-refused", "Node's connResetException says 'aborted' but it is the remote end going away");
	const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
	assert.equal(transportReasonOf(abort), "aborted");
	assert.equal(transportReasonOf(new Error("BBT collection cancelled")), "aborted", "the collector's own cancellation check stays a cancellation");
	assert.equal(transportReasonOf(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), "connection-refused");
});

test("Zotero cutting a response off mid-way is recorded as a failed observation and classifies as bbt-unreachable, not cancelled", async () => {
	const api = await serve((_request, response) => { response.writeHead(200, { "Content-Length": "100" }); response.write("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":"); response.socket?.destroy(); });
	const bbt = service(api.endpoint);
	try {
		const error = await rejection(bbt.capabilities());
		assert.ok(isBbtTransportError(error));
		assert.equal(error.reason, "connection-refused");
		assert.equal(error.code, "ECONNRESET");
		assert.doesNotMatch(error.message, /aborted by the plugin/);
		assert.equal(classifyRefreshError(error), "bbt-unreachable");
		assert.equal(bbt.lastOutcome?.ok, false, "the status line must say failed after Zotero died mid-response");
		assert.equal(bbt.lastOutcome?.reason, "connection-refused");
	} finally { bbt.dispose(); await api.close(); }
});

test("the plugin aborting a request after headers arrived is still its own cancellation and is not recorded", async () => {
	const api = await serve((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{\"jsonrpc\":"); /* never ends */ });
	const bbt = service(api.endpoint, 5000);
	try {
		const pending = rejection(bbt.capabilities());
		await new Promise(resolve => setTimeout(resolve, 50));
		bbt.dispose(); // STRUCT-03: the plugin's own cancellation (reload/unload)
		const error = await pending;
		assert.ok(isBbtTransportError(error));
		assert.equal(error.reason, "aborted");
		assert.equal(classifyRefreshError(error), "cancelled");
		assert.equal(bbt.lastOutcome, null, "the plugin's own abort is never an observation about Zotero");
	} finally { bbt.dispose(); await api.close(); }
});

test("a failure stays recorded while slower requests that started before it complete successfully", async () => {
	const api = await serve((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { params: unknown[] };
			const delay = (parsed.params[0] as { delay?: number } | undefined)?.delay ?? 0;
			const fail = (parsed.params[0] as { fail?: boolean } | undefined)?.fail === true;
			setTimeout(() => {
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify(fail ? { jsonrpc: "2.0", error: { code: -32000, message: "boom" }, id: null } : { jsonrpc: "2.0", id: 1, result: "ok" }));
			}, delay);
		});
	});
	const bbt = service(api.endpoint);
	const rpcCall = (params: unknown[]): Promise<unknown> => (bbt as unknown as { call: (method: string, params: unknown[]) => Promise<unknown> }).call("test.echo", params);
	try {
		const slowSuccess = rpcCall([{ delay: 120 }]);
		await new Promise(resolve => setTimeout(resolve, 10));
		await assert.rejects(rpcCall([{ fail: true }]), (error: unknown) => isBbtTransportError(error) && error.reason === "rpc");
		assert.equal(bbt.lastOutcome?.ok, false);
		const failedAt = bbt.lastOutcome?.at;
		assert.equal(await slowSuccess, "ok");
		assert.equal(bbt.lastOutcome?.ok, false, "a success that started before the failure was observed does not overwrite it");
		assert.equal(bbt.lastOutcome?.at, failedAt);
		assert.equal(await rpcCall([{ delay: 0 }]), "ok");
		assert.equal(bbt.lastOutcome?.ok, true, "a request started after the failure proves BBT is back");
	} finally { bbt.dispose(); await api.close(); }
});

test("bibliography with a non-default style goes through the observed, typed transport path", async () => {
	const styles: string[] = [];
	let failStyle: string | null = null;
	const api = await serve((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { method: string; params: unknown[] };
			assert.equal(parsed.method, "item.bibliography");
			const style = (parsed.params[1] as { id: string }).id;
			styles.push(style);
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(style === failStyle ? { jsonrpc: "2.0", error: { code: -32603, message: "CSL style \"unknown\" not found" }, id: null } : { jsonrpc: "2.0", id: 1, result: `[${style}] Author, Example. Synthetic example.` }));
		});
	});
	const bbt = service(api.endpoint);
	try {
		assert.match(await bbt.bibliography(parent()), /^\[apa\]/);
		assert.match(await bbt.bibliography(parent(), "chicago-author-date"), /^\[chicago-author-date\]/);
		assert.deepEqual(styles, ["apa", "chicago-author-date"]);
		assert.equal(bbt.lastOutcome?.ok, true);
		failStyle = "nature";
		await assert.rejects(bbt.bibliography(parent(), "nature"), (error: unknown) => isBbtTransportError(error) && error.reason === "rpc");
		assert.equal(bbt.lastOutcome?.ok, false, "a styled bibliography failure is observed like any other call");
		assert.equal(bbt.lastOutcome?.reason, "rpc");
	} finally { bbt.dispose(); await api.close(); }
});

test("invalid response shapes are observed as invalid-response and expected probe RPC faults do not record a BBT outage", async () => {
	let mode: "bad-bib" | "bad-search" | "bad-export" | "bad-attachments" | "not-found" | "zotero9" | "optional-probes" = "bad-bib";
	const api = await serve((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
		request.on("end", () => {
			const parsed = JSON.parse(body) as { method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
			response.setHeader("Content-Type", "application/json");
			if (Array.isArray(parsed)) {
				response.end(JSON.stringify(parsed.map(call => ({ jsonrpc: "2.0", id: call.id, result: [] }))));
				return;
			}
			if (mode === "bad-bib") {
				response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 123 }));
			} else if (mode === "bad-search") {
				response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { not: "an-array" } }));
			} else if (mode === "bad-export") {
				response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: JSON.stringify({ items: [] }) }));
			} else if (mode === "bad-attachments") {
				if (parsed.method === "item.export") response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: JSON.stringify({ items: [{ libraryID: 1, citationKey: "Example2026", itemKey: "ABCD2345", uri: "http://zotero.org/users/local/Example/items/ABCD2345", itemType: "journalArticle", title: "Synthetic", date: "2026", creators: [], tags: [], attachments: [], notes: [] }] }) }));
				else response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "not-an-array" }));
			} else if (mode === "not-found") {
				if (parsed.method === "item.export") response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: "not found: Example2026" }, id: null }));
				else response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
			} else if (mode === "zotero9") {
				if (parsed.method === "api.ready") response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { zotero: "9.0.4", betterbibtex: "7.0.5" } }));
				else response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Invalid condition 'resultLevel' in hasOperator()" }, id: null }));
			} else {
				if (parsed.method === "api.ready") response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { zotero: "8.0.0", betterbibtex: "7.0.5" } }));
				else if (parsed.method === "user.groups" || (parsed.method === "item.search" && (parsed.params[0] as unknown[][]).some(t => t[0] === "retracted"))) {
					response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method/condition not supported" }, id: null }));
				} else if (parsed.method === "item.search") {
					response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ id: "http://zotero.org/users/local/Example/items/ABCD2345", citekey: "Example2026", library: "My Library" }] }));
				} else {
					response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: JSON.stringify({ items: [{ libraryID: 1, citationKey: "Example2026", itemKey: "ABCD2345", uri: "http://zotero.org/users/local/Example/items/ABCD2345", itemType: "journalArticle", title: "Synthetic", date: "2026", creators: [], tags: [], attachments: [], notes: [] }] }) }));
				}
			}
		});
	});
	const bbt = service(api.endpoint);
	try {
		const entry = parent();
		await assert.rejects(bbt.bibliography(entry), (err: unknown) => isBbtTransportError(err) && err.reason === "invalid-response");
		assert.equal(bbt.lastOutcome?.ok, false);
		assert.equal(bbt.lastOutcome?.reason, "invalid-response");

		await assert.rejects(bbt.bibliographyList(["Example2026"], 1), (err: unknown) => isBbtTransportError(err) && err.reason === "invalid-response");
		await assert.rejects(bbt.export(["Example2026"], "Better CSL JSON", 1), (err: unknown) => isBbtTransportError(err) && err.reason === "invalid-response");

		mode = "bad-search";
		await assert.rejects(bbt.findByCitekey("Example2026"), (err: unknown) => isBbtTransportError(err) && err.reason === "invalid-response");
		await assert.rejects(bbt.currentCitekey("ABCD2345", 1), (err: unknown) => isBbtTransportError(err) && err.reason === "invalid-response");
		await assert.rejects(bbt.recentlyRead(7), (err: unknown) => isBbtTransportError(err) && err.reason === "invalid-response");
		assert.equal(bbt.lastOutcome?.ok, false);
		assert.equal(bbt.lastOutcome?.reason, "invalid-response");

		mode = "bad-export";
		const target = { citekey: "Example2026", libraryID: 1, itemKey: "ABCD2345", libraryType: "user" as const };
		await assert.rejects(bbt.collectEntry(target), (err: unknown) => isBbtTransportError(err) && err.reason === "invalid-response");
		assert.equal(bbt.lastOutcome?.ok, false);

		mode = "bad-attachments";
		await assert.rejects(bbt.collectEntry(target), (err: unknown) => isBbtTransportError(err) && err.reason === "invalid-response");
		assert.equal(bbt.lastOutcome?.ok, false);

		const freshBbt = service(api.endpoint);
		try {
			mode = "not-found";
			await assert.rejects(freshBbt.collectEntry(target), /no longer has item ABCD2345/);
			assert.equal(freshBbt.lastOutcome?.ok, true, "not-found on initial exportOne is not recorded as a BBT failure; currentCitekey succeeded");

			mode = "zotero9";
			const z9Bbt = service(api.endpoint);
			await assert.rejects(z9Bbt.recentlyRead(7), /needs Zotero 10 or later/);
			assert.equal(z9Bbt.lastOutcome?.ok, true, "unknown condition fault is not recorded as a BBT failure; capabilities succeeded");
			z9Bbt.dispose();

			mode = "optional-probes";
			const collectBbt = service(api.endpoint);
			const index = await collectBbt.collect();
			assert.equal(index.count, 1);
			assert.equal(collectBbt.lastOutcome?.ok, true, "optional user.groups and retracted RPC faults do not poison lastOutcome");
			collectBbt.dispose();
		} finally { freshBbt.dispose(); }
	} finally { bbt.dispose(); await api.close(); }
});
