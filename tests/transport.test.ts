import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { BbtTransportError, bbtErrorPayload, bbtObservation, bbtReasonLabel, classifyTransportError, describeBbtError, httpRequest, isBbtTransportError, rpc, rpcBatch, transportReasonOf } from "../src/api/transport";
import { BbtService, type BbtOutcome } from "../src/bbt";
import { IndexRefusalError, classifyRefreshError, describeRefreshFailure, transportErrorOf } from "../src/index-service";
import { DEFAULT_SETTINGS, type ZoteroIndexEntry } from "../src/types";
import { normalizeEntry } from "../src/api/normalize";

async function serve(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ endpoint: string; port: number; close: () => Promise<void> }> {
	const server = http.createServer(handler);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Server did not expose a port");
	return { endpoint: `http://127.0.0.1:${address.port}`, port: address.port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

/** A port nothing listens on: bind, read the number, release. */
async function closedPort(): Promise<number> {
	const probe = net.createServer();
	await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("Probe did not expose a port");
	await new Promise<void>(resolve => probe.close(() => resolve()));
	return address.port;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try { await promise; } catch (error) { return error; }
	throw new Error("Expected a rejection");
}

function parent(): ZoteroIndexEntry {
	return normalizeEntry({ libraryID: 1, citationKey: "Example2026", itemKey: "ABCD2345", uri: "http://zotero.org/users/local/Example/items/ABCD2345", itemType: "journalArticle", title: "Synthetic example", date: "2026", creators: [{ firstName: "Example", lastName: "Author" }], tags: [], attachments: [], notes: [] });
}

test("classifyTransportError maps Node codes, abort signals and timeouts; plain validation errors are not transport faults", () => {
	const codes: [string, string][] = [["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:23119"], ["ECONNRESET", "socket hang up"], ["ENOTFOUND", "getaddrinfo ENOTFOUND zotero.local"], ["EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.1"]];
	for (const [code, message] of codes) {
		const error = Object.assign(new Error(message), { code });
		const typed = classifyTransportError(error, "http://127.0.0.1:23119/better-bibtex/json-rpc", 20000);
		assert.equal(typed.reason, "connection-refused", code);
		assert.equal(typed.code, code);
		assert.equal(typed.cause, error);
		assert.equal(typed.detail, message);
		assert.equal(transportReasonOf(error), "connection-refused");
	}
	assert.equal(transportReasonOf(new Error("connect ECONNREFUSED 127.0.0.1:23119")), "connection-refused", "message text alone is enough for legacy plain errors");
	const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
	assert.equal(classifyTransportError(abort, "http://x/json-rpc", 20000).reason, "aborted");
	assert.equal(transportReasonOf(new Error("BBT collection cancelled")), "aborted");
	assert.equal(transportReasonOf(Object.assign(new Error("connect ETIMEDOUT 127.0.0.1:23119"), { code: "ETIMEDOUT" })), "timeout");
	assert.equal(transportReasonOf(new Error("BBT request timed out")), "timeout");
	assert.equal(transportReasonOf(new Error("Refusing to save invalid Zotero index")), null);
	assert.equal(transportReasonOf("not an error"), null);
	const unknown = classifyTransportError(new Error("BBT export must return a JSON string"), "http://x/json-rpc", 20000);
	assert.equal(unknown.reason, "invalid-response", "an unrecognised fault of a BBT request is an unusable answer, never a fabricated connection failure");
	const tls = classifyTransportError(Object.assign(new Error("write EPROTO wrong version number"), { code: "EPROTO" }), "https://x/json-rpc", 20000, "connection-refused");
	assert.equal(tls.reason, "connection-refused", "a socket-level fault without a listed code takes the socket fallback");
	assert.equal(tls.code, "EPROTO");
	assert.equal(bbtObservation(tls), "Zotero/Better BibTeX did not answer at https://x/json-rpc (EPROTO)");
	const codeless = new BbtTransportError("connection-refused", "http://x/json-rpc", "socket hang up");
	assert.equal(bbtObservation(codeless), "Zotero/Better BibTeX did not answer at http://x/json-rpc (connection failed)", "no Node code means no claim of a refused connection");
	const typed = new BbtTransportError("http-404", "http://x/json-rpc", "BBT HTTP 404 for api.ready", { status: 404 });
	assert.equal(classifyTransportError(typed, "elsewhere", 1), typed, "typed errors pass through unchanged");
	assert.ok(isBbtTransportError(typed));
	assert.ok(!isBbtTransportError(new Error("x")));
	assert.deepEqual(bbtErrorPayload(typed), { reason: "http-404", endpoint: "http://x/json-rpc" });
	assert.equal(bbtErrorPayload(new Error("x")), null);
});

test("describeBbtError uses observation wording with the endpoint, and messages carry it already", () => {
	const refused = classifyTransportError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:23119"), { code: "ECONNREFUSED" }), "http://127.0.0.1:23119/better-bibtex/json-rpc", 20000);
	assert.equal(describeBbtError(refused), "Zotero/Better BibTeX did not answer at http://127.0.0.1:23119/better-bibtex/json-rpc (connection refused). Start Zotero, then retry.");
	assert.equal(refused.message, describeBbtError(refused));
	const reset = classifyTransportError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "http://127.0.0.1:23119/better-bibtex/json-rpc", 20000);
	assert.equal(bbtObservation(reset), "Zotero/Better BibTeX did not answer at http://127.0.0.1:23119/better-bibtex/json-rpc (ECONNRESET)");
	const timeout = new BbtTransportError("timeout", "http://127.0.0.1:23119/better-bibtex/json-rpc", "BBT request timed out", { timeoutMs: 20000 });
	assert.equal(describeBbtError(timeout), "Zotero/Better BibTeX at http://127.0.0.1:23119/better-bibtex/json-rpc did not respond within 20 s (request timed out). Check that Zotero is responsive, then retry.");
	const missing = new BbtTransportError("http-404", "http://127.0.0.1:23119/wrong/json-rpc", "BBT HTTP 404 for api.ready", { status: 404 });
	assert.equal(describeBbtError(missing), "Zotero answered at http://127.0.0.1:23119/wrong/json-rpc but the Better BibTeX endpoint was not found (HTTP 404); check that Better BibTeX is installed and the endpoint path is /better-bibtex.");
	const server = new BbtTransportError("http-other", "http://x/json-rpc", "BBT HTTP 500 for item.bibliography", { status: 500 });
	assert.match(describeBbtError(server), /^Zotero answered at http:\/\/x\/json-rpc with HTTP 500; /);
	assert.equal(describeBbtError(new BbtTransportError("rpc", "http://x/json-rpc", "BBT RPC error for item.bibliography")), "Better BibTeX at http://x/json-rpc reported an error (BBT RPC error for item.bibliography).");
	assert.equal(describeBbtError(new BbtTransportError("invalid-response", "http://x/json-rpc", "Invalid BBT RPC envelope for api.ready")), "Better BibTeX at http://x/json-rpc returned an unexpected response (Invalid BBT RPC envelope for api.ready).");
	assert.match(describeBbtError(new BbtTransportError("aborted", "http://x/json-rpc", "BBT response aborted")), /aborted by the plugin/);
	assert.equal(describeBbtError(new Error("Bibliography requires a validated item")), "Bibliography requires a validated item");
	assert.equal(bbtReasonLabel("connection-refused"), "connection refused");
	assert.equal(bbtReasonLabel("http-other", 502), "HTTP 502");
	assert.equal(bbtReasonLabel("aborted"), "cancelled");
	assert.equal(bbtReasonLabel("something-new"), "something-new");
});

test("httpRequest and rpc throw typed errors for a closed port, a hung server, HTTP 404/500, invalid JSON and RPC error envelopes", async () => {
	const port = await closedPort();
	const refused = await rejection(rpc(`http://127.0.0.1:${port}`, "api.ready", [], 1000));
	assert.ok(isBbtTransportError(refused));
	assert.equal(refused.reason, "connection-refused");
	assert.equal(refused.code, "ECONNREFUSED");
	assert.equal(refused.endpoint, `http://127.0.0.1:${port}/json-rpc`);
	assert.match(refused.message, /did not answer at .* \(connection refused\)\. Start Zotero, then retry\.$/);

	const api = await serve((request, response) => {
		if (request.url === "/slow/json-rpc") return;
		if (request.url === "/missing/json-rpc") { response.statusCode = 404; response.end("not here"); return; }
		if (request.url === "/broken/json-rpc") { response.statusCode = 500; response.end("boom"); return; }
		if (request.url === "/garbage/json-rpc") { response.end("{not-json"); return; }
		if (request.url === "/shape/json-rpc") { response.end(JSON.stringify({ hello: "world" })); return; }
		// Better BibTeX's real error shape (json-rpc.ts handle()): HTTP 200 and id null, never the request's id.
		if (request.url === "/rpcerror/json-rpc") { response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found: item.bibliographyx" }, id: null })); return; }
		if (request.url === "/rpcerror-own-id/json-rpc") { response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "not found: Gone2026" } })); return; }
		if (request.url === "/rpcerror-foreign-id/json-rpc") { response.end(JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "not found" } })); return; }
		if (request.url === "/null-success/json-rpc") { response.end(JSON.stringify({ jsonrpc: "2.0", id: null, result: "orphan" })); return; }
		if (request.url === "/noresult/json-rpc") { response.end(JSON.stringify({ jsonrpc: "2.0", id: 1 })); return; }
		response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { zotero: "7", betterbibtex: "7" } }));
	});
	try {
		const timeout = await rejection(rpc(`${api.endpoint}/slow`, "api.ready", [], 30));
		assert.ok(isBbtTransportError(timeout));
		assert.equal(timeout.reason, "timeout");
		assert.equal(timeout.timeoutMs, 30);
		assert.match(timeout.message, /did not respond within 1 s \(request timed out\)/);
		const missing = await rejection(rpc(`${api.endpoint}/missing`, "api.ready", [], 1000));
		assert.ok(isBbtTransportError(missing));
		assert.equal(missing.reason, "http-404");
		assert.equal(missing.status, 404);
		assert.match(missing.message, /endpoint was not found \(HTTP 404\)/);
		const broken = await rejection(rpc(`${api.endpoint}/broken`, "api.ready", [], 1000));
		assert.ok(isBbtTransportError(broken));
		assert.equal(broken.reason, "http-other");
		assert.equal(broken.status, 500);
		for (const path of ["/garbage", "/shape", "/noresult", "/null-success", "/rpcerror-foreign-id"]) {
			const invalid = await rejection(rpc(`${api.endpoint}${path}`, "api.ready", [], 1000));
			assert.ok(isBbtTransportError(invalid), path);
			assert.equal(invalid.reason, "invalid-response", path);
		}
		const rpcError = await rejection(rpc(`${api.endpoint}/rpcerror`, "item.bibliography", [], 1000));
		assert.ok(isBbtTransportError(rpcError));
		assert.equal(rpcError.reason, "rpc", "an id-null error reply is an RPC fault, never an invalid envelope");
		assert.equal(rpcError.detail, "BBT RPC error for item.bibliography");
		assert.equal(rpcError.rpcCode, -32601);
		assert.equal(rpcError.rpcMessage, "Method not found: item.bibliographyx");
		assert.match(rpcError.message, /reported an error \(BBT RPC error for item\.bibliography: Method not found: item\.bibliographyx\)\.$/);
		const ownId = await rejection(rpc(`${api.endpoint}/rpcerror-own-id`, "item.export", [], 1000));
		assert.ok(isBbtTransportError(ownId));
		assert.equal(ownId.reason, "rpc", "an error carrying the request's own id is accepted too (JSON-RPC 2.0)");
		assert.equal(ownId.rpcMessage, "not found: Gone2026");
		const controller = new AbortController();
		const aborted = rejection(httpRequest(`${api.endpoint}/slow/json-rpc?x=1`, 5000, undefined, controller.signal));
		controller.abort();
		const abortedError = await aborted;
		assert.ok(isBbtTransportError(abortedError));
		assert.equal(abortedError.reason, "aborted");
		assert.equal(abortedError.endpoint, `${api.endpoint}/slow/json-rpc`, "the query string is not part of the reported endpoint");
		assert.deepEqual(await rpc(api.endpoint, "api.ready", [], 1000), { zotero: "7", betterbibtex: "7" });
		// TLS against a plain HTTP listener fails in the socket before any response: a connection fault, not an unusable answer.
		const tls = await rejection(httpRequest(`https://127.0.0.1:${api.port}/json-rpc`, 1000));
		assert.ok(isBbtTransportError(tls));
		assert.equal(tls.reason, "connection-refused");
		assert.equal(classifyRefreshError(tls), "bbt-unreachable");
	} finally { await api.close(); }
	// Zotero closing the connection mid-response is an observation about Zotero, never the plugin's cancellation.
	const truncating = await serve((_request, response) => { response.writeHead(200, { "Content-Length": "100" }); response.write("{\"partial\":"); response.socket?.destroy(); });
	try {
		const cut = await rejection(httpRequest(`${truncating.endpoint}/json-rpc`, 1000));
		assert.ok(isBbtTransportError(cut));
		assert.equal(cut.reason, "connection-refused");
		assert.notEqual(classifyRefreshError(cut), "cancelled");
		assert.doesNotMatch(cut.message, /aborted by the plugin/);
	} finally { await truncating.close(); }
});

