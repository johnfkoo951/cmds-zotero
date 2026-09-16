import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_API_VERSIONS, INFO_WARNINGS, buildConnection, buildEnvelope, indexAgeMinutes, infoWarnings, pluginStatus, staleGate } from "../src/agent/connection";
import type { HostSnapshot } from "../src/agent/connection";

const NOW = new Date("2026-09-14T10:00:00.000Z");
const INDEX_PATH = "80. References/zotero-index.json";

function snapshot(overrides: Partial<HostSnapshot> = {}, index: Partial<HostSnapshot["index"]> = {}): HostSnapshot {
	return {
		mode: "live",
		obsidian: "ok",
		pluginVersion: "0.4.0",
		pluginApiVersions: [1, 2],
		pluginEnabled: true,
		bbt: { reachable: true, zotero: "7.0.0", betterbibtex: "7.0.0" },
		index: { source: "plugin", path: INDEX_PATH, generatedAt: "2026-09-14T09:30:00.000Z", count: 12, complete: true, schemaVersion: 2, ...index },
		maxAgeMinutes: 60,
		legacyPluginEnabled: false,
		git: { repo: true, indexIgnored: true, cacheIgnored: true },
		now: NOW,
		...overrides,
	};
}

test("age and stale math follow the data.json threshold with whole minutes", () => {
	assert.equal(indexAgeMinutes("2026-09-14T09:30:00.000Z", NOW), 30);
	assert.equal(indexAgeMinutes("2026-09-14T09:59:01.000Z", NOW), 0);
	assert.equal(indexAgeMinutes("2026-09-14T10:00:01.000Z", NOW), null);
	assert.equal(indexAgeMinutes("not a date", NOW), null);
	assert.equal(indexAgeMinutes(null, NOW), null);
	const fresh = buildConnection(snapshot());
	assert.equal(fresh.index.ageMinutes, 30);
	assert.equal(fresh.index.stale, false);
	const atLimit = buildConnection(snapshot({}, { generatedAt: "2026-09-14T09:00:00.000Z" }));
	assert.equal(atLimit.index.ageMinutes, 60);
	assert.equal(atLimit.index.stale, false);
	const overLimit = buildConnection(snapshot({}, { generatedAt: "2026-09-14T08:59:59.000Z" }));
	assert.equal(overLimit.index.ageMinutes, 60);
	assert.equal(overLimit.index.stale, false);
	const stale = buildConnection(snapshot({}, { generatedAt: "2026-09-14T08:58:00.000Z" }));
	assert.equal(stale.index.ageMinutes, 62);
	assert.equal(stale.index.stale, true);
	const custom = buildConnection(snapshot({ maxAgeMinutes: 10 }));
	assert.equal(custom.index.stale, true);
	assert.equal(custom.index.maxAgeMinutes, 10);
});

test("a missing index yields null age and null stale while keeping the path and threshold", () => {
	const none = buildConnection(snapshot({}, { source: "none", generatedAt: null, count: null, complete: null, schemaVersion: null }));
	assert.deepEqual(none.index, { source: "none", path: INDEX_PATH, schemaVersion: null, generatedAt: null, ageMinutes: null, count: null, complete: null, stale: null, maxAgeMinutes: 60 });
	assert.equal(staleGate(none, false), true);
});

