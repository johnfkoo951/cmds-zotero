// 0.6 OPT-15: "Find notes citing a source" reads notes with bounded concurrency; the hits and their order stay 0.5.0's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CITING_READ_CONCURRENCY, findCitingNotes } from "../src/citations/citing-notes";
import { scanCitations } from "../src/citations/scan";

interface Note { path: string; text: string }

/** What 0.5.0 `showCitingNotes` computed: one read at a time, the `@key` prefilter, then most citations first and by path. */
async function citing050(files: Note[], keys: Set<string>): Promise<{ path: string; line: number; count: number }[]> {
	const hits: { path: string; line: number; count: number }[] = [];
	for (const file of files) {
		const text = file.text;
		if (![...keys].some(key => text.includes(`@${key}`))) continue;
		const occurrences = scanCitations(text).filter(item => keys.has(item.citekey));
		if (occurrences.length) hits.push({ path: file.path, line: occurrences[0].line, count: occurrences.length });
	}
	return hits.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

// Synthetic notes only (AGENTS.md).
function notes(count: number): Note[] {
	return Array.from({ length: count }, (_, i) => {
		const body = [
			i % 3 === 0 ? `See [@smith2020] on p. ${i}.` : "",
			i % 5 === 0 ? "Earlier work [[@smith2019old]] and @smith2020 again." : "",
			i % 7 === 0 ? "`@smith2020` in code and mail smith2020@example.org are not citations." : "",
			i % 11 === 0 ? "Unrelated [@jones2021]." : "",
		].filter(Boolean).join("\n");
		return { path: `Notes/${String(i % 13).padStart(2, "0")}/note-${i}.md`, text: `# Note ${i}\n${body}\n` };
	});
}

test("0.6 OPT-15: hits, lines, counts and order equal the sequential 0.5.0 scan", async () => {
	const files = notes(400);
	const keys = new Set(["smith2020", "smith2019old"]);
	const expected = await citing050(files, keys);
	assert.ok(expected.length > 50, "the fixture has many citing notes");
	assert.ok(new Set(expected.map(hit => hit.count)).size > 1, "counts differ, so the order is not only by path");
	const hits = await findCitingNotes(files, keys, async file => file.text);
	assert.deepEqual(hits.map(hit => ({ path: hit.file.path, line: hit.line, count: hit.count })), expected);
	assert.ok(hits.every(hit => files.includes(hit.file)), "hits carry the caller's file objects");
	assert.deepEqual(await findCitingNotes(files, ["nobody1999"], async file => file.text), []);
});

test("0.6 OPT-15: reads finishing out of order do not change the result; at most 8 reads are in flight", async () => {
	const files = notes(120);
	const keys = ["smith2020"];
	let inFlight = 0;
	let peak = 0;
	const reads: string[] = [];
	const read = async (file: Note): Promise<string> => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		reads.push(file.path);
		await new Promise(resolve => setTimeout(resolve, (files.indexOf(file) * 7919) % 5));
		inFlight--;
		return file.text;
	};
	const hits = await findCitingNotes(files, keys, read);
	assert.equal(CITING_READ_CONCURRENCY, 8);
	assert.ok(peak > 1 && peak <= 8, `peak concurrency ${peak}`);
	assert.equal(reads.length, files.length, "every note is read once");
	assert.deepEqual(hits.map(hit => hit.file.path), (await citing050(files, new Set(keys))).map(hit => hit.path));
});

test("0.6 OPT-15: a note without '@key' is no hit, and a failing read ends the search with its error", async () => {
	const files: Note[] = [{ path: "a.md", text: "smith2020 without the at sign" }, { path: "b.md", text: "[@smith2020]" }];
	assert.deepEqual((await findCitingNotes(files, ["smith2020"], async file => file.text)).map(hit => hit.file.path), ["b.md"]);
	await assert.rejects(findCitingNotes(files, ["smith2020"], async file => { if (file.path === "a.md") throw new Error("unreadable"); return file.text; }), /unreadable/);
});

test("IMP-CITED-BY-VIEW: CitingNote includes trimmed 140-char snippet at first occurrence and deduplicated lines", async () => {
	const longTail = "x".repeat(160);
	const files: Note[] = [
		{
			path: "multi.md",
			text: `# Heading\n   First citation [@smith2020] and @smith2020 on same line ${longTail}   \nMiddle\nThird line [[@smith2019old]].\n`,
		},
	];
	const hits = await findCitingNotes(files, ["smith2020", "smith2019old"], async file => file.text);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].line, 1);
	assert.equal(hits[0].count, 3);
	assert.deepEqual(hits[0].lines, [1, 3]);
	assert.equal(hits[0].snippet.length, 140);
	assert.ok(hits[0].snippet.startsWith("First citation [@smith2020] and @smith2020 on same line xxx"));
});

