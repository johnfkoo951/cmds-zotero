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
/** The plugin's own abort (`bbt.dispose()`), Node's AbortError text, or the collector's cancellation check. */
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

	constructor(reason: BbtTransportReason, endpoint: string, detail: string, options: { cause?: unknown; code?: string; status?: number; timeoutMs?: number } = {}) {
		super("");
		this.reason = reason;
		this.endpoint = endpoint;
		this.detail = detail;
		this.cause = options.cause;
		if (options.code !== undefined) this.code = options.code;
		if (options.status !== undefined) this.status = options.status;
		if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
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
	if ((error instanceof Error && error.name === "AbortError") || code === "ABORT_ERR" || CANCELLED.test(message)) return "aborted";
	if (NETWORK_CODES.test(code) || NETWORK_CODES.test(message) || NETWORK_TEXT.test(message)) return "connection-refused";
	if (TIMED_OUT.test(code) || TIMED_OUT.test(message)) return "timeout";
	return null;
}

/**
 * Wraps any failure of a BBT request in a {@link BbtTransportError}. An already typed error is returned unchanged;
 * a fault without a recognised network signature is `invalid-response` (BBT was contacted but did not answer usably).
 */
export function classifyTransportError(error: unknown, endpoint: string, timeoutMs: number): BbtTransportError {
	if (isBbtTransportError(error)) return error;
	const reason = transportReasonOf(error) ?? "invalid-response";
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
		case "connection-refused": return `Zotero/Better BibTeX did not answer at ${at} (${error.code === "ECONNREFUSED" || error.code === undefined ? "connection refused" : error.code})`;
		case "timeout": return `Zotero/Better BibTeX at ${at} did not respond within ${error.timeoutMs !== undefined ? `${Math.max(1, Math.round(error.timeoutMs / 1000))} s` : "the request timeout"} (request timed out)`;
		case "http-404": return `Zotero answered at ${at} but the Better BibTeX endpoint was not found (HTTP 404)`;
		case "http-other": return `Zotero answered at ${at} with HTTP ${error.status ?? "error"}`;
		case "aborted": return `The request to ${at} was aborted by the plugin before Zotero answered`;
		case "rpc": return `Better BibTeX at ${at} reported an error (${error.detail})`;
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
	const fail = (reject: (reason: unknown) => void) => (error: unknown): void => { reject(classifyTransportError(error, endpoint, timeoutMs)); };
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
			response.on("aborted", () => reject(new BbtTransportError("aborted", endpoint, "BBT response aborted")));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
		});
		const timer = timers.setTimeout(() => request.destroy(new BbtTransportError("timeout", endpoint, "BBT request timed out", { timeoutMs })), timeoutMs);
		request.on("close", () => timers.clearTimeout(timer));
		request.on("error", fail(reject));
		request.end(body);
	});
}

export async function rpc(endpoint: string, method: string, params: unknown[], timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
	const url = `${endpoint.replace(/\/$/, "")}/json-rpc`;
	const response = await httpRequest(url, timeoutMs, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal);
	if (response.status !== 200) throw new BbtTransportError(response.status === 404 ? "http-404" : "http-other", url, `BBT HTTP ${response.status} for ${method}`, { status: response.status });
	let parsed: unknown;
	try { parsed = JSON.parse(response.text); }
	catch (error) { throw new BbtTransportError("invalid-response", url, `Invalid BBT RPC JSON for ${method}`, { cause: error }); }
	if (!record(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== 1) throw new BbtTransportError("invalid-response", url, `Invalid BBT RPC envelope for ${method}`);
	if ("error" in parsed) throw new BbtTransportError("rpc", url, `BBT RPC error for ${method}`);
	if (!("result" in parsed)) throw new BbtTransportError("invalid-response", url, `Missing BBT RPC result for ${method}`);
	return parsed.result;
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
