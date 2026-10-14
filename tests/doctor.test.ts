// 0.6.1 doctor-report: report-only setup checks from synthetic facts, the copyable report, the outcome ring buffer and
// `diagnostics --env` through the agent actions.
import test from "node:test";
import assert from "node:assert/strict";
import { doctorChecks, doctorDiagnostics, doctorReport, MAX_PATHS, redactPaths, type DoctorFacts } from "../src/doctor/checks";
import { OutcomeLog, summarizeOutcomes } from "../src/doctor/outcome-log";
import { DIAGNOSTIC_CODES } from "../src/diagnostics";
import { AGENT_FEATURES, validateActionRequest } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { host, NOW, run } from "./agent-fixtures";

const HEALTHY: DoctorFacts = {
	bbt: { reachable: true, zotero: "10.0.6", betterbibtex: "9.0.71" },
	legacyPluginEnabled: false,
	index: { path: "80. References/zotero-index.json", count: 450, ageMinutes: 5, stale: false, maxAgeMinutes: 60, complete: true },
	git: { repo: true, indexIgnored: true, cacheIgnored: true, indexTracked: false, cacheTracked: false },
	pdfjs: true,
	peers: [{ name: "Work", readable: true }],
	outputFolder: { folder: "References/Zotero", notes: 12, unmatched: [], betterNotes: [] },
};
const byId = (facts: DoctorFacts): Record<string, { status: string; code?: string; detail: string; paths?: string[] }> => Object.fromEntries(doctorChecks(facts).map(check => [check.id, check]));

// Synthetic home folders, assembled at runtime so the release sanitizer (which looks for literal home paths) stays quiet.
const MAC_HOME = ["", "Users", "alex"].join("/");
const LINUX_HOME = ["", "home", "sam"].join("/");
const WIN_HOME = ["C:", "Users", "kim"].join("\\");

test("a healthy setup is all ok, in report order, with no diagnostics", () => {
	const checks = doctorChecks(HEALTHY);
	assert.deepEqual(checks.map(check => check.id), ["zotero", "legacy-plugin", "index", "git", "pdfjs", "peer-vaults", "output-folder"]);
	assert.ok(checks.every(check => check.status === "ok" && check.code === undefined));
	assert.equal(checks[0].detail, "Zotero 10.0.6; Better BibTeX 9.0.71.");
	assert.deepEqual(doctorDiagnostics(checks), []);
});

test("each check flags its problem with a registered code whose severity is the status", () => {
	const facts: DoctorFacts = {
		bbt: { reachable: false, reason: "connection-refused" },
		legacyPluginEnabled: true,
		index: { ...HEALTHY.index, ageMinutes: 300, stale: true },
		git: { repo: true, indexIgnored: false, cacheIgnored: true, indexTracked: true },
		pdfjs: false,
		peers: [{ name: "Work", readable: true }, { name: "Lab", readable: false, detail: "Note map is missing or too large." }],
		outputFolder: { folder: "References/Zotero", notes: 30, unmatched: Array.from({ length: 25 }, (_, n) => `References/Zotero/stray ${n}.md`), betterNotes: [] },
		obsidian: "unavailable",
	};
	const checks = byId(facts);
	assert.equal(checks.zotero.code, "zotero-unreachable");
	assert.match(checks.zotero.detail, /connection refused/);
	assert.equal(checks["legacy-plugin"].code, "legacy-plugin-enabled");
	assert.equal(checks["legacy-plugin"].status, "error");
	assert.equal(checks.index.code, "index-stale");
	assert.equal(checks.git.code, "index-in-git");
	assert.match(checks.git.detail, /the doctor changes nothing/);
	assert.equal(checks.pdfjs.code, "pdfjs-unavailable");
	assert.equal(checks["peer-vaults"].code, "peer-map-unreadable");
	assert.match(checks["peer-vaults"].detail, /1 of 2 registered vaults cannot be read: Lab \(Note map is missing or too large\.\)/);
	assert.equal(checks["output-folder"].code, "foreign-notes-in-output");
	assert.match(checks["output-folder"].detail, /^25 notes/);
	assert.equal(checks["output-folder"].paths?.length, MAX_PATHS);
	assert.equal(checks.obsidian.code, "obsidian-unavailable");
	for (const check of doctorChecks(facts)) if (check.code) assert.equal(check.status, DIAGNOSTIC_CODES[check.code], check.id);
	const diagnostics = doctorDiagnostics(doctorChecks(facts));
	assert.equal(diagnostics.length, 8);
	assert.ok(diagnostics.every(item => item.code in DIAGNOSTIC_CODES));
});

