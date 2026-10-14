import test from "node:test";
import assert from "node:assert/strict";
import { validateActionRequest, AGENT_ACTIONS, ACTION_API_VERSION } from "../src/agent/actions";
import { CITING_MAX_NOTES, CITING_MAX_POSITIONS, citingKeys, excerptAround, sortCitingNotes, type CitingNote } from "../src/agent/citing";
import { IngestAPI, JOB_TIMEOUT_MS } from "../src/ingest-api";
import { host, JONES, run, SMITH, SMITH_GROUP, REUSED } from "./agent-fixtures";

// Synthetic records only.

const NOTE_A = [
	"---",
	"type: synthesis",
	"citekey: own2024",
	"cites: [smith2020, jones2019]",
	"evidenceFor: \"claim [@smithOld2020]\"",
	"---",
	"# Heading",
	"",
	"First paragraph cites [@smith2020] in text.",
	"Narrative @smithOld2020 says more, and mail-me@smith2020.com is not a citation.",
	"",
	"```",
	"[@smith2020] inside a fence is skipped",
	"```",
	"",
	"## References",
	"",
	"- [@smith2020] Smith (2020)",
].join("\n");
const NOTE_B = "Plain note\nSee [[@smith2020]] and [[@smith2020|alias]] on one line, plus -@smith2020 here.\n";
const NOTE_C = "Only [@jones2019] here, and a lookalike [@smith2020x] key.\n";
const NOTES = { "Notes/A.md": NOTE_A, "Notes/B.md": NOTE_B, "Notes/C.md": NOTE_C };

test("citing is a contract-2 action the live host advertises", () => {
	assert.ok(AGENT_ACTIONS.includes("citing"));
	assert.equal(ACTION_API_VERSION.citing, 2);
	assert.ok(JOB_TIMEOUT_MS.citing > 0);
	assert.ok(new IngestAPI(null as never, null as never, null as never, null as never, async () => {}).actions.includes("citing"));
});

test("positions: one-based line and column, the syntax form and the line as excerpt; notes with the most citations first", async () => {
	const result = await run("citing", { citekey: "smith2020" }, { notes: NOTES });
	assert.equal(result.ok, true);
	assert.equal(result.action, "citing");
	assert.equal(result.status, "resolved");
	assert.equal(result.item.id, "1:ABCD2345");
	assert.deepEqual(result.notes.map((note: CitingNote) => [note.path, note.count]), [["Notes/A.md", 4], ["Notes/B.md", 3]]);
	const [a, b] = result.notes;
	const lines = NOTE_A.split("\n");
	assert.deepEqual(a.citations, [
		{ key: "smith2020", line: 9, column: lines[8].indexOf("@smith2020") + 1, form: "pandoc", excerpt: lines[8] },
		{ key: "smithOld2020", line: 10, column: lines[9].indexOf("@smithOld2020") + 1, form: "bare", excerpt: lines[9] },
	]);
	assert.deepEqual(a.frontmatter, [{ key: "smith2020", field: "cites", form: "bare" }, { key: "smithOld2020", field: "evidenceFor", form: "pandoc" }]);
	assert.equal(a.frontmatterCount, 2);
	assert.equal(a.basename, "A");
	assert.equal(a.uri, "obsidian://open?vault=Research&file=Notes%2FA");
	assert.deepEqual(b.citations.map((hit: any) => [hit.line, hit.form]), [[2, "wikilink"], [2, "wikilink"], [2, "bare"]]);
	assert.deepEqual(b.frontmatter, []);
	assert.deepEqual(result.summary, { notes: 2, listed: 2, citations: 7, frontmatterCitations: 2, scanned: 3, truncated: false });
	assert.deepEqual(result.scan, { skipped: [], truncated: false, complete: true });
});

