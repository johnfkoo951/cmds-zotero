import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, ZoteroIndexEntry, Annotation } from "../src/types";
import { renderLiterature, safeVaultPath, textFromHTML } from "../src/note-writer";

const annotation: Annotation = { key: "ANNOT001", attachmentKey: "ATTACH01", type: "highlight", text: "Evidence", comment: "Comment", color: "#ffee00", page: 3, pageLabel: "ii", version: 1, uri: "javascript:bad", tags: ["theme"], dateModified: "" };
const entry: ZoteroIndexEntry = { id: "user:1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "Example2026", citekeyHistory: [], title: 'A "quoted" title\n---\ninjected: true', authors: ["Test Author"], year: "2026", doi: "", url: "", collections: [], tags: ["a: b", "true"], attachmentPath: "", zoteroSelectURI: "", attachments: [{ key: "ATTACH01", openURI: "", path: null, title: "", annotations: [annotation] }], attachmentStatus: "complete", contentHash: "", metadata: { abstractNote: "<p>Abstract</p>", notes: [{ note: '<p>Note<script>alert(1)</script><img src=x onerror=bad></p>' }] } };
const render = (previous: string | null, item = entry) => renderLiterature(item, "Author (2026). Example.", DEFAULT_SETTINGS, previous);

test("initial import has quoted typed YAML, native layout and safe notes", () => {
	const first = render(null);
	assert.deepEqual(first.conflicts, []);
	const titleLine = first.content.split("\n").find(l => l.startsWith("title: ")) ?? "";
	assert.equal(JSON.parse(titleLine.slice(7)), entry.title);
	assert.match(first.content, /zoteroID: "user:1:ITEM0001"/);
	assert.match(first.content, /zoteroItemKey: "ITEM0001"/);
	assert.match(first.content, /zoteroLibraryID: 1/);
	assert.match(first.content, /zoteroLibraryType: "user"/);
	assert.match(first.content, /^type: "zotero"$/m);
	assert.match(first.content, /zotero_year: "2026"/);
	assert.match(first.content, /> \[!Cite\]\n> Author \\\(2026\\\)\. Example\./);
	assert.match(first.content, /> \[!Abstract\]\n> abstract:: Abstract/);
	assert.match(first.content, /> \[!md\]\n> \*\*Author\*\*:: Test Author/);
	assert.match(first.content, /\*\*Citekey\*\*:: @Example2026/);
	assert.match(first.content, /> \[!LINK\]\n> \[Open in Zotero\]/);
	assert.match(first.content, /## Synthesis\n\n> \[!Synth\]/);
	assert.doesNotMatch(first.content, /<script|<img|alert\(1\)|javascript:/);
	assert.match(first.content, /page=3&annotation=ANNOT001/);
	assert.match(first.content, /> \[!Highlight\] yellow · p\. ii\n> <mark class="cmds-zotero-hl-yellow">Evidence<\/mark> \(\[p\. ii\]\(zotero:\/\/open-pdf/);
	assert.match(first.content, /> \*\*Comment\*\*: \*Comment\*/);
	assert.doesNotMatch(first.content, /obscite/);
});

test("reimport is idempotent and preserves all user prose and YAML", () => {
	const initial = render(null).content;
	assert.equal(render(initial).content, initial);
	const edited = initial.replace("## Notes\n", "## Notes\nMy permanent commentary.\n").replace("---\n\n<!--", "custom: [mine]\n---\n\n<!--") + "\nAfterword\n";
	const updated = render(edited, { ...entry, title: "New title" });
	assert.deepEqual(updated.conflicts, []);
	assert.match(updated.content, /My permanent commentary/);
	assert.match(updated.content, /custom: \[mine\]/);
	assert.match(updated.content, /Afterword/);
	assert.match(updated.content, /# New title/);
	assert.match(updated.content, /\*\*Title\*\*:: New title/);
	assert.ok(updated.content.startsWith(edited.slice(0, edited.indexOf("<!--"))));
});

test("edited generated text is preserved and reported, unrelated names refuse ownership", () => {
	const edited = render(null).content.replace(">Evidence<", ">My changed evidence<");
	const result = render(edited);
	assert.match(result.conflicts.join(" "), /Edited generated section/);
	assert.match(result.content, /My changed evidence/);
	assert.deepEqual(render("my unowned note").content, "my unowned note");
	assert.equal(render("my unowned note").conflicts.length, 1);
});

test("annotation identities dedupe, append, and preserve removed annotations", () => {
	const duplicate = { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [annotation, annotation] }] };
	const first = render(null, duplicate);
	assert.equal((first.content.match(/\[!Highlight\]/g) ?? []).length, 1);
	const extra = { ...annotation, key: "ANNOT002", text: "New evidence" };
	const second = render(first.content, { ...duplicate, attachments: [{ ...duplicate.attachments[0]!, annotations: [extra] }] });
	assert.match(second.content, />Evidence</);
	assert.match(second.content, /New evidence/);
	assert.equal(render(second.content, duplicate).content, second.content);
});

test("safe source text cannot inject markers or executable markdown", () => {
	assert.doesNotMatch(textFromHTML('&lt;script&gt;x&lt;/script&gt; ![x](javascript:bad)'), /(^|[^\\])<script|(^|[^\\])!\[/);
	for (const path of ["../evil", "/absolute", "a/../../b", "a\\b", "a//b", "a/./b", "x:y"]) assert.throws(() => safeVaultPath(path));
	assert.equal(safeVaultPath("References/Example.md"), "References/Example.md");
});

test("raster image plans use stable names and encoded vault destinations", () => {
	const imageEntry = { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [{ ...annotation, imagePath: "/synthetic/figure.png" }] }] };
	const digest = "a".repeat(64);
	const hashes = new Map([["/synthetic/figure.png", digest]]);
	const result = renderLiterature(imageEntry, "APA", { ...DEFAULT_SETTINGS, imageFolder: "Reference images" }, null, hashes);
	assert.deepEqual(result.images, [{ source: "/synthetic/figure.png", path: `Reference images/user-1-ATTACH01-ANNOT001-${digest}.png` }]);
	assert.ok(result.content.includes(`Reference%20images/user-1-ATTACH01-ANNOT001-${digest}.png`));
	assert.match(result.content, /> \[!Image\] yellow · p\. ii/);
	assert.equal(renderLiterature(imageEntry, "APA", { ...DEFAULT_SETTINGS, imageFolder: "Reference images" }, result.content, hashes).content, result.content);
});

test("gray highlights become headings, notes become note callouts, related items and tags are filtered", () => {
	const gray = { ...annotation, key: "ANNOT003", color: "#aaaaaa", text: "Section heading", comment: "" };
	const sticky = { ...annotation, key: "ANNOT004", type: "note", text: "", comment: "Sticky comment" };
	const item = { ...entry, tags: ["obscite", "theme"], metadata: { ...entry.metadata, itemType: "journalArticle", publicationTitle: "Journal of Tests", volume: "12", creators: [{ creatorType: "author", lastName: "Doe", firstName: "Jane" }, { creatorType: "editor", name: "Editorial Board" }] }, attachments: [{ ...entry.attachments[0]!, annotations: [gray, sticky] }] };
	const result = renderLiterature(item, "APA", DEFAULT_SETTINGS, null, new Map(), { related: ["doe2019", "bad key"] });
	assert.match(result.content, /^##### Section heading \[p\. ii\]\(zotero:/m);
	assert.match(result.content, /> \[!Note\] p\. ii\n> Sticky comment \[p\. ii\]/);
	assert.match(result.content, /\*\*Author\*\*:: Doe, Jane/);
	assert.match(result.content, /\*\*Editor\*\*:: Editorial Board/);
	assert.match(result.content, /\*\*Journal\*\*:: \*Journal of Tests\*/);
	assert.match(result.content, /\*\*Volume\*\*:: 12/);
	assert.match(result.content, /\*\*Related\*\*:: \[\[@doe2019\]\]/);
	assert.doesNotMatch(result.content, /bad key/);
	assert.match(result.content, /zotero_journal: "Journal of Tests"/);
	assert.match(result.content, /zotero_tags: \["theme"\]/);
	assert.doesNotMatch(result.content, /obscite/);
	assert.match(result.content, /zotero_author: \["Doe, Jane"\]/);
	const plain = renderLiterature(item, "APA", { ...DEFAULT_SETTINGS, headingHighlightColor: "none" }, null);
	assert.match(plain.content, /\[!Highlight\] gray · p\. ii/);
});
