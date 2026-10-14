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

// CLI-level tests of the 0.6 actions `annotations` and `citing`: the offline core over a synthetic vault, the read-only
// wrapper, argument errors, and the plugin-too-old refusal of a host that does not list them (a fake `obsidian` on PATH).
const script = join(process.cwd(), "scripts", "ingest.mjs");
const ro = join(process.cwd(), "scripts", "ingest-ro.mjs");
const temporaryRoots: string[] = [];
after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });

function sealed(source: ZoteroIndexEntry): ZoteroIndexEntry {
	const copy = JSON.parse(JSON.stringify(source)) as ZoteroIndexEntry;
	assert.ok(sealEntry(copy), `fixture ${copy.citekey} is a valid index entry`);
	return copy;
}

function vault(): string {
	const root = mkdtempSync(join(tmpdir(), "cmds-zotero-agent-actions-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, ".obsidian", "plugins", "cmds-zotero"), { recursive: true });
	mkdirSync(join(root, "80. References"), { recursive: true });
	mkdirSync(join(root, "Notes"), { recursive: true });
	writeFileSync(join(root, ".obsidian", "plugins", "cmds-zotero", "data.json"), JSON.stringify({ zoteroIndexPath: "80. References/zotero-index.json" }));
	writeFileSync(join(root, "80. References", "zotero-index.json"), JSON.stringify(indexOf([sealed(SMITH), sealed(JONES)], new Date().toISOString())));
	writeFileSync(join(root, "Notes", "Discussion.md"), "---\ntype: synthesis\n---\n# Discussion\n\nThe effect holds [@smith2020, p. 4] and was replicated by @smithOld2020.\n");
	writeFileSync(join(root, "Notes", "Other.md"), "Nothing about it, only [@jones2019].\n");
	return root;
}

function run(args: string[], entry = script, env: NodeJS.ProcessEnv = process.env) {
	return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env });
}
const offline = (root: string, ...args: string[]): string[] => ["--vault", "Research", "--vault-path", root, "--offline", ...args];

test("offline annotations answers from the saved index, with filters, in one JSON document", () => {
	const root = vault();
	const result = run(offline(root, "--action", "annotations", "--citekey", "smith2020", "--color", "yellow", "--attachment", "PDFAAAA1"));
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim().split("\n{").length, 1);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.action, "annotations");
	assert.equal(payload.apiVersion, 2);
	assert.equal(payload.ok, true);
	assert.equal(payload.connection.mode, "offline");
	assert.equal(payload.source, "snapshot");
	assert.deepEqual(payload.filters, { color: "yellow", attachment: "PDFAAAA1" });
	assert.deepEqual(payload.attachments.map((attachment: any) => attachment.annotations.map((row: any) => row.key)), [["ANNO0001"]]);
	assert.equal(payload.attachments[0].annotations[0].uri, "zotero://open-pdf/library/items/PDFAAAA1?page=3&annotation=ANNO0001");
	const images = run(offline(root, "--action", "annotations", "--item-key", "ABCD2345", "--library", "1", "--type", "image"));
	assert.equal(images.status, 0, images.stderr);
	assert.equal(JSON.parse(images.stdout).attachments[0].annotations[0].image.private, true);
	const missing = run(offline(root, "--action", "annotations", "--citekey", "nobody1999"));
	assert.equal(missing.status, 0, "not-found is a usable answer");
	assert.equal(JSON.parse(missing.stdout).status, "not-found");
});

test("offline citing lists the notes that cite the item, former keys included, with positions", () => {
	const root = vault();
	const result = run(offline(root, "--action", "citing", "--citekey", "smith2020"));
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.action, "citing");
	assert.equal(payload.apiVersion, 2);
	assert.equal(payload.connection.mode, "offline");
	assert.deepEqual(payload.notes.map((note: any) => [note.path, note.count]), [["Notes/Discussion.md", 2]]);
	assert.deepEqual(payload.notes[0].citations.map((hit: any) => [hit.key, hit.line, hit.form]), [["smith2020", 6, "pandoc"], ["smithOld2020", 6, "bare"]]);
	assert.match(payload.notes[0].citations[0].excerpt, /The effect holds \[@smith2020, p\. 4\]/);
	assert.deepEqual(payload.scan, { skipped: [], truncated: false, complete: true });
	const byDoi = run(offline(root, "--action", "citing", "--doi", "10.1/none"));
	assert.equal(byDoi.status, 0);
	assert.equal(JSON.parse(byDoi.stdout).status, "not-found");
});

test("the read-only wrapper accepts both actions and still refuses writes", () => {
	const root = vault();
	assert.equal(run(offline(root, "--action", "annotations", "--citekey", "smith2020"), ro).status, 0);
	assert.equal(run(offline(root, "--action", "citing", "--citekey", "smith2020"), ro).status, 0);
	const apply = run(offline(root, "--action", "reconcile", "--apply"), ro);
	assert.equal(apply.status, 2);
	assert.match(apply.stderr, /--apply is not allowed/);
});

