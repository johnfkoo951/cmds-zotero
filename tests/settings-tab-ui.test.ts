// Issue #3 (0.6.8 unsaved-row-save): the settings tab against a stand-in for Obsidian's settings UI. A typed value gets
// its own Save beside it, a switch saves itself, and closing the tab names what was not saved. Synthetic values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type CmdsZoteroSettings } from "../src/types";
import { normalizeSettings } from "../src/settings-data";
import { buildSections, controlRows } from "../src/settings/model";
import { SETTINGS_SECTIONS } from "../src/settings/registry";
import { findAll, loadWithMockObsidian, settle, ui, type MockComponent, type MockSetting } from "./obsidian-ui-mock";

interface Tab { display(): void; hide(): void }
const nameOf = (key: string): string => {
	const row = controlRows(buildSections(SETTINGS_SECTIONS)).find(item => item.field.key === key);
	assert.ok(row, key);
	return row.name;
};

// Timers of "Saved." run when the test asks.
const timers: (() => void)[] = [];
(globalThis as unknown as { window: unknown }).window = { setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout: () => undefined };

async function open(options: { probe?: string | null } = {}) {
	const { CmdsZoteroSettingsTab } = await loadWithMockObsidian<{ CmdsZoteroSettingsTab: new (app: unknown, plugin: unknown) => Tab }>('export { CmdsZoteroSettingsTab } from "./src/settings/tab";');
	ui.__settings = [];
	ui.__notices = [];
	timers.length = 0;
	const saved: CmdsZoteroSettings[] = [];
	const probes: { style: string; locale: string }[] = [];
	const state = { refuse: null as string | null };
	const plugin = {
		settings: normalizeSettings(DEFAULT_SETTINGS),
		manifest: { name: "CMDS Zotero", version: "0.0.0-test" },
		saveSettings: async (next: CmdsZoteroSettings): Promise<void> => {
			if (state.refuse) throw new Error(state.refuse);
			saved.push(next);
			plugin.settings = normalizeSettings(next);
		},
		bibliography: { probeFormat: async (format: { style: string; locale: string }) => { probes.push(format); return options.probe ?? null; } },
	};
	const tab = new CmdsZoteroSettingsTab({}, plugin);
	tab.display();
	const row = (key: string): MockSetting => {
		const found = (ui.__settings ?? []).filter(setting => setting.name === nameOf(key)).at(-1);
		assert.ok(found, key);
		return found;
	};
	const control = (key: string): MockComponent => row(key).components[0];
	const button = (setting: MockSetting, text: string): MockComponent => {
		const found = setting.components.find(component => component.kind === "button" && component.buttonEl.text === text);
		assert.ok(found, `${setting.name}: ${text}`);
		return found;
	};
	const saveOf = (key: string): MockComponent => button(row(key), "Save");
	const statusOf = (key: string): string => findAll(row(key).infoEl, node => node.cls.has("cmds-zotero-status"))[0].text;
	const problemOf = (key: string): string => { const el = findAll(row(key).infoEl, node => node.cls.has("cmds-zotero-error"))[0]; return el.shown ? el.text : ""; };
	const saveRow = (): MockSetting => { const found = (ui.__settings ?? []).filter(setting => setting.name === "Save configuration").at(-1); assert.ok(found); return found; };
	const summary = (): string => findAll(saveRow().infoEl, node => node.cls.has("cmds-zotero-unsaved-summary"))[0].text;
	const notices = (): string[] => (ui.__notices ?? []).map(notice => String(notice.message));
	return { tab, plugin, saved, probes, state, row, control, saveOf, statusOf, problemOf, saveRow, button, summary, notices };
}

