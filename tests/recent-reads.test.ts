import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { BbtService } from "../src/bbt";
import { DEFAULT_SETTINGS, type ZoteroIndexEntry } from "../src/types";
import { normalizeAttachments, normalizeEntry } from "../src/api/normalize";
import { entryHash } from "../src/identity";
import { ownerMarker } from "../src/note-writer";
import {
	addDays, clampRecentDays, dayTerms, daysBetween, describeNoteStatus, describeSendOutcome, indexEntryFor, literatureNoteStatus, localDay, needsSending,
	noteAnnotationIDs, orderRecent, parseRecentItem, readLabel, readNoteTexts, recentKey, sendOutcome, windowTerms,
} from "../src/recent/recent-reads";

// Synthetic records only (AGENTS.md): no real library data.
const row = (itemKey: string, citekey: string, title: string, group?: number): Record<string, unknown> => ({
	id: group ? `http://zotero.org/groups/${group}/items/${itemKey}` : `http://zotero.org/users/local/Example/items/${itemKey}`,
	type: "article-journal", title, issued: { "date-parts": [[2026, 3]] }, author: [{ family: "Author", given: "Example" }, { literal: "Synthetic Consortium" }],
	citekey, library: group ? "Synthetic group" : "My Library",
});
const parent = (citationKey = "Example2026", itemKey = "ABCD2345") => ({
	libraryID: 1, citationKey, itemKey, uri: `http://zotero.org/users/local/Example/items/${itemKey}`, itemType: "journalArticle", title: "Synthetic example",
	date: "2026", creators: [{ firstName: "Example", lastName: "Author" }], tags: [], attachments: [{ select: "zotero://select/library/items/EFGH2345", title: "Synthetic PDF" }], notes: [],
});
const annotation = (key: string, extra: Record<string, unknown> = {}) => ({ key, parentItem: "EFGH2345", annotationType: "highlight", annotationText: `Synthetic text ${key}`, annotationComment: "", annotationColor: "#ffd400", annotationPageLabel: "1", annotationPosition: { pageIndex: 0, rects: [] }, tags: [], dateModified: "2026-03-01T10:00:00Z", version: 1, ...extra });
const attachments = (keys: string[]) => [{ open: "zotero://open-pdf/library/items/EFGH2345", path: "/synthetic/example.pdf", annotations: keys.map(key => annotation(key)) }];
function entryWith(keys: string[]): ZoteroIndexEntry {
	const entry = normalizeEntry(parent());
	entry.attachments = normalizeAttachments(attachments(keys), entry);
	entry.attachmentPath = "/synthetic/example.pdf";
	entry.contentHash = entryHash(entry);
	return entry;
}