test("version gates, missing index, Better Notes notes and unchecked facts", () => {
	const old = byId({ ...HEALTHY, bbt: { reachable: true, zotero: "7.0.11", betterbibtex: "7.0.5" } });
	assert.equal(old.zotero.code, "zotero-reading-history-unavailable");
	assert.equal(old.zotero.status, "info");
	assert.equal(byId({ ...HEALTHY, index: { ...HEALTHY.index, count: null, ageMinutes: null, stale: null } }).index.code, "index-missing");
	const better = byId({ ...HEALTHY, outputFolder: { folder: "References/Zotero", notes: 3, unmatched: ["References/Zotero/x.md"], betterNotes: ["References/Zotero/BN note.md"] } });
	assert.equal(better["output-folder"].code, "better-notes-in-output");
	assert.deepEqual(better["output-folder"].paths, ["References/Zotero/BN note.md"]);
	const offline = byId({ ...HEALTHY, bbt: { reachable: null }, legacyPluginEnabled: null, git: null, pdfjs: null, peers: null, outputFolder: null });
	for (const id of ["zotero", "legacy-plugin", "git", "pdfjs", "peer-vaults", "output-folder"]) assert.equal(offline[id].status, "unknown", id);
	assert.equal(byId({ ...HEALTHY, git: { repo: false, indexIgnored: null, cacheIgnored: null } }).git.status, "ok");
	assert.equal(byId({ ...HEALTHY, peers: [] })["peer-vaults"].status, "ok");
});

test("redactPaths removes absolute paths: vault root, home folder and other user folders", () => {
	const text = `Read ${MAC_HOME}/Vaults/Research/References/Zotero/a.md and ${MAC_HOME}/Zotero/storage/X.pdf; also ${LINUX_HOME}/z.json and ${WIN_HOME}\\Zotero\\x.pdf; root ${MAC_HOME}/Vaults/Research`;
	const redacted = redactPaths(text, { vaultRoot: `${MAC_HOME}/Vaults/Research`, home: `${MAC_HOME}` });
	assert.equal(redacted, "Read References/Zotero/a.md and ~/Zotero/storage/X.pdf; also ~/z.json and ~\\Zotero\\x.pdf; root <vault>");
	assert.doesNotMatch(redacted, /alex|sam|kim/);
});

test("the report lists checks, recent outcomes from the local log, and is redacted", () => {
	const log = new OutcomeLog(3);
	const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 14, 3, minute));
	log.push({ ok: true, at: at(1) });
	log.push({ ok: false, at: at(2), reason: "timeout", message: `BBT request timed out reading ${MAC_HOME}/Zotero/storage/X.pdf` });
	log.push({ ok: true, at: at(3) });
	log.push({ ok: false, at: at(4), reason: "connection-refused", message: "connect ECONNREFUSED 127.0.0.1:23119" });
	assert.equal(log.entries().length, 3, "the ring buffer keeps the newest entries");
	assert.equal(log.entries()[0].at, at(2).toISOString());
	assert.deepEqual(summarizeOutcomes(log.entries()), { total: 3, ok: 1, failed: 2, reasons: { timeout: 1, "connection-refused": 1 } });
	const report = doctorReport({ checks: doctorChecks({ ...HEALTHY, pdfjs: false }), pluginVersion: "0.6.1", generatedAt: at(5), statusLine: "Zotero index: 450 · 5 min old · BBT ok just now", outcomes: log.entries(), vaultRoot: `${MAC_HOME}/Vaults/Research`, home: `${MAC_HOME}` });
	const lines = report.split("\n");
	assert.equal(lines[0], "CMDS Zotero setup report");
	assert.equal(lines[1], "Plugin 0.6.1 · 2026-10-14T03:05:00.000Z");
	assert.ok(lines.includes("[warning] PDF text (pdf.js): Obsidian's PDF library did not load; PDF text extraction and quote location will fail. (pdfjs-unavailable)"));
	assert.ok(lines.includes("Recent Better BibTeX calls (this session, last 3): 1 ok, 2 failed (timeout 1, connection refused 1)."));
	assert.match(report, /timeout: BBT request timed out reading ~\/Zotero\/storage\/X\.pdf/);
	assert.doesNotMatch(report, /\/Users\//);
});

