import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { parseSelection, selectedId } from "../src/library/selection";
import { BbtService } from "../src/bbt";
import { isBbtTransportError } from "../src/api/transport";
import { DEFAULT_SETTINGS } from "../src/types";

// 0.6.1: the Zotero library-pane selection, read on demand through BBT's export of it. Synthetic records only.
const item = (itemKey: string, over: Record<string, unknown> = {}) => ({ libraryID: 1, itemKey, citationKey: `key${itemKey}`, title: `Title ${itemKey}`, itemType: "journalArticle", ...over });

test("parseSelection keeps regular items once, in Zotero's order, and skips children and unmatched rows", () => {
	const body = JSON.stringify({ config: {}, items: [
		item("BBBB0002"), item("AAAA0001", { libraryID: 2 }), item("BBBB0002"),
		item("NOTE0001", { itemType: "note" }), item("ATTA0001", { itemType: "attachment" }),
		item("short"), item("NOKEY001", { citationKey: "" }), item("NOLIB001", { libraryID: 0 }), "junk",
	] });
	const selected = parseSelection(200, body, "e");
	assert.deepEqual(selected.map(selectedId), ["1:BBBB0002", "2:AAAA0001"]);
	assert.deepEqual(selected[0], { libraryID: 1, itemKey: "BBBB0002", citekey: "keyBBBB0002", title: "Title BBBB0002", itemType: "journalArticle" });
});

test("an empty selection is []; a missing endpoint, another status or an unreadable body is a typed fault", () => {
	assert.deepEqual(parseSelection(404, "no selection", "e"), []);
	assert.throws(() => parseSelection(404, "Not found", "e"), (error: unknown) => isBbtTransportError(error) && error.reason === "http-404");
	assert.throws(() => parseSelection(500, "boom", "e"), (error: unknown) => isBbtTransportError(error) && error.reason === "http-other" && error.status === 500);
	assert.throws(() => parseSelection(200, "<html>", "e"), (error: unknown) => isBbtTransportError(error) && error.reason === "invalid-response");
	assert.throws(() => parseSelection(200, "{}", "e"), (error: unknown) => isBbtTransportError(error) && error.reason === "invalid-response");
});

test("BbtService.selectedItems reads the selection export once and records the outcome", async () => {
	let answer: { status: number; body: string } = { status: 200, body: JSON.stringify({ items: [item("CCCC0003")] }) };
	const urls: string[] = [];
	const server = http.createServer((request, response) => { urls.push(request.url ?? ""); response.statusCode = answer.status; response.end(answer.body); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const bbt = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: `http://127.0.0.1:${address.port}/better-bibtex`, requestTimeoutMs: 1000 });
	try {
		assert.deepEqual((await bbt.selectedItems()).map(selectedId), ["1:CCCC0003"]);
		assert.deepEqual(urls, ["/better-bibtex/export/selected?jzon"]);
		assert.equal(bbt.lastOutcome?.ok, true);
		answer = { status: 404, body: "no selection" };
		assert.deepEqual(await bbt.selectedItems(), []);
		answer = { status: 404, body: "Not found" };
		await assert.rejects(bbt.selectedItems(), (error: unknown) => isBbtTransportError(error) && error.reason === "http-404");
		assert.equal(bbt.lastOutcome?.ok, false);
	} finally { bbt.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
