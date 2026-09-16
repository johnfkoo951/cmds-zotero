import test from "node:test";
import assert from "node:assert/strict";
import { IngestAPI, JOB_TIMEOUT_MS } from "../src/ingest-api";
import { LocalFileError } from "../src/local-file";
import { PdfExtractError, type PdfExtractErrorCode } from "../src/pdf/errors";
import { buildConnection } from "../src/agent/connection";
import { DEFAULT_SETTINGS } from "../src/types";
import type { ActionHost } from "../src/agent/actions";
import { IndexService } from "../src/index-service";
import { normalizeEntry } from "../src/api/normalize";
import type { BbtService } from "../src/bbt";
import type { ZoteroIndex } from "../src/types";

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

// 0.5 R13/F05: UI resolve never runs the agent resolve action (whole-vault note scan, git probe) behind a click.
test("resolve() always answers from the in-memory snapshot and never builds an agent host", async () => {
	const stored = snapshot(1);
	const bbt = { collect: async () => snapshot(0) } as unknown as BbtService;
	const index = new IndexService(bbt, { read: async () => JSON.stringify(stored), writeValidated: async () => undefined }, () => 60);
	let hosts = 0;
	const api = new IngestAPI({ vault: { getName: () => "Research" } } as never, bbt, index, {} as never, async () => {}, async () => { hosts++; throw new Error("the host factory must not be used for UI resolve"); });
	const byKey = await api.resolve({ citekey: "Example2026" });
	assert.equal(byKey.status, "resolved");
	assert.equal((byKey as { entry: { itemKey: string } }).entry.itemKey, "ABCD2345");
	const byItem = await api.resolve({ itemKey: "ABCD2345", libraryID: 1 });
	assert.equal(byItem.status, "resolved");
	assert.equal((await api.resolve({ citekey: "missing" })).status, "not-found");
	assert.equal(hosts, 0);
	// Agents still get the full action through the job path.
	api.startJob("resolve", { citekey: "Example2026" });
	await tick();
	assert.equal(hosts, 1);
});

// 0.5 R13/F08: failure reasons come from typed errors and the request, not from message text.

function failingHost(overrides: Partial<ActionHost>): ActionHost {
	const now = new Date("2026-09-16T00:00:00.000Z");
	const stored = snapshot(1);
	const connection = buildConnection({ mode: "live", obsidian: "ok", pluginVersion: "0.5.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: null }, index: { source: "plugin", path: "80. References/zotero-index.json", generatedAt: stored.generatedAt, count: 1, complete: true, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now });
	const host: ActionHost = {
		vault: "Research", now, connection, settings: DEFAULT_SETTINGS, indexView: { index: stored, stale: false, ageMinutes: 1 }, indexFailure: null,
		reader: { vaultName: () => "Research", scanWarnings: () => ({ skipped: [], truncated: false }), listNotes: async () => [], readNote: async () => "", exists: async () => false },
		bibliography: null, bibliographyReason: null, vaultLinks: async () => ({ links: [], warnings: [] }),
		pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
		extractPdf: async () => { throw new Error("unused"); },
		...overrides,
	};
	return host;
}

async function reasonOf(host: ActionHost, action: "pdf-text" | "locate" | "reconcile" | "cites", request: object): Promise<string | undefined> {
	const api = new IngestAPI({ vault: { getName: () => "Research" } } as never, {} as never, {} as never, {} as never, async () => {}, async () => host);
	const id = api.startJob(action, request);
	await tick(); await tick();
	const job = api.getJob(id);
	assert.equal(job.state, "completed", job.error);
	return (job.result as { reason?: string }).reason;
}

test("oversized and non-PDF vault files report pdf-too-large and pdf-invalid by error code", async () => {
	const tooLarge = failingHost({ pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => { throw new LocalFileError("too-large", "PDF size 73400320 exceeds the 67108864 byte limit"); } } });
	assert.equal(await reasonOf(tooLarge, "pdf-text", { file: "Attachments/huge.pdf" }), "pdf-too-large");
	assert.equal(await reasonOf(tooLarge, "locate", { file: "Attachments/huge.pdf", quote: "a long enough quote to locate" }), "pdf-too-large");
	const notPdf = failingHost({ pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => { throw new LocalFileError("bad-magic", "PDF content does not match the expected format"); } } });
	assert.equal(await reasonOf(notPdf, "pdf-text", { file: "Attachments/fake.pdf" }), "pdf-invalid");
});

test("typed extraction failures map by code: pdfjs-unavailable, pdf-invalid, pdf-too-large, and invalid-request for a cancelled publication", async () => {
	const expectations: [PdfExtractErrorCode, string][] = [
		["pdfjs-unavailable", "pdfjs-unavailable"], ["unreadable", "pdf-invalid"], ["too-many-pages", "pdf-invalid"], ["no-pages", "pdf-invalid"],
		["invalid-cache", "pdf-invalid"], ["cache-too-large", "pdf-too-large"], ["cancelled", "invalid-request"],
	];
	for (const [code, reason] of expectations) {
		// The message deliberately avoids every word the last-resort pattern would key on.
		const host = failingHost({ pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => ({ sha256: "a".repeat(64), absolutePath: "/synthetic/vault/x.pdf" }) }, extractPdf: async () => { throw new PdfExtractError(code, "synthetic failure"); } });
		assert.equal(await reasonOf(host, "pdf-text", { file: "x.pdf" }), reason, code);
	}
});