test("diagnostics --env: request validation, environment checks offline and on a live host, also on an index failure", async () => {
	assert.ok(AGENT_FEATURES.includes("diagnostics-env"));
	validateActionRequest("diagnostics", { env: true, allowStale: true });
	assert.throws(() => validateActionRequest("diagnostics", { env: "yes" }), /env must be boolean/);
	const plain = await run("diagnostics", {});
	assert.equal(plain.environment, undefined, "without --env the payload is unchanged");

	const offline = await run("diagnostics", { env: true }, { live: false });
	const checks = offline.environment.checks as { id: string; status: string }[];
	assert.deepEqual(checks.map(check => check.id), ["zotero", "legacy-plugin", "index", "git", "pdfjs", "peer-vaults", "output-folder"]);
	assert.deepEqual(Object.fromEntries(checks.map(check => [check.id, check.status])), { zotero: "unknown", "legacy-plugin": "ok", index: "ok", git: "unknown", pdfjs: "unknown", "peer-vaults": "unknown", "output-folder": "unknown" });
	assert.deepEqual(offline.diagnostics, plain.diagnostics, "--env never changes the diagnostics list");

	const base = host();
	const live = host({ extra: {
		connection: { ...base.connection, bbt: { reachable: true, zotero: "10.0.6", betterbibtex: "9.0.71" } },
		environmentFacts: async () => ({ pdfjs: true, peers: [], outputFolder: { folder: "References/Zotero", notes: 2, unmatched: ["References/Zotero/stray.md"], betterNotes: [] } }),
	} });
	const { runAction } = await import("../src/agent/actions");
	const answer = await runAction(live, "diagnostics", { env: true }) as Record<string, any>;
	const liveChecks = Object.fromEntries((answer.environment.checks as { id: string; status: string; code?: string }[]).map(check => [check.id, check]));
	assert.equal(liveChecks.zotero.status, "ok");
	assert.equal(liveChecks.obsidian.status, "ok");
	assert.equal(liveChecks["output-folder"].code, "foreign-notes-in-output");

	const missing = host({ extra: { indexView: null, indexFailure: { reason: "index-missing", message: "No index." }, connection: buildConnection({ mode: "offline", obsidian: "unavailable", obsidianError: "Obsidian is not running.", pluginVersion: null, pluginApiVersions: null, pluginEnabled: null, bbt: { reachable: null }, index: { source: "none", path: "", generatedAt: null, count: null, complete: null, schemaVersion: null }, maxAgeMinutes: 60, legacyPluginEnabled: null, git: null, now: NOW }) } });
	const failed = await runAction(missing, "diagnostics", { env: true }) as Record<string, any>;
	assert.equal(failed.ok, false);
	assert.equal(failed.reason, "index-missing");
	const failedChecks = Object.fromEntries((failed.environment.checks as { id: string; status: string; code?: string; detail: string }[]).map(check => [check.id, check]));
	assert.equal(failedChecks.index.code, "index-missing");
	assert.match(failedChecks.index.detail, /80\. References\/zotero-index\.json/, "the configured path stands in for an unknown one");
	assert.equal(failedChecks.obsidian.code, "obsidian-unavailable");
});