async function serve(handler: (call: { method: string; params: unknown[] }) => unknown): Promise<{ endpoint: string; calls: { method: string; params: unknown[] }[]; close: () => Promise<void> }> {
	const calls: { method: string; params: unknown[] }[] = [];
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", chunk => { body += String(chunk); });
		request.on("end", () => {
			const call = JSON.parse(body) as { method: string; params: unknown[] };
			calls.push(call);
			let payload: unknown;
			try { payload = { jsonrpc: "2.0", id: 1, result: handler(call) }; }
			catch (error) { payload = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: error instanceof Error ? error.message : "error" } }; }
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(payload));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	return { endpoint: `http://127.0.0.1:${address.port}/better-bibtex`, calls, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test("calendar helpers use local days and survive month and year boundaries", () => {
	assert.equal(localDay(new Date(2026, 9, 12, 0, 30)), "2026-10-12");
	assert.equal(addDays("2026-03-01", -1), "2026-02-28");
	assert.equal(addDays("2024-03-01", -1), "2024-02-29");
	assert.equal(addDays("2026-01-01", -1), "2025-12-31");
	assert.equal(daysBetween("2026-10-12", "2026-09-22"), 20);
	assert.equal(daysBetween("2026-10-12", "2026-10-12"), 0);
	assert.throws(() => addDays("2026-13-01x", 1));
	assert.throws(() => dayTerms("yesterday"));
});

test("window terms clamp to 1..365 days and map the attachment condition to the parent item", () => {
	assert.deepEqual(windowTerms(30), [["resultLevel", "item"], ["lastRead", "isInTheLast", "30 days"]]);
	assert.deepEqual(windowTerms(9999)[1], ["lastRead", "isInTheLast", "365 days"]);
	assert.equal(clampRecentDays(0), 30);
	assert.equal(clampRecentDays("7"), 7);
	assert.equal(clampRecentDays(2.5), 30);
	assert.deepEqual(dayTerms("2026-09-22"), [["resultLevel", "item"], ["lastRead", "is", "2026-09-22"]]);
});

test("search rows parse into recent reads; standalone attachments and unparsable rows are skipped", () => {
	const user = parseRecentItem(row("ABCD2345", "Example2026", "Synthetic title"));
	assert.deepEqual(user, { libraryType: "user", itemKey: "ABCD2345", library: "My Library", citekey: "Example2026", title: "Synthetic title", year: "2026", authors: ["Author, Example", "Synthetic Consortium"] });
	const group = parseRecentItem(row("WXYZ2345", "Grouped2026", "Group title", 12345));
	assert.equal(group?.libraryType, "group");
	assert.equal(group?.groupID, 12345);
	assert.equal(parseRecentItem({ ...row("EFGH2345", "", "PDF"), citekey: "" }), null, "a standalone PDF has no citekey and cannot become a literature note");
	assert.equal(parseRecentItem({ id: "not a uri", citekey: "X" }), null);
	assert.equal(parseRecentItem("nope"), null);
	assert.equal(parseRecentItem({ ...row("ABCD2345", "Example2026", "T"), issued: { literal: "Spring 2025" } })?.year, "2025");
	assert.notEqual(recentKey(user ?? { itemKey: "", libraryType: "user" }), recentKey(group ?? { itemKey: "", libraryType: "group" }));
});

test("recent rows sort newest first with undated rows last and get relative labels", () => {
	const rows = [
		{ citekey: "b", title: "B", readOn: "2026-09-15" },
		{ citekey: "c", title: "C", readOn: null },
		{ citekey: "a", title: "A", readOn: "2026-09-22" },
		{ citekey: "d", title: "A", readOn: "2026-09-15" },
	];
	assert.deepEqual(orderRecent(rows).map(item => item.citekey), ["a", "d", "b", "c"]);
	assert.equal(readLabel("2026-10-12", "2026-10-12"), "read today");
	assert.equal(readLabel("2026-10-11", "2026-10-12"), "read yesterday");
	assert.equal(readLabel("2026-10-02", "2026-10-12"), "read 10 days ago");
	assert.equal(readLabel("2026-09-22", "2026-10-12"), "read on 2026-09-22");
	assert.equal(readLabel(null, "2026-10-12"), "read recently");
});

test("recent rows map to index entries by item key and library scope only", () => {
	const entry = entryWith([]);
	assert.equal(indexEntryFor({ itemKey: "ABCD2345", libraryType: "user" }, [entry]), entry);
	assert.equal(indexEntryFor({ itemKey: "ABCD2345", libraryType: "group", groupID: 12345 }, [entry]), null, "same key in another library is a different item");
	assert.equal(indexEntryFor({ itemKey: "ZZZZ2345", libraryType: "user" }, [entry]), null);
});

test("note status compares annotation blocks without contacting Zotero", () => {
	const entry = entryWith(["JKLM2345", "NPQR2345", "STUV2345"]);
	const owner = ownerMarker(entry.id);
	const block = (key: string, hash = "a".repeat(64)) => `<!-- cmds-zotero:annotation-EFGH2345-${key}:${hash} -->\nbody\n<!-- /cmds-zotero:annotation-EFGH2345-${key} -->`;
	const detached = (key: string) => `<!-- cmds-zotero:annotation-EFGH2345-${key}:detached -->\nmine\n<!-- /cmds-zotero:annotation-EFGH2345-${key} -->`;

	assert.deepEqual(literatureNoteStatus(entry, []), { state: "none", path: null, missing: 3, orphaned: 0, annotations: 3 });
	assert.equal(literatureNoteStatus(entry, [{ path: "a.md", text: owner }, { path: "b.md", text: owner }]).state, "duplicate");
	assert.equal(literatureNoteStatus(entry, [{ path: "a.md", text: block("JKLM2345") }]).state, "foreign", "no owner marker: never treated as ours");

	const behind = literatureNoteStatus(entry, [{ path: "n.md", text: `${owner}\n${block("JKLM2345")}\n${detached("NPQR2345")}\n${block("GONE2345")}` }]);
	assert.deepEqual(behind, { state: "behind", path: "n.md", missing: 1, orphaned: 1, annotations: 3 }, "a detached block counts as present; a block for a deleted annotation is orphaned");
	assert(needsSending(behind));
	assert.match(describeNoteStatus(behind), /^1 new annotation not in the note; 1 block for annotations deleted in Zotero kept$/);

	const current = literatureNoteStatus(entry, [{ path: "n.md", text: `${owner}\n${["JKLM2345", "NPQR2345", "STUV2345"].map(key => block(key)).join("\n")}` }]);
	assert.equal(current.state, "current");
	assert(!needsSending(current));
	assert.equal(noteAnnotationIDs("<!-- cmds-zotero:annotation-EFGH2345-JKLM2345:nothex -->").size, 0, "malformed markers are not counted");
});

test("recentlyRead dates every item with exact-day probes and stops once all are dated", async () => {
	const readOn: Record<string, string> = { ABCD2345: "2026-10-10", WXYZ2345: "2026-10-12", KLMN2345: "2026-09-30" };
	const rows = [row("ABCD2345", "Example2026", "Second"), row("WXYZ2345", "Grouped2026", "First", 12345), row("KLMN2345", "Third2026", "Third"), { ...row("EFGH2345", "", "Standalone PDF"), citekey: "" }];
	const bbt = await serve(call => {
		assert.equal(call.method, "item.search");
		const terms = call.params[0] as unknown[][];
		assert.deepEqual(terms[0], ["resultLevel", "item"]);
		const [, operator, value] = terms[1] as [string, string, string];
		if (operator === "isInTheLast") return rows;
		assert.equal(operator, "is");
		return rows.filter(item => readOn[String(item.id).slice(-8)] === value);
	});
	try {
		const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: bbt.endpoint });
		const recent = await service.recentlyRead(30, { now: new Date(2026, 9, 12, 9) });
		assert.deepEqual(recent.map(item => [item.citekey, item.readOn]), [["Grouped2026", "2026-10-12"], ["Example2026", "2026-10-10"], ["Third2026", "2026-09-30"]]);
		const dayProbes = bbt.calls.filter(call => (call.params[0] as unknown[][])[1][1] === "is").length;
		assert.equal(dayProbes, 14, "two 7-day batches reach 2026-09-30; no further days are probed");
		service.dispose();
	} finally { await bbt.close(); }
});