test("BbtService observes the whole call: an HTTP 404 picker answer or an unusable readiness answer is a failed outcome", async () => {
	let readiness: unknown = { zotero: "7", betterbibtex: "7" };
	const api = await serve((request, response) => {
		if (request.url?.startsWith("/cayw")) { response.statusCode = 404; response.end("not here"); return; }
		response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: readiness }));
	});
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint, requestTimeoutMs: 1000 });
	try {
		await service.capabilities();
		assert.equal(service.lastOutcome?.ok, true);
		await assert.rejects(service.cayw(), (error: unknown) => isBbtTransportError(error) && error.reason === "http-404");
		assert.equal(service.lastOutcome?.ok, false, "a 404 from the picker is never recorded as ok");
		assert.equal(service.lastOutcome?.reason, "http-404");
		assert.equal(service.lastOutcome?.status, 404);
		readiness = { hello: "world" };
		await assert.rejects(service.capabilities(), (error: unknown) => isBbtTransportError(error) && error.reason === "invalid-response");
		assert.equal(service.lastOutcome?.ok, false);
		assert.equal(service.lastOutcome?.reason, "invalid-response");
		assert.equal(await service.isReachable(), false);
		readiness = { zotero: "7", betterbibtex: "7" };
		assert.equal(await service.isReachable(), true);
		assert.equal(service.lastOutcome?.ok, true);
	} finally { service.dispose(); await api.close(); }
});

