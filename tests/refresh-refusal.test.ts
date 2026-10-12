import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { BbtService } from "../src/bbt";
import { IndexRefusalError, IndexService, describeRefreshFailure, refreshRefusal, type RefreshOutcome } from "../src/index-service";
import { isBbtTransportError } from "../src/api/transport";
import { runAction, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";
import { normalizeEntry } from "../src/api/normalize";
import { entryHash, validateIndex } from "../src/identity";

// 0.5 R4: the non-forced refresh path (stale-fallback) carries the typed transport cause, so a refused `refresh {ifOlderThanMinutes}`
// reports the same payload as a forced refusal of the same closed port, and the warm-up Notice gets the observation wording.

/** A port nothing listens on: bind, read the number, release. */
async function closedPort(): Promise<number> {
	const probe = net.createServer();
	await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("Probe did not expose a port");
	await new Promise<void>(resolve => probe.close(() => resolve()));
	return address.port;
}

/** A validated entry (as `collect` would persist it): normalized, hashed, so the stored index is a usable fallback. */
function entry(): ZoteroIndexEntry {
	const normalized = normalizeEntry({ libraryID: 1, citationKey: "smith2020", itemKey: "ITEM0001", uri: "http://zotero.org/users/local/Example/items/ITEM0001", itemType: "journalArticle", title: "Knowledge sharing", date: "2020", creators: [{ firstName: "Ann", lastName: "Smith" }], tags: [], attachments: [], notes: [] });
	normalized.contentHash = entryHash(normalized);
	return normalized;
}
function staleIndex(): ZoteroIndex {
	const index: ZoteroIndex = { schemaVersion: 2, generatedAt: new Date(Date.now() - 3 * 3600000).toISOString(), source: "better-bibtex", count: 1, entries: [entry()], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
	assert.ok(validateIndex(index), "the stored fixture must validate, or the non-forced path has no fallback to report");
	return index;
}

function offlineService(port: number, stored: ZoteroIndex | null): { bbt: BbtService; index: IndexService } {
	const bbt = new BbtService({ ...DEFAULT_SETTINGS, bbtEndpoint: `http://127.0.0.1:${port}`, requestTimeoutMs: 1000 });
	const index = new IndexService(bbt, { read: async () => stored ? JSON.stringify(stored) : null, writeValidated: async () => { throw new Error("must not write"); } }, () => 60);
	return { bbt, index };
}

/** The live host's refresh handler, as plugin/agent-host.ts and ingest-api.ts rebuild it: a stale-fallback is a refusal carrying the outcome's cause. */
function hostFor(index: IndexService, stored: ZoteroIndex): ActionHost {
	const now = new Date();
	const connection = buildConnection({ mode: "live", obsidian: "ok", pluginVersion: "0.5.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: null }, index: { source: "plugin", path: "80. References/zotero-index.json", generatedAt: stored.generatedAt, count: 1, complete: true, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now });
	const host: ActionHost = {
		vault: "Research", now, connection, settings: DEFAULT_SETTINGS, indexView: { index: stored, stale: true, ageMinutes: 180 }, indexFailure: null,
		reader: { vaultName: () => "Research", listNotes: async () => [], readNote: async () => "", exists: async () => false },
		bibliography: async () => null, bibliographyReason: null, vaultLinks: async () => ({ links: [], warnings: [] }),
		pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
	};
	host.refresh = async request => {
		const outcome = await index.refresh({ force: request.ifOlderThanMinutes === undefined, ...(request.ifOlderThanMinutes ? { ifOlderThanMs: request.ifOlderThanMinutes * 60000 } : {}) });
		if (outcome.reason === "stale-fallback") throw refreshRefusal(outcome);
		return { host, refreshed: outcome.refreshed, reason: outcome.reason, ageMinutesBefore: outcome.ageMinutesBefore };
	};
	return host;
}

test("a stale-fallback outcome carries the typed transport cause and refreshRefusal rebuilds the forced-path refusal from it", async () => {
	const port = await closedPort();
	const stored = staleIndex();
	const { bbt, index } = offlineService(port, stored);
	try {
		const outcome = await index.refresh({ force: false, ifOlderThanMs: 10 * 60000 });
		assert.equal(outcome.reason, "stale-fallback");
		assert.equal(outcome.failure, "bbt-unreachable");
		assert.ok(isBbtTransportError(outcome.cause), "the raw collection error rides on the outcome");
		assert.equal(outcome.cause.reason, "connection-refused");
		assert.equal(outcome.cause.endpoint, `http://127.0.0.1:${port}/json-rpc`);
		const rebuilt = refreshRefusal(outcome);
		assert.ok(rebuilt instanceof IndexRefusalError);
		assert.equal(rebuilt.reason, "bbt-unreachable");
		assert.equal(rebuilt.cause, outcome.cause);
		assert.match(rebuilt.message, /did not answer at .* \(connection refused\)/);
		// The warm-up Notice built from the rebuilt refusal uses the observation wording, not the legacy endpoint-parameter sentence.
		assert.equal(describeRefreshFailure(rebuilt, "http://settings-endpoint", 180), `Zotero/Better BibTeX did not answer at http://127.0.0.1:${port}/json-rpc (connection refused); using the saved index from 3 h ago.`);
		const forced = await index.refresh({ force: true }).then(() => null, (error: unknown) => error);
		assert.ok(forced instanceof IndexRefusalError);
		assert.equal(forced.reason, rebuilt.reason);
		assert.ok(isBbtTransportError(forced.cause));
		assert.equal(forced.cause.reason, outcome.cause.reason);
		assert.equal(forced.message, rebuilt.message, "one fault, one message on both paths");
	} finally { bbt.dispose(); }
});

test("refreshRefusal keeps a gate refusal, an already-typed refusal cause and a plain error as before", () => {
	const base: RefreshOutcome = { index: staleIndex(), refreshed: false, reason: "stale-fallback", ageMinutesBefore: 180 };
	const gate = refreshRefusal({ ...base, error: "Legacy plugin enabled.", failure: "legacy-plugin-enabled" });
	assert.ok(gate instanceof IndexRefusalError);
	assert.equal(gate.reason, "legacy-plugin-enabled");
	assert.equal(gate.cause, undefined);
	const typed = new IndexRefusalError("legacy-plugin-enabled", "Refused by the collector.");
	assert.equal(refreshRefusal({ ...base, error: typed.message, failure: typed.reason, cause: typed }), typed, "a refusal thrown by the collector is rethrown as-is");
	const plain = refreshRefusal({ ...base, error: "Malformed BBT search item", cause: new Error("Malformed BBT search item") });
	assert.ok(!(plain instanceof IndexRefusalError));
	assert.equal(plain.message, "Malformed BBT search item");
	assert.equal(refreshRefusal(base).message, "The index could not be refreshed.");
});

test("refresh {ifOlderThanMinutes} and a forced refresh against a closed port return the same reason and bbtError", async () => {
	const port = await closedPort();
	const stored = staleIndex();
	const { bbt, index } = offlineService(port, stored);
	try {
		const host = hostFor(index, stored);
		const nonForced = await runAction(host, "refresh", { ifOlderThanMinutes: 10 }) as Record<string, unknown>;
		assert.equal((await index.refresh({ force: false, ifOlderThanMs: 10 * 60000 })).reason, "stale-fallback", "the non-forced path keeps the saved index and reports the fault beside it");
		assert.equal(nonForced.ok, false);
		assert.equal(nonForced.reason, "bbt-unreachable");
		assert.equal(nonForced.status, "unavailable");
		assert.deepEqual(nonForced.bbtError, { reason: "connection-refused", endpoint: `http://127.0.0.1:${port}/json-rpc` });
		const forced = await runAction(host, "refresh", {}) as Record<string, unknown>;
		assert.equal(forced.reason, nonForced.reason);
		assert.deepEqual(forced.bbtError, nonForced.bbtError);
		assert.equal(forced.message, nonForced.message);
	} finally { bbt.dispose(); }
});
