import test from "node:test";
import assert from "node:assert/strict";
import { IngestAPI } from "../src/ingest-api";
import { IndexService } from "../src/index-service";
import { normalizeEntry } from "../src/api/normalize";
import type { BbtService } from "../src/bbt";
import type { ZoteroIndex } from "../src/types";

function service(capabilities: () => Promise<unknown>) {
	return new IngestAPI({ vault: { getName: () => "Research" } } as never, { capabilities } as never, {} as never, {} as never, async () => {});
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("jobs acknowledge immediately, timestamp, and consume completed results once", async () => {
	let finish!: (value: unknown) => void;
	const api = service(() => new Promise(resolve => { finish = resolve; }));
	const id = api.startJob("connection");
	const pending = api.getJob(id);
	assert.equal(pending.state, "pending");
	assert.ok(Date.parse(pending.createdAt));
	finish({ zotero: "example", betterbibtex: "example" });
	await tick();
	const completed = api.getJob(id);
	assert.equal(completed.state, "completed");
	assert.ok(completed.finishedAt && Date.parse(completed.finishedAt));
	assert.equal((completed.result as { vault: string }).vault, "Research");
	assert.match(api.getJob(id).error ?? "", /consumed/);
});

test("failed jobs remain inspectable and invalid actions fail before acceptance", async () => {
	const api = service(async () => { throw new Error("Offline"); });
	const id = api.startJob("connection");
	await tick();
	assert.equal(api.getJob(id).state, "failed");
	assert.equal(api.getJob(id).error, "Offline");
	assert.throws(() => api.startJob("write-library" as never));
	assert.throws(() => api.startJob("info", { refresh: true }), /Unsupported/);
});

test("capacity counts all unconsumed jobs and never evicts pending work", () => {
	const api = service(() => new Promise(() => {}));
	const ids = Array.from({ length: 16 }, () => api.startJob("connection"));
	assert.throws(() => api.startJob("connection"), /Too many/);
	assert.equal(api.getJob(ids[0]).state, "pending");
});

test("terminal TTL pruning never evicts pending jobs", () => {
	const api = service(() => new Promise(() => {}));
	const pending = api.startJob("connection");
	const internals = api as unknown as { jobs: Map<string, { state: "failed"; createdAt: string; finishedAt: string; error: string }> };
	internals.jobs.set("old-terminal", { state: "failed", createdAt: "2020-01-01T00:00:00.000Z", finishedAt: "2020-01-01T00:00:00.000Z", error: "old" });
	assert.equal(api.getJob("old-terminal").error?.includes("expired"), true);
	assert.equal(api.getJob(pending).state, "pending");
});

test("dispose prevents late completion from resurrecting a job", async () => {
	let finish!: (value: unknown) => void;
	const api = service(() => new Promise(resolve => { finish = resolve; }));
	const id = api.startJob("connection");
	api.dispose();
	finish({ zotero: "7", betterbibtex: "7" });
	await tick();
	assert.equal(api.getJob(id).state, "failed");
	assert.equal(api.busy, false);
});

const parent = { libraryID: 1, citationKey: "Example2026", itemKey: "ABCD2345", uri: "http://zotero.org/users/local/Example/items/ABCD2345", itemType: "journalArticle", title: "Synthetic example", date: "2026", creators: [{ firstName: "Example", lastName: "Author" }], tags: [], attachments: [], notes: [] };
const snapshot = (ageMinutes: number): ZoteroIndex => ({ schemaVersion: 2, generatedAt: new Date(Date.now() - ageMinutes * 60000).toISOString(), source: "better-bibtex", count: 1, entries: [normalizeEntry(parent)], capabilities: { zotero: "8", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true });

/** A hostless API over a real IndexService whose collect blocks until `release()` (or throws when `fail` is set). */
function indexed(stored: ZoteroIndex | null, options: { fail?: Error } = {}) {
	let release = () => {};
	let collections = 0;
	const bbt = { collect: async () => { collections++; await new Promise<void>(resolve => { release = resolve; }); if (options.fail) throw options.fail; return snapshot(0); } } as unknown as BbtService;
	const index = new IndexService(bbt, { read: async () => stored ? JSON.stringify(stored) : null, writeValidated: async () => undefined }, () => 60);
	const api = new IngestAPI({ vault: { getName: () => "Research" } } as never, bbt, index, {} as never, async () => {});
	return { api, index, release: () => release(), collections: () => collections };
}

test("busy covers forced refreshes and any collection that will write the index; a snapshot read never blocks", async () => {
	const fresh = indexed(snapshot(1));
	const read = fresh.api.ensureIndex();
	assert.equal(fresh.api.activeCount, 1, "a read is counted as active");
	assert.equal(fresh.api.busy, false, "a read served from a fresh snapshot is not a write");
	assert.equal((await read).reason, "fresh");
	assert.equal(fresh.api.activeCount, 0);
	assert.equal(fresh.collections(), 0);

	const stale = indexed(snapshot(120));
	const warm = stale.api.ensureIndex();
	while (!stale.index.collecting) await tick();
	assert.equal(stale.api.busy, true, "a non-forced read that collects blocks reconfiguration while the collection runs");
	assert.equal(stale.api.activeCount, 1);
	stale.release();
	assert.equal((await warm).reason, "stale");
	assert.equal(stale.api.busy, false);
	assert.equal(stale.api.activeCount, 0);

	const forced = stale.api.ensureIndex(true);
	assert.equal(stale.api.busy, true, "a forced refresh is busy from the moment it is requested");
	while (!stale.index.collecting) await tick();
	stale.release();
	assert.equal((await forced).reason, "forced");
	assert.equal(stale.api.busy, false);
});

test("the hostless refresh job never reports a stale-fallback as success, whatever the flag", async () => {
	const offline = new Error("connect ECONNREFUSED 127.0.0.1:23119");
	for (const request of [{}, { ifOlderThanMinutes: 30 }]) {
		const { api, index, release } = indexed(snapshot(120), { fail: offline });
		const id = api.startJob("refresh", request);
		while (!index.collecting) await tick();
		release();
		await tick(); await tick();
		const job = api.getJob(id);
		assert.equal(job.state, "failed", `refresh ${JSON.stringify(request)} fails instead of publishing the stale snapshot`);
		assert.match(job.error ?? "", /ECONNREFUSED/);
	}
});
