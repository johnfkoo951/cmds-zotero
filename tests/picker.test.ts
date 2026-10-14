import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { BbtService, formatWait, pickerAnswer, pickerReadiness, PickerWaitError } from "../src/bbt";
import { isBbtTransportError } from "../src/api/transport";
import { DEFAULT_SETTINGS } from "../src/types";
import { normalizeSettings } from "../src/settings-data";

// 0.6 OPT-14 / cayw-picker-wait-cancel: Zotero's citation picker waits with its own limit, apart from the request timeout.

interface Picker { probe?: string; probeStatus?: number; pickDelayMs?: number; pick?: string; pickStatus?: number }

async function picker(options: Picker): Promise<{ endpoint: string; urls: string[]; close: () => Promise<void> }> {
	const urls: string[] = [];
	const sockets = new Set<net.Socket>();
	const server = http.createServer((request, response) => {
		urls.push(request.url ?? "");
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.searchParams.get("probe") === "true") { response.statusCode = options.probeStatus ?? 200; response.end(options.probe ?? "ready"); return; }
		const timer = setTimeout(() => { response.statusCode = options.pickStatus ?? 200; response.end(options.pick ?? "[@doe2020]"); }, options.pickDelayMs ?? 0);
		request.on("close", () => clearTimeout(timer));
	});
	server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	return {
		endpoint: `http://127.0.0.1:${address.port}/better-bibtex`, urls,
		close: () => { for (const socket of sockets) socket.destroy(); return new Promise<void>(resolve => server.close(() => resolve())); },
	};
}

const service = (endpoint: string, over: Partial<typeof DEFAULT_SETTINGS> = {}): BbtService => new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: endpoint, requestTimeoutMs: 200, pickerWaitSeconds: 5, ...over });

test("pickerReadiness and pickerAnswer read BBT's replies; anything unexpected is a typed fault", () => {
	assert.equal(pickerReadiness(200, "ready\n", "e"), "ready");
	assert.equal(pickerReadiness(200, "starting", "e"), "starting");
	assert.throws(() => pickerReadiness(200, "<html>", "e"), (error: unknown) => isBbtTransportError(error) && error.reason === "invalid-response");
	assert.throws(() => pickerReadiness(404, "", "e"), (error: unknown) => isBbtTransportError(error) && error.reason === "http-404");
	assert.deepEqual(pickerAnswer(200, " [@doe2020, p. 4] \n", "e"), { kind: "picked", text: "[@doe2020, p. 4]" });
	assert.deepEqual(pickerAnswer(200, "  ", "e"), { kind: "empty" });
	assert.throws(() => pickerAnswer(500, "boom", "e"), (error: unknown) => isBbtTransportError(error) && error.reason === "http-other" && error.status === 500);
	assert.equal(formatWait(600), "10 minutes");
	assert.equal(formatWait(60), "1 minute");
	assert.equal(formatWait(45), "45 seconds");
});

test("a pick slower than the request timeout succeeds within the picker wait, after one readiness probe", async () => {
	const api = await picker({ pickDelayMs: 600 });
	const bbt = service(api.endpoint);
	try {
		assert.deepEqual(await bbt.pickCitation(), { kind: "picked", text: "[@doe2020]" });
		assert.equal(api.urls.length, 2);
		assert.equal(api.urls[0], "/better-bibtex/cayw?probe=true");
		assert.equal(api.urls[1], "/better-bibtex/cayw?format=pandoc&brackets=true");
		assert.equal(bbt.lastOutcome?.ok, true);
	} finally { bbt.dispose(); await api.close(); }
});

test("running out of the picker wait is a PickerWaitError and never a Better BibTeX failure", async () => {
	const api = await picker({ pickDelayMs: 5000 });
	const bbt = service(api.endpoint, { pickerWaitSeconds: 0.3 });
	try {
		await assert.rejects(bbt.pickCitation(), (error: unknown) => error instanceof PickerWaitError && /No citation was picked within 0\.3 seconds/.test(error.message));
		assert.equal(bbt.lastOutcome?.ok, true, "the probe's success stands; the wait is the person's, not Zotero's");
	} finally { bbt.dispose(); await api.close(); }
});

test("Cancel aborts the wait without recording a failure; nothing is left waiting", async () => {
	const api = await picker({ pickDelayMs: 5000 });
	const bbt = service(api.endpoint);
	const controller = new AbortController();
	try {
		const pick = bbt.pickCitation(controller.signal);
		setTimeout(() => controller.abort(), 100);
		await assert.rejects(pick, (error: unknown) => isBbtTransportError(error) && error.reason === "aborted");
		assert.equal(bbt.lastOutcome?.ok, true);
	} finally { bbt.dispose(); await api.close(); }
});

test("a starting Zotero is told apart without opening the picker; a closed picker is an empty answer", async () => {
	const starting = await picker({ probe: "starting" });
	const bbt = service(starting.endpoint);
	try {
		await assert.rejects(bbt.pickCitation(), (error: unknown) => error instanceof PickerWaitError && /still starting/.test(error.message));
		assert.equal(starting.urls.length, 1, "only the probe");
	} finally { bbt.dispose(); await starting.close(); }
	const empty = await picker({ pick: "" });
	const second = service(empty.endpoint);
	try { assert.deepEqual(await second.pickCitation(), { kind: "empty" }); }
	finally { second.dispose(); await empty.close(); }
});

test("a closed Zotero fails fast at the probe and is recorded; the picker wait setting is bounded", async () => {
	const api = await picker({});
	const endpoint = api.endpoint;
	await api.close();
	const bbt = service(endpoint);
	try {
		await assert.rejects(bbt.pickCitation(), (error: unknown) => isBbtTransportError(error) && error.reason === "connection-refused");
		assert.equal(bbt.lastOutcome?.ok, false);
		assert.equal(bbt.lastOutcome?.reason, "connection-refused");
	} finally { bbt.dispose(); }
	assert.equal(normalizeSettings({}).pickerWaitSeconds, 600);
	assert.equal(normalizeSettings({ pickerWaitSeconds: 5 }).pickerWaitSeconds, 600, "out of range falls back to the default");
	assert.equal(normalizeSettings({ pickerWaitSeconds: 1800 }).pickerWaitSeconds, 1800);
});