test("recentlyRead with nothing read in the window makes exactly one search", async () => {
	const bbt = await serve(() => []);
	try {
		const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: bbt.endpoint });
		assert.deepEqual(await service.recentlyRead(365), []);
		assert.equal(bbt.calls.length, 1);
		service.dispose();
	} finally { await bbt.close(); }
});

test("collectEntry reads one item fresh, follows a citekey renamed in Zotero, and refuses another item", async () => {
	let renamed = false;
	const bbt = await serve(call => {
		if (call.method === "item.export") {
			const [keys] = call.params as [string[]];
			if (keys[0] === "Example2026" && !renamed) return JSON.stringify({ items: [parent()] });
			if (keys[0] === "Renamed2026" && renamed) return JSON.stringify({ items: [parent("Renamed2026")] });
			if (keys[0] === "Other2026") return JSON.stringify({ items: [parent("Other2026", "QQQQ2345")] });
			throw new Error(`not found: ${keys[0]}`);
		}
		if (call.method === "item.search") return renamed ? [row("ABCD2345", "Renamed2026", "Synthetic example")] : [row("ABCD2345", "Example2026", "Synthetic example")];
		if (call.method === "item.attachments") return attachments(["JKLM2345", "NPQR2345"]);
		throw new Error("unexpected method");
	});
	try {
		const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: bbt.endpoint });
		const target = { citekey: "Example2026", libraryID: 1, itemKey: "ABCD2345", libraryType: "user" as const };
		const fresh = await service.collectEntry(target);
		assert.equal(fresh.attachments[0].annotations.length, 2);
		assert.equal(fresh.attachmentStatus, "complete");
		assert.deepEqual(bbt.calls.map(call => call.method), ["item.export", "item.attachments"]);

		renamed = true;
		const previous = entryWith([]);
		const followed = await service.collectEntry(target, previous);
		assert.equal(followed.citekey, "Renamed2026");
		assert.deepEqual(followed.citekeyHistory, ["Example2026"], "the old citekey stays resolvable");

		const reassigned = await service.collectEntry({ ...target, citekey: "Other2026" });
		assert.equal(reassigned.itemKey, "ABCD2345", "a citekey now owned by another item is never followed to that item");
		assert.equal(reassigned.citekey, "Renamed2026");
		service.dispose();
	} finally { await bbt.close(); }
});

