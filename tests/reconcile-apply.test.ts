import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { applyReconcile, type ReconcileWriteHost } from "../src/reconcile-apply";
import { reconcileNotes, type ReconcileResult } from "../src/agent/reconcile-core";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

const now = new Date("2026-09-14T10:00:00.000Z");
const entry: ZoteroIndexEntry = { id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "smith2020", citekeyHistory: [], title: "Synthetic", authors: ["Smith, A"], year: "2020", doi: "10.1000/example", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {} };
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: now.toISOString(), source: "better-bibtex", count: 1, entries: [entry], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const initial = "---\ntype: paper-hub\ncitekey: smith2020\ndoi: 10.1000/example\nowner: human\n---\nHuman body\n";

function plan(source = initial): ReconcileResult {
	const fm = parse(/^---\n([\s\S]*?)\n---/.exec(source)![1]) as Record<string, unknown>;
	const result = reconcileNotes([{ path: "Hubs/smith2020/Hub.md", basename: "Hub", frontmatter: fm, frontmatterParse: "ok", body: source }], index, { name: "Research", pdfPaths: [] }, { now, stale: false, allowStale: false });
	(result.notes[0] as typeof result.notes[0] & { sourceHash: string }).sourceHash = createHash("sha256").update(source).digest("hex");
	return result;
}

function fakeHost(options: { mutateBeforeCallback?: boolean; mutateBodyAfter?: boolean } = {}): ReconcileWriteHost & { text: string } {
	const file = { path: "Hubs/smith2020/Hub.md", basename: "Hub" };
	const host = {
		text: initial,
		read: async () => host.text,
		file: path => path === file.path ? file : null,
		canWrite: () => true,
		processFrontMatter: async (_file, change) => {
			const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(host.text)!;
			const fm = parse(match[1]) as Record<string, unknown>;
			if (options.mutateBeforeCallback) fm.owner = "other-editor";
			change(fm);
			host.text = `---\n${stringify(fm).trimEnd()}\n---\n${match[2]}`;
			if (options.mutateBodyAfter) host.text += "external edit\n";
		},
		snapshot: async () => ({ index, indexValid: true, indexComplete: true, indexFresh: true, live: true, bbtReachable: true, legacyPluginEnabled: false, vault: "Research", pdfPaths: [], now }),
		yaml: { parse, stringify },
	};
	return host;
}

test("apply writes only the five allowed identity keys and preserves body/nonallowed fields", async () => {
	const host = fakeHost();
	const result = await applyReconcile(host, plan());
	assert.equal(result.mode, "applied");
	assert.equal(result.applied, 1);
	assert.match(host.text, /owner: human/);
	assert.match(host.text, /Human body/);
	assert.doesNotMatch(host.text, /citekey: smith2020\n.*citekey:/s);
	assert.match(host.text, /zoteroID: 1:ITEM0001/);
	assert.match(host.text, /zoteroStatus: resolved/);
});

test("source changes and callback-time frontmatter races are refused without rollback", async () => {
	const changed = fakeHost();
	changed.text += "external\n";
	const first = await applyReconcile(changed, plan());
	assert.equal(first.notes[0].reason, "changed-since-plan");
	assert.equal(first.notes[0].wrote, false);

	const raced = fakeHost({ mutateBeforeCallback: true });
	const second = await applyReconcile(raced, plan());
	assert.equal(second.notes[0].reason, "write-error");
	assert.equal(second.notes[0].wrote, false);
	assert.match(raced.text, /owner: human/);
});

test("post-write body mismatch is a truthful integrity failure", async () => {
	const host = fakeHost({ mutateBodyAfter: true });
	const result = await applyReconcile(host, plan());
	assert.equal(result.mode, "partial");
	assert.equal(result.integrityFailure, true);
	assert.equal(result.notes[0].status, "integrity-failure");
	assert.equal(result.notes[0].wrote, true);
	assert.match(result.limitation, /compare-and-swap/);
});

