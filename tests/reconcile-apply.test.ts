import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { applyReconcile, type ReconcileWriteHost } from "../src/reconcile-apply";
import { reconcileNotes, type ReconcileResult } from "../src/agent/reconcile-core";
import { BbtTransportError } from "../src/api/transport";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

const now = new Date("2026-09-14T10:00:00.000Z");
const entry: ZoteroIndexEntry = { id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "smith2020", citekeyHistory: [], title: "Synthetic", authors: ["Smith, A"], year: "2020", doi: "10.1000/example", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {} };
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: now.toISOString(), source: "better-bibtex", count: 1, entries: [entry], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const initial = "---\ntype: paper-hub\ncitekey: smith2020\ndoi: 10.1000/example\nowner: human\n---\nHuman body\n";
const PATH = "Hubs/smith2020/Hub.md";

/** A hand-formatted hub no parse/stringify pass reproduces: quoted scalars, a folded description, comments, lists, trailing whitespace. */
const handFormatted = [
	"---",
	"type: paper-hub",
	"title: \"Synthetic: a study\"",
	"citekey: \"smith2020\"",
	"citekeyProvisional: true",
	"doi: \"10.1000/example\"",
	"authors:",
	"  - \"Smith, A\"",
	"tags: [paper, hub]",
	"owner: human  ",
	"description: >-",
	"  Folded text that a stringify pass would",
	"  fold differently.",
	"# managed by reconcile",
	"zoteroStatus: not-found # offline",
	"---",
	"Human body  ",
	"",
].join("\n");

function plan(source = initial, yaml: (text: string) => unknown = parse): ReconcileResult {
	const fm = yaml(/^---\n([\s\S]*?)\n---/.exec(source)![1]) as Record<string, unknown>;
	const result = reconcileNotes([{ path: PATH, basename: "Hub", frontmatter: fm, frontmatterParse: "ok", body: source }], index, { name: "Research", pdfPaths: [] }, { now, stale: false, allowStale: false });
	(result.notes[0] as typeof result.notes[0] & { sourceHash: string }).sourceHash = createHash("sha256").update(source).digest("hex");
	return result;
}

function fakeHost(options: { mutateBeforeCallback?: boolean; mutateBodyAfter?: boolean; text?: string } = {}): ReconcileWriteHost & { text: string } {
	const file = { path: PATH, basename: "Hub" };
	const host = {
		text: options.text ?? initial,
		read: async () => host.text,
		file: path => path === file.path ? file : null,
		canWrite: () => true,
		process: async (_file, change) => {
			// An external editor landing between the dry-run and the callback: the callback sees the newer bytes.
			if (options.mutateBeforeCallback) host.text = host.text.replace("owner: human", "owner: other-editor");
			host.text = change(host.text);
			if (options.mutateBodyAfter) host.text += "external edit\n";
		},
		snapshot: async () => ({ index, indexValid: true, indexComplete: true, indexFresh: true, live: true, bbtReachable: true, legacyPluginEnabled: false, vault: "Research", pdfPaths: [], now }),
		yaml: { parse, stringify },
	} satisfies ReconcileWriteHost & { text: string };
	return host;
}

test("apply appends the five allowed identity keys in order and preserves body and non-allowed fields byte for byte", async () => {
	const host = fakeHost();
	const result = await applyReconcile(host, plan());
	assert.equal(result.mode, "applied");
	assert.equal(result.applied, 1);
	assert.equal(host.text, "---\ntype: paper-hub\ncitekey: smith2020\ndoi: 10.1000/example\nowner: human\ncitekeyProvisional: false\nzoteroID: 1:ITEM0001\nzoteroSelectURI: zotero://select/library/items/ITEM0001\nzoteroStatus: resolved\nzoteroCheckedAt: \"2026-09-14T10:00:00.000Z\"\n---\nHuman body\n");
	assert.deepEqual(result.notes[0].replacedKeys, []);
	assert.deepEqual(result.notes[0].appendedKeys, ["citekeyProvisional", "zoteroID", "zoteroSelectURI", "zoteroStatus", "zoteroCheckedAt"]);
	assert.deepEqual(result.notes[0].changedKeys, result.notes[0].appendedKeys);
});

