import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { entryHash } from "../src/identity";
import { pluginApiVersionsFor } from "../src/cli/core";
import type { ZoteroIndexEntry } from "../src/types";

const script = join(process.cwd(), "scripts", "ingest.mjs");
const ro = join(process.cwd(), "scripts", "ingest-ro.mjs");
const temporaryRoots: string[] = [];
after(() => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });
function vault(): string {
	const root = mkdtempSync(join(tmpdir(), "cmds-zotero-offline-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, ".obsidian", "plugins", "cmds-zotero"), { recursive: true });
	mkdirSync(join(root, "80. References"), { recursive: true });
	writeFileSync(join(root, ".obsidian", "plugins", "cmds-zotero", "data.json"), JSON.stringify({ zoteroIndexPath: "80. References/zotero-index.json" }));
	const base: ZoteroIndexEntry = { id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "smith2020", citekeyHistory: [], title: "Synthetic", authors: ["Smith, A"], year: "2020", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {} };
	base.contentHash = entryHash(base);
	writeFileSync(join(root, "80. References", "zotero-index.json"), JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), source: "better-bibtex", count: 1, entries: [base], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true }));
	return root;
}
function run(args: string[]) { return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }); }

test("offline resolve emits one JSON envelope and exits zero for not-found", () => {
	const root = vault();
	const result = run(["--vault", "Research", "--vault-path", root, "--offline", "--action", "resolve", "--citekey", "missing"]);
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.action, "resolve");
	assert.equal(payload.status, "not-found");
	assert.equal(payload.connection.mode, "offline");
	assert.equal(result.stdout.trim().split("\n{").length, 1);
});

test("invalid index is reported as invalid, never absent or not-found", () => {
	const root = vault();
	writeFileSync(join(root, "80. References", "zotero-index.json"), "{broken");
	const result = run(["--vault", "Research", "--vault-path", root, "--offline", "--action", "resolve", "--citekey", "missing"]);
	assert.equal(result.status, 1);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.reason, "index-invalid");
	assert.equal(payload.status, "unavailable");
	assert.equal(result.stderr.trim(), "reason: index-invalid");
});

test("argument errors use exit 2 and stderr only", () => {
	const result = run(["--vault", "Research", "--offline", "--action", "resolve", "--citekey", "a", "--doi", "10.1/x"]);
	assert.equal(result.status, 2);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /exactly one selector/);
});

function fakeObsidian(mode: "old" | "submission-fails" | "poll-fails"): { dir: string; env: NodeJS.ProcessEnv } {
	const dir = mkdtempSync(join(tmpdir(), "cmds-zotero-bin-"));
	temporaryRoots.push(dir);
	const executable = join(dir, "obsidian");
	writeFileSync(executable, `#!/bin/sh\ncode="$3"\ncase "$code" in\n  *apiVersions*) if [ "$FAKE_MODE" = old ]; then echo '=> {"apiVersion":1,"apiVersions":[1]}'; else echo '=> {"apiVersion":2,"apiVersions":[1,2]}'; fi;;\n  *startJob*) if [ "$FAKE_MODE" = submission-fails ]; then exit 1; else echo '=> "job-1"'; fi;;\n  *getJob*) exit 1;;\nesac\n`);
	chmodSync(executable, 0o755);
	// Poll failures are transient until the deadline; keep the deadline short so the uncertain case stays fast.
	return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_MODE: mode, CMDS_ZOTERO_POLL_MS: "1500" } };
}

test("old read-only hosts fall back before submission, while uncertain submissions never fall back", () => {
	const root = vault();
	const old = fakeObsidian("old");
	const fallback = spawnSync(process.execPath, [script, "--vault", "Research", "--vault-path", root, "--action", "resolve", "--citekey", "smith2020"], { encoding: "utf8", env: old.env });
	assert.equal(fallback.status, 0, fallback.stderr);
	assert.equal(JSON.parse(fallback.stdout).connection.mode, "offline");

	for (const mode of ["submission-fails", "poll-fails"] as const) {
		const fake = fakeObsidian(mode);
		const uncertain = spawnSync(process.execPath, [script, "--vault", "Research", "--vault-path", root, "--action", "resolve", "--citekey", "smith2020"], { encoding: "utf8", env: fake.env });
		assert.equal(uncertain.status, 1);
		const payload = JSON.parse(uncertain.stdout);
		assert.equal(payload.ok, false);
		assert.equal(payload.connection.mode, "live");
		assert.match(payload.message, /do not resubmit automatically/);
	}
});

test("read-only wrapper honors offline mode and rejects mutating flags", () => {
	const root = vault();
	const valid = execFileSync(process.execPath, [ro, "--vault", "Research", "--vault-path", root, "--offline", "--action", "info"], { encoding: "utf8" });
	assert.equal(JSON.parse(valid).connection.mode, "offline");
	const rejected = spawnSync(process.execPath, [ro, "--vault", "Research", "--action", "reconcile", "--apply"], { encoding: "utf8" });
	assert.equal(rejected.status, 2);
	assert.equal(rejected.stdout, "");
});

