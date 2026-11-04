// Issue #4 (0.6.8 export-result-tones): the end of an export against a stand-in for Obsidian and for the processes
// (pandoc, the default app, Hookmark). A clean run is a Notice only; a warning or a failure opens the toned report.
// Synthetic paths and citekeys only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findAll, loadWithMockObsidian, settle, textOf, ui, type MockEl, type MockModal } from "./obsidian-ui-mock";
import type { PandocRunSummary } from "../src/export/run";

const RUNNER = `
export async function runPandoc(setting, defaultsPath, folder) { const r = globalThis.__runner; r.runs.push({ setting, defaultsPath, folder }); return r.next(); }
export async function openWithDefaultApp(path) { const r = globalThis.__runner; r.opened.push(path); return r.openProblem; }
export async function linkInHookmark(docxPath, noteURI) { const r = globalThis.__runner; r.linked.push({ docxPath, noteURI }); return r.hookmarkProblem; }
`;

type Run = { kind: "ok"; pandoc: string; summary: PandocRunSummary } | { kind: "failed"; pandoc: string | null; message: string; summary?: PandocRunSummary };
interface Runner { runs: unknown[]; opened: string[]; linked: unknown[]; openProblem: string | null; hookmarkProblem: string | null; next: () => Run }
const runner = (): Runner => (globalThis as unknown as { __runner: Runner }).__runner;
const clipboard: string[] = [];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } } });

const FOLDER = "/vault/exports/Draft (Word)";
const DOCX = `${FOLDER}/Draft.docx`;
const clean: PandocRunSummary = { missing: [], ambiguous: [], other: [] };

async function setup(options: { pandocAfterExport?: boolean; hookmark?: boolean; reachable?: boolean; runs?: Run[]; openProblem?: string | null; hookmarkProblem?: string | null; word?: boolean } = {}) {
	const { ReferencesController } = await loadWithMockObsidian<{ ReferencesController: new (plugin: unknown) => unknown }>('export { ReferencesController } from "./src/plugin/references-controller";', { "export-runner$": RUNNER });
	ui.__notices = [];
	ui.__modals = [];
	ui.__settings = [];
	clipboard.length = 0;
	const runs = [...(options.runs ?? [{ kind: "ok", pandoc: "/opt/homebrew/bin/pandoc", summary: clean }])];
	(globalThis as unknown as { __runner: Runner }).__runner = { runs: [], opened: [], linked: [], openProblem: options.openProblem ?? null, hookmarkProblem: options.hookmarkProblem ?? null, next: () => runs.length > 1 ? runs.shift()! : runs[0] };
	const state = { reachable: options.reachable ?? true };
	const plugin = {
		settings: { pandocAfterExport: options.pandocAfterExport ?? true, pandocPath: "", hookmarkLinkExports: options.hookmark ?? false },
		app: { vault: { getName: () => "Research" } },
		bbt: { isReachable: async () => state.reachable },
		run: async (action: () => Promise<void>) => { await action(); },
	};
	const controller = new ReferencesController(plugin) as { finishKit(kit: unknown): Promise<void> };
	const word = options.word ?? true;
	const kit = {
		title: word ? "Word export kit (live Zotero citations)" : "Pandoc export kit", lines: ["Written to exports/Draft (Word)/: Draft.md, defaults.yaml and cmds-zotero-word.lua."],
		warnings: [], unresolved: [], docx: "Draft.docx", word,
		store: { absolute: (path: string) => `/vault/exports/${path}` }, folder: "Draft (Word)", defaultsPath: `${FOLDER}/defaults.yaml`, file: { path: "Notes/Draft.md", basename: "Draft" },
	};
	const modals = (): MockModal[] => ui.__modals ?? [];
	const buttons = (modal: MockModal): MockEl[] => findAll(modal.contentEl, node => node.tag === "button");
	const toneOf = (modal: MockModal): string | undefined => [...modal.modalEl.cls].find(name => /^cmds-zotero-report-(success|info|warning|error)$/.test(name))?.replace("cmds-zotero-report-", "");
	const outcome = (modal: MockModal): string[] => {
		const block = findAll(modal.contentEl, node => node.cls.has("cmds-zotero-report-outcome"))[0];
		return block ? findAll(block, node => node.tag === "p" || node.tag === "li").map(node => node.text) : [];
	};
	return { controller, kit, state, plugin, modals, buttons, toneOf, outcome, finish: () => controller.finishKit(kit) };
}

const click = (buttons: MockEl[], label: string): void => {
	const button = buttons.find(item => item.text === label);
	assert.ok(button, label);
	// The stand-in's ButtonComponent keeps its handler; the element only carries the label.
	const component = (ui.__settings ?? []).flatMap(setting => setting.components).find(item => item.kind === "button" && item.buttonEl === button);
	assert.ok(component, label);
	void component.click();
};

test("a clean run opens no report: one Notice says the .docx opened, with Refresh for the Word kit and a button for the report", async () => {
	const t = await setup();
	await t.finish();
	assert.equal(t.modals().length, 0, "no report for a clean run");
	assert.deepEqual(runner().opened, [DOCX]);
	assert.deepEqual(clipboard, [], "nothing to run by hand, so the clipboard is left alone");
	const notice = (ui.__notices ?? []).filter(item => !item.hidden).at(-1);
	assert.ok(notice && typeof notice.message !== "string");
	const message = notice.message as MockEl;
	assert.match(textOf(message), /^Opened Draft\.docx\. In Word, press Refresh in the Zotero tab once\./);
	assert.ok(notice.duration && notice.duration > 0, "the Notice goes away by itself");
	const show = findAll(message, node => node.tag === "button" && node.text === "Show report")[0];
	assert.ok(show);
	show.dispatch("click");
	assert.equal(t.modals().length, 1);
	assert.equal(t.toneOf(t.modals()[0]), "success");
	assert.equal(t.outcome(t.modals()[0])[0], "Opened Draft.docx.");
});

