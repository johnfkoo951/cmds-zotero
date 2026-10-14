import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sealEntry } from "../src/identity";
import type { ZoteroIndexEntry } from "../src/types";
import { indexOf, SMITH } from "./agent-fixtures";
import { evalCalls, fakeObsidian } from "./fake-obsidian";

// 0.6.1 doctor-report: `diagnostics --env` through the CLI: the offline core, the feature gate for an older host, and the
// request a current host receives (a fake `obsidian` on PATH).
const script = join(process.cwd(), "scripts", "ingest.mjs");
const temporaryRoots: string[] = [];
after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });

function vault(): string {
	const root = mkdtempSync(join(tmpdir(), "cmds-zotero-doctor-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, ".obsidian", "plugins", "cmds-zotero"), { recursive: true });
	mkdirSync(join(root, "80. References"), { recursive: true });
	writeFileSync(join(root, ".obsidian", "plugins", "cmds-zotero", "data.json"), JSON.stringify({ zoteroIndexPath: "80. References/zotero-index.json" }));
	const entry = JSON.parse(JSON.stringify(SMITH)) as ZoteroIndexEntry;
	assert.ok(sealEntry(entry));
	writeFileSync(join(root, "80. References", "zotero-index.json"), JSON.stringify(indexOf([entry], new Date().toISOString())));
	return root;
}
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });

test("offline diagnostics --env adds environment.checks and leaves the diagnostics list as it was", () => {
	const root = vault();
	const base = ["--vault", "Research", "--vault-path", root, "--offline", "--action", "diagnostics"];
	const plain = run(base);
	assert.equal(plain.status, 0, plain.stderr);
	const withEnv = run([...base, "--env"]);
	assert.equal(withEnv.status, 0, withEnv.stderr);
	const payload = JSON.parse(withEnv.stdout);
	assert.equal(payload.apiVersion, 1);
	assert.deepEqual(payload.diagnostics, JSON.parse(plain.stdout).diagnostics);
	const checks = Object.fromEntries((payload.environment.checks as { id: string; status: string }[]).map(check => [check.id, check.status]));
	assert.equal(checks.index, "ok");
	assert.equal(checks.zotero, "unknown", "the offline core does not probe Better BibTeX");
	assert.equal(checks.pdfjs, "unknown");
	assert.equal(JSON.parse(plain.stdout).environment, undefined);
});

test("--env applies to diagnostics only", () => {
	const result = run(["--vault", "Research", "--offline", "--action", "resolve", "--citekey", "a", "--env"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /--env does not apply to --action resolve/);
});

test("a host without the diagnostics-env feature is refused before submission; a current host receives env: true", () => {
	const old = fakeObsidian({ actions: ["connection", "recent", "import", "annotations", "citing"] });
	temporaryRoots.push(old.dir);
	const refused = run(["--vault", "Research", "--action", "diagnostics", "--env"], old.env);
	assert.equal(refused.status, 1);
	const payload = JSON.parse(refused.stdout);
	assert.equal(payload.reason, "plugin-too-old");
	assert.match(payload.message, /does not accept --env for diagnostics; install CMDS Zotero 0\.6\.1 or later/);
	assert.deepEqual(evalCalls(old.dir).map(call => call.kind), ["discovery"], "nothing was submitted");
	const plain = run(["--vault", "Research", "--action", "diagnostics"], old.env);
	assert.equal(plain.status, 0, "without --env an older host still answers");

	const current = fakeObsidian({ actions: ["connection", "recent", "import", "annotations", "citing"], features: ["diagnostics-env"] });
	temporaryRoots.push(current.dir);
	const accepted = run(["--vault", "Research", "--action", "diagnostics", "--env"], current.env);
	assert.equal(accepted.status, 0, accepted.stderr);
	assert.deepEqual(JSON.parse(accepted.stdout).request, { env: true });
});
