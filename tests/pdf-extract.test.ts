import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type { PdfCacheStore } from "../src/pdf/extract";

async function moduleForTest() {
	const result = await build({ stdin: { contents: 'export * from "./src/pdf/extract.ts"; export { state } from "obsidian";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, plugins: [{
		name: "pdf-fake-host", setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
			builder.onResolve({ filter: /local-file$/ }, () => ({ path: "local-file", namespace: "mock" }));
			builder.onResolve({ filter: /vault-storage$/ }, () => ({ path: "storage", namespace: "mock" }));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "obsidian"
				? `export class App{}; export class FileSystemAdapter{}; export const state={loads:0,destroys:0,fail:false,text:'x'.repeat(200001),pages:1}; export async function loadPdfJs(){return {version:'test',getDocument(options){const data=options.data;state.options=options;state.loads++;structuredClone(data,{transfer:[data.buffer]});return {destroy:async()=>{state.destroys++},promise:state.fail?Promise.reject(new Error('load failure')):Promise.resolve({numPages:state.pages,getPageLabels:async()=>null,getPage:async()=>({getTextContent:async()=>({items:[{str:state.text,hasEOL:false}]}),cleanup(){}}),destroy:async()=>{state.destroys++}})}}}};`
				: args.path === "local-file" ? `export async function readLocalFile(){return {bytes:new Uint8Array(512).fill(7),mtimeMs:1234.5}};`
				: `export async function assertVaultBoundary(){}; export async function ensureCmdsIgnore(){}; export async function ensureDirectory(){};` }));
		},
	}] });
	return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
}

function storeFixture(): { store: PdfCacheStore; files: Map<string, string>; events: string[] } {
	const files = new Map<string, string>();
	const events: string[] = [];
	return { files, events, store: {
		exists: async path => files.has(path), read: async path => files.get(path)!,
		write: async (path, content) => { events.push("write"); files.set(path, content); },
		remove: async path => { files.delete(path); }, list: async () => [...files.keys()].map(path => path.split("/").pop()!),
		ensureDirectory: async () => {}, assertBoundary: async () => {}, ensureIgnore: async () => { events.push("ignore"); },
	} };
}

const scope = { kind: "attachment", libraryType: "user", libraryID: 1, attachmentKey: "ATTACH01", id: "1:ITEMKEY1", path: "/synthetic/paper.pdf" } as const;

test("pdf.js transferable input keeps byte metadata and cache hits retain truncation warnings", async () => {
	const { PdfTextService } = await moduleForTest();
	const fixture = storeFixture();
	const service = new PdfTextService({}, fixture.store);
	const first = await service.extract(scope);
	assert.equal(first.extracted.bytes, 512);
	assert.equal(first.cache.hit, false);
	assert.deepEqual(first.truncatedPages, [1]);
	assert.equal(first.warnings.length, 1);
	assert.deepEqual(fixture.events.slice(0, 2), ["ignore", "write"]);
	const hit = await service.extract(scope);
	assert.equal(hit.cache.hit, true);
	assert.equal(hit.warnings.length, 1);
	assert.equal(hit.extracted.pages[0].text.length, 200000);
});

test("a cache hash alone cannot claim a different source identity", async () => {
	const { PdfTextService } = await moduleForTest();
	const fixture = storeFixture();
	const service = new PdfTextService({}, fixture.store);
	const first = await service.extract(scope);
	const wrong = JSON.parse(fixture.files.get(first.cache.path)!);
	wrong.id = "1:OTHER001";
	fixture.files.set(first.cache.path, JSON.stringify(wrong));
	const rebuilt = await service.extract(scope);
	assert.equal(rebuilt.cache.hit, false);
	assert.equal(rebuilt.extracted.id, scope.id);
});

test("loading failure and oversized output destroy resources without cache publication", async () => {
	const { PdfTextService, state } = await moduleForTest();
	const fixture = storeFixture();
	const service = new PdfTextService({}, fixture.store);
	const before = state.destroys;
	state.fail = true;
	await assert.rejects(service.extract(scope), /load failure/);
	assert.equal(state.destroys, before + 1);
	state.fail = false;
	state.pages = 180;
	await assert.rejects(service.extract(scope), /32 MiB/);
	assert.equal(state.destroys, before + 2);
	assert.equal(fixture.files.size, 0);
	assert.equal(fixture.events.length, 0);
	state.pages = 1;
});

test("configuration replacement before publication cancels cache writes", async () => {
	const { PdfTextService } = await moduleForTest();
	const fixture = storeFixture();
	let active = true;
	fixture.store.ensureDirectory = async () => { active = false; };
	const service = new PdfTextService({}, fixture.store, () => active);
	await assert.rejects(service.extract(scope), /publication was cancelled/);
	assert.equal(fixture.files.size, 0);
	assert.ok(!fixture.events.includes("write"));
});

test("pdf.js receives Obsidian's bundled character maps and standard fonts so CJK text extracts", async () => {
	const { PdfTextService, PDFJS_RESOURCE_OPTIONS, state } = await moduleForTest();
	state.text = "synthetic";
	const service = new PdfTextService({}, storeFixture().store);
	await service.extract(scope, { force: true });
	assert.equal(state.options.cMapUrl, "/lib/pdfjs/cmaps/");
	assert.equal(state.options.cMapPacked, true);
	assert.equal(state.options.standardFontDataUrl, "/lib/pdfjs/standard_fonts/");
	assert.equal(state.options.isEvalSupported, false, "resource options never re-enable eval");
	assert.deepEqual(Object.keys(PDFJS_RESOURCE_OPTIONS).sort(), ["cMapPacked", "cMapUrl", "standardFontDataUrl"]);
});
