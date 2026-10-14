// 0.6 OPT-13: the References sidebar's bibliography pass. No BBT probe per edit while Zotero was just found not answering,
// one offline verdict and one fallback per item for each render generation, and a Refresh that asks BBT again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type { ZoteroIndexEntry } from "../src/types";
import type { BibliographyDetail } from "../src/bibliography-store";

/** BibliographyController bundled against a mock `obsidian` and a mock `vault-storage` (the sidecar lives in memory). */
async function loadController(): Promise<new (plugin: unknown) => { configure(): void; bibliographyBatch(entries: ZoteroIndexEntry[], style?: string, options?: { fresh?: boolean; refresh?: boolean }): Promise<BibliographyDetail[]> }> {
	const bundled = await build({ entryPoints: ["src/plugin/bibliography-controller.ts"], bundle: true, platform: "node", format: "esm", write: false, plugins: [{
		name: "mock-host", setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
			b.onResolve({ filter: /vault-storage$/ }, () => ({ path: "storage", namespace: "mock" }));
			b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian"
				? "export class TFile {} export class Notice {} export class Editor {}"
				: "export function bibliographySidecarStorage(app) { return app.sidecar; } export async function assertVaultBoundary() {} export async function ensureCmdsIgnore() {} export async function ensureDirectory() {}" }));
		},
	}] });
	const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`) as { BibliographyController: never };
	return module.BibliographyController;
}

// Synthetic records only (AGENTS.md).
const entry = (id: string, contentHash = `hash-${id}`): ZoteroIndexEntry => ({ id, contentHash, citekey: id.toLowerCase(), citekeyHistory: [], title: `Title ${id}`, authors: ["Doe, Jane"], year: "2020" }) as ZoteroIndexEntry;
const record = (text: string, contentHash: string, bbtVersion: string) => ({ contentHash, bbtVersion, text, renderedAt: "2026-09-01T10:00:00.000Z" });

interface Outcome { ok: boolean; at: Date; reason?: string; message?: string }

/** A host whose BBT is up or down on demand; it records outcomes the way BbtService does. */
function host(sidecar: Record<string, ReturnType<typeof record>>) {
	const bbt = {
		down: false,
		probes: 0,
		renders: [] as string[],
		lastOutcome: null as Outcome | null,
		fail(reason = "connection-refused"): never {
			const error = Object.assign(new Error(`Zotero/Better BibTeX did not answer (${reason}). Start Zotero, then retry.`), { reason });
			bbt.lastOutcome = { ok: false, at: new Date(), reason, message: error.message };
			throw error;
		},
		capabilities: async (options: { timeoutMs?: number }): Promise<unknown> => {
			bbt.probes++;
			assert.equal(options.timeoutMs, 2500, "the pre-batch probe keeps its short bound");
			if (bbt.down) bbt.fail();
			bbt.lastOutcome = { ok: true, at: new Date() };
			return { zotero: "7", betterbibtex: "7.0.1" };
		},
		bibliography: async (item: ZoteroIndexEntry): Promise<string> => {
			bbt.renders.push(item.id);
			if (bbt.down) bbt.fail();
			bbt.lastOutcome = { ok: true, at: new Date() };
			return `Live ${item.id}.`;
		},
	};
	const text = JSON.stringify({ version: 1, styles: { apa: sidecar } });
	const plugin = {
		active: true,
		bbt,
		settings: { bibliographyStyle: "apa", concurrency: 2 },
		lastIndex: { capabilities: { betterbibtex: "7.0.1" } },
		app: { sidecar: { read: async () => text, write: async () => undefined } },
	};
	return { plugin, bbt };
}

const recent = (reason: string, ageMs: number): Outcome => ({ ok: false, at: new Date(Date.now() - ageMs), reason, message: `Zotero/Better BibTeX did not answer (${reason}).` });

test("0.6 OPT-13: a recent 'not answering' failure serves sidecar or fallback text with no probe; other or older failures probe", async () => {
	const BibliographyController = await loadController();
	const cachedEntry = entry("1:CACHED01");
	const { plugin, bbt } = host({ [cachedEntry.id]: record("Doe (2020). Cached.", cachedEntry.contentHash, "7.0.1") });
	const controller = new BibliographyController(plugin);
	controller.configure();
	const rows = [cachedEntry, entry("1:MISSING1")];
	bbt.down = true;
	bbt.lastOutcome = recent("connection-refused", 5_000);
	for (let edit = 0; edit < 3; edit++) {
		const details = await controller.bibliographyBatch(rows);
		assert.deepEqual(details.map(detail => [detail.source, detail.text]), [["cached", "Doe (2020). Cached."], ["fallback", ""]]);
	}
	assert.equal(bbt.probes, 0, "no connection attempt per edit while Zotero was just found not answering");
	assert.deepEqual(bbt.renders, []);
	for (const reason of ["timeout", "http-404"]) {
		bbt.lastOutcome = recent(reason, 1_000);
		await controller.bibliographyBatch(rows);
		assert.equal(bbt.probes, 0, `${reason} counts as not answering`);
	}
	// An RPC fault for one item says nothing about the next request: the probe runs (and fails here).
	bbt.lastOutcome = recent("rpc", 1_000);
	await controller.bibliographyBatch(rows);
	assert.equal(bbt.probes, 1);
	// Outside the 60 s window the probe runs again; with Zotero back the missing row renders live.
	bbt.down = false;
	bbt.lastOutcome = recent("connection-refused", 61_000);
	const back = await controller.bibliographyBatch(rows);
	assert.equal(bbt.probes, 2);
	assert.deepEqual(back.map(detail => detail.source), ["cached", "live"]);
	// Nothing pending (memory and sidecar answer every row): no probe at all, as before.
	bbt.lastOutcome = recent("connection-refused", 1_000);
	await controller.bibliographyBatch(rows);
	assert.equal(bbt.probes, 2);
});

test("0.6 OPT-13: a generation decides offline once; a copy joining it neither probes again nor recomputes a fallback", async () => {
	const BibliographyController = await loadController();
	const { plugin, bbt } = host({});
	const controller = new BibliographyController(plugin);
	controller.configure();
	const rows = [entry("1:AAAA0001"), entry("1:BBBB0001")];
	bbt.down = true;
	const render = await controller.bibliographyBatch(rows);
	assert.equal(bbt.probes, 1);
	assert.deepEqual(render.map(detail => detail.source), ["fallback", "fallback"]);
	// Zotero answers again, but the copy joins the same render generation: same verdict, the same fallback answers.
	bbt.down = false;
	bbt.lastOutcome = null;
	const copy = await controller.bibliographyBatch(rows, undefined, { fresh: false });
	assert.equal(bbt.probes, 1, "the joined generation does not probe again");
	assert.deepEqual(bbt.renders, []);
	assert.ok(copy.every((detail, index) => detail === render[index]), "the generation's fallback answers are reused");
	// The next render generation decides again, and Zotero answers now.
	const next = await controller.bibliographyBatch(rows);
	assert.equal(bbt.probes, 2);
	assert.deepEqual(next.map(detail => detail.source), ["live", "live"]);
});

test("0.6 OPT-13: Refresh probes despite a recent failure and reads texts again unless they came live from BBT", async () => {
	const BibliographyController = await loadController();
	const live = entry("1:LIVE0001");
	const older = entry("1:OLDER001");
	const { plugin, bbt } = host({ [older.id]: record("Doe (2020). Rendered by an older BBT.", older.contentHash, "6.9.0") });
	const controller = new BibliographyController(plugin);
	controller.configure();
	await controller.bibliographyBatch([live]);
	assert.deepEqual(bbt.renders, [live.id]);
	// Zotero closes: the older rendering is served (and remembered) with the fault; the live text stays in memory.
	bbt.down = true;
	bbt.lastOutcome = recent("connection-refused", 1_000);
	const offline = await controller.bibliographyBatch([live, older]);
	assert.deepEqual(offline.map(detail => detail.source), ["live", "cached"]);
	assert.ok(offline[1].error, "the cached text says why it was served");
	// Zotero is back but the failure is recent: an ordinary render keeps serving the remembered text without a probe.
	bbt.down = false;
	const probesBefore = bbt.probes;
	assert.deepEqual((await controller.bibliographyBatch([live, older])).map(detail => detail.text), ["Live 1:LIVE0001.", "Doe (2020). Rendered by an older BBT."]);
	assert.equal(bbt.probes, probesBefore);
	// Refresh: probes despite the recent failure, renders the row that was not live, keeps the live one.
	const refreshed = await controller.bibliographyBatch([live, older], undefined, { refresh: true });
	assert.equal(bbt.probes, probesBefore + 1);
	assert.deepEqual(bbt.renders, [live.id, older.id], "only the row that was not live asked BBT again");
	assert.deepEqual(refreshed.map(detail => [detail.source, detail.text]), [["live", "Live 1:LIVE0001."], ["live", "Live 1:OLDER001."]]);
	// Refresh when every row is live: nothing to ask, so no probe and no rendering.
	await controller.bibliographyBatch([live, older], undefined, { refresh: true });
	assert.equal(bbt.probes, probesBefore + 1);
	assert.equal(bbt.renders.length, 2);
});
