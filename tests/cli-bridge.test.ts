import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bridge transport tests: a fake `obsidian` executable on PATH reproduces the busy-renderer behavior observed live
// (exit 0 with empty stdout while the eval still runs) and plugin-side rejections. No Obsidian or vault is touched.
const script = join(process.cwd(), "scripts", "ingest.mjs");
const ro = join(process.cwd(), "scripts", "ingest-ro.mjs");
const temporaryRoots: string[] = [];
after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });

type Mode = "flaky" | "poll-always-empty" | "invalid" | "job-failed";

const FAKE = `
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const state = process.env.FAKE_STATE;
const mode = process.env.FAKE_MODE;
const emptyPolls = Number(process.env.FAKE_EMPTY_POLLS ?? "0");
const code = process.argv.slice(2).find(a => a.startsWith("code=")) ?? "";
const kind = /ackJob/.test(code) ? "ackJob" : /getJob/.test(code) ? "getJob" : /startJob/.test(code) ? "startJob" : /apiVersions/.test(code) ? "discovery" : "other";
const counts = existsSync(join(state, "counts.json")) ? JSON.parse(readFileSync(join(state, "counts.json"), "utf8")) : {};
counts[kind] = (counts[kind] ?? 0) + 1;
writeFileSync(join(state, "counts.json"), JSON.stringify(counts));
appendFileSync(join(state, "calls.log"), kind + "\\n");
const result = { contract: 2, apiVersion: 1, apiVersions: [1, 2], action: "resolve", vault: "Research", ok: true, status: "resolved", marker: "delivered-after-empty-polls", checkedAt: new Date().toISOString(), connection: { mode: "live", obsidian: "ok", plugin: { status: "ok", version: "0.5.0", apiVersions: [1, 2] }, bbt: { reachable: true }, index: { source: "plugin", path: "", schemaVersion: 2, generatedAt: null, ageMinutes: 0, count: 1, complete: true, stale: false, maxAgeMinutes: 60 }, legacyPluginEnabled: false, git: null } };
if (kind === "discovery") {
  // First discovery call on a busy renderer: exit 0, empty stdout.
  if (mode === "flaky" && counts[kind] === 1) process.exit(0);
  console.log('=> {"apiVersion":2,"apiVersions":[1,2]}'); process.exit(0);
}
if (kind === "startJob") {
  // An eval throw is reported by the Obsidian CLI as an "Error: ..." line with exit 0 (observed live, audit F12).
  if (mode === "invalid") { console.log("Error: Selector citekey must not be empty."); process.exit(0); }
  console.log('=> "job-7"'); process.exit(0);
}
if (kind === "getJob") {
  if (mode === "poll-always-empty") process.exit(0);
  if (mode === "job-failed") { console.log('=> {"state":"failed","createdAt":"2026-01-01T00:00:00.000Z","finishedAt":"2026-01-01T00:00:01.000Z","error":"Ingest request failed: adapter error"}'); process.exit(0); }
  if (counts[kind] <= emptyPolls) process.exit(0);
  console.log("=> " + JSON.stringify({ state: "completed", createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", result })); process.exit(0);
}
if (kind === "ackJob") { console.log("=> true"); process.exit(0); }
console.log("Error: unexpected eval"); process.exit(1);
`;

function fakeObsidian(mode: Mode, emptyPolls = 0): { state: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), "cmds-zotero-bridge-"));
	temporaryRoots.push(dir);
	writeFileSync(join(dir, "fake.cjs"), FAKE);
	writeFileSync(join(dir, "obsidian"), `#!/bin/sh\nexec "$FAKE_NODE" "$FAKE_SCRIPT" "$@"\n`);
	chmodSync(join(dir, "obsidian"), 0o755);
	return { state: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_NODE: process.execPath, FAKE_SCRIPT: join(dir, "fake.cjs"), FAKE_STATE: dir, FAKE_MODE: mode, FAKE_EMPTY_POLLS: String(emptyPolls), CMDS_ZOTERO_POLL_MS: "4000" } };
}
function counts(state: string): Record<string, number> {
	return existsSync(join(state, "counts.json")) ? JSON.parse(readFileSync(join(state, "counts.json"), "utf8")) as Record<string, number> : {};
}
function run(env: NodeJS.ProcessEnv, entry = script, args = ["--vault", "Research", "--action", "resolve", "--citekey", "smith2020"]) {
	return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env });
}

test("empty CLI output during discovery and polling is transient: the completed result is still delivered and acknowledged", () => {
	const fake = fakeObsidian("flaky", 3);
	const started = Date.now();
	const result = run(fake.env);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.ok, true);
	assert.equal(payload.status, "resolved");
	assert.equal(payload.marker, "delivered-after-empty-polls");
	assert.equal(result.stdout.trim().split("\n{").length, 1, "exactly one JSON document");
	const seen = counts(fake.state);
	assert.equal(seen.discovery, 2, "discovery retried once after the empty reply");
	assert.equal(seen.startJob, 1, "a submission is never repeated");
	assert.equal(seen.getJob, 4, "three empty polls, then the result");
	assert.equal(seen.ackJob, 1, "the result is acknowledged after it was read");
	assert.ok(Date.now() - started < 20000);
});

test("a bridge that never answers polls yields timeout after the deadline without resubmitting", () => {
	const fake = fakeObsidian("poll-always-empty");
	fake.env.CMDS_ZOTERO_POLL_MS = "1500";
	const result = run(fake.env);
	assert.equal(result.status, 1);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.ok, false);
	assert.equal(payload.reason, "timeout");
	assert.equal(payload.connection.mode, "live");
	assert.match(payload.message, /Timed out after 2s/);
	assert.match(payload.message, /Empty output from the Obsidian CLI/);
	assert.match(payload.message, /do not resubmit automatically/);
	assert.equal(result.stderr.trim(), "reason: timeout");
	const seen = counts(fake.state);
	assert.equal(seen.startJob, 1);
	assert.ok(seen.getJob >= 3, `polled ${seen.getJob} times`);
	assert.equal(seen.ackJob, undefined, "nothing to acknowledge");
});

test("plugin-side request rejection is invalid-request with a present plugin, not requires-obsidian", () => {
	const fake = fakeObsidian("invalid");
	const result = run(fake.env);
	assert.equal(result.status, 1);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.reason, "invalid-request");
	assert.match(payload.message, /Selector citekey must not be empty/);
	assert.equal(payload.connection.mode, "live");
	assert.equal(payload.connection.obsidian, "ok");
	assert.equal(payload.connection.plugin.status, "ok");
	assert.deepEqual(payload.connection.plugin.apiVersions, [1, 2]);
	assert.equal(counts(fake.state).getJob, undefined, "a rejected submission is never polled");
	assert.equal(result.stderr.trim(), "reason: invalid-request");
});

test("a job that ends failed still maps to requires-obsidian and is reported once", () => {
	const fake = fakeObsidian("job-failed");
	const result = run(fake.env);
	assert.equal(result.status, 1);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.reason, "requires-obsidian");
	assert.match(payload.message, /adapter error/);
	assert.match(payload.message, /do not resubmit automatically/);
	assert.equal(counts(fake.state).getJob, 1);
});

test("the read-only wrapper forwards the environment so transient bridge failures recover there too", () => {
	const fake = fakeObsidian("flaky", 1);
	const result = run(fake.env, ro, ["--vault", "Research", "--action", "resolve", "--citekey", "smith2020"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).marker, "delivered-after-empty-polls");
	assert.equal(counts(fake.state).ackJob, 1);
});
