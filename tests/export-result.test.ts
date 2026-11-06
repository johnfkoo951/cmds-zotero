// Issue #4 (0.6.8 export-result-tones): a clean export is a Notice; a warning or a failure opens a toned report with the
// outcome first. Synthetic paths and citekeys only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportReport, runIssues, type ExportStep, type KitResult } from "../src/export/outcome";
import type { PandocRunSummary } from "../src/export/run";

const COMMAND = "pandoc --defaults '/vault/exports/Draft (Word)/defaults.yaml'";
const DOCX_PATH = "/vault/exports/Draft (Word)/Draft.docx";
const clean: PandocRunSummary = { missing: [], ambiguous: [], other: [] };
const kit = (over: Partial<KitResult> = {}): KitResult => ({
	title: "Word export kit (live Zotero citations)", lines: ["Written to exports/Draft (Word)/: Draft.md, defaults.yaml and cmds-zotero-word.lua."],
	warnings: [], unresolved: [], docx: "Draft.docx", word: true, ...over,
});
const ran = (over: Partial<Extract<ExportStep, { kind: "ran" }>> = {}): ExportStep => ({ kind: "ran", pandoc: "/opt/homebrew/bin/pandoc", summary: clean, docxPath: DOCX_PATH, openProblem: null, hookmark: null, ...over });

test("a clean run is a Notice only; the Word kit's Notice says to press Refresh in Word", () => {
	const word = exportReport(kit(), ran(), COMMAND, false);
	assert.equal(word.tone, "success");
	assert.equal(word.notice, "Opened Draft.docx. In Word, press Refresh in the Zotero tab once.");
	assert.equal(word.retry, false);
	assert.equal(word.docxPath, DOCX_PATH);
	assert.deepEqual(word.summary.slice(0, 1), ["Opened Draft.docx."], "the report behind the Notice states the outcome first");
	assert.ok(word.details.includes(COMMAND), "the command is in the folded details, not in the outcome");
	assert.ok(!word.summary.some(line => line.includes(COMMAND)));
	const pandoc = exportReport(kit({ title: "Pandoc export kit", word: false }), ran(), COMMAND, false);
	assert.equal(pandoc.notice, "Opened Draft.docx.");
	const linked = exportReport(kit(), ran({ hookmark: { problem: null } }), COMMAND, false);
	assert.equal(linked.tone, "success");
	assert.match(linked.notice ?? "", /Linked with the note in Hookmark\.$/);
});

test("citations left as text are a warning whose first lines name them", () => {
	const missing = exportReport(kit(), ran({ summary: { missing: ["doe2020"], ambiguous: [], other: [] } }), COMMAND, false);
	assert.equal(missing.tone, "warning");
	assert.equal(missing.notice, null);
	assert.equal(missing.summary[0], "Draft.docx was written, but some citations were left as text.");
	assert.equal(missing.summary[1], "Not found in Zotero, left as text in the .docx: @doe2020.");
	assert.ok(missing.summary.some(line => /Check those citekeys/.test(line)));
	assert.ok(missing.summary.includes("In Word, press Refresh in the Zotero tab once; the citations and the bibliography are then Zotero's."), "the .docx opened, so Refresh still applies");
	assert.equal(missing.docxPath, DOCX_PATH, "the report can open the .docx again");
	assert.equal(missing.retry, false);
	const twin = exportReport(kit(), ran({ summary: { missing: [], ambiguous: ["roe2021"], other: [] } }), COMMAND, false);
	assert.equal(twin.tone, "warning");
	assert.match(twin.summary[1], /Found more than once in Zotero, left as text: @roe2021\./);
	const other = exportReport(kit({ word: false }), ran({ summary: { missing: [], ambiguous: [], other: ["[WARNING] Citeproc: citation roe2021 not found"] } }), COMMAND, false);
	assert.equal(other.tone, "warning");
	assert.equal(other.summary[0], "Draft.docx was written and opened; check the notes below.");
	assert.equal(other.summary[1], "pandoc: [WARNING] Citeproc: citation roe2021 not found");
});

