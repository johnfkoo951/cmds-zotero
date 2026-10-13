import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { IdentityMap, noteZoteroID, type IdentitySource } from "../src/batch/identity-map";

// Synthetic notes only (AGENTS.md).
const parseYaml = (yaml: string): unknown => parse(yaml) as unknown;

/** The 0.5.0 importer's per-note test (`findIdentityPaths`), kept here as the reference the map must agree with. */
function legacyMatches(content: string, identity: string): boolean {
	const withoutBOM = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	const yaml = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(withoutBOM)?.[1];
	if (yaml === undefined) return false;
	try {
		const data: unknown = parseYaml(yaml);
		return !!data && typeof data === "object" && (data as Record<string, unknown>).zoteroID === identity;
	} catch { return false; }
}

interface Vault { files: Map<string, string>; reads: string[]; inFlight: number; maxInFlight: number; failing: Set<string>; source: IdentitySource }

function vault(files: Record<string, string>): Vault {
	const state: Vault = {
		files: new Map(Object.entries(files)), reads: [], inFlight: 0, maxInFlight: 0, failing: new Set(),
		source: {
			list: () => [...state.files.keys()],
			reader: () => async path => {
				state.reads.push(path);
				state.inFlight++;
				state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
				await new Promise(resolve => setImmediate(resolve));
				state.inFlight--;
				if (state.failing.has(path)) throw new Error(`Symlinked vault destination refused: ${path}`);
				return state.files.get(path) ?? null;
			},
			parseYaml,
		},
	};
	return state;
}

const note = (id: unknown, body = "Text"): string => `---\nzoteroID: ${JSON.stringify(id)}\ntitle: "x"\n---\n\n${body}\n`;

test("noteZoteroID agrees with the 0.5.0 per-note check for BOM, CRLF, bad YAML, arrays and non-string ids", () => {
	const texts = [
		note("1:AAAA0001"), `﻿${note("1:AAAA0001")}`, note("1:AAAA0001").replace(/\n/g, "\r\n"), "---\nzoteroID: [unclosed\n---\n",
		"---\n- 1:AAAA0001\n---\n", note(42), "---\n---\n", "no frontmatter", "---\nzoteroID: 1:AAAA0001\n---", `---\nzoteroID: "1:AAAA0001"\n...`,
		"---\ntitle: other\n---\nzoteroID: 1:AAAA0001", "",
	];
	for (const text of texts) {
		const id = noteZoteroID(text, parseYaml);
		assert.equal(id === "1:AAAA0001", legacyMatches(text, "1:AAAA0001"), JSON.stringify(text));
		if (id !== null) assert.equal(typeof id, "string");
	}
});

test("the map reads each note below the folder once and answers every identity from memory", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 60; i++) files[`Lit/@key${i}.md`] = note(`1:ITEM${String(i).padStart(4, "0")}`);
	files["Lit/@copy.md"] = note("1:ITEM0003");
	files["Lit/sub/@nested.md"] = `﻿${note("1:ITEM0007")}`;
	files["Lit/broken.md"] = "---\nzoteroID: [\n---\n";
	files["Lit/plain.md"] = "Just text";
	files["Elsewhere/@key1.md"] = note("1:ITEM0001");
	files["Literature/@key2.md"] = note("1:ITEM0002");
	const state = vault(files);
	const map = await IdentityMap.build("Lit", state.source);
	const below = Object.keys(files).filter(path => path.startsWith("Lit/"));
	assert.deepEqual([...state.reads].sort(), below.sort(), "every note below the folder is read exactly once; notes outside it never");
	assert.ok(state.maxInFlight > 1 && state.maxInFlight <= 8, `reads run concurrently and at most 8 at once (saw ${state.maxInFlight})`);
	const readsAfterBuild = state.reads.length;
	for (let i = 0; i < 60; i++) {
		const id = `1:ITEM${String(i).padStart(4, "0")}`;
		const expected = below.filter(path => legacyMatches(files[path], id)).sort();
		assert.deepEqual(await map.pathsFor(id), expected, id);
	}
	assert.deepEqual(await map.pathsFor("1:ITEM0003"), ["Lit/@copy.md", "Lit/@key3.md"], "duplicates are reported together, sorted");
	assert.deepEqual(await map.pathsFor("1:NONE0000"), []);
	assert.equal(state.reads.length, readsAfterBuild, "answers never read again");
	assert.equal(map.covers("Lit/x.md"), true);
	assert.equal(map.covers("Literature/x.md"), false);
});