test("classifyRefreshError and describeRefreshFailure delegate to the transport classification", () => {
	const refused = new BbtTransportError("connection-refused", "http://127.0.0.1:23119/better-bibtex/json-rpc", "connect ECONNREFUSED 127.0.0.1:23119", { code: "ECONNREFUSED" });
	assert.equal(classifyRefreshError(refused), "bbt-unreachable");
	assert.equal(classifyRefreshError(new BbtTransportError("http-404", "http://x/json-rpc", "BBT HTTP 404 for api.ready", { status: 404 })), "bbt-unreachable", "an endpoint without BBT is unreachable BBT");
	assert.equal(classifyRefreshError(new BbtTransportError("timeout", "http://x/json-rpc", "BBT request timed out", { timeoutMs: 20000 })), "timeout");
	assert.equal(classifyRefreshError(new BbtTransportError("aborted", "http://x/json-rpc", "BBT response aborted")), "cancelled");
	assert.equal(classifyRefreshError(new BbtTransportError("rpc", "http://x/json-rpc", "BBT RPC error for item.search")), null, "an RPC error is an answer from BBT, not a connectivity fault");
	assert.equal(classifyRefreshError(new BbtTransportError("invalid-response", "http://x/json-rpc", "Invalid BBT RPC envelope for api.ready")), null);
	assert.equal(classifyRefreshError(new BbtTransportError("http-other", "http://x/json-rpc", "BBT HTTP 500 for api.ready", { status: 500 })), null);
	// The typed error, directly or as the cause of an IndexRefusalError, drives the same observation wording as Notices.
	assert.equal(describeRefreshFailure(refused, "http://127.0.0.1:23119/better-bibtex", 90), "Zotero/Better BibTeX did not answer at http://127.0.0.1:23119/better-bibtex/json-rpc (connection refused); using the saved index from 2 h ago.");
	const wrapped = new IndexRefusalError("bbt-unreachable", refused.message, refused);
	assert.equal(transportErrorOf(wrapped), refused);
	assert.equal(transportErrorOf(new IndexRefusalError("legacy-plugin-enabled", "legacy")), null);
	assert.equal(describeRefreshFailure(wrapped, "http://127.0.0.1:23119/better-bibtex", null), "Zotero/Better BibTeX did not answer at http://127.0.0.1:23119/better-bibtex/json-rpc (connection refused); no saved index is available yet. Start Zotero and refresh the index.");
	const timeout = new BbtTransportError("timeout", "http://127.0.0.1:23119/better-bibtex/json-rpc", "BBT request timed out", { timeoutMs: 20000 });
	assert.equal(describeRefreshFailure(timeout, "http://127.0.0.1:23119/better-bibtex", 5), "Zotero/Better BibTeX at http://127.0.0.1:23119/better-bibtex/json-rpc did not respond within 20 s (request timed out); using the saved index from 5 min ago.");
	// Plain legacy errors keep the endpoint-parameter wording.
	assert.equal(describeRefreshFailure(new Error("connect ECONNREFUSED 127.0.0.1:23119"), "http://127.0.0.1:23119", 5), "Zotero/Better BibTeX is not reachable at http://127.0.0.1:23119; using the saved index from 5 min ago.");
});