// 0.5 R8 (F04): hand-formatted YAML that fails a parse/stringify round trip is patched line by line.
test("a hand-formatted hub applies: only the key lines change, every other byte (quotes, folding, comments, list, trailing spaces) is preserved", async () => {
	const host = fakeHost({ text: handFormatted });
	const result = await applyReconcile(host, plan(handFormatted));
	assert.equal(result.mode, "applied", JSON.stringify(result.notes));
	assert.equal(result.notes[0].wrote, true);
	assert.deepEqual(result.notes[0].replacedKeys, ["citekeyProvisional", "zoteroStatus"]);
	assert.deepEqual(result.notes[0].appendedKeys, ["zoteroID", "zoteroSelectURI", "zoteroCheckedAt"]);
	const expected = handFormatted
		.replace("citekeyProvisional: true\n", "citekeyProvisional: false\n")
		.replace("zoteroStatus: not-found # offline\n---", "zoteroStatus: resolved # offline\nzoteroID: 1:ITEM0001\nzoteroSelectURI: zotero://select/library/items/ITEM0001\nzoteroCheckedAt: \"2026-09-14T10:00:00.000Z\"\n---");
	assert.equal(host.text, expected);
	assert.notEqual(stringify(parse(/^---\n([\s\S]*?)\n---/.exec(handFormatted)![1])).trimEnd(), /^---\n([\s\S]*?)\n---/.exec(handFormatted)![1], "the fixture must not survive a round trip, or the test proves nothing");
	// A second run over the written note proposes nothing, so nothing is attempted and the timestamp does not churn.
	const second = plan(host.text);
	assert.equal(second.notes[0].proposed, null);
	const again = await applyReconcile(host, second);
	assert.deepEqual([again.mode, again.attempted, again.notes], ["applied", 0, []]);
	assert.equal(host.text, expected);
});

test("source changes before the write and inside the write callback are refused as changed-since-plan without rollback", async () => {
	const changed = fakeHost();
	changed.text += "external\n";
	const first = await applyReconcile(changed, plan());
	assert.equal(first.notes[0].reason, "changed-since-plan");
	assert.equal(first.notes[0].wrote, false);

	const raced = fakeHost({ mutateBeforeCallback: true });
	const second = await applyReconcile(raced, plan());
	assert.equal(second.notes[0].status, "skipped");
	assert.equal(second.notes[0].reason, "changed-since-plan");
	assert.equal(second.notes[0].wrote, false);
	assert.match(second.notes[0].message ?? "", /between the dry-run and the write callback/);
	assert.match(raced.text, /owner: other-editor/);
	assert.doesNotMatch(raced.text, /zoteroID/);
	assert.equal(second.integrityFailure, false, "an edit by someone else is not our write");
});

test("a refusal inside the write callback stays a skip even when another editor changes the note right after it", async () => {
	const source = "---\ntype: paper-hub\ncitekey: smith2020\nzoteroStatus: not-found\ndoi: 10.1000/example\nzoteroStatus: unavailable\n---\nbody\n";
	const lenient = (text: string): unknown => parse(text, { uniqueKeys: false });
	const host = fakeHost({ text: source });
	host.yaml = { parse: lenient, stringify };
	const write = host.process;
	host.process = async (file, change) => { try { await write(file, change); } finally { host.text += "edited elsewhere\n"; } };
	const result = await applyReconcile(host, plan(source, lenient));
	assert.deepEqual([result.notes[0].status, result.notes[0].reason, result.notes[0].wrote], ["skipped", "frontmatter-not-patchable", false]);
	assert.equal(result.integrityFailure, false);
	assert.equal(host.text, `${source}edited elsewhere\n`);
});

test("a quoted spelling of an allowed key is refused instead of being duplicated", async () => {
	const source = "---\ntype: paper-hub\ncitekey: smith2020\ndoi: 10.1000/example\n\"zoteroStatus\": not-found\n---\nbody\n";
	const host = fakeHost({ text: source });
	const result = await applyReconcile(host, plan(source));
	assert.equal(result.notes[0].reason, "frontmatter-not-patchable");
	assert.match(result.notes[0].message ?? "", /quoted-key \(zoteroStatus\)/);
	assert.equal(host.text, source);
});

// 0.5 R8: a duplicate allowed key can never be patched safely; a lenient parser (Obsidian tolerates duplicates) must not hide it.
test("a duplicated allowed key refuses the note as frontmatter-not-patchable and writes nothing", async () => {
	const source = "---\ntype: paper-hub\ncitekey: smith2020\nzoteroStatus: not-found\ndoi: 10.1000/example\nzoteroStatus: unavailable\n---\nbody\n";
	const lenient = (text: string): unknown => parse(text, { uniqueKeys: false });
	const host = fakeHost({ text: source });
	host.yaml = { parse: lenient, stringify };
	const result = await applyReconcile(host, plan(source, lenient));
	assert.equal(result.mode, "partial");
	assert.equal(result.notes[0].status, "skipped");
	assert.equal(result.notes[0].reason, "frontmatter-not-patchable");
	assert.match(result.notes[0].message ?? "", /duplicate-key \(zoteroStatus\)/);
	assert.equal(result.notes[0].wrote, false);
	assert.equal(host.text, source);
});

