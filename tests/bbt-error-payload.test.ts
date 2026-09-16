import test from "node:test";
import assert from "node:assert/strict";
import { runAction, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { BbtTransportError } from "../src/api/transport";
import { IndexRefusalError } from "../src/index-service";
import { DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";
import type { NoteRecord } from "../src/agent/types";

// 0.5 R4: the typed transport fault surfaces beside bibliographyReason/referencesReason and in refresh refusals.
const now = new Date("2026-09-14T10:00:00.000Z");
const entry: ZoteroIndexEntry = { id: "1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "smith2020", citekeyHistory: [], title: "Knowledge sharing", authors: ["Smith, Ann"], year: "2020", doi: "10.1000/Example", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {} };
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: now.toISOString(), source: "better-bibtex", count: 1, entries: [entry], capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const notes: NoteRecord[] = [{ path: "Questions/Q.md", basename: "Q", frontmatter: { type: "research-question" }, frontmatterParse: "ok" }];
const bodies = new Map([["Questions/Q.md", "[@smith2020]"]]);
const ENDPOINT = "http://127.0.0.1:23119/better-bibtex/json-rpc";
const refused = (): BbtTransportError => new BbtTransportError("connection-refused", ENDPOINT, "connect ECONNREFUSED 127.0.0.1:23119", { code: "ECONNREFUSED" });

function host(bibliography: ActionHost["bibliography"]): ActionHost {
	const connection = buildConnection({ mode: "live", obsidian: "ok", pluginVersion: "0.5.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: null }, index: { source: "plugin", path: "80. References/zotero-index.json", generatedAt: index.generatedAt, count: 1, complete: true, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now });
	return {
		vault: "Research", now, connection, settings: DEFAULT_SETTINGS, indexView: { index, stale: false, ageMinutes: 0 }, indexFailure: null,
		reader: { vaultName: () => "Research", scanWarnings: () => ({ skipped: [], truncated: false }), listNotes: async () => notes, readNote: async path => bodies.get(path) ?? "", exists: async path => bodies.has(path) },
		bibliography, bibliographyReason: null, vaultLinks: async () => ({ links: [], warnings: [] }),
		pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
	};
}

test("identity and cites add bbtError {reason, endpoint} beside the bbt-unreachable reason only for typed transport faults", async () => {
	const typed = host(async () => { throw refused(); });
	const identity = await runAction(typed, "identity", { citekey: "smith2020" }) as Record<string, unknown>;
	assert.equal(identity.ok, true, "bibliography failure never fails the identity verdict");
	assert.equal(identity.bibliography, null);
	assert.equal(identity.bibliographyReason, "bbt-unreachable");
	assert.deepEqual(identity.bbtError, { reason: "connection-refused", endpoint: ENDPOINT });
	const cites = await runAction(typed, "cites", { path: "Questions/Q.md", bibliography: true }) as Record<string, unknown>;
	assert.equal(cites.referencesReason, "bbt-unreachable");
	assert.deepEqual(cites.bbtError, { reason: "connection-refused", endpoint: ENDPOINT });

	const untyped = host(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:23119"); });
	const plain = await runAction(untyped, "identity", { citekey: "smith2020" }) as Record<string, unknown>;
	assert.equal(plain.bibliographyReason, "bbt-unreachable");
	assert.equal("bbtError" in plain, false);
	const plainCites = await runAction(untyped, "cites", { path: "Questions/Q.md", bibliography: true }) as Record<string, unknown>;
	assert.equal(plainCites.referencesReason, "bbt-unreachable");
	assert.equal("bbtError" in plainCites, false);

	const ok = await runAction(host(async () => "Smith (2020)."), "identity", { citekey: "smith2020" }) as Record<string, unknown>;
	assert.equal("bibliographyReason" in ok, false);
	assert.equal("bbtError" in ok, false);
	const disabled = await runAction(typed, "identity", { citekey: "smith2020", noBibliography: true }) as Record<string, unknown>;
	assert.equal(disabled.bibliographyReason, "disabled");
	assert.equal("bbtError" in disabled, false);
});

test("a refresh refused by the host keeps its contract reason and adds bbtError from the typed cause", async () => {
	const value = host(async () => null);
	value.refresh = async () => { throw new IndexRefusalError("bbt-unreachable", refused().message, refused()); };
	const result = await runAction(value, "refresh", {}) as Record<string, unknown>;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "bbt-unreachable");
	assert.equal(result.status, "unavailable");
	assert.match(String(result.message), /did not answer at .* \(connection refused\)/);
	assert.deepEqual(result.bbtError, { reason: "connection-refused", endpoint: ENDPOINT });
	value.refresh = async () => { throw new IndexRefusalError("legacy-plugin-enabled", "The legacy plugin is enabled."); };
	const legacy = await runAction(value, "refresh", {}) as Record<string, unknown>;
	assert.equal(legacy.reason, "legacy-plugin-enabled");
	assert.equal("bbtError" in legacy, false);
	value.refresh = async () => { throw new Error("Refusing to save invalid Zotero index"); };
	await assert.rejects(runAction(value, "refresh", {}), /Refusing to save invalid Zotero index/, "unclassified errors still propagate to the host envelope builder");
});
