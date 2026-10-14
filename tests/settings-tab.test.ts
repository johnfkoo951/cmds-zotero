// 0.6 settings-ux: the area sections, their field codecs and the stored keys they edit. Pure (no obsidian import).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../src/types";
import { normalizeSettings, normalizeTagList } from "../src/settings-data";
import { choiceField, draftOf, endpointField, integerField, linesField, parsePeerVaults, peerVaultsField, secondsField, tagsField, toggleField, vaultPathField, vaultPathProblem } from "../src/settings/fields";
import { buildSections, controlRows, saveBlocker, type DropdownRowSpec } from "../src/settings/model";
import { SETTINGS_SECTIONS } from "../src/settings/registry";

const sections = buildSections(SETTINGS_SECTIONS);
const controls = controlRows(sections);
const rowFor = (key: string) => controls.find(row => row.field.key === key);

test("0.5 keys and defaults are unchanged; 0.6 adds refresh requests and the picker wait, 0.6.1 the note layout", () => {
	assert.deepEqual(DEFAULT_SETTINGS, {
		bbtEndpoint: "http://127.0.0.1:23119/better-bibtex", zoteroIndexPath: "80. References/zotero-index.json", caywFormat: "pandoc",
		requestTimeoutMs: 20000, attachmentTimeoutMs: 60000, concurrency: 2, indexMaxAgeMinutes: 60, outputFolder: "References/Zotero",
		imageFolder: "References/Zotero/images", bibliographyStyle: "apa", peerVaults: [], citationTrigger: "bracket", excludedTags: ["obscite"],
		headingHighlightColor: "gray", referencesFollowActiveNote: true, referencesHeadings: ["References", "Bibliography", "Works Cited", "참고 문헌", "참고 자료"], recentReadsDays: 30,
		collectConcurrency: 4, pickerWaitSeconds: 600,
		// 0.6.1 R17: note layout (the 0.6.0 note).
		noteAbstract: true, noteCitation: true, noteMetadata: true, noteLinks: true, noteZoteroNotes: true, noteSynthesis: true,
		calloutAbstract: "Abstract", calloutCite: "Cite", calloutMetadata: "md", calloutLinks: "LINK", calloutSynthesis: "Synth",
		synthesisLines: ["**Contribution**::", "**Related**::"], annotationsHeading: "Annotations", noteItemTypeFields: false,
		joinContinuations: false, noteRichText: false, annotationTagStyle: "plain",
	});
});

test("every stored key has exactly one control, with a name and a description", () => {
	const keys = Object.keys(DEFAULT_SETTINGS).sort();
	assert.deepEqual([...new Set(controls.map(row => row.field.key))].sort(), keys);
	assert.equal(controls.length, keys.length, "one control per key");
	for (const row of controls) {
		assert.ok(row.name.trim() && row.desc.trim(), row.field.key);
		assert.match(row.name, /^[A-Z]/, `${row.field.key}: sentence case starts with a capital`);
	}
	// The four keys 0.5 stored without a control.
	assert.equal(rowFor("citationTrigger")?.kind, "dropdown");
	assert.equal(rowFor("excludedTags")?.kind, "textarea");
	assert.equal(rowFor("headingHighlightColor")?.kind, "dropdown");
	assert.equal(rowFor("referencesFollowActiveNote")?.kind, "toggle");
});

test("sections: one file per area, all registered, distinct ids, headings Obsidian accepts, advanced and agent keys last", () => {
	const files = readdirSync(join(process.cwd(), "src", "settings", "sections")).filter(name => name.endsWith(".ts")).map(name => name.replace(/\.ts$/, "")).sort();
	assert.deepEqual(sections.map(section => section.id).sort(), files);
	for (const section of sections) {
		assert.ok(section.heading, section.id);
		assert.doesNotMatch(section.heading, /settings|options|general|cmds zotero/i, `${section.id}: heading wording the settings-tab lint forbids`);
		assert.ok(section.rows.length > 0, section.id);
	}
	const firstAdvanced = sections.findIndex(section => section.advanced);
	assert.ok(firstAdvanced > 0 && sections.slice(firstAdvanced).every(section => section.advanced), "advanced sections render together under one heading");
	assert.deepEqual(sections.filter(section => section.advanced).map(section => section.id), ["agents", "advanced"]);
	assert.ok(sections.find(section => section.id === "agents")?.rows.some(row => row.kind === "textarea" && row.field.key === "referencesHeadings"));
});

