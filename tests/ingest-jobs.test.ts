import test from "node:test";
import assert from "node:assert/strict";
import { IngestAPI } from "../src/ingest-api";

function service(capabilities: () => Promise<unknown>) {
	return new IngestAPI({ vault: { getName: () => "Research" } } as never, { capabilities } as never, {} as never, {} as never, async () => {});
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("jobs acknowledge immediately, timestamp, and keep completed results until acknowledged", async () => {
	let finish!: (value: unknown) => void;
	const api = service(() => new Promise(resolve => { finish = resolve; }));
	const id = api.startJob("connection");
	const pending = api.getJob(id);
	assert.equal(pending.state, "pending");
	assert.ok(Date.parse(pending.createdAt));
	assert.equal(api.ackJob(id), false, "pending jobs cannot be acknowledged away");
	finish({ zotero: "example", betterbibtex: "example" });
	await tick();
	const completed = api.getJob(id);
	assert.equal(completed.state, "completed");
	assert.ok(completed.finishedAt && Date.parse(completed.finishedAt));
	assert.equal((completed.result as { vault: string }).vault, "Research");
	// A lost CLI delivery re-reads the same result; nothing is consumed by reading.
	const again = api.getJob(id);
	assert.equal(again.state, "completed");
	assert.deepEqual(again.result, completed.result);
	assert.equal(again.finishedAt, completed.finishedAt);
	assert.equal(api.ackJob(id), true);
	assert.equal(api.ackJob(id), false);
	assert.match(api.getJob(id).error ?? "", /consumed/);
});

test("acknowledging a failed job releases it and unknown ids are not acknowledged", async () => {
	const api = service(async () => { throw new Error("Offline"); });
	const id = api.startJob("connection");
	await tick();
	assert.equal(api.getJob(id).state, "failed");
	assert.equal(api.getJob(id).state, "failed", "failed jobs stay inspectable across reads");
	assert.equal(api.ackJob("never-issued"), false);
	assert.equal(api.ackJob(id), true);
	assert.match(api.getJob(id).error ?? "", /expired/);
});

test("unacknowledged completed jobs count toward capacity until acknowledged or pruned", async () => {
	const api = service(async () => ({ zotero: "7", betterbibtex: "7" }));
	const ids = Array.from({ length: 16 }, () => api.startJob("connection"));
	await tick();
	for (const id of ids) assert.equal(api.getJob(id).state, "completed");
	assert.throws(() => api.startJob("connection"), /Too many/);
	assert.equal(api.ackJob(ids[0]), true);
	api.startJob("connection");
	assert.throws(() => api.startJob("connection"), /Too many/);
	// TTL pruning still releases unacknowledged terminal jobs.
	const internals = api as unknown as { jobs: Map<string, { state: string; createdAt: string; finishedAt?: string }> };
	internals.jobs.set(ids[1], { ...internals.jobs.get(ids[1])!, finishedAt: "2020-01-01T00:00:00.000Z" });
	assert.match(api.getJob(ids[1]).error ?? "", /expired/);
	assert.doesNotThrow(() => api.startJob("connection"));
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