test("reconcile errors are apply-failed only when a write was requested; other action errors are invalid-request", async () => {
	const broken = failingHost({ reader: { vaultName: () => "Research", listNotes: async () => { throw new Error("Note exceeds 2 MiB: Hubs/big.md"); }, readNote: async () => "", exists: async () => false } });
	assert.equal(await reasonOf(broken, "reconcile", {}), "invalid-request");
	assert.equal(await reasonOf(broken, "reconcile", { apply: false }), "invalid-request");
	assert.equal(await reasonOf(broken, "reconcile", { apply: true }), "apply-failed");
	// A message that merely mentions PDFs does not classify a non-PDF action.
	const mentionsPdf = failingHost({ reader: { vaultName: () => "Research", listNotes: async () => { throw new Error("PDF extraction wording inside a cites failure"); }, readNote: async () => "", exists: async () => false } });
	assert.equal(await reasonOf(mentionsPdf, "cites", { path: "Q.md" }), "invalid-request");
});

// 0.5 R13/F18: a job that never settles is failed by its per-action timeout and releases the write gate.

function fakeTimers() {
	const scheduled = new Map<number, { callback: () => void; ms: number }>();
	let next = 1;
	return {
		scheduled,
		timers: { setTimeout: (callback: () => void, ms: number) => { const handle = next++; scheduled.set(handle, { callback, ms }); return handle; }, clearTimeout: (handle: unknown) => { scheduled.delete(handle as number); } },
		fire(): void { for (const [handle, entry] of [...scheduled]) { scheduled.delete(handle); entry.callback(); } },
	};
}

test("per-action timeouts default to 900 s for pdf-text and 300 s otherwise", () => {
	assert.equal(JOB_TIMEOUT_MS["pdf-text"], 900_000);
	for (const action of ["connection", "info", "refresh", "resolve", "identity", "cites", "reconcile", "diagnostics", "locate"] as const) assert.equal(JOB_TIMEOUT_MS[action], 300_000);
});

test("a hung write job times out, is reported as failed, releases busy, and a late settlement is ignored", async () => {
	const clock = fakeTimers();
	let finish!: (value: unknown) => void;
	const host = failingHost({ extractPdf: () => new Promise(resolve => { finish = resolve as never; }), pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => ({ sha256: "a".repeat(64), absolutePath: "/synthetic/vault/x.pdf" }) } });
	const api = new IngestAPI({ vault: { getName: () => "Research" } } as never, {} as never, { collecting: false } as never, {} as never, async () => {}, async () => host, { timers: clock.timers });
	const id = api.startJob("pdf-text", { file: "x.pdf" });
	assert.equal(api.busy, true);
	assert.deepEqual(api.pendingWrites(), [{ id, action: "pdf-text" }]);
	// Let the job reach the hung extraction before the timeout fires.
	while (!finish) await tick();
	assert.equal([...clock.scheduled.values()][0]?.ms, 900_000);
	clock.fire();
	const job = api.getJob(id);
	assert.equal(job.state, "failed");
	assert.match(job.error ?? "", /timed out after 900 s \(pdf-text\)/);
	assert.match(job.error ?? "", /inspect the current state/);
	assert.equal(api.busy, false, "the write gate is released on timeout");
	assert.equal(api.activeCount, 0);
	assert.deepEqual(api.pendingWrites(), []);
	// The extraction eventually settles: the failed verdict stands and the counters are not decremented twice.
	finish({ cache: { path: "x", hit: false, evicted: [] }, extracted: {}, truncatedPages: [], warnings: [] });
	await tick(); await tick();
	assert.equal(api.getJob(id).state, "failed");
	assert.equal(api.activeCount, 0);
	assert.equal(api.busy, false);
	assert.equal(api.ackJob(id), true);
});

test("a job that settles in time clears its timer and reads never appear in pendingWrites", async () => {
	const clock = fakeTimers();
	const api = new IngestAPI({ vault: { getName: () => "Research" } } as never, { capabilities: async () => ({ zotero: "7", betterbibtex: "7" }) } as never, { collecting: false } as never, {} as never, async () => {}, undefined, { timers: clock.timers, timeoutMs: { connection: 5 } });
	const id = api.startJob("connection");
	assert.equal(clock.scheduled.size, 1);
	assert.equal([...clock.scheduled.values()][0]?.ms, 5, "per-action overrides apply");
	assert.deepEqual(api.pendingWrites(), [], "a read never holds the write gate");
	await tick();
	assert.equal(api.getJob(id).state, "completed");
	assert.equal(clock.scheduled.size, 0, "the timer is cleared on settlement");
	clock.fire();
	assert.equal(api.getJob(id).state, "completed", "a stale timer cannot fail a completed job");
	// A hung read-only job times out with read-only wording: nothing to inspect, just resubmit.
	const hungRead = new IngestAPI({ vault: { getName: () => "Research" } } as never, { capabilities: () => new Promise(() => {}) } as never, { collecting: false } as never, {} as never, async () => {}, undefined, { timers: clock.timers, timeoutMs: { connection: 5 } });
	const readId = hungRead.startJob("connection");
	clock.fire();
	assert.equal(hungRead.getJob(readId).state, "failed");
	assert.match(hungRead.getJob(readId).error ?? "", /timed out after 0 s \(connection\)\. The request was read-only/);
	assert.doesNotMatch(hungRead.getJob(readId).error ?? "", /may still have completed/);
	assert.equal(hungRead.activeCount, 0);
	// dispose clears outstanding timers.
	const hung = new IngestAPI({ vault: { getName: () => "Research" } } as never, { capabilities: () => new Promise(() => {}) } as never, { collecting: false } as never, {} as never, async () => {}, undefined, { timers: clock.timers });
	hung.startJob("connection");
	assert.equal(clock.scheduled.size, 1);
	hung.dispose();
	assert.equal(clock.scheduled.size, 0);
});
