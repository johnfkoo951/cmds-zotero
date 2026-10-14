import test from "node:test";
import assert from "node:assert/strict";
import { parseProtocolRequest } from "../src/protocol";
import { ZOTERO_SCRIPT_TARGETS, zoteroActionScript, zoteroScriptURL, type ZoteroScriptTarget } from "../src/zotero-script";

// 0.6.1 zotero-menu-actions-recipe: the Actions & Tags customScript, run here against fake Zotero items. Synthetic records only.

interface FakeItem { libraryID: number; key: string; regular: boolean; parentItem?: FakeItem; isRegularItem: () => boolean }
const regular = (libraryID: number, key: string): FakeItem => ({ libraryID, key, regular: true, isRegularItem() { return this.regular; } });
const child = (parent: FakeItem, key: string): FakeItem => ({ libraryID: parent.libraryID, key, regular: false, parentItem: parent, isRegularItem() { return false; } });

type AsyncScript = (item: unknown, items: unknown, require: (name: string) => unknown) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => AsyncScript;

/** Runs the script the way Actions & Tags does (an async function body with `item`, `items` and `require`) and records what it launches. */
async function run(script: string, item: unknown, items: unknown): Promise<{ launched: string[]; alerts: string[] }> {
	const launched: string[] = [];
	const alerts: string[] = [];
	const zotero = { launchURL: (url: string) => { launched.push(url); }, getMainWindow: () => ({ alert: (message: string) => { alerts.push(message); } }) };
	await new AsyncFunction("item", "items", "require", script)(item, items, name => { assert.equal(name, "Zotero"); return zotero; });
	return { launched, alerts };
}

/** What Obsidian hands the protocol handler for a launched link. */
function handlerParams(url: string): Record<string, string> {
	const parsed = new URL(url);
	assert.equal(parsed.protocol, "obsidian:");
	assert.equal(parsed.host, "cmds-zotero");
	return { action: "cmds-zotero", ...Object.fromEntries(parsed.searchParams) };
}

test("every target's launched link round-trips through parseProtocolRequest", async () => {
	for (const { target } of ZOTERO_SCRIPT_TARGETS) {
		const { launched } = await run(zoteroActionScript("Research", target), regular(1, "ABCD2345"), null);
		assert.deepEqual(launched, [zoteroScriptURL("Research", target, 1, "ABCD2345")]);
		assert.deepEqual(parseProtocolRequest(handlerParams(launched[0]), "Research"), { vault: "Research", libraryID: 1, itemKey: "ABCD2345", target, page: undefined, annotation: undefined });
	}
});

test("the vault name is escaped in the script and encoded in the link", async () => {
	for (const vault of ["Thesis \"draft\" \\ notes", "연구 노트 & 'quotes'", "a\u2028b</script>", "50% done?#"]) {
		const script = zoteroActionScript(vault, "import");
		assert.ok(script.includes(`const VAULT = ${JSON.stringify(vault).replace(/\u2028/g, "\\u2028")};`));
		assert.ok(!script.includes("\u2028"), "no raw line separator in the script text");
		const { launched } = await run(script, regular(3, "WXYZ0001"), null);
		const params = handlerParams(launched[0]);
		assert.equal(params.vault, vault);
		if (!/[\0\r\n]/.test(vault)) assert.equal(parseProtocolRequest(params, vault).vault, vault);
	}
});

test("Actions & Tags' all-items-then-each-item runs launch once, for the parent item", async () => {
	const script = zoteroActionScript("V", "note");
	const paper = regular(1, "ABCD2345");
	const pdf = child(paper, "PDFA0001");
	const annotation = child(pdf, "ANNO0001");
	// Menu with one item: first run with `items`, then the per-item run with `items` empty.
	assert.deepEqual((await run(script, undefined, [paper])).launched.length, 1);
	assert.deepEqual((await run(script, paper, [])).launched, []);
	// An event (`items` null), a reader menu on the attachment, and an annotation all stand for the parent.
	for (const target of [paper, pdf, annotation]) {
		const { launched } = await run(script, target, null);
		assert.deepEqual(launched, [zoteroScriptURL("V", "note", 1, "ABCD2345")]);
	}
	// The paper and its PDF selected together are one item.
	assert.equal((await run(script, undefined, [paper, pdf])).launched.length, 1);
});

test("several items launch nothing and name the Obsidian command; nothing selected does nothing", async () => {
	for (const { target, command } of ZOTERO_SCRIPT_TARGETS) {
		const { launched, alerts } = await run(zoteroActionScript("V", target), undefined, [regular(1, "AAAA0001"), regular(1, "BBBB0002")]);
		assert.deepEqual(launched, []);
		assert.equal(alerts.length, 1);
		assert.ok(alerts[0].includes(`"${command}"`));
	}
	assert.deepEqual(await run(zoteroActionScript("V", "note"), null, []), { launched: [], alerts: [] });
	assert.deepEqual(await run(zoteroActionScript("V", "note"), null, null), { launched: [], alerts: [] });
	const orphan: FakeItem = { libraryID: 1, key: "NOTE0001", regular: false, isRegularItem: () => false };
	assert.deepEqual(await run(zoteroActionScript("V", "note"), orphan, null), { launched: [], alerts: [] }, "a standalone note has no parent to open");
});

test("an unknown target is refused", () => {
	assert.throws(() => zoteroActionScript("V", "pdf" as ZoteroScriptTarget), /Unknown script target/);
});
