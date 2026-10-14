// 0.6.1 R17: settings-level note layout. Synthetic records only (tests/fixtures/note-golden.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type CmdsZoteroSettings, type ZoteroIndexEntry } from "../src/types";
import { normalizeSettings } from "../src/settings-data";
import { hashText, renderLiterature } from "../src/note-writer";
import { annotationsHeading, calloutType, DEFAULT_CALLOUTS, DEFAULT_SYNTHESIS_LINES, layoutOf, synthesisLines, THEME_VARIABLES } from "../src/layout";
import { annotationsHeadingField, calloutField, synthesisLinesField } from "../src/settings/sections/layout";
import { draftOf } from "../src/settings/fields";
import { GOLDEN_BIBLIOGRAPHY, GOLDEN_ENTRIES, GOLDEN_IMAGE_HASHES, GOLDEN_RELATED } from "./fixtures/note-golden";

const golden = (name: string): string => readFileSync(join(__dirname, "fixtures", "golden", `${name}.md`), "utf8");
const render = (name: string, settings: CmdsZoteroSettings, previous: string | null, entry: ZoteroIndexEntry = GOLDEN_ENTRIES[name], bibliography = GOLDEN_BIBLIOGRAPHY) =>
	renderLiterature(entry, bibliography, settings, previous, GOLDEN_IMAGE_HASHES, { related: GOLDEN_RELATED[name] ?? [] });
const ids = (content: string): string[] => [...content.matchAll(/<!-- cmds-zotero:([a-zA-Z0-9-]+):(?:[a-f0-9]{64}|detached) -->/g)].map(match => match[1]);
const closings = (content: string): string[] => [...content.matchAll(/<!-- \/cmds-zotero:([a-zA-Z0-9-]+) -->/g)].map(match => match[1]);
const blockBody = (content: string, id: string): string | undefined => new RegExp(`<!-- cmds-zotero:${id}:[a-f0-9]{64} -->\\n([\\s\\S]*?)\\n<!-- /cmds-zotero:${id} -->`).exec(content)?.[1];
const TOGGLES = ["noteAbstract", "noteCitation", "noteMetadata", "noteLinks", "noteZoteroNotes", "noteSynthesis"] as const;

test("golden: default settings reproduce the 0.6.0 notes byte for byte, and re-rendering them changes nothing", () => {
	for (const name of Object.keys(GOLDEN_ENTRIES)) {
		const expected = golden(name);
		assert.equal(render(name, DEFAULT_SETTINGS, null).content, expected, `${name}: new note`);
		assert.equal(render(name, normalizeSettings({}), null).content, expected, `${name}: an older settings file`);
		const again = render(name, DEFAULT_SETTINGS, expected);
		assert.equal(again.content, expected, `${name}: update`);
		assert.deepEqual([again.conflicts, again.softConflicts], [[], []], name);
		assert.ok(again.sections.every(section => section.state === "unchanged"), name);
	}
});

test("layoutOf: defaults, and invalid values fall back per field", () => {
	assert.deepEqual(layoutOf(DEFAULT_SETTINGS), layoutOf({}));
	const layout = layoutOf({});
	assert.deepEqual([layout.abstract, layout.citation, layout.metadata, layout.links, layout.zoteroNotes, layout.synthesis], [true, true, true, true, true, true]);
	assert.deepEqual(layout.callouts, DEFAULT_CALLOUTS);
	assert.deepEqual(layout.synthesisLines, DEFAULT_SYNTHESIS_LINES);
	assert.equal(layout.annotationsHeading, "Annotations");
	assert.equal(calloutType("quote", "md"), "quote");
	for (const bad of ["", " ", "two words", "1abc", "x]", "a".repeat(33), 3, null]) assert.equal(calloutType(bad, "md"), "md", String(bad));
	assert.deepEqual(synthesisLines(["  **Gap**:: ", "", "<!-- cmds-zotero:overview:x -->", "fine -->", 7, "tab\there"]), ["**Gap**::"]);
	assert.deepEqual(synthesisLines([]), DEFAULT_SYNTHESIS_LINES);
	assert.deepEqual(synthesisLines("**Gap**::"), DEFAULT_SYNTHESIS_LINES);
	assert.equal(annotationsHeading("## Reading   highlights "), "Reading highlights");
	for (const bad of ["", "##", "a\nb", "x -->", 5]) assert.equal(annotationsHeading(bad), "Annotations", String(bad));
	const normalized = normalizeSettings({ noteAbstract: "no", noteCitation: false, calloutCite: "bad type", calloutLinks: "links", synthesisLines: ["A::"], annotationsHeading: "# Highlights" });
	assert.deepEqual([normalized.noteAbstract, normalized.noteCitation, normalized.calloutCite, normalized.calloutLinks, normalized.synthesisLines, normalized.annotationsHeading], [true, false, "Cite", "links", ["A::"], "Highlights"]);
});