test("a typed value shows Not saved and a Save beside it; typed back, the row is saved again", async () => {
	const t = await open();
	assert.equal(t.saveOf("pandocPath").buttonEl.shown, false, "no Save while the row holds the stored value");
	t.control("pandocPath").input("/usr/local/bin/pandoc");
	assert.equal(t.saveOf("pandocPath").buttonEl.shown, true);
	assert.equal(t.saveOf("pandocPath").disabled, false);
	assert.equal(t.statusOf("pandocPath"), "Not saved yet: press Save or Enter.");
	assert.ok(t.row("pandocPath").settingEl.cls.has("cmds-zotero-unsaved"));
	assert.equal(t.summary(), `1 value is not saved yet: ${nameOf("pandocPath")}.`);
	t.control("pandocPath").input("");
	assert.equal(t.saveOf("pandocPath").buttonEl.shown, false);
	assert.equal(t.statusOf("pandocPath"), "");
	assert.ok(!t.row("pandocPath").settingEl.cls.has("cmds-zotero-unsaved"));
	assert.equal(t.summary(), "");
	assert.equal(t.saved.length, 0, "typing never saves");
});

test("a row's Save stores that value alone; another row's unsaved value stays in the draft", async () => {
	const t = await open();
	t.control("exportFolder").input("Exports");
	t.control("pandocPath").input("/usr/local/bin/pandoc");
	assert.equal(t.summary(), `2 values are not saved yet: ${nameOf("exportFolder")}, ${nameOf("pandocPath")}.`);
	t.saveOf("pandocPath").click();
	await settle();
	assert.equal(t.saved.length, 1);
	assert.equal(t.saved[0].pandocPath, "/usr/local/bin/pandoc");
	assert.equal(t.saved[0].exportFolder, DEFAULT_SETTINGS.exportFolder, "the other row is not stored");
	assert.equal(t.statusOf("pandocPath"), "Saved.");
	assert.equal(t.saveOf("pandocPath").buttonEl.shown, false);
	assert.equal(t.statusOf("exportFolder"), "Not saved yet: press Save or Enter.");
	assert.equal(t.summary(), `1 value is not saved yet: ${nameOf("exportFolder")}.`);
	for (const timer of timers.splice(0)) timer();
	assert.equal(t.statusOf("pandocPath"), "", "Saved. goes away");
	// Enter saves a one-line field, but not while an input method is composing.
	assert.equal(t.control("exportFolder").inputEl.dispatch("keydown", { key: "Enter", isComposing: true }).defaultPrevented, false);
	await settle();
	assert.equal(t.saved.length, 1);
	t.control("exportFolder").inputEl.dispatch("keydown", { key: "Enter", isComposing: false });
	await settle();
	assert.equal(t.saved.length, 2);
	assert.equal(t.saved[1].exportFolder, "Exports");
	assert.equal(t.saved[1].pandocPath, "/usr/local/bin/pandoc");
	assert.equal(t.summary(), "");
});

test("a rejected value disables its Save; Enter does nothing", async () => {
	const t = await open();
	t.control("requestTimeoutMs").input("999");
	assert.match(t.problemOf("requestTimeoutMs"), /Enter seconds from 1 to 180/);
	assert.equal(t.saveOf("requestTimeoutMs").buttonEl.shown, true);
	assert.equal(t.saveOf("requestTimeoutMs").disabled, true);
	t.saveOf("requestTimeoutMs").click();
	t.control("requestTimeoutMs").inputEl.dispatch("keydown", { key: "Enter" });
	await settle();
	assert.equal(t.saved.length, 0);
	assert.equal(t.summary(), `1 value is not saved yet: ${nameOf("requestTimeoutMs")}.`);
	t.control("requestTimeoutMs").input("30");
	assert.equal(t.saveOf("requestTimeoutMs").disabled, false);
});

test("a changed style is checked with Better BibTeX before its row is stored; a refused style is not stored", async () => {
	const refused = await open({ probe: "Better BibTeX could not render the style \"nope\"." });
	refused.control("bibliographyStyle").input("nope");
	refused.saveOf("bibliographyStyle").click();
	await settle();
	assert.deepEqual(refused.probes, [{ style: "nope", locale: "" }]);
	assert.equal(refused.saved.length, 0);
	assert.equal(refused.statusOf("bibliographyStyle"), "Not saved: Better BibTeX could not render the style \"nope\".");
	assert.equal(refused.saveOf("bibliographyStyle").buttonEl.shown, true);
	const accepted = await open();
	accepted.control("bibliographyStyle").input("chicago-author-date");
	accepted.saveOf("bibliographyStyle").click();
	await settle();
	assert.equal(accepted.saved[0]?.bibliographyStyle, "chicago-author-date");
});