test("annotations --fresh and --today need the live host and Zotero; offline they fail structured, never with the snapshot", () => {
	const root = vault();
	for (const [flag, expect] of [["--fresh", /--fresh requires the live host and a running Zotero/], ["--today", /--today requires the live host and a running Zotero/]] as const) {
		const args = flag === "--today" ? ["--action", "annotations", "--today"] : ["--action", "annotations", "--citekey", "smith2020", "--fresh"];
		const result = run(offline(root, ...args));
		assert.equal(result.status, 1, flag);
		const payload = JSON.parse(result.stdout);
		assert.equal(payload.ok, false);
		assert.equal(payload.reason, "requires-obsidian");
		assert.match(payload.message, expect);
		assert.equal(payload.attachments, undefined);
		assert.equal(result.stderr.trim(), "reason: requires-obsidian");
	}
});

test("argument errors exit 2 with a message on stderr only", () => {
	const root = vault();
	const cases: [string[], RegExp][] = [
		[["--action", "annotations"], /annotations needs exactly one selector/],
		[["--action", "annotations", "--citekey", "a", "--today"], /annotations needs exactly one selector/],
		[["--action", "annotations", "--item-key", "ABCD2345"], /--item-key requires eight characters and --library/],
		[["--action", "annotations", "--citekey", "a", "--color", "teal"], /--color must be one of yellow/],
		[["--action", "annotations", "--citekey", "a", "--type", "scribble"], /--type must be one of highlight/],
		[["--action", "annotations", "--citekey", "a", "--attachment", "short"], /--attachment must be an eight-character/],
		[["--action", "annotations", "--citekey", "a", "--tag", " "], /--tag must not be empty/],
		[["--action", "citing"], /citing needs exactly one selector/],
		[["--action", "citing", "--citekey", "a", "--doi", "10.1/x"], /citing needs exactly one selector/],
		[["--action", "citing", "--citekey", "a", "--fresh"], /--fresh does not apply to --action citing/],
		[["--action", "resolve", "--citekey", "a", "--today"], /--today does not apply to --action resolve/],
	];
	for (const [args, message] of cases) {
		const result = run(offline(root, ...args));
		assert.equal(result.status, 2, args.join(" "));
		assert.equal(result.stdout, "");
		assert.match(result.stderr, message, args.join(" "));
	}
});

function host(actions: string[] | null) {
	const fake = fakeObsidian({ actions });
	temporaryRoots.push(fake.dir);
	return fake;
}

test("a host that does not list the action is refused as plugin-too-old before anything is submitted", () => {
	for (const [actions, label] of [[null, "no action list"], [["connection", "recent", "import"], "a 0.5 action list"]] as const) {
		for (const action of ["annotations", "citing"]) {
			const fake = host(actions as string[] | null);
			const result = run(["--vault", "Research", "--action", action, "--citekey", "smith2020"], script, fake.env);
			assert.equal(result.status, 1, `${action}: ${label}`);
			const payload = JSON.parse(result.stdout);
			assert.equal(payload.ok, false);
			assert.equal(payload.reason, "plugin-too-old");
			assert.equal(payload.action, action);
			assert.match(payload.message, new RegExp(`does not provide the ${action} action; install CMDS Zotero 0\\.6 or later`));
			assert.match(payload.message, /Add --offline to answer from the saved index file instead/);
			assert.equal(payload.connection.obsidian, "ok", "the plugin answered; only the action is missing");
			assert.equal(result.stderr.trim(), "reason: plugin-too-old");
			assert.deepEqual(evalCalls(fake.dir).map(call => call.kind), ["discovery"], "nothing was submitted to the old host");
		}
	}
	// The live-only flags have no offline alternative to suggest.
	const fake = host(null);
	const fresh = JSON.parse(run(["--vault", "Research", "--action", "annotations", "--citekey", "smith2020", "--fresh"], script, fake.env).stdout);
	assert.equal(fresh.reason, "plugin-too-old");
	assert.doesNotMatch(fresh.message, /--offline/);
});

test("a host that lists the actions runs them as jobs with the request exactly as typed", () => {
	const fake = host(["connection", "recent", "import", "annotations", "citing"]);
	const result = run(["--vault", "Research", "--action", "annotations", "--citekey", "smith2020", "--fresh", "--color", "#ffd400", "--type", "highlight", "--tag", "method", "--attachment", "PDFAAAA1", "--allow-stale"], script, fake.env);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.marker, "live-result");
	assert.deepEqual(payload.request, { citekey: "smith2020", allowStale: true, attachment: "PDFAAAA1", fresh: true, color: "#ffd400", type: "highlight", tag: "method" });
	const calls = evalCalls(fake.dir);
	const start = calls.find(call => call.kind === "startJob");
	assert.ok(start);
	assert.match(start.code, /startJob\("annotations",\{[^}]*"citekey":"smith2020"[^}]*"fresh":true[^}]*\}\)/);
	for (const field of ['"color":"#ffd400"', '"type":"highlight"', '"tag":"method"', '"attachment":"PDFAAAA1"', '"allowStale":true']) assert.ok(start.code.includes(field), field);
	assert.deepEqual(calls.map(call => call.kind), ["discovery", "startJob", "getJob", "ackJob"]);
});