test("every toggle keeps all managed section IDs and the marker grammar, in new and in existing notes", () => {
	const name = "journal-article";
	const expectedIds = ids(golden(name));
	const variants: Partial<CmdsZoteroSettings>[] = [...TOGGLES.map(key => ({ [key]: false })), Object.fromEntries(TOGGLES.map(key => [key, false]))];
	for (const variant of variants) {
		const settings = { ...DEFAULT_SETTINGS, ...variant };
		const fresh = render(name, settings, null);
		assert.deepEqual(ids(fresh.content), expectedIds, JSON.stringify(variant));
		assert.deepEqual(closings(fresh.content), expectedIds, JSON.stringify(variant));
		const updated = render(name, settings, golden(name));
		assert.deepEqual([updated.conflicts, updated.softConflicts], [[], []], JSON.stringify(variant));
		assert.deepEqual(ids(updated.content), expectedIds, JSON.stringify(variant));
		// Switching the part back on restores the 0.6.0 note exactly.
		assert.equal(render(name, DEFAULT_SETTINGS, updated.content).content, golden(name), JSON.stringify(variant));
	}
});

test("a switched-off section keeps an empty-body block with a valid hash; partial sections keep the rest", () => {
	const name = "journal-article";
	const off = render(name, { ...DEFAULT_SETTINGS, noteCitation: false, noteZoteroNotes: false, noteMetadata: false, noteLinks: false }, golden(name)).content;
	for (const id of ["citation", "notes", "metadata"]) assert.ok(off.includes(`<!-- cmds-zotero:${id}:${hashText("")} -->\n\n<!-- /cmds-zotero:${id} -->`), id);
	const again = render(name, { ...DEFAULT_SETTINGS, noteCitation: false, noteZoteroNotes: false, noteMetadata: false, noteLinks: false }, off);
	assert.equal(again.content, off);
	assert.ok(again.sections.every(section => section.state === "unchanged"));
	const noAbstract = render(name, { ...DEFAULT_SETTINGS, noteAbstract: false }, null).content;
	assert.equal(blockBody(noAbstract, "overview"), "# Synthetic evidence \\(part 1\\): a \\*starred\\* study");
	const linksOnly = blockBody(render(name, { ...DEFAULT_SETTINGS, noteMetadata: false }, null).content, "metadata") ?? "";
	assert.match(linksOnly, /^> \[!LINK\]\n> \[Open in Zotero\]/);
	assert.doesNotMatch(linksOnly, /\[!md\]/);
	const fieldsOnly = blockBody(render(name, { ...DEFAULT_SETTINGS, noteLinks: false }, null).content, "metadata") ?? "";
	assert.match(fieldsOnly, /^> \[!md\]\n/);
	assert.doesNotMatch(fieldsOnly, /\[!LINK\]/);
	const noSynthesis = render(name, { ...DEFAULT_SETTINGS, noteSynthesis: false }, null).content;
	assert.doesNotMatch(noSynthesis, /Synthesis|\[!Synth\]/);
	assert.match(noSynthesis, /<!-- \/cmds-zotero:citation -->\n\n<!-- cmds-zotero:metadata:/);
});

test("switching a part off never overwrites an edited block: it stays as a soft conflict", () => {
	const name = "journal-article";
	const edited = golden(name).replace("Second paragraph.", "Second paragraph, with my own words.");
	const result = render(name, { ...DEFAULT_SETTINGS, noteAbstract: false }, edited);
	assert.deepEqual(result.conflicts, []);
	assert.deepEqual(result.softConflicts, ["Edited generated section preserved: overview"]);
	assert.match(result.content, /with my own words/);
});

test("with the bibliography switched off a first import needs no bibliography text", () => {
	assert.throws(() => render("thesis", DEFAULT_SETTINGS, null, GOLDEN_ENTRIES.thesis, ""), /Zotero must be running/);
	const content = render("thesis", { ...DEFAULT_SETTINGS, noteCitation: false }, null, GOLDEN_ENTRIES.thesis, "").content;
	assert.equal(blockBody(content, "citation"), "");
});

