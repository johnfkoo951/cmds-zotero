import * as http from "http";
import * as https from "https";
import * as timers from "timers";
import { record } from "../identity";

export interface HttpResult { status: number; text: string }

// 0.5 R4: typed BBT transport errors — the single classification point for every BBT fault the plugin reports.
/**
 * Why a BBT request failed. `connection-refused` covers every socket-level fault (refused, reset, unresolved host);
 * `aborted` is the plugin's own cancellation and never an observation about Zotero.
 */
export type BbtTransportReason = "connection-refused" | "timeout" | "http-404" | "http-other" | "aborted" | "rpc" | "invalid-response";

const REASON_ORDER: readonly BbtTransportReason[] = ["connection-refused", "timeout", "http-404", "http-other", "aborted", "rpc", "invalid-response"];
const NETWORK_CODES = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|ECONNABORTED|EPIPE|ENETUNREACH)\b/;
const NETWORK_TEXT = /socket hang up|fetch failed/i;
const TIMED_OUT = /\bETIMEDOUT\b|timed out/i;
/**
 * The plugin's own abort (`bbt.dispose()`), Node's AbortError text, or the collector's cancellation check. Tested only
 * after the Node code: a remote socket drop raises `ECONNRESET` with the message `aborted`, which is Zotero going away.
 */
const CANCELLED = /\baborted\b|cancelled/i;

/** A classified BBT request failure. `message` is already human wording; `cause` keeps the raw error for diagnostics. */
export class BbtTransportError extends Error {
	readonly name = "BbtTransportError";
	readonly reason: BbtTransportReason;
	readonly endpoint: string;
	readonly cause: unknown;
	/** Node error code (`ECONNREFUSED`), when the cause carried one. */
	readonly code?: string;
	/** HTTP status for `http-404`/`http-other`. */
	readonly status?: number;
	/** Bound of the request that timed out, in milliseconds. */
	readonly timeoutMs?: number;
	/** The raw cause text (`connect ECONNREFUSED 127.0.0.1:23119`, `BBT RPC error for item.bibliography`). */
	readonly detail: string;
	/** JSON-RPC error code and message Better BibTeX sent with an `rpc` fault (`-32602`, `not found: <citekey>`). */
	readonly rpcCode?: number;
	readonly rpcMessage?: string;

	constructor(reason: BbtTransportReason, endpoint: string, detail: string, options: { cause?: unknown; code?: string; status?: number; timeoutMs?: number; rpcCode?: number; rpcMessage?: string } = {}) {
		super("");
		this.reason = reason;
		this.endpoint = endpoint;
		this.detail = detail;
		this.cause = options.cause;
		if (options.code !== undefined) this.code = options.code;
		if (options.status !== undefined) this.status = options.status;
		if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
		if (options.rpcCode !== undefined) this.rpcCode = options.rpcCode;
		if (options.rpcMessage !== undefined) this.rpcMessage = options.rpcMessage;
		this.message = describeBbtError(this);
	}
}

export function isBbtTransportError(error: unknown): error is BbtTransportError {
	return error instanceof BbtTransportError || (error instanceof Error && error.name === "BbtTransportError" && (REASON_ORDER as readonly string[]).includes((error as { reason?: unknown }).reason as string));
}

function codeOf(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && code ? code : undefined;
}

/**
 * The transport reason an error carries, or null when it is not a transport fault (a validation error, a storage
 * error). Typed errors answer directly; plain errors are recognised by Node code or message text.
 */
export function transportReasonOf(error: unknown): BbtTransportReason | null {
	if (isBbtTransportError(error)) return error.reason;
	const code = codeOf(error) ?? "";
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if ((error instanceof Error && error.name === "AbortError") || code === "ABORT_ERR") return "aborted";
	if (NETWORK_CODES.test(code)) return "connection-refused";
	if (CANCELLED.test(message)) return "aborted";
	if (NETWORK_CODES.test(message) || NETWORK_TEXT.test(message)) return "connection-refused";
	if (TIMED_OUT.test(code) || TIMED_OUT.test(message)) return "timeout";
	return null;
}

/**
 * Wraps any failure of a BBT request in a {@link BbtTransportError}. An already typed error is returned unchanged;
 * a fault without a recognised network signature takes `fallback`: `invalid-response` by default (BBT was contacted but
 * did not answer usably), or `connection-refused` for an error raised by the socket before any response arrived
 * (TLS faults such as `EPROTO`, unlisted `ECONN*` variants).
 */
export function classifyTransportError(error: unknown, endpoint: string, timeoutMs: number, fallback: BbtTransportReason = "invalid-response"): BbtTransportError {
	if (isBbtTransportError(error)) return error;
	const reason = transportReasonOf(error) ?? fallback;
	const detail = error instanceof Error ? error.message : String(error);
	return new BbtTransportError(reason, endpoint, detail, { cause: error, code: codeOf(error), ...(reason === "timeout" ? { timeoutMs } : {}) });
}

