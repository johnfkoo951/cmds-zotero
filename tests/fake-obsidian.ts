// A fake `obsidian` executable for CLI tests: put `env` on a child process and `scripts/ingest.mjs` talks to it instead of Obsidian.
// Discovery answers with `actions` (a list, or null for a host that predates the action list) and, when given, `features`; every job completes at its first
// poll with a canned result that names the job and echoes the request it was started with; `mode: "down"` is Obsidian not running.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FAKE = `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const state = process.env.FAKE_STATE;
const code = process.argv.slice(2).find(a => a.startsWith("code=")) ?? "";
const kind = /ackJob/.test(code) ? "ackJob" : /getJob/.test(code) ? "getJob" : /startJob/.test(code) ? "startJob" : /apiVersions/.test(code) ? "discovery" : "other";
appendFileSync(join(state, "calls.log"), JSON.stringify({ kind, code }) + "\\n");
if (process.env.FAKE_MODE === "down") { console.log("Obsidian is not running."); process.exit(1); }
const connection = { mode: "live", obsidian: "ok", plugin: { status: "ok", version: "0.6.0", apiVersions: [1, 2] }, bbt: { reachable: true }, index: { source: "plugin", path: "", schemaVersion: 2, generatedAt: null, ageMinutes: 0, count: 1, complete: true, stale: false, maxAgeMinutes: 60 }, legacyPluginEnabled: false, git: null };
if (kind === "discovery") { console.log("=> " + JSON.stringify({ apiVersion: 2, apiVersions: [1, 2], actions: JSON.parse(process.env.FAKE_ACTIONS), ...(process.env.FAKE_FEATURES ? { features: JSON.parse(process.env.FAKE_FEATURES) } : {}) })); process.exit(0); }
if (kind === "startJob") {
  const counter = join(state, "counter.txt");
  const next = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
  writeFileSync(counter, String(next));
  // The request is the JSON object right after the action name: the shortest prefix that parses (string values may hold braces).
  const head = /startJob\\("([a-z-]+)",/.exec(code);
  let request = null;
  if (head) {
    const rest = code.slice(head.index + head[0].length);
    for (let end = rest.indexOf("}"); end >= 0 && request === null; end = rest.indexOf("}", end + 1)) {
      try { request = JSON.parse(rest.slice(0, end + 1)); } catch { /* not the end of the object yet */ }
    }
  }
  writeFileSync(join(state, "job-" + next + ".json"), JSON.stringify({ action: head ? head[1] : null, request }));
  console.log('=> "job-' + next + '"'); process.exit(0);
}
if (kind === "getJob") {
  const id = /getJob\\("(job-\\d+)"\\)/.exec(code)[1];
  const job = JSON.parse(readFileSync(join(state, id + ".json"), "utf8"));
  const result = { contract: 2, apiVersion: job.action === "resolve" ? 1 : 2, apiVersions: [1, 2], action: job.action, vault: "Research", ok: true, status: "resolved", marker: "live-result", job: id, request: job.request, checkedAt: new Date().toISOString(), connection };
  console.log("=> " + JSON.stringify({ state: "completed", createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", result })); process.exit(0);
}
if (kind === "ackJob") { console.log("=> true"); process.exit(0); }
console.log("Error: unexpected eval"); process.exit(1);
`;

export interface FakeObsidian { dir: string; env: NodeJS.ProcessEnv }

/** The caller removes `dir` when it is done. */
export function fakeObsidian(options: { actions?: string[] | null; features?: string[]; mode?: "up" | "down" } = {}): FakeObsidian {
	const dir = mkdtempSync(join(tmpdir(), "cmds-zotero-fake-obsidian-"));
	writeFileSync(join(dir, "fake.cjs"), FAKE);
	writeFileSync(join(dir, "obsidian"), `#!/bin/sh\nexec "$FAKE_NODE" "$FAKE_SCRIPT" "$@"\n`);
	chmodSync(join(dir, "obsidian"), 0o755);
	return {
		dir,
		env: {
			...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_NODE: process.execPath, FAKE_SCRIPT: join(dir, "fake.cjs"), FAKE_STATE: dir, FAKE_MODE: options.mode ?? "up",
			FAKE_ACTIONS: JSON.stringify(options.actions === undefined ? null : options.actions), ...(options.features ? { FAKE_FEATURES: JSON.stringify(options.features) } : {}), CMDS_ZOTERO_POLL_MS: "4000", CMDS_ZOTERO_DELAY_MS: "10",
		},
	};
}

/** Every eval the CLI sent, in order. */
export function evalCalls(dir: string): { kind: string; code: string }[] {
	return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string; code: string });
}