test("renaming callouts changes only the callout title lines", () => {
	const name = "journal-article";
	const renamed = render(name, { ...DEFAULT_SETTINGS, calloutAbstract: "summary", calloutCite: "quote", calloutMetadata: "info", calloutLinks: "tip", calloutSynthesis: "todo" }, null).content;
	const strip = (text: string): string[] => text.split("\n").filter(line => !line.startsWith("<!-- cmds-zotero:"));
	const before = strip(golden(name));
	const after = strip(renamed);
	assert.equal(after.length, before.length);
	const changed = before.map((line, index) => [line, after[index]]).filter(([a, b]) => a !== b);
	assert.deepEqual(changed, [["> [!Abstract]", "> [!summary]"], ["> [!Cite]", "> [!quote]"], ["> [!Synth]", "> [!todo]"], ["> [!md]", "> [!info]"], ["> [!LINK]", "> [!tip]"]]);
});

test("synthesis lines and the annotations heading shape new notes; new blocks find a custom heading", () => {
	const name = "journal-article";
	const settings = { ...DEFAULT_SETTINGS, synthesisLines: ["**Gap**::", "**Method**::"], annotationsHeading: "Reading highlights" };
	const fresh = render(name, settings, null).content;
	assert.match(fresh, /## Synthesis\n\n> \[!Synth\]\n> \*\*Gap\*\*::\n> \*\*Method\*\*::\n\n<!-- cmds-zotero:metadata/);
	assert.match(fresh, /## Notes\n\n## Reading highlights\n\n<!-- cmds-zotero:annotation-/);
	assert.doesNotMatch(fresh, /## Annotations/);
	// A note written before its first annotation: the new block goes right under the configured heading, before user prose.
	const bare: ZoteroIndexEntry = { ...GOLDEN_ENTRIES[name], attachments: [{ ...GOLDEN_ENTRIES[name].attachments[0], annotations: [] }] };
	const empty = `${render(name, settings, null, bare).content}My closing thoughts.\n`;
	const updated = render(name, settings, empty).content;
	assert.ok(updated.indexOf("## Reading highlights") < updated.indexOf("cmds-zotero:annotation-ATTACH01-ANNOT001"));
	assert.ok(updated.indexOf("cmds-zotero:annotation-ATTACH01-ANNOT007") < updated.indexOf("My closing thoughts."));
	// A note written with the default heading still receives blocks under it after the heading setting changed.
	const old = `${render(name, DEFAULT_SETTINGS, null, bare).content}My closing thoughts.\n`;
	const moved = render(name, settings, old).content;
	assert.ok(moved.indexOf("## Annotations") < moved.indexOf("cmds-zotero:annotation-ATTACH01-ANNOT001"));
	assert.ok(moved.indexOf("cmds-zotero:annotation-ATTACH01-ANNOT007") < moved.indexOf("My closing thoughts."));
});

test("layout fields: callout types, synthesis lines and the heading are checked as typed", () => {
	const draft = draftOf(DEFAULT_SETTINGS);
	const cite = calloutField("calloutCite");
	assert.equal(cite.write(draft, "two words"), "Use a letter followed by letters, digits, - or _ (at most 32 characters).");
	assert.equal(draft.calloutCite, "Cite");
	assert.equal(cite.write(draft, " quote "), null);
	assert.equal(draft.calloutCite, "quote");
	assert.equal(cite.write(draft, ""), null);
	assert.equal(normalizeSettings(draft).calloutCite, "Cite", "empty means the default");
	assert.match(synthesisLinesField.write(draft, "**A**::\nbad <!-- x") ?? "", /^Line 2: /);
	assert.deepEqual(draft.synthesisLines, DEFAULT_SETTINGS.synthesisLines);
	assert.equal(synthesisLinesField.write(draft, " **A**:: \n\n**B**::"), null);
	assert.deepEqual(draft.synthesisLines, ["**A**::", "**B**::"]);
	assert.notEqual(draftOf(DEFAULT_SETTINGS).synthesisLines, DEFAULT_SETTINGS.synthesisLines, "the draft never aliases stored arrays");
	assert.match(annotationsHeadingField.write(draft, "x -->") ?? "", /HTML comment/);
	assert.equal(annotationsHeadingField.write(draft, "## Highlights"), null);
	assert.equal(draft.annotationsHeading, "Highlights");
});

test("styles.css declares every documented theme variable", () => {
	const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");
	for (const variable of THEME_VARIABLES) {
		assert.match(css, new RegExp(`^\\s*${variable}:`, "m"), `${variable} declared`);
		assert.ok(css.includes(`var(${variable})`), `${variable} used`);
		assert.ok(css.slice(0, css.indexOf("*/")).includes(variable.replace(/-(?:yellow|red|green|blue|purple|magenta|orange|gray)$/, "-<colour>").replace(/^--cmds-zotero-state-(?!ok).*/, "--cmds-zotero-state-ok").replace(/^--cmds-zotero-card-(?!padding).*/, "--cmds-zotero-card-padding")), `${variable} documented`);
	}
});
