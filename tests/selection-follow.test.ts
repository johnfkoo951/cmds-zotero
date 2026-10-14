// 0.6.1 follow-zotero-selection: the selection poller with an injected clock. Pure; no Zotero and no timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_BACKOFF_MS, SelectionPoller, followConfig, selectionSignature, type FollowConfig } from "../src/library/selection-follow";
import { normalizeSettings } from "../src/settings-data";
import type { SelectedItem } from "../src/library/selection";

// Synthetic records only (AGENTS.md).
const item = (itemKey: string, libraryID = 1): SelectedItem => ({ libraryID, itemKey, citekey: `synthetic${itemKey.toLowerCase()}`, title: "Synthetic", itemType: "journalArticle" });
const focus: FollowConfig = { mode: "focus", intervalMs: 10_000 };
const every: FollowConfig = { mode: "interval", intervalMs: 5_000 };

function harness(answers: (() => Promise<SelectedItem[]>)[]) {
	let now = 1_000_000;
	let calls = 0;
	const poller = new SelectionPoller(() => now);
	const read = (): Promise<SelectedItem[]> => { const answer = answers[Math.min(calls, answers.length - 1)]; calls++; return answer(); };
	return { poller, read, calls: () => calls, advance: (ms: number) => { now += ms; } };
}

test("focus mode: one read per focus; ticks never read; an unchanged selection is no event", async () => {
	const h = harness([() => Promise.resolve([item("ITEM0001")])]);
	assert.deepEqual(await h.poller.poll("tick", focus, true, h.read), { kind: "skipped", reason: "not-due" });
	assert.equal(h.calls(), 0);
	const first = await h.poller.poll("focus", focus, true, h.read);
	assert.equal(first.kind, "changed");
	assert.equal(h.calls(), 1, "one read");
	assert.deepEqual(await h.poller.poll("focus", focus, true, h.read), { kind: "unchanged" });
	assert.equal(h.calls(), 2);
});

test("interval mode: reads when due, on focus too; off and hidden never read", async () => {
	const h = harness([() => Promise.resolve([item("ITEM0001")]), () => Promise.resolve([item("ITEM0002")])]);
	assert.equal((await h.poller.poll("tick", every, true, h.read)).kind, "changed");
	h.advance(4_999);
	assert.deepEqual(await h.poller.poll("tick", every, true, h.read), { kind: "skipped", reason: "not-due" });
	h.advance(1);
	const second = await h.poller.poll("tick", every, true, h.read);
	assert.deepEqual(second.kind === "changed" ? second.items.map(row => row.itemKey) : second, ["ITEM0002"]);
	assert.equal((await h.poller.poll("focus", every, true, h.read)).kind, "unchanged", "focus reads even before the interval");
	h.advance(60_000);
	assert.deepEqual(await h.poller.poll("tick", every, false, h.read), { kind: "skipped", reason: "hidden" }, "a hidden sidebar stops polling");
	assert.deepEqual(await h.poller.poll("focus", { ...every, mode: "off" }, true, h.read), { kind: "skipped", reason: "off" });
	assert.equal(h.calls(), 3);
});

test("a failed read pauses polling for 60 s, then polling resumes", async () => {
	const h = harness([() => Promise.reject(new Error("refused")), () => Promise.resolve([item("ITEM0001")])]);
	const failed = await h.poller.poll("focus", every, true, h.read);
	assert.equal(failed.kind, "failed");
	assert.equal(failed.kind === "failed" ? failed.resumeAt : 0, 1_000_000 + FOLLOW_BACKOFF_MS);
	assert.ok(h.poller.paused());
	h.advance(FOLLOW_BACKOFF_MS - 1);
	assert.deepEqual(await h.poller.poll("focus", every, true, h.read), { kind: "skipped", reason: "paused" });
	assert.deepEqual(await h.poller.poll("tick", every, true, h.read), { kind: "skipped", reason: "paused" });
	assert.equal(h.calls(), 1);
	h.advance(1);
	assert.ok(!h.poller.paused());
	assert.equal((await h.poller.poll("tick", every, true, h.read)).kind, "changed");
});

test("one read at a time; remember and reset decide what counts as a change", async () => {
	let release: (items: SelectedItem[]) => void = () => {};
	const h = harness([() => new Promise(resolve => { release = resolve; })]);
	const pending = h.poller.poll("focus", focus, true, h.read);
	assert.deepEqual(await h.poller.poll("focus", focus, true, h.read), { kind: "skipped", reason: "busy" });
	release([item("ITEM0001")]);
	assert.equal((await pending).kind, "changed");
	const g = harness([() => Promise.resolve([item("ITEM0002"), item("ITEM0001")])]);
	g.poller.remember([item("ITEM0001"), item("ITEM0002")]);
	assert.equal((await g.poller.poll("focus", focus, true, g.read)).kind, "unchanged", "a manual read is remembered; order is ignored");
	g.poller.reset();
	assert.equal((await g.poller.poll("focus", focus, true, g.read)).kind, "changed", "following switched on again reports the selection");
	assert.equal(selectionSignature([item("ITEM0001", 2), item("ITEM0001")]), "1:ITEM0001 2:ITEM0001", "library-scoped identities");
	assert.equal(selectionSignature([]), "", "an empty selection is a selection too");
});

test("settings: off by default, 3–30 s, unknown values fall back", () => {
	assert.deepEqual(followConfig(normalizeSettings({})), { mode: "off", intervalMs: 10_000 });
	assert.deepEqual(followConfig(normalizeSettings({ followZoteroSelection: "interval", followZoteroSelectionSeconds: 3 })), { mode: "interval", intervalMs: 3_000 });
	assert.equal(normalizeSettings({ followZoteroSelection: "listen" }).followZoteroSelection, "off");
	assert.equal(normalizeSettings({ followZoteroSelectionSeconds: 1 }).followZoteroSelectionSeconds, 10);
	assert.equal(normalizeSettings({ followZoteroSelectionSeconds: 31 }).followZoteroSelectionSeconds, 10);
	assert.deepEqual(followConfig({ followZoteroSelection: "focus", followZoteroSelectionSeconds: 90 }), { mode: "focus", intervalMs: 30_000 });
	assert.deepEqual(followConfig({}), { mode: "off", intervalMs: 10_000 });
});