test("the pandoc kit's clean run says only that the .docx opened", async () => {
	const t = await setup({ word: false });
	await t.finish();
	assert.equal(t.modals().length, 0);
	assert.match(textOf((ui.__notices ?? []).at(-1)!.message as MockEl), /^Opened Draft\.docx\.\nShow report$/);
});

test("citations left as text open a warning report that names them first and can open the .docx again", async () => {
	const t = await setup({ runs: [{ kind: "ok", pandoc: "/opt/homebrew/bin/pandoc", summary: { missing: ["doe2020"], ambiguous: [], other: [] } }] });
	await t.finish();
	assert.equal(t.modals().length, 1);
	const modal = t.modals()[0];
	assert.equal(t.toneOf(modal), "warning");
	assert.deepEqual(t.outcome(modal).slice(0, 2), ["Draft.docx was written, but some citations were left as text.", "Not found in Zotero, left as text in the .docx: @doe2020."]);
	assert.ok(findAll(modal.contentEl, node => node.tag === "details").length === 1, "the kit's files are folded under Details");
	assert.deepEqual(t.buttons(modal).map(button => button.text), ["Copy command", "Open .docx", "Close"]);
	click(t.buttons(modal), "Open .docx");
	await settle();
	assert.deepEqual(runner().opened, [DOCX, DOCX]);
});

test("a .docx that could not be opened, or a failed Hookmark link, is a warning", async () => {
	const closed = await setup({ openProblem: "no application knows .docx" });
	await closed.finish();
	assert.equal(closed.toneOf(closed.modals()[0]), "warning");
	assert.equal(closed.outcome(closed.modals()[0])[0], "Draft.docx was written, but it could not be opened.");
	const hookmark = await setup({ hookmark: true, hookmarkProblem: "Hookmark was not found. Install Hookmark, or turn off Link exports in Hookmark." });
	await hookmark.finish();
	assert.equal(hookmark.modals().length, 1);
	assert.equal(hookmark.toneOf(hookmark.modals()[0]), "warning");
	assert.ok(hookmark.outcome(hookmark.modals()[0]).includes("Hookmark was not found. Install Hookmark, or turn off Link exports in Hookmark."));
	const linked = await setup({ hookmark: true });
	await linked.finish();
	assert.equal(linked.modals().length, 0, "a made link is part of a clean run");
	assert.match(textOf((ui.__notices ?? []).at(-1)!.message as MockEl), /Linked with the note in Hookmark\./);
});

test("Zotero not answering is an error report; Try again runs the same kit once Zotero answers", async () => {
	const t = await setup({ reachable: false });
	await t.finish();
	assert.equal(runner().runs.length, 0, "pandoc is not run without Zotero");
	const modal = t.modals()[0];
	assert.equal(t.toneOf(modal), "error");
	assert.match(t.outcome(modal)[0], /^Zotero is not answering, so pandoc was not run/);
	assert.equal(clipboard.length, 1, "the command is still copied");
	assert.deepEqual(t.buttons(modal).map(button => button.text), ["Command copied", "Try again", "Close"], "copied shows on the button, not in the report");
	assert.doesNotMatch(textOf(modal.contentEl), /Command copied to the clipboard/);
	t.state.reachable = true;
	click(t.buttons(modal), "Try again");
	await settle();
	assert.equal(modal.closed, true);
	assert.equal(runner().runs.length, 1);
	assert.equal(t.modals().length, 1, "the second attempt ran cleanly: a Notice, no second report");
	assert.match(textOf((ui.__notices ?? []).at(-1)!.message as MockEl), /^Opened Draft\.docx\./);
});

test("a failed pandoc is an error report; Try again runs pandoc again on the same kit", async () => {
	const t = await setup({ runs: [{ kind: "failed", pandoc: "/opt/homebrew/bin/pandoc", message: "Could not find data file zotero.lua" }, { kind: "failed", pandoc: "/opt/homebrew/bin/pandoc", message: "Could not find data file zotero.lua" }] });
	await t.finish();
	const first = t.modals()[0];
	assert.equal(t.toneOf(first), "error");
	assert.equal(t.outcome(first)[0], "pandoc did not finish: Could not find data file zotero.lua");
	click(t.buttons(first), "Try again");
	await settle();
	assert.equal(runner().runs.length, 2);
	assert.deepEqual(runner().runs[0], runner().runs[1], "the same kit");
	assert.equal(t.modals().length, 2);
	assert.equal(t.toneOf(t.modals()[1]), "error");
});

test("with Run pandoc after export off the report stays, with the outcome first and the command shown", async () => {
	const t = await setup({ pandocAfterExport: false });
	await t.finish();
	assert.equal(runner().runs.length, 0);
	const modal = t.modals()[0];
	assert.equal(t.toneOf(modal), "info");
	assert.equal(t.outcome(modal)[0], "Kit written. The pandoc command is on the clipboard (pandoc 2.17 or later).");
	assert.equal(clipboard.length, 1);
	const code = findAll(modal.contentEl, node => node.cls.has("cmds-zotero-report-code"))[0];
	assert.equal(code?.text, clipboard[0]);
	const details = findAll(modal.contentEl, node => node.tag === "details")[0];
	assert.match(textOf(details), /Written to exports\/Draft \(Word\)\//);
	assert.deepEqual(t.buttons(modal).map(button => button.text), ["Command copied", "Close"]);
});