test("fenced code, mail-like tokens, the References section, the note's own frontmatter key and lookalike keys are not citations", async () => {
	const result = await run("citing", { citekey: "smith2020" }, { notes: NOTES });
	const hits = result.notes.flatMap((note: CitingNote) => note.citations);
	assert.ok(hits.every((hit: any) => hit.line !== 13 && hit.line !== 18), "the fence on line 13 and the References entry on line 18 are skipped");
	assert.equal(result.notes.some((note: CitingNote) => note.path === "Notes/C.md"), false, "[@smith2020x] is another key");
	const own = await run("citing", { citekey: "jones2019" }, { notes: { "Notes/Own.md": "---\ncitekey: jones2019\ncites: [jones2019]\n---\nBody without citations.\n", ...NOTES } });
	assert.deepEqual(own.notes.map((note: CitingNote) => note.path), ["Notes/A.md", "Notes/C.md"], "Own.md names jones2019 only as its own citekey, which is not a citation of itself");
});

test("former citekeys count: the keys searched are listed with their kind", async () => {
	const result = await run("citing", { citekey: "smithOld2020" }, { notes: NOTES });
	assert.equal(result.status, "resolved");
	assert.equal(result.matchedHistory, true);
	assert.deepEqual(result.keys, { searched: [{ key: "smith2020", kind: "current" }, { key: "smithOld2020", kind: "former" }], excluded: [] });
	assert.equal(result.notes[0].path, "Notes/A.md");
	assert.ok(result.notes[0].citations.some((hit: any) => hit.key === "smithOld2020"));
});

test("a key another item also carries is excluded and reported, never attributed", async () => {
	const reused = await run("citing", { itemKey: "ABCD2345", libraryID: 1 }, { notes: NOTES, entries: [SMITH, REUSED, JONES] });
	assert.deepEqual(reused.keys.searched, [{ key: "smith2020", kind: "current" }]);
	assert.deepEqual(reused.keys.excluded, [{ key: "smithOld2020", kind: "former", reason: "shared", sharedWith: [{ id: "1:REUS2345", citekey: "smithOld2020", libraryID: 1 }] }]);
	const a = reused.notes.find((note: CitingNote) => note.path === "Notes/A.md");
	assert.deepEqual(a.citations.map((hit: any) => hit.key), ["smith2020"], "@smithOld2020 on line 10 is not counted for this item");
	assert.deepEqual(a.frontmatter, [{ key: "smith2020", field: "cites", form: "bare" }]);
	// The same citekey in another library: the current key is shared, so only the former key is searched.
	const shared = await run("citing", { itemKey: "ABCD2345", libraryID: 1 }, { notes: NOTES, entries: [SMITH, SMITH_GROUP] });
	assert.deepEqual(shared.keys.searched, [{ key: "smithOld2020", kind: "former" }]);
	assert.equal(shared.keys.excluded[0].key, "smith2020");
	assert.equal(shared.keys.excluded[0].sharedWith[0].id, "2:GRPS2345");
	assert.deepEqual(shared.notes.map((note: CitingNote) => note.path), ["Notes/A.md"]);
	const none = await run("citing", { itemKey: "GRPS2345", libraryID: 2 }, { notes: NOTES, entries: [SMITH, SMITH_GROUP] });
	assert.deepEqual(none.keys.searched, []);
	assert.deepEqual(none.notes, [], "nothing can be attributed when every key is shared");
});

