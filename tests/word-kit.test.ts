// 0.6.6 word-zotero-fields: Zotero document preferences, the Word kit's Lua filter and defaults file. Synthetic only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { parseCslInfo, styleKey, wordStyleFacts, type InstalledStyle } from "../src/bibliography/csl-styles";
import { MAX_PREF_LENGTH, WORD_FILTER, ZOTERO_LUA, documentFrontmatter, hasRefsPlace, luaString, preferenceChunks, sessionId, wordDefaultsYaml, wordFilterLua, zoteroDocumentData, zoteroLuaLocations } from "../src/export/word-kit";

const style = (id: string, attributes: string, info = "", body = ""): string => `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" ${attributes} version="1.0">
  <info><title>${id}</title><id>http://www.zotero.org/styles/${id}</id>${info}</info>${body}
</style>`;

const installed = (xml: string): InstalledStyle => {
	const info = parseCslInfo(xml);
	assert.ok(info);
	return { ...info, key: styleKey(info.id), path: `/styles/${styleKey(info.id)}.csl`, file: `${styleKey(info.id)}.csl` };
};

test("CSL info: citation format, style class and bibliography; Word facts for independent and dependent styles", () => {
	const notes = installed(style("notes-sample", "class=\"note\"", "<category citation-format=\"note\"/><category field=\"history\"/>", "<citation><layout/></citation><bibliography><layout/></bibliography>"));
	assert.deepEqual([notes.citationFormat, notes.styleClass, notes.bibliography], ["note", "note", true]);
	const plain = installed(style("plain-notes", "class=\"note\"", "", "<citation><layout/></citation>"));
	assert.equal(plain.bibliography, undefined);
	const authorDate = installed(style("date-sample", "class=\"in-text\"", "<category citation-format=\"author-date\"/>", "<citation><layout/></citation><bibliography><layout/></bibliography>"));
	const dependent = installed(style("journal-sample", "", "<link href=\"http://www.zotero.org/styles/notes-sample\" rel=\"independent-parent\"/><category citation-format=\"note\"/>"));
	const orphan = installed(style("orphan-sample", "", "<link href=\"http://www.zotero.org/styles/missing\" rel=\"independent-parent\"/><category citation-format=\"note\"/>"));
	const styles = [notes, plain, authorDate, dependent, orphan];
	assert.deepEqual(wordStyleFacts(styles, notes), { noteStyle: true, hasBibliography: true });
	assert.deepEqual(wordStyleFacts(styles, plain), { noteStyle: true, hasBibliography: false });
	assert.deepEqual(wordStyleFacts(styles, authorDate), { noteStyle: false, hasBibliography: true });
	assert.deepEqual(wordStyleFacts(styles, dependent), { noteStyle: true, hasBibliography: true });
	assert.deepEqual(wordStyleFacts(styles, orphan), { noteStyle: true, hasBibliography: true });
});

test("Zotero document data: the form Zotero writes back, escaped, in 255-character properties", () => {
	const data = zoteroDocumentData({ styleId: "http://www.zotero.org/styles/notes-sample", locale: "en-US", noteStyle: true, hasBibliography: true, sessionId: "Ab3dE7gH" });
	assert.equal(data, "<data data-version=\"3\" zotero-version=\"7.0\"><session id=\"Ab3dE7gH\"/><style id=\"http://www.zotero.org/styles/notes-sample\" locale=\"en-US\" hasBibliography=\"1\" bibliographyStyleHasBeenSet=\"0\"/><prefs><pref name=\"fieldType\" value=\"Field\"/><pref name=\"noteType\" value=\"1\"/></prefs></data>");
	const inText = zoteroDocumentData({ styleId: "https://example.org/a&b\"c", locale: "ko-KR", noteStyle: false, hasBibliography: false, sessionId: "x" });
	assert.match(inText, /id="https:\/\/example\.org\/a&amp;b&quot;c" locale="ko-KR" hasBibliography="0"/);
	assert.doesNotMatch(inText, /noteType/);
	const chunks = preferenceChunks(data);
	assert.ok(chunks.length === 2 && chunks.every(chunk => chunk.length <= MAX_PREF_LENGTH));
	assert.equal(chunks.join(""), data);
	const astral = "a".repeat(254) + "😀" + "b";
	assert.deepEqual(preferenceChunks(astral).map(chunk => chunk.length), [254, 3]);
	assert.equal(preferenceChunks(astral).join(""), astral);
	assert.deepEqual(preferenceChunks(""), []);
	const id = sessionId(new Uint8Array([0, 1, 25, 26, 51, 52, 61, 62]));
	assert.equal(id, "ABZaz09A");
	assert.throws(() => sessionId(new Uint8Array(4)), /eight/);
});

