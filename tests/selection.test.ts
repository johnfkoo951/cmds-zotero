import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { EMPTY_SELECTION_MESSAGE, parseSelection, planSelection, selectedId, selectionCitation, unindexedMessage } from "../src/library/selection";
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

// 0.6.1 zotero-selection-commands: matching a selection to the saved index and the citation it cites.
const sel = (libraryID: number, itemKey: string, citekey = `key${itemKey}`) => ({ libraryID, itemKey, citekey, title: "", itemType: "journalArticle" });
const entry = (id: string, citekey: string) => ({ id, citekey });

test("planSelection matches by library ID and item key only, in Zotero's order", () => {
	const entries = [entry("1:AAAA0001", "doe2020"), entry("2:AAAA0001", "doe2020"), entry("1:BBBB0002", "roe2021")];
	assert.deepEqual(planSelection(entries, []), { kind: "empty" });
	const one = planSelection(entries, [sel(2, "AAAA0001")]);
	assert.equal(one.kind, "one");
	assert.equal(one.kind === "one" && one.entry.id, "2:AAAA0001", "the same item key in two libraries resolves by library, never to the first match");
	const several = planSelection(entries, [sel(1, "BBBB0002"), sel(1, "AAAA0001")]);
	assert.ok(several.kind === "several");
	assert.deepEqual(several.entries.map(e => e.id), ["1:BBBB0002", "1:AAAA0001"]);
	assert.deepEqual(several.unindexed, []);
});

test("planSelection keeps unknown items apart and never matches by citekey", () => {
	const entries = [entry("1:AAAA0001", "doe2020")];
	const unknown = planSelection(entries, [sel(1, "ZZZZ0009", "doe2020")]);
	assert.equal(unknown.kind, "unindexed", "a citekey shared with an indexed entry does not make an unknown item known");
	assert.deepEqual(unknown.kind === "unindexed" && unknown.unindexed.map(selectedId), ["1:ZZZZ0009"]);
	const mixed = planSelection(entries, [sel(1, "ZZZZ0009"), sel(1, "AAAA0001")]);
	assert.ok(mixed.kind === "one");
	assert.deepEqual(mixed.unindexed.map(selectedId), ["1:ZZZZ0009"]);
	const duplicated = planSelection([entry("1:AAAA0001", "a"), entry("1:AAAA0001", "b")], [sel(1, "AAAA0001")]);
	assert.equal(duplicated.kind, "unindexed", "an id the index holds twice is not resolved to either copy");
});

test("an attachment or note selection is no selection; the empty message says so", () => {
	const body = JSON.stringify({ items: [item("ATTA0001", { itemType: "attachment" }), item("NOTE0001", { itemType: "note" })] });
	assert.deepEqual(planSelection([entry("1:ATTA0001", "x")], parseSelection(200, body, "e")), { kind: "empty" });
	assert.deepEqual(planSelection([], parseSelection(404, "no selection", "e")), { kind: "empty" });
	assert.match(EMPTY_SELECTION_MESSAGE, /Nothing is selected in Zotero/);
});

test("selectionCitation and unindexedMessage", () => {
	assert.equal(selectionCitation([]), "");
	assert.equal(selectionCitation([{ citekey: "doe2020" }]), "[@doe2020]");
	assert.equal(selectionCitation([{ citekey: "doe2020" }, { citekey: "kim2021" }, { citekey: "doe2020" }]), "[@doe2020; @kim2021]");
	assert.equal(selectionCitation([{ citekey: "김2021" }]), "[@김2021]");
	assert.equal(unindexedMessage([]), "");
	assert.equal(unindexedMessage([{ citekey: "a" }]), "1 selected item is not in the saved index yet (@a). Refresh the citekey index, then retry.");
	assert.match(unindexedMessage([{ citekey: "a" }, { citekey: "b" }, { citekey: "c" }, { citekey: "d" }, { citekey: "e" }]), /^5 selected items are not in the saved index yet \(@a, @b, @c and 2 more\)/);
});