test("selector outcomes: ambiguous never picks one; not-found is withheld on a stale index; a missing index fails", async () => {
	const ambiguous = await run("citing", { citekey: "smith2020" }, { notes: NOTES, entries: [SMITH, SMITH_GROUP] });
	assert.equal(ambiguous.ok, true);
	assert.equal(ambiguous.status, "ambiguous");
	assert.equal(ambiguous.notes, undefined);
	assert.equal(ambiguous.ranked.length, 2);
	assert.equal((await run("citing", { citekey: "nobody1999" }, { notes: NOTES })).status, "not-found");
	const stale = await run("citing", { citekey: "nobody1999" }, { notes: NOTES, ageMinutes: 600 });
	assert.equal(stale.reason, "stale-index");
	assert.equal(stale.indexAnswer, "not-found");
	assert.equal((await run("citing", { citekey: "nobody1999", allowStale: true }, { notes: NOTES, ageMinutes: 600 })).status, "not-found");
	const missing = await run("citing", { citekey: "smith2020" }, { extra: { indexView: null, indexFailure: { reason: "index-missing", message: "No validated Zotero index" } } });
	assert.equal(missing.reason, "index-missing");
	const doi = await run("citing", { doi: "10.1/none" }, { notes: NOTES });
	assert.equal(doi.status, "not-found");
});

test("an incomplete scan says so: unreadable and skipped notes make the empty list uncertain, a truncated listing fails", async () => {
	const skipped = await run("citing", { citekey: "smith2020" }, { notes: NOTES, scan: { skipped: ["Notes/Broken.md"] } });
	assert.equal(skipped.ok, true);
	assert.deepEqual(skipped.scan, { skipped: ["Notes/Broken.md"], truncated: false, complete: false });
	const unreadable = await run("citing", { citekey: "smith2020" }, { notes: NOTES, extra: { reader: { ...host({ notes: NOTES }).reader, readNote: async (path: string) => { if (path === "Notes/B.md") throw new Error("permission denied"); return NOTES[path as keyof typeof NOTES]; } } } });
	assert.equal(unreadable.ok, true);
	assert.deepEqual(unreadable.scan, { skipped: ["Notes/B.md"], truncated: false, complete: false });
	assert.deepEqual(unreadable.notes.map((note: CitingNote) => note.path), ["Notes/A.md"]);
	assert.equal(unreadable.summary.scanned, 2);
	const truncated = await run("citing", { citekey: "smith2020" }, { notes: NOTES, scan: { skipped: ["Notes/Later.md"], truncated: true } });
	assert.equal(truncated.ok, false);
	assert.equal(truncated.reason, "discovery-incomplete");
	assert.equal(truncated.scan.complete, false);
	assert.equal(truncated.status, "resolved", "the found notes are still reported beside the failure");
	assert.ok(truncated.notes.length > 0);
});

test("notes are read with bounded concurrency and a vault without any searched key reads nothing", async () => {
	const many: Record<string, string> = {};
	for (let i = 0; i < 40; i++) many[`Bulk/n${String(i).padStart(2, "0")}.md`] = i % 5 === 0 ? `cite [@smith2020] ${i}` : `nothing here ${i}`;
	let inFlight = 0; let peak = 0; let reads = 0;
	const base = host({ notes: many });
	const reader = { ...base.reader, readNote: async (path: string) => { inFlight++; reads++; peak = Math.max(peak, inFlight); await new Promise(resolve => setImmediate(resolve)); inFlight--; return many[path]; } };
	const result = await run("citing", { citekey: "smith2020" }, { notes: many, extra: { reader } });
	assert.equal(result.summary.notes, 8);
	assert.equal(result.summary.scanned, 40);
	assert.ok(peak > 1 && peak <= 8, `peak concurrency ${peak}`);
	assert.equal(reads, 40);
	let listed = 0;
	await run("citing", { itemKey: "GRPS2345", libraryID: 2 }, { notes: many, entries: [SMITH, SMITH_GROUP], extra: { reader: { ...base.reader, listNotes: async () => { listed++; return []; } } } });
	assert.equal(listed, 0, "with every key excluded the vault is not scanned");
});