test("a multi-line allowed value refuses the note as frontmatter-not-patchable", async () => {
	const source = "---\ntype: paper-hub\ncitekey: smith2020\ndoi: 10.1000/example\nzoteroCheckedAt: >-\n  2026-01-01T00:00:00.000Z\n---\nbody\n";
	const host = fakeHost({ text: source });
	const result = await applyReconcile(host, plan(source));
	assert.equal(result.notes[0].reason, "frontmatter-not-patchable");
	assert.match(result.notes[0].message ?? "", /multiline-value \(zoteroCheckedAt\)/);
	assert.equal(host.text, source);
});

test("post-write body mismatch is a truthful integrity failure", async () => {
	const host = fakeHost({ mutateBodyAfter: true });
	const result = await applyReconcile(host, plan());
	assert.equal(result.mode, "partial");
	assert.equal(result.integrityFailure, true);
	assert.equal(result.notes[0].status, "integrity-failure");
	assert.equal(result.notes[0].wrote, true);
	assert.match(result.notes[0].message ?? "", /the body changed/);
	assert.match(result.limitation, /compare-and-swap/);
});

test("post-write verification catches a non-allowed key that changed under the write", async () => {
	const host = fakeHost();
	const write = host.process;
	host.process = async (file, change) => { await write(file, change); host.text = host.text.replace("owner: human", "owner: robot"); };
	const result = await applyReconcile(host, plan());
	assert.equal(result.notes[0].status, "integrity-failure");
	assert.match(result.notes[0].message ?? "", /outside the allowed set changed/);
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
	assert.ok(host.text.includes(`zoteroCheckedAt: "${later.toISOString()}"`));
});

test("unavailable post-write verification retains an unknown outcome and fails closed", async () => {
	const host = fakeHost();
	const write = host.process;
	let persisted = false;
	host.process = async (file, change) => { await write(file, change); persisted = true; };
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

test("freshness expiring inside the write callback aborts before the patch", async t => {
	const host = fakeHost();
	const snapshot = host.snapshot;
	const write = host.process;
	let clock = 0;
	t.mock.method(Date, "now", () => clock);
	host.snapshot = async () => ({ ...await snapshot(), expiresAt: 100 });
	host.process = async (file, change) => { clock = 200; await write(file, change); };
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

// 0.5 R4 (F16): a throwing snapshot is unusable evidence, not a BBT outage.
test("snapshot exceptions refuse as index-invalid with the message; only a typed transport error is bbt-unreachable", async () => {
	const storage = fakeHost();
	storage.snapshot = async () => { throw new Error("Index file could not be read: EACCES"); };
	const refused = await applyReconcile(storage, plan());
	assert.equal(refused.mode, "refused");
	assert.equal(refused.refusedReason, "index-invalid");
	assert.notEqual(refused.refusedReason, "bbt-unreachable");
	assert.equal(refused.refusedMessage, "Index file could not be read: EACCES");
	assert.equal(refused.attempted, 0);
	assert.match(storage.text, /owner: human/);

	const transport = fakeHost();
	transport.snapshot = async () => { throw new BbtTransportError("connection-refused", "http://127.0.0.1:23119/better-bibtex/json-rpc", "connect ECONNREFUSED 127.0.0.1:23119", { code: "ECONNREFUSED" }); };
	const unreachable = await applyReconcile(transport, plan());
	assert.equal(unreachable.refusedReason, "bbt-unreachable");
	assert.match(unreachable.refusedMessage ?? "", /did not answer at http:\/\/127\.0\.0\.1:23119\/better-bibtex\/json-rpc \(connection refused\)/);

	const opaque = fakeHost();
	opaque.snapshot = async () => { throw "not an Error object"; };
	const stringy = await applyReconcile(opaque, plan());
	assert.equal(stringy.refusedReason, "index-invalid");
	assert.equal(stringy.refusedMessage, "not an Error object");
	// A snapshot that resolves with BBT unreachable still refuses with the gate reason and no message.
	const gated = fakeHost();
	const base = await gated.snapshot();
	gated.snapshot = async () => ({ ...base, bbtReachable: false });
	const gateRefusal = await applyReconcile(gated, plan());
	assert.equal(gateRefusal.refusedReason, "bbt-unreachable");
	assert.equal("refusedMessage" in gateRefusal, false);
});