test("a .docx that did not open, a failed Hookmark link or a kit warning is a warning", () => {
	const closed = exportReport(kit(), ran({ openProblem: "no application" }), COMMAND, false);
	assert.equal(closed.tone, "warning");
	assert.equal(closed.summary[0], "Draft.docx was written, but it could not be opened.");
	assert.ok(closed.summary.includes("The .docx could not be opened: no application"));
	assert.ok(!closed.summary.some(line => line.startsWith("In Word, press Refresh")), "nothing to refresh in a document that did not open");
	const hookmark = exportReport(kit(), ran({ hookmark: { problem: "Hookmark was not found. Install Hookmark, or turn off Link exports in Hookmark." } }), COMMAND, false);
	assert.equal(hookmark.tone, "warning");
	assert.ok(hookmark.summary.includes("Hookmark was not found. Install Hookmark, or turn off Link exports in Hookmark."));
	const noCsl = exportReport(kit({ word: false, warnings: ["No CSL file in the kit: the style \"x\" is not in the Zotero styles folder; pandoc uses its default (Chicago author-date)."] }), ran(), COMMAND, false);
	assert.equal(noCsl.tone, "warning");
	assert.match(noCsl.summary[1], /^No CSL file in the kit/);
});

test("after a run, pandoc's output replaces the kit's guess about unresolved citations; they stay in the details", () => {
	const unresolved = "Not in the index (zotero.lua leaves them as text): @new2026 (not in the index).";
	const report = exportReport(kit({ unresolved: [unresolved] }), ran(), COMMAND, false);
	assert.equal(report.tone, "success", "Zotero answered for the key the index did not have yet");
	assert.ok(report.details.includes(unresolved));
	const handedOver = exportReport(kit({ unresolved: [unresolved] }), { kind: "handed-over" }, COMMAND, true);
	assert.equal(handedOver.tone, "warning", "without a run the kit's guess is all there is");
	assert.ok(handedOver.summary.includes(unresolved));
});

test("Zotero not answering and a failed pandoc are errors with Try again; the cause comes first", () => {
	const offline = exportReport(kit(), { kind: "zotero-offline" }, COMMAND, true);
	assert.equal(offline.tone, "error");
	assert.equal(offline.retry, true);
	assert.equal(offline.docxPath, null);
	assert.match(offline.summary[0], /^Zotero is not answering, so pandoc was not run/);
	assert.equal(offline.summary.at(-1), "Start Zotero, then press Try again.");
	assert.ok(!offline.summary.some(line => /copied to the clipboard/i.test(line)), "the copied state belongs to the button");
	const failed = exportReport(kit(), { kind: "failed", pandoc: "/opt/homebrew/bin/pandoc", message: "Could not find data file zotero.lua", summary: { missing: ["doe2020"], ambiguous: [], other: [] } }, COMMAND, true);
	assert.equal(failed.tone, "error");
	assert.equal(failed.retry, true);
	assert.equal(failed.summary[0], "pandoc did not finish: Could not find data file zotero.lua");
	assert.equal(failed.summary[1], "Not found in Zotero, left as text in the .docx: @doe2020.");
	const notFound = exportReport(kit(), { kind: "failed", pandoc: null, message: "pandoc was not found. Install it or set Pandoc path in the settings." }, COMMAND, false);
	assert.equal(notFound.summary[0], "pandoc was not found. Install it or set Pandoc path in the settings.");
	assert.ok(failed.details.includes(COMMAND));
	assert.equal(failed.showCommand, false);
});

test("with Run pandoc after export off the report stays: the outcome first, the command open, the files folded", () => {
	const copied = exportReport(kit(), { kind: "handed-over" }, COMMAND, true);
	assert.equal(copied.tone, "info");
	assert.equal(copied.notice, null);
	assert.equal(copied.summary[0], "Kit written. The pandoc command is on the clipboard (pandoc 2.17 or later).");
	assert.match(copied.summary[1], /^Run it while Zotero is open\. In Word, press Refresh/);
	assert.equal(copied.showCommand, true);
	assert.ok(!copied.details.includes(COMMAND), "shown open, so not repeated in the details");
	assert.deepEqual(copied.details, kit().lines);
	const notCopied = exportReport(kit({ word: false }), { kind: "handed-over" }, COMMAND, false);
	assert.equal(notCopied.summary[0], "Kit written. Run the command below (pandoc 2.17 or later).");
	assert.equal(notCopied.summary.length, 1);
	const warned = exportReport(kit({ warnings: ["zotero.lua was not found in pandoc's filters folder."] }), { kind: "handed-over" }, COMMAND, true);
	assert.equal(warned.tone, "warning");
});

test("run issues: one line per kind, in the order pandoc's output is acted on", () => {
	assert.deepEqual(runIssues(undefined), []);
	assert.deepEqual(runIssues({ missing: ["a", "b"], ambiguous: ["c"], other: ["[WARNING] x"] }), [
		"Not found in Zotero, left as text in the .docx: @a, @b.",
		"Found more than once in Zotero, left as text: @c.",
		"pandoc: [WARNING] x",
	]);
});