test("BbtService records the last real outcome from calls only and never from its own abort", async () => {
	let mode: "ok" | "rpc-error" | "hang" = "ok";
	const api = await serve((request, response) => {
		if (mode === "hang") return;
		if (mode === "rpc-error") { response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "nope" }, id: null })); return; }
		let body = "";
		request.on("data", chunk => { body += String(chunk); });
		request.on("end", () => {
			const call = JSON.parse(body) as { method: string };
			response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: call.method === "api.ready" ? { zotero: "7", betterbibtex: "7" } : "Synthetic bibliography" }));
		});
	});
	const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: api.endpoint, requestTimeoutMs: 1000 });
	const seen: BbtOutcome[] = [];
	const unsubscribe = service.onOutcome(outcome => { seen.push(outcome); });
	try {
		assert.equal(service.lastOutcome, null, "untested before any call");
		await service.capabilities();
		assert.equal(service.lastOutcome?.ok, true);
		assert.ok(service.lastOutcome && service.lastOutcome.at instanceof Date);
		const entry = parent();
		assert.equal(await service.bibliography(entry), "Synthetic bibliography");
		assert.equal(seen.length, 2);
		mode = "rpc-error";
		await assert.rejects(service.bibliography(entry), (error: unknown) => isBbtTransportError(error) && error.reason === "rpc");
		assert.equal(service.lastOutcome?.ok, false);
		assert.equal(service.lastOutcome?.reason, "rpc");
		assert.match(service.lastOutcome?.message ?? "", /reported an error/);
		unsubscribe();
		mode = "ok";
		await service.capabilities();
		assert.equal(seen.length, 3, "unsubscribed listeners are not called");
		assert.equal(service.lastOutcome?.ok, true);
		assert.equal(await service.isReachable(), true);
		mode = "rpc-error";
		await assert.rejects(service.bibliography(entry), (error: unknown) => isBbtTransportError(error) && error.reason === "rpc");
		// STRUCT-03: the plugin's own cancellation is dispose() (reload/unload), which aborts the request in flight.
		mode = "hang";
		const pending = service.capabilities();
		service.dispose();
		await assert.rejects(pending, (error: unknown) => isBbtTransportError(error) && error.reason === "aborted");
		assert.equal(service.lastOutcome?.reason, "rpc", "an aborted request is not an observation about BBT");
	} finally { service.dispose(); await api.close(); }
	const port = await closedPort();
	const offline = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: `http://127.0.0.1:${port}`, requestTimeoutMs: 1000 });
	try {
		assert.equal(await offline.isReachable(), false);
		assert.equal(offline.lastOutcome?.ok, false);
		assert.equal(offline.lastOutcome?.reason, "connection-refused");
	} finally { offline.dispose(); }
});

