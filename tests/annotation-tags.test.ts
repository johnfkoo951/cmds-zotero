// 0.6.1 zi-annot-tags: annotation tags as Obsidian tags, with the excluded tags left out. Synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Annotation } from "../src/types";
import { annotationBody, annotationTagsLine, renderLiterature } from "../src/note-writer";
import { normalizeSettings } from "../src/settings-data";
import { GOLDEN_BIBLIOGRAPHY, GOLDEN_ENTRIES, GOLDEN_IMAGE_HASHES, GOLDEN_RELATED } from "./fixtures/note-golden";

const entry = GOLDEN_ENTRIES["journal-article"];
const highlight: Annotation = { key: "TAGS0001", attachmentKey: "ATTACH01", type: "highlight", text: "Tagged text", comment: "", color: "#ffd400", page: 2, pageLabel: "2", version: 1, uri: "", tags: [], dateModified: "" };
const HASHTAG = { ...DEFAULT_SETTINGS, annotationTagStyle: "hashtag" as const };

test("hashtag: Obsidian-valid slugs (spaces to -, Korean kept), deduplicated, unsluggable tags stay as escaped text", () => {
	assert.equal(annotationTagsLine(["method", "self efficacy", "자기 효능감", "Method", "2020", "a/b", "#x*"], HASHTAG), "Tags: #method #self-efficacy #자기-효능감 2020 #a/b #x");
	assert.equal(annotationTagsLine([], HASHTAG), "");
});

test("excluded tags are left out case-insensitively, in both styles; an annotation with only excluded tags has no Tags line", () => {
	const settings = { ...DEFAULT_SETTINGS, excludedTags: ["obscite", "to-read"] };
	assert.equal(annotationTagsLine(["ObsCite", "theme", " TO-READ "], settings), "Tags: theme");
	assert.equal(annotationTagsLine(["ObsCite", "theme"], { ...settings, annotationTagStyle: "hashtag" }), "Tags: #theme");
	assert.doesNotMatch(annotationBody({ ...highlight, tags: ["obscite"] }, undefined, entry, DEFAULT_SETTINGS), /Tags:/);
});

test("plain (default) keeps the 0.6.0 line: Zotero's text, escaped, comma-separated", () => {
	assert.equal(annotationTagsLine(["self efficacy", "a_b", "질문"], DEFAULT_SETTINGS), "Tags: self efficacy, a\\_b, 질문");
	assert.match(annotationBody({ ...highlight, tags: ["theme", "질문"] }, undefined, entry, DEFAULT_SETTINGS), /\n> Tags: theme, 질문$/);
	assert.match(annotationBody({ ...highlight, tags: ["self efficacy"] }, undefined, entry, HASHTAG), /\n> Tags: #self-efficacy$/);
	assert.equal(normalizeSettings({}).annotationTagStyle, "plain");
	assert.equal(normalizeSettings({ annotationTagStyle: "hashtag" }).annotationTagStyle, "hashtag");
	assert.equal(normalizeSettings({ annotationTagStyle: "#" }).annotationTagStyle, "plain");
});

test("golden notes: plain default is byte-identical; hashtag changes only the Tags lines of annotation blocks, which refresh unedited", () => {
	for (const name of Object.keys(GOLDEN_ENTRIES)) {
		const expected = readFileSync(join(__dirname, "fixtures", "golden", `${name}.md`), "utf8");
		const render = (settings: typeof DEFAULT_SETTINGS, previous: string | null) => renderLiterature(GOLDEN_ENTRIES[name], GOLDEN_BIBLIOGRAPHY, settings, previous, GOLDEN_IMAGE_HASHES, { related: GOLDEN_RELATED[name] ?? [] });
		assert.equal(render(DEFAULT_SETTINGS, null).content, expected, name);
		const hashtag = render(HASHTAG, expected);
		assert.deepEqual([hashtag.conflicts, hashtag.softConflicts], [[], []], name);
		const changed = hashtag.content.split("\n").filter((line, index) => line !== expected.split("\n")[index]);
		assert.ok(changed.every(line => /^> Tags: #|^<!-- cmds-zotero:annotation-/.test(line)), `${name}: ${changed.join(" | ")}`);
	}
	assert.match(renderLiterature(entry, GOLDEN_BIBLIOGRAPHY, HASHTAG, null, GOLDEN_IMAGE_HASHES).content, /> Tags: #theme #질문/);
});