test("the References headings description says only the agent CLI's cites and citing actions read the list", () => {
	const row = rowFor("referencesHeadings");
	assert.ok(row);
	assert.match(row.desc, /agent CLI's cites and citing actions/);
	assert.match(row.desc, /references sidebar and the commands that copy CSL-JSON or write the pandoc bibliography sidecar do not read this list/);
	assert.doesNotMatch(row.desc, /for the references check and the pandoc sidecar/);
});

test("citation trigger: bracket, at or off only; a rejected value leaves the draft alone", () => {
	const row = rowFor("citationTrigger") as DropdownRowSpec;
	assert.deepEqual(row.options(draftOf(DEFAULT_SETTINGS)).map(([value]) => value), ["bracket", "at", "off"]);
	const draft = draftOf(DEFAULT_SETTINGS);
	for (const value of ["at", "off", "bracket"]) { assert.equal(row.field.write(draft, value), null); assert.equal(draft.citationTrigger, value); }
	assert.equal(choiceField("citationTrigger", ["bracket", "at", "off"]).write(draft, "hash"), "Choose one of the listed values.");
	assert.equal(draft.citationTrigger, "bracket");
	assert.equal(normalizeSettings({ citationTrigger: "hash" }).citationTrigger, "bracket");
});

test("excluded tags: one per line, trimmed, lower-cased, deduplicated; the stored setting uses the same rule", () => {
	const draft = draftOf(DEFAULT_SETTINGS);
	const field = tagsField("excludedTags");
	assert.equal(field.read(draft), "obscite");
	assert.equal(field.write(draft, " ObsCite \n\nTo-Read\r\nto-read\n  "), null);
	assert.deepEqual(draft.excludedTags, ["obscite", "to-read"]);
	assert.deepEqual(normalizeTagList([" A ", "a", 3, "", "B"]), ["a", "b"]);
	assert.deepEqual(normalizeSettings({ excludedTags: [" ObsCite ", "obscite", 7] }).excludedTags, ["obscite"]);
	assert.equal(field.write(draft, ""), null);
	assert.deepEqual(normalizeSettings(draft).excludedTags, [], "an empty list excludes nothing");
	assert.deepEqual(normalizeSettings({}).excludedTags, ["obscite"]);
});

test("heading highlight color: none plus the Zotero palette", () => {
	const row = rowFor("headingHighlightColor") as DropdownRowSpec;
	assert.deepEqual(row.options(draftOf(DEFAULT_SETTINGS)).map(([value]) => value), ["none", "yellow", "red", "green", "blue", "purple", "magenta", "orange", "gray"]);
	const draft = draftOf(DEFAULT_SETTINGS);
	assert.equal(row.field.write(draft, "none"), null);
	assert.equal(normalizeSettings(draft).headingHighlightColor, "none");
	assert.equal(row.field.write(draft, "teal"), "Choose one of the listed values.");
	assert.equal(draft.headingHighlightColor, "none");
	assert.equal(normalizeSettings({ headingHighlightColor: "teal" }).headingHighlightColor, "gray");
});

test("new keys round-trip through the draft, normalizeSettings and back into the controls", () => {
	const draft = draftOf(DEFAULT_SETTINGS);
	assert.equal(rowFor("citationTrigger")!.field.write(draft, "at"), null);
	assert.equal(tagsField("excludedTags").write(draft, "Method\nself-efficacy"), null);
	assert.equal(rowFor("headingHighlightColor")!.field.write(draft, "purple"), null);
	assert.equal(toggleField("referencesFollowActiveNote").write(draft, false), null);
	const saved = normalizeSettings(JSON.parse(JSON.stringify(draft)));
	assert.deepEqual([saved.citationTrigger, saved.excludedTags, saved.headingHighlightColor, saved.referencesFollowActiveNote], ["at", ["method", "self-efficacy"], "purple", false]);
	const reopened = draftOf(saved);
	assert.equal(rowFor("citationTrigger")!.field.read(reopened), "at");
	assert.equal(rowFor("excludedTags")!.field.read(reopened), "method\nself-efficacy");
	assert.equal(rowFor("headingHighlightColor")!.field.read(reopened), "purple");
	assert.equal(rowFor("referencesFollowActiveNote")!.field.read(reopened), false);
	assert.notEqual(reopened.excludedTags, saved.excludedTags, "the draft never aliases stored arrays");
});

test("numbers are checked per field with an inline message and never reach the draft when invalid", () => {
	const draft = draftOf(DEFAULT_SETTINGS);
	const age = integerField("indexMaxAgeMinutes", 1, 10080);
	for (const bad of ["0", "10081", "1.5", "abc", "", "-3", "1e3"]) { assert.equal(age.write(draft, bad), "Enter a whole number from 1 to 10080.", bad); assert.equal(draft.indexMaxAgeMinutes, 60); }
	assert.equal(age.write(draft, " 120 "), null);
	assert.equal(draft.indexMaxAgeMinutes, 120);
	const timeout = secondsField("requestTimeoutMs", 1, 180);
	assert.equal(timeout.read(draft), "20");
	assert.equal(timeout.write(draft, "1.5"), null);
	assert.equal(draft.requestTimeoutMs, 1500);
	for (const bad of ["0.5", "181", "1.0001", "x", "", "-1"]) { assert.equal(timeout.write(draft, bad), "Enter seconds from 1 to 180.", bad); assert.equal(draft.requestTimeoutMs, 1500); }
	// 0.6 review: values whose float product is not exact (16.1 * 1000) are accepted and stored rounded.
	for (const [input, ms] of [["16.1", 16100], ["2.01", 2010], ["1.001", 1001], ["179.999", 179999]] as const) { assert.equal(timeout.write(draft, input), null, input); assert.equal(draft.requestTimeoutMs, ms, input); }
	assert.equal(rowFor("concurrency")!.field.write(draft, "9"), "Enter a whole number from 1 to 8.");
	assert.equal(rowFor("recentReadsDays")!.field.write(draft, "400"), "Choose one of the listed values.");
});

test("paths, endpoint and peer vaults are validated inline with the save-time rules", () => {
	const draft = draftOf(DEFAULT_SETTINGS);
	const folder = vaultPathField("outputFolder");
	for (const bad of ["/abs/path", "a/../b", "a//b", "C:\\notes", "zotero://x", "./notes", "notes/"]) assert.ok(folder.write(draft, bad), bad);
	assert.equal(draft.outputFolder, "References/Zotero");
	assert.equal(folder.write(draft, " Literature/Zotero "), null);
	assert.equal(draft.outputFolder, "Literature/Zotero");
	assert.equal(vaultPathProblem(""), null, "empty means the default");
	assert.equal(endpointField.write(draft, "http://127.0.0.1:23119/better-bibtex/"), null);
	assert.equal(draft.bbtEndpoint, "http://127.0.0.1:23119/better-bibtex");
	assert.match(endpointField.write(draft, "http://example.com/better-bibtex") ?? "", /local HTTP endpoint/);
	assert.match(endpointField.write(draft, "not a url") ?? "", /Enter a URL such as/);
	assert.equal(draft.bbtEndpoint, "http://127.0.0.1:23119/better-bibtex");
	assert.deepEqual(parsePeerVaults("Wiki | /vaults/wiki\n\n  Main|/vaults/main  "), { peers: [{ name: "Wiki", path: "/vaults/wiki" }, { name: "Main", path: "/vaults/main" }] });
	assert.deepEqual(parsePeerVaults("Wiki | /vaults/wiki\n/vaults/no-name"), { problem: "Line 2 needs a vault name and an absolute folder path separated by |." });
	assert.equal(peerVaultsField.write(draft, "Only a name |"), "Line 1 needs a vault name and an absolute folder path separated by |.");
	assert.deepEqual(draft.peerVaults, []);
	assert.equal(peerVaultsField.write(draft, "Wiki | /vaults/wiki"), null);
	assert.equal(peerVaultsField.read(draft), "Wiki | /vaults/wiki");
	assert.equal(linesField("referencesHeadings").write(draft, " Literatur \nLiteratur\n"), null);
	assert.deepEqual(draft.referencesHeadings, ["Literatur"]);
	assert.equal(linesField("referencesHeadings").write(draft, "\n"), null);
	assert.deepEqual(normalizeSettings(draft).referencesHeadings, DEFAULT_SETTINGS.referencesHeadings, "an empty list restores the defaults");
});

test("the recently read window lists a stored value outside the fixed choices, in order", () => {
	const row = rowFor("recentReadsDays") as DropdownRowSpec;
	assert.deepEqual(row.options(draftOf(DEFAULT_SETTINGS)).map(([value]) => value), ["7", "30", "90", "365"]);
	assert.deepEqual(row.options({ ...draftOf(DEFAULT_SETTINGS), recentReadsDays: 14 }).map(([value]) => value), ["7", "14", "30", "90", "365"]);
});

test("save is blocked while any control holds a rejected value", () => {
	assert.equal(saveBlocker(new Map()), null);
	assert.equal(saveBlocker(new Map([["Request timeout", "Enter seconds from 1 to 180."]])), "Fix this value first: Request timeout.");
	assert.equal(saveBlocker(new Map([["Index path", "x"], ["Peer vaults", "y"]])), "Fix these 2 values first: Index path, Peer vaults.");
});