test("standalone core parses YAML without the repository node_modules or a global require", () => {
	const root = vault();
	writeFileSync(join(root, "note.md"), "---\ncites:\n  - smith2020\n---\nA synthetic note.\n");
	const isolated = mkdtempSync(join(tmpdir(), "zotero-standalone-"));
	temporaryRoots.push(isolated);
	copyFileSync(join(process.cwd(), "scripts", "ingest-core.mjs"), join(isolated, "core.mjs"));
	writeFileSync(join(isolated, "run.mjs"), 'import {runAction} from "./core.mjs"; const original=globalThis.require; const result=await runAction({action:"cites",vault:"Research",vaultPath:process.argv[2],request:{path:"note.md"}}); if(globalThis.require!==original)throw Error("Global require was mutated");console.log(JSON.stringify(result));');
	const result = spawnSync(process.execPath, [join(isolated, "run.mjs"), root], { cwd: isolated, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } });
	assert.equal(result.status, 0, result.stderr);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.ok, true);
	assert.equal(payload.files[0].citations[0].citeStatus, "resolved");
});

test("missing indexes have their own failure code and installed old plugins are not advertised as API 2", () => {
	const root = vault();
	writeFileSync(join(root, ".obsidian", "plugins", "cmds-zotero", "manifest.json"), JSON.stringify({version:"0.3.0"}));
	rmSync(join(root, "80. References", "zotero-index.json"));
	const result = run(["--vault", "Research", "--vault-path", root, "--offline", "--action", "resolve", "--citekey", "missing"]);
	const payload = JSON.parse(result.stdout);
	assert.equal(result.status, 1);
	assert.equal(payload.reason, "index-missing");
	assert.deepEqual(payload.connection.plugin.apiVersions, [1]);
});

test("offline live-only capabilities return structured exit-one refusals", () => {
	for (const extra of [["--action", "refresh"], ["--action", "pdf-text", "--file", "source.pdf"], ["--action", "reconcile", "--apply"]]) {
		const result = run(["--vault", "Research", "--offline", ...extra]);
		assert.equal(result.status, 1);
		const payload = JSON.parse(result.stdout);
		assert.equal(payload.reason, "requires-obsidian");
		assert.equal(payload.connection.mode, "offline");
		if (extra.includes("--apply")) assert.equal(payload.apply.mode, "refused");
	}
});

test("read-only wrapper falls back from old hosts but never sends apply there", () => {
	const root = vault();
	const old = fakeObsidian("old");
	const result = spawnSync(process.execPath, [ro, "--vault", "Research", "--vault-path", root, "--action", "info"], {encoding:"utf8",env:old.env});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).connection.mode, "offline");
	const apply = spawnSync(process.execPath, [script, "--vault", "Research", "--vault-path", root, "--action", "reconcile", "--apply"], {encoding:"utf8",env:old.env});
	assert.equal(apply.status, 1);
	assert.equal(JSON.parse(apply.stdout).reason, "plugin-too-old");
	assert.equal(JSON.parse(apply.stdout).apply.mode, "refused");
});

// 0.5 R13/F10: contract-2 support follows the installed manifest's numeric major.minor, not one hard-coded version.

test("plugin API versions are derived from the manifest's major.minor", () => {
	assert.deepEqual(pluginApiVersionsFor("0.4.0"), [1, 2]);
	assert.deepEqual(pluginApiVersionsFor("0.4.1"), [1, 2]);
	assert.deepEqual(pluginApiVersionsFor("0.5.0"), [1, 2]);
	assert.deepEqual(pluginApiVersionsFor("0.10.3"), [1, 2]);
	assert.deepEqual(pluginApiVersionsFor("1.0.0"), [1, 2]);
	assert.deepEqual(pluginApiVersionsFor("0.5.0-beta.1"), [1, 2]);
	assert.deepEqual(pluginApiVersionsFor("0.3.0"), [1]);
	assert.deepEqual(pluginApiVersionsFor("0.0.1"), [1]);
	assert.equal(pluginApiVersionsFor(null), null);
	assert.equal(pluginApiVersionsFor(""), null);
	assert.equal(pluginApiVersionsFor("latest"), null);
	assert.equal(pluginApiVersionsFor("v0.4.1"), null);
});

test("offline envelopes advertise API 2 for installed 0.4.1 and 0.5.0 manifests and unknown for an unparsable one", () => {
	for (const [version, expected] of [["0.4.1", [1, 2]], ["0.5.0", [1, 2]], ["garbage", null]] as const) {
		const root = vault();
		writeFileSync(join(root, ".obsidian", "plugins", "cmds-zotero", "manifest.json"), JSON.stringify({ version }));
		const result = run(["--vault", "Research", "--vault-path", root, "--offline", "--action", "info"]);
		assert.equal(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.deepEqual(payload.connection.plugin.apiVersions, expected, `manifest ${version}`);
		assert.equal(payload.connection.plugin.version, version);
	}
});