/** Short label for status lines: `connection refused`, `timeout`, `HTTP 404`, `cancelled`. */
export function bbtReasonLabel(reason: string, status?: number): string {
	switch (reason) {
		case "connection-refused": return "connection refused";
		case "timeout": return "timeout";
		case "http-404": return "HTTP 404";
		case "http-other": return status !== undefined ? `HTTP ${status}` : "HTTP error";
		case "aborted": return "cancelled";
		case "rpc": return "RPC error";
		case "invalid-response": return "invalid response";
		default: return reason;
	}
}

/** What was observed, without advice or a final period: `Zotero/Better BibTeX did not answer at <endpoint> (connection refused)`. */
export function bbtObservation(error: BbtTransportError): string {
	const at = error.endpoint;
	switch (error.reason) {
		case "connection-refused": return `Zotero/Better BibTeX did not answer at ${at} (${error.code === "ECONNREFUSED" ? "connection refused" : error.code ?? "connection failed"})`;
		case "timeout": return `Zotero/Better BibTeX at ${at} did not respond within ${error.timeoutMs !== undefined ? `${Math.max(1, Math.round(error.timeoutMs / 1000))} s` : "the request timeout"} (request timed out)`;
		case "http-404": return `Zotero answered at ${at} but the Better BibTeX endpoint was not found (HTTP 404)`;
		case "http-other": return `Zotero answered at ${at} with HTTP ${error.status ?? "error"}`;
		case "aborted": return `The request to ${at} was aborted by the plugin before Zotero answered`;
		case "rpc": return `Better BibTeX at ${at} reported an error (${error.detail}${error.rpcMessage ? `: ${error.rpcMessage.replace(/\s+/g, " ").trim().slice(0, 200)}` : ""})`;
		default: return `Better BibTeX at ${at} returned an unexpected response (${error.detail})`;
	}
}

/** One Notice-ready sentence pair for a BBT failure; a non-transport error keeps its own message. */
export function describeBbtError(error: unknown): string {
	if (!isBbtTransportError(error)) return error instanceof Error ? error.message : String(error);
	const observed = bbtObservation(error);
	switch (error.reason) {
		case "connection-refused": return `${observed}. Start Zotero, then retry.`;
		case "timeout": return `${observed}. Check that Zotero is responsive, then retry.`;
		case "http-404": return `${observed}; check that Better BibTeX is installed and the endpoint path is /better-bibtex.`;
		case "http-other": return `${observed}; check the Better BibTeX endpoint and the Zotero error log.`;
		case "aborted": return `${observed}.`;
		default: return `${observed}.`;
	}
}

/** The additive `bbtError` payload field: the typed reason and the endpoint that failed, or null for non-transport errors. */
export function bbtErrorPayload(error: unknown): { reason: BbtTransportReason; endpoint: string } | null {
	return isBbtTransportError(error) ? { reason: error.reason, endpoint: error.endpoint } : null;
}

function endpointLabel(rawURL: string): string {
	const query = rawURL.indexOf("?");
	return query < 0 ? rawURL : rawURL.slice(0, query);
}

export function httpRequest(rawURL: string, timeoutMs: number, body?: string, signal?: AbortSignal): Promise<HttpResult> {
	const endpoint = endpointLabel(rawURL);
	// A socket-level `error` event is a transport fault even without a recognised Node code (`connection-refused`),
	// unless the plugin's own signal fired: then whatever Node raised while tearing down is the plugin's `aborted`.
	const fail = (reject: (reason: unknown) => void) => (error: unknown): void => {
		reject(signal?.aborted ? new BbtTransportError("aborted", endpoint, error instanceof Error ? error.message : String(error), { cause: error, code: codeOf(error) }) : classifyTransportError(error, endpoint, timeoutMs, "connection-refused"));
	};
	return new Promise((resolve, reject) => {
		const url = new URL(rawURL);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid BBT endpoint");
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("Invalid request timeout");
		const transport = url.protocol === "https:" ? https : http;
		const request = transport.request(url, { signal, method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, response => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 64 * 1024 * 1024) { request.destroy(new BbtTransportError("invalid-response", endpoint, "BBT response exceeds 64 MiB limit")); return; }
				chunks.push(chunk);
			});
			response.on("error", fail(reject));
			// Zotero closed the connection mid-response: an observation about Zotero (`ECONNRESET`), not the plugin's own
			// abort — unless the plugin's signal is what tore the socket down.
			response.on("aborted", () => reject(signal?.aborted
				? new BbtTransportError("aborted", endpoint, "BBT request aborted by the plugin")
				: new BbtTransportError("connection-refused", endpoint, "BBT response aborted by the remote end before it completed", { code: "ECONNRESET" })));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
		});
		const timer = timers.setTimeout(() => request.destroy(new BbtTransportError("timeout", endpoint, "BBT request timed out", { timeoutMs })), timeoutMs);
		request.on("close", () => timers.clearTimeout(timer));
		request.on("error", fail(reject));
		request.end(body);
	});
}