test("limits: positions per note and notes per response are capped and the totals stay exact", async () => {
	const cited = Array.from({ length: CITING_MAX_POSITIONS + 5 }, (_, i) => `Line ${i} [@smith2020]`).join("\n");
	const result = await run("citing", { citekey: "smith2020" }, { notes: { "Notes/Heavy.md": cited } });
	assert.equal(result.notes[0].count, CITING_MAX_POSITIONS + 5);
	assert.equal(result.notes[0].citations.length, CITING_MAX_POSITIONS);
	assert.equal(result.notes[0].positionsTruncated, true);
	assert.equal(result.notes[0].citations[0].line, 1);
	const many: Record<string, string> = {};
	for (let i = 0; i < CITING_MAX_NOTES + 20; i++) many[`Bulk/n${String(i).padStart(4, "0")}.md`] = "[@smith2020]";
	const capped = await run("citing", { citekey: "smith2020" }, { notes: many });
	assert.equal(capped.notes.length, CITING_MAX_NOTES);
	assert.equal(capped.summary.notes, CITING_MAX_NOTES + 20);
	assert.equal(capped.summary.listed, CITING_MAX_NOTES);
	assert.equal(capped.summary.truncated, true);
	assert.equal(capped.summary.citations, CITING_MAX_NOTES + 20);
});

test("sorting: most citations first, ties in path order", () => {
	const note = (path: string, count: number): CitingNote => ({ path, basename: path, uri: "", count, frontmatterCount: 0, citations: [], frontmatter: [] });
	assert.deepEqual(sortCitingNotes([note("b.md", 1), note("a.md", 1), note("c.md", 3), note("A.md", 1)]).map(item => item.path), ["c.md", "A.md", "a.md", "b.md"]);
});

test("excerpts: a short line is kept, a long line is cut around the citation with ellipses, a surrogate pair is never split", () => {
	assert.equal(excerptAround("  A short line [@k] here.   ", 15), "A short line [@k] here.");
	const long = `${"x".repeat(200)} [@smith2020] ${"y".repeat(200)}`;
	const cut = excerptAround(long, 201);
	assert.ok(cut.startsWith("…") && cut.endsWith("…"));
	assert.ok(cut.includes("[@smith2020]"));
	assert.ok(cut.replace(/…/g, "").length <= 120);
	const head = excerptAround(`[@smith2020] ${"z".repeat(300)}`, 1);
	assert.ok(!head.startsWith("…") && head.endsWith("…") && head.startsWith("[@smith2020]"));
	const tail = excerptAround(`${"z".repeat(300)} [@smith2020]`, 302);
	assert.ok(tail.startsWith("…") && !tail.endsWith("…") && tail.endsWith("[@smith2020]"));
	const emoji = `${"😀".repeat(100)} [@smith2020]`;
	for (const column of [0, 50, 100, 205]) assert.doesNotMatch(excerptAround(emoji, column), /^…?[\udc00-\udfff]|[\ud800-\udbff]…?$/);
});

test("citingKeys lists the current key first and drops empty history entries", () => {
	const odd = { ...SMITH, citekeyHistory: ["smithOld2020", "", "smith2020", "smithOld2020"] };
	assert.deepEqual(citingKeys(odd, [odd]).searched, [{ key: "smith2020", kind: "current" }, { key: "smithOld2020", kind: "former" }]);
});

test("request validation: one selector family, the narrowing rules of resolve, no foreign fields", () => {
	validateActionRequest("citing", { citekey: "smith2020" });
	validateActionRequest("citing", { itemKey: "ABCD2345", libraryID: 1, allowStale: true });
	validateActionRequest("citing", { title: "A synthetic paper", year: "2020", author: "Smith" });
	assert.throws(() => validateActionRequest("citing", {}), /citing requires exactly one selector/);
	assert.throws(() => validateActionRequest("citing", { citekey: "a", doi: "10.1/x" }), /citing requires exactly one selector/);
	assert.throws(() => validateActionRequest("citing", { citekey: "a", year: "2020" }), /year and author narrow title or query only/);
	assert.throws(() => validateActionRequest("citing", { citekey: "a", fresh: true }), /Unsupported citing request field: fresh/);
	assert.throws(() => validateActionRequest("citing", { itemKey: "ABCD2345" }), /libraryID/);
});