test("contradictory Better BibTeX answers are refused instead of returning another item", async () => {
	const bbt = await serve(call => {
		if (call.method === "item.export") return JSON.stringify({ items: [parent("Example2026", "QQQQ2345")] });
		if (call.method === "item.search") return [row("ABCD2345", "Example2026", "Synthetic example")];
		throw new Error("unexpected method");
	});
	try {
		const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: bbt.endpoint });
		await assert.rejects(service.collectEntry({ citekey: "Example2026", libraryID: 1, itemKey: "ABCD2345", libraryType: "user" }), /different Zotero item/);
		service.dispose();
	} finally { await bbt.close(); }
});

test("an unknown citekey without a matching item key is reported, not guessed", async () => {
	const bbt = await serve(call => {
		if (call.method === "item.export") throw new Error("not found: Gone2026");
		if (call.method === "item.search") return [];
		throw new Error("unexpected method");
	});
	try {
		const service = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: bbt.endpoint });
		await assert.rejects(service.collectEntry({ citekey: "Gone2026", libraryID: 1, itemKey: "ABCD2345", libraryType: "user" }), /no longer has item ABCD2345/);
		service.dispose();
	} finally { await bbt.close(); }
});

// 0.6 PERF-12: recent rows resolve through the per-generation item-key and id maps, with the 0.5.0 results.
import { recentFirst } from "../src/recent/recent-reads";

/** 0.5.0 `indexEntryFor`: a scan of every entry per read. */
function indexEntryFor050(read: { itemKey: string; libraryType: string; groupID?: number }, entries: readonly ZoteroIndexEntry[]): ZoteroIndexEntry | null {
	return entries.find(entry => entry.itemKey === read.itemKey && entry.libraryType === read.libraryType && (entry.groupID ?? 0) === (read.groupID ?? 0)) ?? null;
}

/** 0.5.0 picker ordering (`pick()` in main.ts). */
function pickOrder050(entries: ZoteroIndexEntry[], reads: { itemKey: string; libraryType: "user" | "group"; groupID?: number; readOn: string | null }[]): { ordered: ZoteroIndexEntry[]; readOn: Map<string, string | null> } {
	const readOn = new Map<string, string | null>();
	for (const read of reads) {
		const entry = indexEntryFor050(read, entries);
		if (entry && !readOn.has(entry.id)) readOn.set(entry.id, read.readOn);
	}
	const recent = [...readOn.keys()].flatMap(id => entries.filter(entry => entry.id === id));
	return { ordered: [...recent, ...entries.filter(entry => !readOn.has(entry.id))], readOn };
}

function libraryEntries(): ZoteroIndexEntry[] {
	const base = entryWith([]);
	const make = (libraryID: number, itemKey: string, group?: number): ZoteroIndexEntry => ({ ...base, id: `${libraryID}:${itemKey}`, libraryID, itemKey, libraryType: group === undefined ? "user" : "group", ...(group === undefined ? {} : { groupID: group }), citekey: `c${libraryID}${itemKey}` });
	const entries: ZoteroIndexEntry[] = [];
	for (let i = 0; i < 40; i++) {
		const key = `K${String(i % 15).padStart(3, "0")}2345`;
		entries.push(i % 3 === 0 ? make(2, `${key.slice(0, 4)}${i}`.padEnd(8, "Z").slice(0, 8), 4242) : i % 3 === 1 ? make(1, key) : make(3 + (i % 2), key, 900 + (i % 2)));
	}
	// The same key in the user library and in two groups; a group whose ID collides with "no group" (0) is not the user library.
	entries.push(make(5, "SAME2345", 7), make(1, "SAME2345"), make(6, "SAME2345", 8), make(7, "ZERO2345", 0));
	return entries;
}

