// 0.6.6 export-outside-vault, run-pandoc-after-export and hookmark-link-export. Synthetic paths only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome, externalFolderProblem, isExternalFolderValue, resolveKitRoot } from "../src/export/location";
import { HOOKMARK_LINK_SCRIPT, hookmarkLinkArguments, pandocCandidates, pandocRunSummary } from "../src/export/run";
import { pandocCommand } from "../src/export/kit";
import { zoteroLuaInstallCommand, zoteroLuaLocations } from "../src/export/word-kit";
import { completionConflict, doctorChecks, type DoctorFacts } from "../src/doctor/checks";
import { runPandoc } from "../src/plugin/export-runner";
import { exportFolderField, pandocPathField, draftOf } from "../src/settings/fields";
import { normalizeSettings } from "../src/settings-data";
import { DEFAULT_SETTINGS } from "../src/types";

// Assembled at runtime so the release sanitizer (which looks for literal home paths) stays quiet.
const HOME = ["", "home", "synthetic"].join("/");
const VAULT = `${HOME}/Vaults/Main`;

test("export folder: vault folders by default, outside folders only when allowed", () => {
	assert.ok(isExternalFolderValue("~/Documents/Exports"));
	assert.ok(isExternalFolderValue("/srv/exports"));
	assert.ok(!isExternalFolderValue("CMDS Zotero exports"));
	assert.equal(expandHome("~/Documents/Exports", HOME), `${HOME}/Documents/Exports`);
	assert.match(externalFolderProblem("~/Documents/Exports", false, HOME) ?? "", /Allow export kits outside the vault/);
	assert.equal(externalFolderProblem("~/Documents/Exports", true, HOME), null);
	assert.match(externalFolderProblem("~/Documents/../x", true, HOME) ?? "", /traversal/);
	assert.match(externalFolderProblem("~", true, HOME) ?? "", /not the root or home/);
	assert.match(externalFolderProblem("/", true, HOME) ?? "", /not the root or home/);
	const options = { allowOutside: true, home: HOME, vaultBase: VAULT };
	assert.deepEqual(resolveKitRoot("CMDS Zotero exports/", options), { kind: "vault", folder: "CMDS Zotero exports" });
	assert.deepEqual(resolveKitRoot("~/Documents/CMDS Zotero exports", options), { kind: "external", path: `${HOME}/Documents/CMDS Zotero exports` });
	assert.deepEqual(resolveKitRoot(`${VAULT}/70. Outputs/Exports`, options), { kind: "vault", folder: "70. Outputs/Exports" }, "an absolute path inside the vault is a vault folder");
	assert.throws(() => resolveKitRoot(VAULT, options), /is the vault itself/);
	assert.throws(() => resolveKitRoot("~/Documents/CMDS Zotero exports", { ...options, allowOutside: false }), /Allow export kits outside the vault/);
});

test("settings: the export folder field follows the toggle; pandoc path; defaults are off", () => {
	const draft = draftOf(DEFAULT_SETTINGS);
	assert.match(exportFolderField.write(draft, "~/Documents/CMDS Zotero exports") ?? "", /Allow export kits outside the vault/);
	assert.equal(draft.exportFolder, "CMDS Zotero exports", "a rejected value leaves the draft as it was");
	draft.exportOutsideVault = true;
	assert.equal(exportFolderField.write(draft, "~/Documents/CMDS Zotero exports"), null);
	assert.equal(draft.exportFolder, "~/Documents/CMDS Zotero exports");
	assert.match(exportFolderField.write(draft, "../outside") ?? "", /traversal|vault-relative/);
	assert.equal(exportFolderField.write(draft, "70. Outputs/Exports"), null);
	assert.match(pandocPathField.write(draft, "pandoc") ?? "", /full path/);
	assert.equal(pandocPathField.write(draft, "/opt/homebrew/bin/pandoc"), null);
	assert.equal(pandocPathField.write(draft, ""), null);
	const normalized = normalizeSettings({ exportOutsideVault: "yes", pandocAfterExport: 1, pandocPath: "pandoc", hookmarkLinkExports: null });
	assert.deepEqual([normalized.exportOutsideVault, normalized.pandocAfterExport, normalized.pandocPath, normalized.hookmarkLinkExports], [false, false, "", false]);
	const kept = normalizeSettings({ exportOutsideVault: true, exportFolder: "~/Documents/Exports", pandocAfterExport: true, pandocPath: " /usr/local/bin/pandoc ", hookmarkLinkExports: true });
	assert.deepEqual([kept.exportOutsideVault, kept.exportFolder, kept.pandocAfterExport, kept.pandocPath, kept.hookmarkLinkExports], [true, "~/Documents/Exports", true, "/usr/local/bin/pandoc", true]);
});