test("a switch saves itself without a Save button; a refused save shows why and a Save to try again", async () => {
	const t = await open();
	t.control("exportFolder").input("Typed but not saved");
	t.control("pandocAfterExport").input(true);
	assert.equal(t.saveOf("pandocAfterExport").buttonEl.shown, false, "no button while the switch saves");
	await settle();
	assert.equal(t.saved.length, 1);
	assert.equal(t.saved[0].pandocAfterExport, true);
	assert.equal(t.saved[0].exportFolder, DEFAULT_SETTINGS.exportFolder, "the typed value of another row stays out");
	assert.equal(t.statusOf("pandocAfterExport"), "Saved.");
	assert.equal(t.saveOf("pandocAfterExport").buttonEl.shown, false);
	t.state.refuse = "Wait for index refresh to finish before changing configuration.";
	t.control("hookmarkLinkExports").input(true);
	await settle();
	assert.equal(t.saved.length, 1);
	assert.equal(t.statusOf("hookmarkLinkExports"), "Not saved: Wait for index refresh to finish before changing configuration. Press Save to try again.");
	assert.equal(t.saveOf("hookmarkLinkExports").buttonEl.shown, true);
	assert.equal(t.saveOf("hookmarkLinkExports").disabled, false);
	t.state.refuse = null;
	t.saveOf("hookmarkLinkExports").click();
	await settle();
	assert.equal(t.saved.length, 2);
	assert.equal(t.saved[1].hookmarkLinkExports, true);
	assert.equal(t.statusOf("hookmarkLinkExports"), "Saved.");
});

test("closing the tab with unsaved rows names them in a Notice; a save still running is not reported", async () => {
	const t = await open();
	t.control("exportFolder").input("Elsewhere");
	t.control("pandocPath").input("/usr/local/bin/pandoc");
	t.saveOf("pandocPath").click();
	t.tab.hide();
	await settle();
	assert.equal(t.saved.at(-1)?.pandocPath, "/usr/local/bin/pandoc");
	assert.equal(t.notices().length, 1);
	assert.match(t.notices()[0], new RegExp(`^Settings closed without saving ${nameOf("exportFolder")}\\. The stored value stays in use`));
	assert.doesNotMatch(t.notices()[0], new RegExp(nameOf("pandocPath")));
	assert.equal(t.plugin.settings.exportFolder, DEFAULT_SETTINGS.exportFolder, "the unsaved value was dropped");
	// Opened again, the tab starts from the stored settings: nothing to report on the next close.
	t.tab.display();
	assert.equal(t.summary(), "");
	t.tab.hide();
	await settle();
	assert.equal(t.notices().length, 1);
	// A switch whose save was refused is named too.
	t.tab.display();
	t.state.refuse = "Wait for index refresh to finish before changing configuration.";
	t.control("citationHover").input(true);
	t.tab.hide();
	await settle();
	assert.equal(t.notices().length, 2);
	assert.match(t.notices()[1], new RegExp(nameOf("citationHover")));
});

test("Save all stores every changed value at once", async () => {
	const t = await open();
	t.control("exportFolder").input("Exports");
	t.control("pandocPath").input("/usr/local/bin/pandoc");
	assert.equal(t.button(t.saveRow(), "Save all").cta, true);
	await t.button(t.saveRow(), "Save all").click();
	await settle();
	assert.equal(t.saved.length, 1);
	assert.equal(t.saved[0].exportFolder, "Exports");
	assert.equal(t.saved[0].pandocPath, "/usr/local/bin/pandoc");
	assert.equal(t.summary(), "");
	assert.equal(t.saveOf("exportFolder").buttonEl.shown, false);
	assert.equal(t.statusOf("exportFolder"), "");
});