test("0.6 PERF-12: indexEntryFor through the item-key map returns the 0.5.0 entry for every library scope", () => {
	const entries = libraryEntries();
	const reads = [
		...entries.map(entry => ({ itemKey: entry.itemKey, libraryType: entry.libraryType, ...(entry.groupID === undefined ? {} : { groupID: entry.groupID }) })),
		{ itemKey: "SAME2345", libraryType: "group", groupID: 8 }, { itemKey: "SAME2345", libraryType: "group" }, { itemKey: "SAME2345", libraryType: "user", groupID: 0 },
		{ itemKey: "ZERO2345", libraryType: "user" }, { itemKey: "ZERO2345", libraryType: "group" }, { itemKey: "ZERO2345", libraryType: "group", groupID: 0 },
		{ itemKey: "NONE2345", libraryType: "user" }, { itemKey: "K0012345", libraryType: "group", groupID: 900 }, { itemKey: "K0012345", libraryType: "group", groupID: 901 },
	];
	for (const read of reads) assert.equal(indexEntryFor(read, entries), indexEntryFor050(read, entries), JSON.stringify(read));
	assert.equal(indexEntryFor({ itemKey: "ZERO2345", libraryType: "group" }, entries)?.id, "7:ZERO2345", "groupID 0 and an absent groupID compare equal, as before");
});

test("0.6 PERF-12: recentFirst orders the picker exactly as 0.5.0 did: recent reads first, once each, then index order", () => {
	const entries = libraryEntries();
	const reads = [
		{ itemKey: "SAME2345", libraryType: "group" as const, groupID: 8, readOn: "2026-10-12" },
		{ itemKey: "NONE2345", libraryType: "user" as const, readOn: "2026-10-12" },
		{ itemKey: "K0042345", libraryType: "user" as const, readOn: "2026-10-11" },
		{ itemKey: "SAME2345", libraryType: "group" as const, groupID: 8, readOn: "2026-10-01" },
		{ itemKey: "K0052345", libraryType: "group" as const, groupID: 901, readOn: null },
		{ itemKey: "SAME2345", libraryType: "user" as const, readOn: "2026-09-30" },
	];
	const expected = pickOrder050(entries, reads);
	const actual = recentFirst(entries, reads);
	assert.deepEqual(actual.ordered.map(entry => entry.id), expected.ordered.map(entry => entry.id));
	actual.ordered.forEach((entry, index) => assert.equal(entry, expected.ordered[index]));
	assert.deepEqual([...actual.readOn], [...expected.readOn]);
	assert.deepEqual([...actual.readOn.values()], ["2026-10-12", "2026-10-11", null, "2026-09-30"], "the first read of an entry keeps its day");
	assert.deepEqual(recentFirst(entries, []).ordered, entries);
	assert.equal(recentFirst(entries, reads).ordered.length, entries.length, "every entry is listed once");
});

test("0.6 STRUCT-02: sendOutcome maps a preview and its apply result exactly as both send paths did", () => {
	const result = (extra: Partial<{ path: string; conflicts: string[]; changed: boolean; preserved: string[] }> = {}) => ({ path: "Lit/@a.md", conflicts: [], changed: true, preserved: [], ...extra });
	assert.deepEqual(sendOutcome({ exists: false }, result()), { status: "created", path: "Lit/@a.md", preserved: [] });
	assert.deepEqual(sendOutcome({ exists: true }, result()), { status: "updated", path: "Lit/@a.md", preserved: [] });
	assert.deepEqual(sendOutcome({ exists: true }, result({ changed: false, preserved: ["notes"] })), { status: "unchanged", path: "Lit/@a.md", preserved: ["notes"] });
	assert.deepEqual(sendOutcome({ exists: true }, result({ conflicts: ["Note changed after preview", "again"], preserved: ["notes"] })), { status: "refused", path: "Lit/@a.md", preserved: [], message: "Note changed after preview; again" });
	assert.equal(describeSendOutcome(sendOutcome({ exists: true }, result({ preserved: ["notes", "overview"] }))), "Updated Lit/@a.md; your edits kept in 2 sections");
	const preserved = ["x"];
	const outcome = sendOutcome({ exists: true }, result({ preserved }));
	preserved.push("y");
	assert.deepEqual(outcome.preserved, ["x"], "the outcome owns its list");
});

test("0.6 STRUCT-02: readNoteTexts reads every note concurrently and keeps the input order", async () => {
	const order: string[] = [];
	const texts = await readNoteTexts([{ path: "b.md", delay: 2 }, { path: "a.md", delay: 0 }], async file => {
		for (let i = 0; i < file.delay; i++) await new Promise(resolve => setImmediate(resolve));
		order.push(file.path);
		return `text of ${file.path}`;
	});
	assert.deepEqual(texts, [{ path: "b.md", text: "text of b.md" }, { path: "a.md", text: "text of a.md" }]);
	assert.deepEqual(order, ["a.md", "b.md"], "reads overlap");
	assert.deepEqual(await readNoteTexts([], async () => "never"), []);
});