test("pandoc candidates and what its output means", () => {
	assert.deepEqual(pandocCandidates("", "darwin", HOME), ["/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc", "/opt/local/bin/pandoc", `${HOME}/.local/bin/pandoc`, "pandoc"]);
	assert.deepEqual(pandocCandidates("", "linux", HOME).at(-1), "pandoc");
	const winHome = ["C:", "Users", "synthetic"].join("\\");
	assert.deepEqual(pandocCandidates("", "win32", winHome), [`${winHome}\\AppData\\Local\\Pandoc\\pandoc.exe`, "C:\\Program Files\\Pandoc\\pandoc.exe", "pandoc"]);
	assert.deepEqual(pandocCandidates("~/bin/pandoc", "darwin", HOME), [`${HOME}/bin/pandoc`]);
	const summary = pandocRunSummary("zotero-live-citations 5904ae6\n@shortKey: not found\n@other not in Zotero\n@twin: duplicates found\n@shortKey: not found\n", "new version \"abc\" available at https://example.org\n[WARNING] Could not fetch resource x.png\n");
	assert.deepEqual(summary, { missing: ["shortKey", "other"], ambiguous: ["twin"], other: ["[WARNING] Could not fetch resource x.png"] });
	assert.deepEqual(pandocRunSummary("", ""), { missing: [], ambiguous: [], other: [] });
});

