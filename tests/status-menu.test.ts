// 0.6.1 index-status-menu: the status item's menu model, tooltip and status JSON (pure; no BBT call anywhere).
import test from "node:test";
import assert from "node:assert/strict";
import { statusJson, statusMenuItems, statusTooltip } from "../src/plugin/status-menu-model";
import type { StatusView } from "../src/agent/connection";

const NOW = new Date(2026, 9, 14, 12, 0, 0);
const FRESH: StatusView = { count: 450, ageMinutes: 5, stale: false, legacyPluginEnabled: false, bbt: { state: "ok", at: new Date(NOW.getTime() - 120_000).toISOString() } };

test("menu items: fixed order, only existing actions, refresh disabled while collecting or with the legacy plugin", () => {
	const idle = statusMenuItems({ collecting: false, legacyPluginEnabled: false });
	assert.deepEqual(idle.map(item => item.action), ["test-connection", "refresh-index", "diagnose-setup", "diagnose-links", "open-references", "open-annotations", "open-settings", "copy-status"]);
	assert.ok(idle.every(item => !item.disabled));
	const collecting = statusMenuItems({ collecting: true, legacyPluginEnabled: false });
	assert.deepEqual(collecting.filter(item => item.disabled).map(item => item.action), ["refresh-index"]);
	assert.equal(collecting[1].title, "Refreshing citekey index…");
	assert.deepEqual(statusMenuItems({ collecting: false, legacyPluginEnabled: true }).filter(item => item.disabled).map(item => item.action), ["refresh-index"]);
	assert.deepEqual(statusMenuItems({ collecting: false, legacyPluginEnabled: null }).filter(item => item.disabled), [], "an unknown plugin registry does not block");
});

test("tooltip: fresh, missing, stale, legacy and failed states", () => {
	const fresh = statusTooltip(FRESH, 60, NOW).split("\n");
	assert.deepEqual(fresh, ["Zotero index: 450 · 5 min old · BBT ok 2 min ago", "Click for actions."]);
	assert.match(statusTooltip({ ...FRESH, count: null, ageMinutes: null, stale: null }, 60, NOW), /No index is loaded yet/);
	const stale = statusTooltip({ ...FRESH, ageMinutes: 90, stale: true }, 60, NOW);
	assert.match(stale, /· stale ·/);
	assert.match(stale, /older than 60 minutes/);
	assert.match(statusTooltip({ ...FRESH, legacyPluginEnabled: true }, 60, NOW), /Disable the legacy cmds-link-zotero plugin/);
	const failed = statusTooltip({ ...FRESH, bbt: { state: "failed", at: NOW.toISOString(), reason: "connection-refused" } }, 60, NOW);
	assert.match(failed, /BBT failed 12:00/);
	assert.match(failed, /Test the connection/);
	// A citation pick that ran out of time is not recorded as a failure (tests/picker.test.ts), so health stays ok.
	assert.doesNotMatch(statusTooltip(FRESH, 60, NOW), /failed/);
});

test("status JSON is stable, vault-relative and carries the status line", () => {
	const json = JSON.parse(statusJson({ view: FRESH, pluginVersion: "0.6.1", indexPath: "80. References/zotero-index.json", generatedAt: "2026-10-14T02:55:00.000Z", complete: true, maxAgeMinutes: 60, collecting: false, now: NOW })) as Record<string, unknown>;
	assert.deepEqual(Object.keys(json), ["plugin", "checkedAt", "index", "legacyPluginEnabled", "bbt", "status"]);
	assert.deepEqual(json.plugin, { id: "cmds-zotero", version: "0.6.1" });
	assert.deepEqual(json.index, { path: "80. References/zotero-index.json", count: 450, generatedAt: "2026-10-14T02:55:00.000Z", ageMinutes: 5, stale: false, maxAgeMinutes: 60, complete: true, collecting: false });
	assert.equal(json.status, "Zotero index: 450 · 5 min old · BBT ok 2 min ago");
});
