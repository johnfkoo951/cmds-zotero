import * as http from "http";
import * as https from "https";
import * as timers from "timers";
import { record } from "../identity";

export interface HttpResult { status: number; text: string }

export function httpRequest(rawURL: string, timeoutMs: number, body?: string, signal?: AbortSignal): Promise<HttpResult> {
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
				if (size > 64 * 1024 * 1024) { request.destroy(new Error("BBT response exceeds 64 MiB limit")); return; }
				chunks.push(chunk);
			});
			response.on("error", reject);
			response.on("aborted", () => reject(new Error("BBT response aborted")));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
		});
		const timer = timers.setTimeout(() => request.destroy(new Error("BBT request timed out")), timeoutMs);
		request.on("close", () => timers.clearTimeout(timer));
		request.on("error", reject);
		request.end(body);
	});
}

export async function rpc(endpoint: string, method: string, params: unknown[], timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
	const response = await httpRequest(`${endpoint.replace(/\/$/, "")}/json-rpc`, timeoutMs, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal);
	if (response.status !== 200) throw new Error(`BBT HTTP ${response.status} for ${method}`);
	const parsed: unknown = JSON.parse(response.text);
	if (!record(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== 1) throw new Error(`Invalid BBT RPC envelope for ${method}`);
	if ("error" in parsed) throw new Error(`BBT RPC error for ${method}`);
	if (!("result" in parsed)) throw new Error(`Missing BBT RPC result for ${method}`);
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
