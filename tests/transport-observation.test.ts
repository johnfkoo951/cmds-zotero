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