test("lifecycle guard prevents a late write after unload or reconfigure", async () => {
	const host = fakeHost();
	host.canWrite = () => false;
	const result = await applyReconcile(host, plan());
	assert.equal(result.applied, 0);
	assert.equal(result.notes[0].wrote, false);
	assert.match(result.notes[0].message ?? "", /unloaded or reconfigured/);
	assert.equal(host.text, initial);
});

test("unknown or unsafe apply preconditions fail closed", async () => {
	const host = fakeHost();
	host.snapshot = async () => ({ index, indexValid: true, indexComplete: true, indexFresh: true, live: true, bbtReachable: true, legacyPluginEnabled: null, vault: "Research", pdfPaths: [], now });
	const result = await applyReconcile(host, plan());
	assert.equal(result.mode, "refused");
	assert.equal(result.refusedReason, "legacy-plugin-enabled");
});

test("each file rechecks freshness after the queue and source read", async () => {
	const host = fakeHost();
	const snapshot = host.snapshot;
	let calls = 0;
	host.snapshot = async () => ({ ...await snapshot(), indexFresh: ++calls === 1 });
	const result = await applyReconcile(host, plan());
	assert.equal(result.mode, "partial");
	assert.equal(result.notes[0].reason, "stale-index");
	assert.equal(host.text, initial);
	assert.equal(calls, 2);
});

test("revalidated write time may advance without changing the approved material proposal", async () => {
	const host = fakeHost();
	const snapshot = host.snapshot;
	const later = new Date(now.getTime() + 1000);
	host.snapshot = async () => ({ ...await snapshot(), now: later });
	const result = await applyReconcile(host, plan());
	assert.equal(result.applied, 1);
	assert.ok(host.text.includes(later.toISOString()));
});

test("unavailable post-write verification retains an unknown outcome and fails closed", async () => {
	const host = fakeHost();
	const write = host.processFrontMatter;
	let persisted = false;
	host.processFrontMatter = async (file, change) => { await write(file, change); persisted = true; };
	host.read = async () => { if (persisted) throw new Error("verification read failed"); return host.text; };
	const result = await applyReconcile(host, plan());
	assert.equal(result.mode, "partial");
	assert.equal(result.integrityFailure, true);
	assert.equal(result.notes[0].wrote, null);
	assert.equal(result.notes[0].reason, "verification-unavailable");
	assert.match(host.text, /zoteroID/);
});

test("pre-write read failures are reported per file, not thrown out of the batch", async () => {
	const host = fakeHost();
	host.read = async () => { throw new Error("note disappeared"); };
	const result = await applyReconcile(host, plan());
	assert.equal(result.mode, "partial");
	assert.equal(result.failed, 1);
	assert.equal(result.notes[0].wrote, false);
});

test("round-trip guard does not hide meaningful trailing whitespace", async () => {
	const source = initial.replace("owner: human\n", "owner: human  \n");
	const host = fakeHost();
	host.text = source;
	const result = await applyReconcile(host, plan(source));
	assert.equal(result.notes[0].reason, "yaml-roundtrip-unsafe");
	assert.equal(host.text, source);
});

test("freshness expiring inside processFrontMatter aborts before assignments", async t => {
	const host = fakeHost();
	const snapshot = host.snapshot;
	const write = host.processFrontMatter;
	let clock = 0;
	t.mock.method(Date, "now", () => clock);
	host.snapshot = async () => ({ ...await snapshot(), expiresAt: 100 });
	host.processFrontMatter = async (file, change) => { clock = 200; await write(file, change); };
	const result = await applyReconcile(host, plan());
	assert.equal(result.notes[0].status, "failed");
	assert.match(result.notes[0].message ?? "", /expired/);
	assert.equal(host.text, initial);
});

test("same-path concurrent applies serialize and reject the superseded source", async () => {
	const host = fakeHost();
	const proposal = plan();
	const results = await Promise.all([applyReconcile(host, proposal), applyReconcile(host, proposal)]);
	assert.equal(results.reduce((count, result) => count + result.applied, 0), 1);
	assert.ok(results.some(result => result.notes[0].reason === "changed-since-plan"));
});