test("connection keeps vocabulary key order and omits absent optional fields", () => {
	const connection = buildConnection(snapshot());
	assert.deepEqual(Object.keys(connection), ["mode", "obsidian", "plugin", "bbt", "index", "legacyPluginEnabled", "git"]);
	assert.deepEqual(Object.keys(connection.plugin), ["status", "version", "apiVersions"]);
	assert.deepEqual(Object.keys(connection.bbt), ["reachable", "zotero", "betterbibtex"]);
	assert.deepEqual(Object.keys(connection.index), ["source", "path", "schemaVersion", "generatedAt", "ageMinutes", "count", "complete", "stale", "maxAgeMinutes"]);
	assert.deepEqual(Object.keys(connection.git ?? {}), ["repo", "indexIgnored", "cacheIgnored"]);
	assert.equal("obsidianError" in connection, false);
	const offline = buildConnection(snapshot({ mode: "offline", obsidian: "unavailable", obsidianError: "Vault not found.", bbt: { reachable: null }, git: null, legacyPluginEnabled: null }, { source: "offline-file" }));
	assert.deepEqual(Object.keys(offline), ["mode", "obsidian", "obsidianError", "plugin", "bbt", "index", "legacyPluginEnabled", "git"]);
	assert.equal(offline.obsidianError, "Vault not found.");
	assert.deepEqual(offline.bbt, { reachable: null });
	assert.equal(offline.git, null);
	assert.equal(offline.legacyPluginEnabled, null);
	const failed = buildConnection(snapshot({ bbt: { reachable: false, error: "connect ECONNREFUSED" } }));
	assert.deepEqual(failed.bbt, { reachable: false, error: "connect ECONNREFUSED" });
	const input = snapshot();
	const built = buildConnection(input);
	assert.notEqual(built.git, input.git);
	assert.notEqual(built.bbt, input.bbt);
});

test("plugin status derives from enabled state and contract support", () => {
	assert.equal(pluginStatus(true, [1, 2]), "ok");
	assert.equal(pluginStatus(null, [1, 2]), "ok");
	assert.equal(pluginStatus(true, [1]), "too-old");
	assert.equal(pluginStatus(true, []), "too-old");
	assert.equal(pluginStatus(false, [1, 2]), "off");
	assert.equal(pluginStatus(false, null), "off");
	assert.equal(pluginStatus(true, null), "unknown");
	assert.equal(pluginStatus(null, null), "unknown");
	const old = buildConnection(snapshot({ pluginVersion: "0.3.0", pluginApiVersions: [1] }));
	assert.deepEqual(old.plugin, { status: "too-old", version: "0.3.0", apiVersions: [1] });
	const off = buildConnection(snapshot({ pluginEnabled: false, pluginApiVersions: null, pluginVersion: null }));
	assert.deepEqual(off.plugin, { status: "off", version: null, apiVersions: null });
});

test("envelope shape and key order for success and failure", () => {
	const connection = buildConnection(snapshot());
	const ok = buildEnvelope("info", "Research", 2, connection, NOW);
	assert.deepEqual(Object.keys(ok), ["apiVersion", "contract", "apiVersions", "action", "vault", "ok", "checkedAt", "connection"]);
	assert.equal(ok.apiVersion, 2);
	assert.equal(ok.contract, 2);
	assert.deepEqual(ok.apiVersions, [1, 2]);
	assert.deepEqual(CONTRACT_API_VERSIONS, [1, 2]);
	assert.equal(ok.action, "info");
	assert.equal(ok.vault, "Research");
	assert.equal(ok.ok, true);
	assert.equal(ok.checkedAt, "2026-09-14T10:00:00.000Z");
	assert.equal(ok.connection, connection);
	assert.equal("reason" in ok, false);
	assert.equal("message" in ok, false);
	const v1 = buildEnvelope("connection", "Research", 1, connection, NOW);
	assert.equal(v1.apiVersion, 1);
	assert.equal(v1.contract, 2);
	const failed = buildEnvelope("resolve", "Research", 1, connection, NOW, { reason: "stale-index", message: "Index is stale." });
	assert.deepEqual(Object.keys(failed), ["apiVersion", "contract", "apiVersions", "action", "vault", "ok", "reason", "message", "checkedAt", "connection"]);
	assert.equal(failed.ok, false);
	assert.equal(failed.reason, "stale-index");
	assert.equal(failed.message, "Index is stale.");
	ok.apiVersions.push(3);
	assert.deepEqual(buildEnvelope("info", "Research", 2, connection, NOW).apiVersions, [1, 2]);
});