test("Lua strings: a long-bracket level the value cannot close", () => {
	assert.equal(luaString("plain"), "[[plain]]");
	assert.equal(luaString("a]]b"), "[=[a]]b]=]");
	assert.equal(luaString("ends]"), "[=[ends]]=]");
	assert.equal(luaString("x]=]y]]"), "[==[x]=]y]]]==]");
	assert.equal(luaString("\nfirst"), "[[\n\nfirst]]");
});

test("Word defaults file: no citeproc, the kit's filter before zotero.lua, the style for zotero.lua", () => {
	const text = wordDefaultsYaml({ input: "Draft.md", output: "Draft.docx", style: "notes-sample", lang: "en-US", vaultRoot: "${.}/../..", noteFolder: "Papers", generator: "CMDS Zotero 0.6.6" });
	const yaml = parse(text) as Record<string, unknown>;
	assert.deepEqual(yaml.filters, [`\${.}/${WORD_FILTER}`, ZOTERO_LUA]);
	assert.equal(yaml.citeproc, undefined);
	assert.equal(yaml.bibliography, undefined);
	assert.deepEqual(yaml.metadata, { zotero: { "csl-style": "notes-sample", "author-in-text": true }, lang: "en-US" });
	assert.deepEqual(yaml["resource-path"], ["${.}/../..", "${.}/../../Papers", "${.}"]);
	assert.equal(yaml["output-file"], "${.}/Draft.docx");
	assert.match(text, /^# Written by CMDS Zotero 0\.6\.6\. Run while Zotero is open/);
	assert.ok(hasRefsPlace("Text.\n\n::: {#refs}\n:::\n"));
	assert.ok(hasRefsPlace("::::{ #refs .small}\n::::"));
	assert.ok(!hasRefsPlace("A sentence about ::: {#refs} in prose.\n"));
	assert.deepEqual(zoteroLuaLocations("/h"), ["/h/.local/share/pandoc/filters/zotero.lua", "/h/.pandoc/filters/zotero.lua"]);
	assert.deepEqual(zoteroLuaLocations("/h", "/x"), ["/x/pandoc/filters/zotero.lua", "/h/.pandoc/filters/zotero.lua"]);
});

test("Word copy frontmatter: only document keys reach the .docx, wikilinked names become names", () => {
	const note = "---\ntype: manuscript\ndescription: \"An agent hint.\"\nauthor:\n  - \"[[Jane Doe]]\"\n  - \"[[People/Kim|Kim, S.]]\"\ndate created: 2026-10-28\nsession-link: \"app-link:focus-42\"\ntitle: \"Draft: one\"\nlang: en-US\ntags:\n  - a\n---\n# Body\n";
	const copy = documentFrontmatter(note);
	assert.equal(copy.text, "---\nauthor:\n  - \"Jane Doe\"\n  - \"Kim, S.\"\ntitle: \"Draft: one\"\nlang: en-US\n---\n# Body\n");
	assert.deepEqual(copy.removed, ["type", "description", "date created", "session-link", "tags"]);
	assert.deepEqual(documentFrontmatter("---\ntype: note\ncsl: apa\n---\n\nText.\n"), { text: "Text.\n", removed: ["type", "csl"] });
	assert.deepEqual(documentFrontmatter("No frontmatter.\n"), { text: "No frontmatter.\n", removed: [] });
});

const pandocVersion = ((): number[] | null => {
	const result = spawnSync("pandoc", ["--version"], { encoding: "utf8" });
	const match = result.status === 0 ? /pandoc (\d+)\.(\d+)/.exec(result.stdout) : null;
	return match ? [Number(match[1]), Number(match[2])] : null;
})();
const noPandoc = !pandocVersion || pandocVersion[0] < 3;

interface PandocNode { t: string; c?: unknown }

/** The pandoc JSON of `markdown` after the kit's filter (without zotero.lua: citations stay Cite nodes). */
async function filtered(markdown: string, options: { noteStyle: boolean; hasBibliography: boolean; withoutRefs: "end" | "none"; prefs: string[] }): Promise<{ meta: Record<string, PandocNode>; blocks: PandocNode[] }> {
	const folder = await mkdtemp(join(tmpdir(), "cmds-zotero-word-"));
	try {
		await writeFile(join(folder, WORD_FILTER), wordFilterLua({ generator: "test", ...options }));
		await writeFile(join(folder, "in.md"), markdown);
		const json = execFileSync("pandoc", [join(folder, "in.md"), "-t", "json", "--lua-filter", join(folder, WORD_FILTER)], { encoding: "utf8" });
		return JSON.parse(json) as { meta: Record<string, PandocNode>; blocks: PandocNode[] };
	} finally { await rm(folder, { recursive: true, force: true }); }
}

/** Every node of `type` under `value`, in document order. */
function nodes(value: unknown, type: string, out: PandocNode[] = []): PandocNode[] {
	if (Array.isArray(value)) for (const item of value) nodes(item, type, out);
	else if (value && typeof value === "object") {
		const node = value as PandocNode;
		if (node.t === type) out.push(node);
		for (const child of Object.values(node)) nodes(child, type, out);
	}
	return out;
}

const SAMPLE = "Text [@a2020, 23]. Then *emph [@b2021]* and @c2019 says.[^1] End [@a2020; @b2021], more.\n\n[^1]: Already a note [@d2018].\n\n## References\n\n::: {#refs}\n:::\n";

test("Word filter: preferences as metadata, footnotes after punctuation, the bibliography in the refs place", { skip: noPandoc && "pandoc 3 not installed" }, async () => {
	const doc = await filtered(SAMPLE, { noteStyle: true, hasBibliography: true, withoutRefs: "end", prefs: ["<data a=\"1\">]]", "</data>"] });
	assert.deepEqual(doc.meta.ZOTERO_PREF_1, { t: "MetaString", c: "<data a=\"1\">]]" });
	assert.deepEqual(doc.meta.ZOTERO_PREF_2, { t: "MetaString", c: "</data>" });
	const notes = nodes(doc.blocks, "Note");
	assert.equal(notes.length, 4, "three citations become footnotes, the written footnote stays one");
	assert.equal(nodes(doc.blocks, "Cite").length, 5);
	const first = (doc.blocks[0].c as PandocNode[]).slice(0, 4).map(node => node.t);
	assert.deepEqual(first, ["Str", "Str", "Note", "Space"], "Text . note: the space before the citation is gone and the period comes first");
	assert.deepEqual((doc.blocks[0].c as PandocNode[])[1], { t: "Str", c: "." });
	const raw = nodes(doc.blocks, "RawBlock");
	assert.equal(raw.length, 1);
	assert.match(JSON.stringify(raw[0].c), /ADDIN ZOTERO_BIBL/);
	assert.equal(doc.blocks.at(-1)?.t, "RawBlock", "the field is where ::: {#refs} was");
});

test("Word filter: an in-text style keeps citations in place; the end placement and a style without bibliography", { skip: noPandoc && "pandoc 3 not installed" }, async () => {
	const inText = await filtered("Text [@a2020].\n", { noteStyle: false, hasBibliography: true, withoutRefs: "end", prefs: ["p"] });
	assert.equal(nodes(inText.blocks, "Note").length, 0);
	assert.equal(inText.blocks.length, 2);
	assert.equal(inText.blocks[1].t, "RawBlock", "no refs place: the field goes at the end");
	const none = await filtered("Text [@a2020].\n", { noteStyle: false, hasBibliography: true, withoutRefs: "none", prefs: ["p"] });
	assert.equal(nodes(none.blocks, "RawBlock").length, 0);
	const noBibliography = await filtered(SAMPLE, { noteStyle: true, hasBibliography: false, withoutRefs: "end", prefs: ["p"] });
	assert.equal(nodes(noBibliography.blocks, "RawBlock").length, 0);
	assert.equal(nodes(noBibliography.blocks, "Div").length, 0, "the empty refs place is removed");
});