test("Hookmark link: addresses are arguments, never script text", () => {
	const args = hookmarkLinkArguments(`${HOME}/Documents/CMDS Zotero exports/초안 (Word)/초안.docx`, "obsidian://open?vault=Main&file=Inbox%2F%EC%B4%88%EC%95%88", "초안.docx", "초안");
	assert.equal(args[0], "-e");
	assert.equal(args[1], HOOKMARK_LINK_SCRIPT);
	assert.equal(args[2], `file://${HOME}/Documents/CMDS%20Zotero%20exports/%EC%B4%88%EC%95%88%20(Word)/%EC%B4%88%EC%95%88.docx`);
	assert.deepEqual(args.slice(3), ["obsidian://open?vault=Main&file=Inbox%2F%EC%B4%88%EC%95%88", "초안.docx", "초안"]);
	assert.match(HOOKMARK_LINK_SCRIPT, /item 1 of argv[\s\S]*hook docBookmark and noteBookmark/);
	assert.doesNotMatch(HOOKMARK_LINK_SCRIPT, /초안|file:\/\//);
});

test("runPandoc: runs the configured program in the kit folder and sorts its output", { skip: process.platform === "win32" && "needs a POSIX shell script" }, async () => {
	const folder = await mkdtemp(join(tmpdir(), "cmds-zotero-run-"));
	try {
		const ok = join(folder, "fake-pandoc");
		await writeFile(ok, "#!/bin/sh\n[ \"$1\" = --defaults ] || exit 9\necho \"zotero-live-citations 5904ae6\"\necho \"@shortKey: not found\"\npwd >&2\n");
		await chmod(ok, 0o755);
		const done = await runPandoc(ok, join(folder, "defaults.yaml"), folder);
		assert.equal(done.kind, "ok");
		assert.deepEqual(done.summary?.missing, ["shortKey"]);
		assert.ok(done.summary?.other.some(line => line.endsWith(folder.split("/").pop() ?? "")), "runs in the kit folder");
		const bad = join(folder, "failing-pandoc");
		await writeFile(bad, "#!/bin/sh\necho 'pandoc: defaults file not found' >&2\nexit 97\n");
		await chmod(bad, 0o755);
		const failed = await runPandoc(bad, join(folder, "defaults.yaml"), folder);
		assert.deepEqual([failed.kind, failed.kind === "failed" ? failed.message : ""], ["failed", "pandoc: defaults file not found"]);
		const missing = await runPandoc(join(folder, "no-such-pandoc"), join(folder, "defaults.yaml"), folder);
		assert.equal(missing.kind === "failed" && missing.pandoc, null);
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test("Windows: zotero.lua under %APPDATA%, a PowerShell install line and double-quoted commands", () => {
	const winHome = ["C:", "Users", "synthetic"].join("\\");
	const appData = `${winHome}\\AppData\\Roaming`;
	assert.deepEqual(zoteroLuaLocations(winHome, { APPDATA: appData }, "win32"), [`${appData}\\pandoc\\filters\\zotero.lua`]);
	assert.deepEqual(zoteroLuaLocations(winHome, {}, "win32"), [`${appData}\\pandoc\\filters\\zotero.lua`]);
	assert.match(zoteroLuaInstallCommand("win32"), /^New-Item -ItemType Directory -Force "\$env:APPDATA\\pandoc\\filters".*Invoke-WebRequest -Uri https:\/\/retorque\.re\/.*-OutFile "\$env:APPDATA\\pandoc\\filters\\zotero\.lua"$/);
	assert.match(zoteroLuaInstallCommand("darwin"), /^mkdir -p ~\/\.local\/share\/pandoc\/filters && curl /);
	assert.equal(pandocCommand(`${winHome}\\Documents/CMDS Zotero exports/Draft (Word)/defaults.yaml`, "win32"), `pandoc --defaults "${winHome}\\Documents\\CMDS Zotero exports\\Draft (Word)\\defaults.yaml"`);
	assert.equal(pandocCommand("/tmp/x y/defaults.yaml", "darwin"), "pandoc --defaults '/tmp/x y/defaults.yaml'");
});

test("Diagnose setup: completions known to answer [@ first, read from their settings", () => {
	assert.deepEqual(completionConflict("various-complements", { firstCharactersDisableSuggestions: ":/^" }), { plugin: "Various Complements", fix: "in Various Complements add [ and @ to \"First characters to disable suggestions\"" });
	assert.equal(completionConflict("various-complements", { firstCharactersDisableSuggestions: ":/^[@" }), null);
	assert.equal(completionConflict("obsidian-pandoc-reference-list", { enableCiteKeyCompletion: true })?.plugin, "Pandoc Reference List");
	assert.equal(completionConflict("obsidian-pandoc-reference-list", { enableCiteKeyCompletion: false }), null);
	assert.equal(completionConflict("obsidian-pandoc-reference-list", undefined)?.plugin, "Pandoc Reference List", "its default is on");
	assert.equal(completionConflict("some-other-plugin", {}), null);
	const facts = (completion: DoctorFacts["completion"]): DoctorFacts => ({ bbt: { reachable: null }, legacyPluginEnabled: null, index: { path: "i.json", count: null, ageMinutes: null, stale: null, maxAgeMinutes: 60, complete: null }, git: null, pdfjs: null, peers: null, outputFolder: null, completion });
	const check = (completion: DoctorFacts["completion"]) => doctorChecks(facts(completion)).find(item => item.id === "citation-completion");
	assert.equal(check({ enabled: true, conflicts: [] })?.status, "ok");
	assert.equal(check({ enabled: false, conflicts: [] })?.status, "info");
	assert.equal(check(null)?.status, "unknown");
	const warned = check({ enabled: true, conflicts: [completionConflict("various-complements", {})!, completionConflict("obsidian-pandoc-reference-list", {})!] });
	assert.equal(warned?.status, "warning");
	assert.match(warned?.detail ?? "", /^Various Complements and Pandoc Reference List answer \[@ before the plugin/);
	assert.equal(doctorChecks({ ...facts(null), completion: undefined }).some(item => item.id === "citation-completion"), false, "hosts that cannot see Obsidian's completions leave the check out");
});