test("stale gate withholds negative verdicts only on a stale index without --allow-stale", () => {
	const fresh = buildConnection(snapshot());
	const stale = buildConnection(snapshot({}, { generatedAt: "2026-09-14T08:00:00.000Z" }));
	assert.equal(staleGate(fresh, false), false);
	assert.equal(staleGate(fresh, true), false);
	assert.equal(staleGate(stale, false), true);
	assert.equal(staleGate(stale, true), false);
});

test("info warnings cover git exposure, the legacy plugin and staleness in vocabulary order", () => {
	assert.deepEqual([...INFO_WARNINGS], ["index-in-git", "legacy-plugin-enabled", "index-stale"]);
	assert.deepEqual(infoWarnings(buildConnection(snapshot())), []);
	const exposed = infoWarnings(buildConnection(snapshot({ git: { repo: true, indexIgnored: false, cacheIgnored: false } })));
	assert.equal(exposed.length, 1);
	assert.equal(exposed[0].code, "index-in-git");
	assert.match(exposed[0].message, /zotero-index\.json/);
	assert.match(exposed[0].message, /\.cmds-zotero\//);
	const indexOnly = infoWarnings(buildConnection(snapshot({ git: { repo: true, indexIgnored: false, cacheIgnored: true } })));
	assert.equal(indexOnly.length, 1);
	assert.match(indexOnly[0].message, /zotero-index\.json/);
	assert.doesNotMatch(indexOnly[0].message, /\.cmds-zotero\//);
	const cacheOnly = infoWarnings(buildConnection(snapshot({ git: { repo: true, indexIgnored: true, cacheIgnored: false } })));
	assert.equal(cacheOnly.length, 1);
	assert.doesNotMatch(cacheOnly[0].message, /zotero-index\.json/);
	assert.match(cacheOnly[0].message, /\.cmds-zotero\//);
	assert.deepEqual(infoWarnings(buildConnection(snapshot({ git: { repo: false, indexIgnored: null, cacheIgnored: null } }))), []);
	assert.deepEqual(infoWarnings(buildConnection(snapshot({ git: { repo: true, indexIgnored: null, cacheIgnored: null } }))), []);
	assert.deepEqual(infoWarnings(buildConnection(snapshot({ git: null }))), []);
	const legacy = infoWarnings(buildConnection(snapshot({ legacyPluginEnabled: true })));
	assert.deepEqual(legacy.map(w => w.code), ["legacy-plugin-enabled"]);
	assert.match(legacy[0].message, /cmds-link-zotero/);
	const stale = infoWarnings(buildConnection(snapshot({}, { generatedAt: "2026-09-14T08:00:00.000Z" })));
	assert.deepEqual(stale.map(w => w.code), ["index-stale"]);
	assert.match(stale[0].message, /120 minutes old \(limit 60\)/);
	const all = infoWarnings(buildConnection(snapshot({ legacyPluginEnabled: true, git: { repo: true, indexIgnored: false, cacheIgnored: false } }, { generatedAt: "2026-09-14T08:00:00.000Z" })));
	assert.deepEqual(all.map(w => w.code), ["index-in-git", "legacy-plugin-enabled", "index-stale"]);
	assert.deepEqual(infoWarnings(buildConnection(snapshot({}, { source: "none", generatedAt: null, count: null, complete: null, schemaVersion: null }))), []);
});

test("incomplete and unknown-freshness indexes never prove absence, even with allow-stale", () => {
 for (const fields of [{complete:false}, {generatedAt:null}, {generatedAt:"2027-01-01T00:00:00Z"}]) {
  const c=buildConnection(snapshot({},fields));
  assert.equal(staleGate(c,true),true);
 }
 const c=buildConnection(snapshot({git:{repo:true,indexIgnored:true,cacheIgnored:true,indexTracked:true}}));
 assert.equal(c.git?.indexTracked,true);
 assert.equal(infoWarnings(c)[0].code,"index-in-git");
});