test("writes are taken from their text, reported changes are read again once, and a folder change reads the listing again", async () => {
	const state = vault({ "Lit/@a.md": note("1:AAAA0001"), "Lit/@b.md": note("1:BBBB0001"), "Other/@c.md": note("1:CCCC0001") });
	const map = await IdentityMap.build("Lit", state.source);
	state.reads.length = 0;
	// The batch created a note: known at once, without a read.
	map.noteWritten("Lit/@new.md", note("1:NNNN0001"));
	state.files.set("Lit/@new.md", note("1:NNNN0001"));
	assert.deepEqual(await map.pathsFor("1:NNNN0001"), ["Lit/@new.md"]);
	assert.equal(state.reads.length, 0);
	map.noteWritten("Other/@d.md", note("1:NNNN0001"));
	assert.deepEqual(await map.pathsFor("1:NNNN0001"), ["Lit/@new.md"], "writes outside the folder are ignored");
	// A user edit changes the identity of @b; a note is deleted; another appears.
	state.files.set("Lit/@b.md", note("1:AAAA0001"));
	state.files.delete("Lit/@a.md");
	state.files.set("Lit/@e.md", note("1:EEEE0001"));
	for (const path of ["Lit/@b.md", "Lit/@a.md", "Lit/@e.md", "Other/@c.md"]) map.noteChanged(path);
	assert.deepEqual(await map.pathsFor("1:AAAA0001"), ["Lit/@b.md"]);
	assert.deepEqual(await map.pathsFor("1:BBBB0001"), []);
	assert.deepEqual(await map.pathsFor("1:EEEE0001"), ["Lit/@e.md"]);
	assert.deepEqual([...state.reads].sort(), ["Lit/@a.md", "Lit/@b.md", "Lit/@e.md"], "exactly the changed notes below the folder are read, once");
	// A folder rename (no per-file events): the listing is read again.
	state.files.delete("Lit/@e.md");
	state.files.set("Lit/moved/@e.md", note("1:EEEE0001"));
	map.foldersChanged();
	state.reads.length = 0;
	assert.deepEqual(await map.pathsFor("1:EEEE0001"), ["Lit/moved/@e.md"]);
	assert.deepEqual([...state.reads].sort(), ["Lit/@b.md", "Lit/@new.md", "Lit/moved/@e.md"]);
});

test("the first unreadable note in listing order fails every answer, like the per-preview scan did", async () => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 30; i++) files[`Lit/n${String(i).padStart(2, "0")}.md`] = note(`1:ITEM${String(i).padStart(4, "0")}`);
	const state = vault(files);
	state.failing.add("Lit/n12.md");
	state.failing.add("Lit/n20.md");
	const map = await IdentityMap.build("Lit", state.source);
	await assert.rejects(map.pathsFor("1:ITEM0000"), /refused: Lit\/n12\.md/);
	await assert.rejects(map.pathsFor("1:ITEM0029"), /refused: Lit\/n12\.md/, "still failing; the map never answers from a partial read");
	assert.ok(state.inFlight === 0, "no read outlives the build");
	// A change read later that fails also fails the map.
	const healthy = vault({ "Lit/a.md": note("1:AAAA0001") });
	const later = await IdentityMap.build("Lit", healthy.source);
	assert.deepEqual(await later.pathsFor("1:AAAA0001"), ["Lit/a.md"]);
	healthy.failing.add("Lit/a.md");
	later.noteChanged("Lit/a.md");
	await assert.rejects(later.pathsFor("1:AAAA0001"), /refused/);
});

test("an unsafe folder is refused when the map is built", async () => {
	await assert.rejects(IdentityMap.build("Lit/", vault({}).source), /Unsafe vault path/);
	await assert.rejects(IdentityMap.build("", vault({}).source), /Unsafe vault path/);
});