// 0.6 OPT-01: batch replies are matched by position; BBT answers errors with id null and echoes an id of 0 as null.
test("rpcBatch matches replies by position, settles each request on its own and types whole-batch faults", async () => {
	let mode: "ok" | "short" | "parse-error" | "not-array" | "bad-id" = "ok";
	const bodies: unknown[] = [];
	const api = await serve((request, response) => {
		let body = "";
		request.on("data", chunk => { body += String(chunk); });
		request.on("end", () => {
			const calls = JSON.parse(body) as { id: number; method: string; params: unknown[] }[];
			bodies.push(calls);
			if (mode === "parse-error") { response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: synthetic" }, id: null })); return; }
			if (mode === "not-array") { response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "single" })); return; }
			const replies = calls.map(call => call.params[0] === "Missing2026"
				? { jsonrpc: "2.0", error: { code: -32602, message: "Missing2026 not found" }, id: null }
				: { jsonrpc: "2.0", result: `attachments of ${String(call.params[0])}`, id: mode === "bad-id" ? 99 : call.id });
			response.end(JSON.stringify(mode === "short" ? replies.slice(1) : replies));
		});
	});
	try {
		assert.deepEqual(await rpcBatch(api.endpoint, [], 1000), [], "an empty batch never reaches BBT");
		assert.equal(bodies.length, 0);
		const calls = ["Alpha2026", "Missing2026", "Gamma2026"].map(citekey => ({ method: "item.attachments", params: [citekey, 1] }));
		const settled = await rpcBatch(api.endpoint, calls, 1000);
		assert.deepEqual((bodies[0] as { id: number }[]).map(call => call.id), [1, 2, 3], "ids start at 1: BBT would echo an id of 0 as null");
		assert.deepEqual(settled.map(reply => reply.ok), [true, false, true]);
		assert.deepEqual(settled[0], { ok: true, result: "attachments of Alpha2026" });
		assert.deepEqual(settled[2], { ok: true, result: "attachments of Gamma2026" });
		const failed = settled[1];
		assert.ok(!failed.ok && failed.error.reason === "rpc" && failed.error.rpcCode === -32602 && failed.error.rpcMessage === "Missing2026 not found", "the id-null error lands on its own position");
		mode = "bad-id";
		const misattributed = await rpcBatch(api.endpoint, calls.slice(0, 1), 1000);
		assert.ok(!misattributed[0].ok && misattributed[0].error.reason === "invalid-response", "a result for another id is never attributed to this request");
		mode = "short";
		const short = await rejection(rpcBatch(api.endpoint, calls, 1000));
		assert.ok(isBbtTransportError(short) && short.reason === "invalid-response");
		assert.match(short.detail, /answered 2 of 3 requests/);
		mode = "parse-error";
		const parse = await rejection(rpcBatch(api.endpoint, calls, 1000));
		assert.ok(isBbtTransportError(parse) && parse.reason === "rpc" && parse.rpcCode === -32700);
		mode = "not-array";
		const single = await rejection(rpcBatch(api.endpoint, calls, 1000));
		assert.ok(isBbtTransportError(single) && single.reason === "invalid-response");
	} finally { await api.close(); }
	const port = await closedPort();
	const refused = await rejection(rpcBatch(`http://127.0.0.1:${port}`, [{ method: "api.ready", params: [] }], 1000));
	assert.ok(isBbtTransportError(refused) && refused.reason === "connection-refused");
});
