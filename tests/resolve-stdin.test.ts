import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sealEntry } from "../src/identity";
import type { ZoteroIndexEntry } from "../src/types";
import { indexOf, JONES, SMITH } from "./agent-fixtures";
import { evalCalls, fakeObsidian } from "./fake-obsidian";

// 0.6 `resolve --stdin`: NDJSON selectors in, one envelope per input line out, in input order. Synthetic vault only.
const script = join(process.cwd(), "scripts", "ingest.mjs");
const temporaryRoots: string[] = [];
after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });

function sealed(source: ZoteroIndexEntry): ZoteroIndexEntry {
	const copy = JSON.parse(JSON.stringify(source)) as ZoteroIndexEntry;
	assert.ok(sealEntry(copy), `fixture ${copy.citekey} is a valid index entry`);
	return copy;
}

function vault(): string {
	const root = mkdtempSync(join(tmpdir(), "cmds-zotero-stdin-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, ".obsidian", "plugins", "cmds-zotero"), { recursive: true });
	mkdirSync(join(root, "80. References"), { recursive: true });
	writeFileSync(join(root, ".obsidian", "plugins", "cmds-zotero", "data.json"), JSON.stringify({ zoteroIndexPath: "80. References/zotero-index.json" }));
	writeFileSync(join(root, "80. References", "zotero-index.json"), JSON.stringify(indexOf([sealed(SMITH), sealed(JONES)], new Date().toISOString())));
	return root;
}

function run(args: string[], input: string, env: NodeJS.ProcessEnv = process.env) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", input, env });
}

const lines = (stdout: string): Record<string, any>[] => stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);

test("resolve --stdin answers every line in order, one envelope per line, from one offline batch", () => {
	const root = vault();
	const input = [
		JSON.stringify({ citekey: "smith2020" }),
		"",
		JSON.stringify({ itemKey: "JONE2345", libraryID: 1 }),
		JSON.stringify({ citekey: "nobody1999" }),
		JSON.stringify({ citekey: "smithOld2020" }),
	].join("\n");
	const result = run(["--vault", "Research", "--vault-path", root, "--offline", "--action", "resolve", "--stdin"], input);
	assert.equal(result.status, 0, result.stderr);
	const out = lines(result.stdout);
	assert.deepEqual(out.map(payload => payload.line), [1, 3, 4, 5], "blank lines are skipped; line numbers are the input's");
	assert.deepEqual(out.map(payload => [payload.action, payload.apiVersion, payload.connection.mode]), Array(4).fill(["resolve", 1, "offline"]));
	assert.deepEqual(out.map(payload => payload.status), ["resolved", "resolved", "not-found", "resolved"]);
	assert.equal(out[0].entry.citekey, "smith2020");
	assert.equal(out[1].entry.citekey, "jones2019");
	assert.equal(out[3].entry.citekey, "smith2020", "a former key resolves to the current one");
	assert.equal(result.stderr, "");
});

test("resolve --stdin: a bad line becomes its own invalid-request envelope and never stops the batch", () => {
	const root = vault();
	const input = ["{not json", JSON.stringify(["smith2020"]), JSON.stringify({ citekey: "smith2020", style: "apa" }), JSON.stringify({ citekey: "smith2020", doi: "10.1/x" }), JSON.stringify({ citekey: "jones2019" })].join("\n");
	const result = run(["--vault", "Research", "--vault-path", root, "--offline", "--action", "resolve", "--stdin"], input);
	assert.equal(result.status, 1, "any failed line makes the exit code 1");
	const out = lines(result.stdout);
	assert.deepEqual(out.map(payload => payload.line), [1, 2, 3, 4, 5]);
	assert.deepEqual(out.slice(0, 4).map(payload => [payload.ok, payload.reason]), Array(4).fill([false, "invalid-request"]));
	assert.match(out[0].message, /Line 1 is not valid JSON/);
	assert.match(out[1].message, /Line 2 must be a JSON object/);
	assert.match(out[2].message, /Line 3 has unsupported field\(s\): style/);
	assert.match(out[3].message, /exactly one selector/, "the core validates the selector combination per line");
	assert.equal(out[4].status, "resolved");
	assert.equal(out[4].entry.citekey, "jones2019");
	assert.deepEqual(result.stderr.trim().split("\n"), ["line 1 reason: invalid-request", "line 2 reason: invalid-request", "line 3 reason: invalid-request", "line 4 reason: invalid-request"]);
});

test("resolve --stdin --allow-stale applies to every line; a line may also set allowStale itself", () => {
	const root = vault();
	const result = run(["--vault", "Research", "--vault-path", root, "--offline", "--action", "resolve", "--stdin", "--allow-stale"], `${JSON.stringify({ citekey: "smith2020" })}\n${JSON.stringify({ citekey: "jones2019", allowStale: true })}\n`);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(lines(result.stdout).map(payload => payload.status), ["resolved", "resolved"]);
});

test("resolve --stdin argument errors exit 2 with stderr only", () => {
	const root = vault();
	const base = ["--vault", "Research", "--vault-path", root, "--offline"];
	const cases: [string[], string, RegExp][] = [
		[["--action", "resolve", "--stdin", "--citekey", "smith2020"], "{}", /--stdin takes the selectors from the input lines; remove --citekey/],
		[["--action", "resolve", "--stdin", "--refresh"], "{}", /remove --refresh/],
		[["--action", "identity", "--stdin"], "{}", /--stdin does not apply to --action identity/],
		[["--action", "resolve", "--stdin"], "\n\n", /--stdin received no input lines/],
		[["--action", "resolve", "--stdin"], `${JSON.stringify({ citekey: "a" })}\n`.repeat(501), /at most 500 lines/],
	];
	for (const [args, input, message] of cases) {
		const result = run([...base, ...args], input);
		assert.equal(result.status, 2, args.join(" "));
		assert.equal(result.stdout, "");
		assert.match(result.stderr, message, args.join(" "));
	}
});

test("resolve --stdin against a live host submits one job per line and keeps the input order", () => {
	const fake = fakeObsidian({ actions: ["connection", "resolve", "recent", "import"] });
	temporaryRoots.push(fake.dir);
	const result = run(["--vault", "Research", "--action", "resolve", "--stdin"], `${JSON.stringify({ citekey: "smith2020" })}\n${JSON.stringify({ doi: "10.1000/example" })}\n`, fake.env);
	assert.equal(result.status, 0, result.stderr);
	const out = lines(result.stdout);
	assert.deepEqual(out.map(payload => [payload.line, payload.marker, payload.request]), [[1, "live-result", { citekey: "smith2020" }], [2, "live-result", { doi: "10.1000/example" }]]);
	assert.equal(evalCalls(fake.dir).filter(call => call.kind === "startJob").length, 2);
});