/** One JSON-RPC reply, settled: the result, or the typed fault this request alone ran into. */
export type RpcSettled = { ok: true; result: unknown } | { ok: false; error: BbtTransportError };

/**
 * Reads one JSON-RPC reply envelope (0.6 OPT-01). `error` is read before the id check: Better BibTeX answers every error
 * with HTTP 200 and `id: null` (`json-rpc.ts` handle()), so an error reply is accepted with `id` null or the request's own
 * id and keeps its JSON-RPC code and message. A result must carry the request's id; one with `id: null` cannot be
 * attributed to the request and is an invalid response.
 */
function settleReply(reply: unknown, id: number, url: string, method: string): RpcSettled {
	if (!record(reply) || reply.jsonrpc !== "2.0") return { ok: false, error: new BbtTransportError("invalid-response", url, `Invalid BBT RPC envelope for ${method}`) };
	if ("error" in reply) {
		if (reply.id !== null && reply.id !== id) return { ok: false, error: new BbtTransportError("invalid-response", url, `Invalid BBT RPC envelope for ${method}`) };
		const fault = record(reply.error) ? reply.error : {};
		return { ok: false, error: new BbtTransportError("rpc", url, `BBT RPC error for ${method}`, {
			...(typeof fault.code === "number" ? { rpcCode: fault.code } : {}),
			...(typeof fault.message === "string" ? { rpcMessage: fault.message.slice(0, 500) } : {}),
		}) };
	}
	if (reply.id !== id) return { ok: false, error: new BbtTransportError("invalid-response", url, `Invalid BBT RPC envelope for ${method}`) };
	if (!("result" in reply)) return { ok: false, error: new BbtTransportError("invalid-response", url, `Missing BBT RPC result for ${method}`) };
	return { ok: true, result: reply.result };
}

function rpcURL(endpoint: string): string { return `${endpoint.replace(/\/$/, "")}/json-rpc`; }

/** POSTs a JSON-RPC body and parses the HTTP 200 JSON answer; HTTP and JSON faults are typed for every request in it. */
async function postRpc(url: string, body: unknown, label: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
	const response = await httpRequest(url, timeoutMs, JSON.stringify(body), signal);
	if (response.status !== 200) throw new BbtTransportError(response.status === 404 ? "http-404" : "http-other", url, `BBT HTTP ${response.status} for ${label}`, { status: response.status });
	try { return JSON.parse(response.text) as unknown; }
	catch (error) { throw new BbtTransportError("invalid-response", url, `Invalid BBT RPC JSON for ${label}`, { cause: error }); }
}

export async function rpc(endpoint: string, method: string, params: unknown[], timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
	const url = rpcURL(endpoint);
	const settled = settleReply(await postRpc(url, { jsonrpc: "2.0", id: 1, method, params }, method, timeoutMs, signal), 1, url, method);
	if (!settled.ok) throw settled.error;
	return settled.result;
}

export interface RpcCall { method: string; params: unknown[] }

/**
 * Several JSON-RPC requests in one POST (0.6 OPT-01/OPT-10). Better BibTeX answers a batch array in request order
 * (`Promise.all` over the requests) and echoes an id of 0 as null, so replies are matched by position, never by id; each
 * request settles on its own (a `not found` for one citekey leaves the others intact). A fault of the whole POST (HTTP
 * status, unreadable JSON, a reply that is not one answer per request) is thrown for the batch.
 */
export async function rpcBatch(endpoint: string, calls: readonly RpcCall[], timeoutMs: number, signal?: AbortSignal): Promise<RpcSettled[]> {
	if (!calls.length) return [];
	const url = rpcURL(endpoint);
	const label = `a batch of ${calls.length} ${[...new Set(calls.map(call => call.method))].join("/")} requests`;
	const parsed = await postRpc(url, calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 1, method: call.method, params: call.params })), label, timeoutMs, signal);
	if (!Array.isArray(parsed)) {
		// A batch BBT could not parse at all comes back as one error envelope (`Parse error`, id null).
		const whole = settleReply(parsed, 0, url, label);
		throw whole.ok ? new BbtTransportError("invalid-response", url, `Invalid BBT RPC envelope for ${label}`) : whole.error;
	}
	if (parsed.length !== calls.length) throw new BbtTransportError("invalid-response", url, `BBT answered ${parsed.length} of ${calls.length} requests in ${label}`);
	return parsed.map((reply, index) => settleReply(reply, index + 1, url, calls[index].method));
}

export async function mapBounded<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Concurrency must be between 1 and 8");
	const results = new Array<R>(items.length);
	let cursor = 0;
	let failed = false;
	await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
		while (!failed && cursor < items.length) {
			const index = cursor++;
			try { results[index] = await fn(items[index], index); }
			catch (error) { failed = true; throw error; }
		}
	}));
	return results;
}
