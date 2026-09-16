import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, ZoteroIndexEntry, Annotation } from "../src/types";
import { LEGACY_LITERATURE_KEYS, LITERATURE_IDENTITY_KEYS } from "../src/agent/types";
import { bibliographyText, decodeDoubleEncodedURL, hashText, normalizeLinkTargets, normalizeTag, normalizedTags, plainText, renderLiterature, safeDOI, safeURL, safeVaultPath, textFromHTML } from "../src/note-writer";

const annotation: Annotation = { key: "ANNOT001", attachmentKey: "ATTACH01", type: "highlight", text: "Evidence", comment: "Comment", color: "#ffee00", page: 3, pageLabel: "ii", version: 1, uri: "javascript:bad", tags: ["theme"], dateModified: "" };
const entry: ZoteroIndexEntry = { id: "user:1:ITEM0001", libraryID: 1, libraryType: "user", itemKey: "ITEM0001", citekey: "Example2026", citekeyHistory: [], title: 'A "quoted" title\n---\ninjected: true', authors: ["Test Author"], year: "2026", doi: "", url: "", collections: [], tags: ["a: b", "true"], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEM0001", attachments: [{ key: "ATTACH01", openURI: "", path: null, title: "", annotations: [annotation] }], attachmentStatus: "complete", contentHash: "", metadata: { abstractNote: "<p>Abstract</p>", notes: [{ note: '<p>Note<script>alert(1)</script><img src=x onerror=bad></p>' }] } };
const render = (previous: string | null, item = entry) => renderLiterature(item, "Author (2026). Example.", DEFAULT_SETTINGS, previous);

test("initial import has quoted typed YAML, native layout and safe notes", () => {
	const first = render(null);
	assert.deepEqual(first.conflicts, []);
	const titleLine = first.content.split("\n").find(l => l.startsWith("title: ")) ?? "";
	assert.equal(JSON.parse(titleLine.slice(7)), entry.title);
	assert.match(first.content, /zoteroID: "user:1:ITEM0001"/);
	assert.match(first.content, /^type: "zotero"$/m);
	// 0.5 R14: the initial frontmatter is exactly `type` plus LITERATURE_IDENTITY_KEYS, in order; the pre-0.5 keys are gone.
	const yaml = first.content.split("\n---\n")[0].replace(/^---\n/, "").split("\n").map(line => line.slice(0, line.indexOf(":")));
	assert.deepEqual(yaml, ["type", ...LITERATURE_IDENTITY_KEYS]);
	assert.match(first.content, /^zotero-key: "ITEM0001"$/m);
	assert.match(first.content, /^zoteroSelectURI: "zotero:\/\/select\/library\/items\/ITEM0001"$/m);
	for (const key of LEGACY_LITERATURE_KEYS) assert.doesNotMatch(first.content, new RegExp(`^${key}:`, "m"), key);
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
	assert.match(result.content, /\*\*Zotero related\*\*:: \[\[@doe2019\]\]/);
	assert.equal((result.content.match(/\*\*Related\*\*::/g) ?? []).length, 1);
	assert.doesNotMatch(result.content, /bad key/);
	assert.match(result.content, /zotero_journal: "Journal of Tests"/);
	assert.match(result.content, /zotero_tags: \["theme"\]/);
	assert.doesNotMatch(result.content, /obscite/);
	assert.match(result.content, /zotero_author: \["Doe, Jane"\]/);
	const plain = renderLiterature(item, "APA", { ...DEFAULT_SETTINGS, headingHighlightColor: "none" }, null);
	assert.match(plain.content, /\[!Highlight\] gray · p\. ii/);
});

test("placeholder page labels fall back to the PDF page position", () => {
	const result = renderLiterature({ ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [{ ...annotation, pageLabel: "-" }] }] }, "APA", DEFAULT_SETTINGS, null);
	assert.match(result.content, /\[!Highlight\] yellow · p\. 3\n/);
	assert.match(result.content, /\[p\. 3\]\(zotero:/);
});

test("plain-text fields keep <…> segments: SICI DOI and <B> in titles survive (T02)", () => {
	const sici = "10.1002/(SICI)1099-1743(200005/06)17:3<273::AID-SRES329>3.0.CO;2-R";
	const item = { ...entry, title: "The <B>bold</B> claim", metadata: { ...entry.metadata, DOI: sici } };
	const result = render(null, item);
	assert.ok(result.content.includes(`**DOI**:: ${sici}`));
	assert.match(result.content, /^# The \\<B\\>bold\\<\/B\\> claim$/m);
	assert.match(result.content, /\*\*Title\*\*:: The \\<B\\>bold\\<\/B\\> claim/);
	assert.equal(plainText("a <b> c"), "a \\<b\\> c");
	assert.equal(plainText("&amp;x"), "&amp;x");
	assert.equal(textFromHTML("<p>a &amp; <b>b</b></p>"), "a & b");
});

test("DOI, URL and citekey values are emitted verbatim when strict, escaped otherwise (T03, LIVE-08)", () => {
	assert.equal(safeDOI("10.1162/tacl_a_00099"), "10.1162/tacl_a_00099");
	assert.equal(safeDOI("10.1016/S0378-7206(98)00080-9"), "10.1016/S0378-7206(98)00080-9");
	// Non-strict values fall back to escaped prose (`.` is not a Markdown-significant character).
	assert.equal(safeDOI("10.1/short_x"), "10.1/short\\_x");
	assert.equal(safeDOI("10.1000/has (space)"), "10.1000/has \\(space\\)");
	assert.equal(safeURL("https://example.org/a%20b/c_d?x=1&_tp=x"), "https://example.org/a%20b/c_d?x=1&_tp=x");
	assert.equal(safeURL("ftp://example.org/x_y"), "ftp://example.org/x\\_y");
	assert.equal(safeURL("https://example.org/<x>"), "https://example.org/\\<x\\>");
	assert.equal(decodeDoubleEncodedURL("https://doi.org/10.1002/%2528SICI%2529"), "https://doi.org/10.1002/%28SICI%29");
	assert.equal(safeURL("https://doi.org/10.1002/%2528SICI%2529"), "https://doi.org/10.1002/%28SICI%29");
	assert.equal(decodeDoubleEncodedURL("https://x.y/%25zz"), "https://x.y/%25zz");
	// %25 decoding is limited to DOI URLs (doi.org host or DOI-prefixed path); a literal percent sign elsewhere is kept.
	assert.equal(decodeDoubleEncodedURL("https://onlinelibrary.wiley.com/doi/10.1002/%2528SICI%2529"), "https://onlinelibrary.wiley.com/doi/10.1002/%28SICI%29");
	assert.equal(safeURL("https://example.org/100%25ab-off"), "https://example.org/100%25ab-off");
	assert.equal(bibliographyText("https://example.org/100%25ab"), "<https://example.org/100%25ab>");
	// A real SICI DOI with `<…>` stays verbatim, but `<` may not start an HTML tag and Markdown link/emphasis characters fall back to escaped prose.
	assert.equal(safeDOI("10.1002/(SICI)1097-4571(1999)50:9<799::AID-ASI7>3.0.CO;2-C"), "10.1002/(SICI)1097-4571(1999)50:9<799::AID-ASI7>3.0.CO;2-C");
	assert.equal(safeDOI("10.1234/[[x]]"), "10.1234/\\[\\[x\\]\\]");
	assert.equal(safeDOI("10.1000/a*b*c"), "10.1000/a\\*b\\*c");
	assert.equal(safeDOI("10.1000/a|b`c"), "10.1000/a\\|b\\`c");
	assert.equal(safeDOI("10.1000/<script>alert(1)</script>"), "10.1000/\\<script\\>alert\\(1\\)\\</script\\>");
	// The fallback stays on one line: an embedded newline never breaks the [!md] callout.
	assert.equal(safeDOI("10.1234/ab\ncd"), "10.1234/ab cd");
	assert.equal(safeURL("https://x.y/a\nb"), "https://x.y/a b");
	const item = { ...entry, citekey: "smith_title_2020", url: "https://example.org/a%20b/c_d", metadata: { ...entry.metadata, DOI: "10.1162/tacl_a_00099" } };
	const result = render(null, item);
	assert.match(result.content, /\*\*DOI\*\*:: 10\.1162\/tacl_a_00099$/m);
	assert.match(result.content, /\*\*URL\*\*:: https:\/\/example\.org\/a%20b\/c_d$/m);
	assert.match(result.content, /\*\*Citekey\*\*:: @smith_title_2020$/m);
	assert.doesNotMatch(result.content, /tacl\\_a|c\\_d|smith\\_/);
});

test("bibliography prose stays escaped while URLs become autolinks (T03)", () => {
	assert.equal(bibliographyText("Author (2026). Example. https://doi.org/10.1162/tacl_a_00099."), "Author \\(2026\\). Example. <https://doi.org/10.1162/tacl_a_00099>.");
	assert.equal(bibliographyText("Plain_prose (no URL)"), "Plain\\_prose \\(no URL\\)");
	assert.equal(bibliographyText("See https://x.y/a<b>c and https://doi.org/10.1002/%2528SICI%2529"), "See <https://x.y/a%3Cb%3Ec> and <https://doi.org/10.1002/%28SICI%29>");
	// Unbalanced closing brackets after a URL belong to the prose; balanced ones stay inside the autolink.
	assert.equal(bibliographyText("Retrieved from (https://x.y/z)."), "Retrieved from \\(<https://x.y/z>\\).");
	assert.equal(bibliographyText("See [https://x.y/z]; also https://x.y/w)."), "See \\[<https://x.y/z>\\]; also <https://x.y/w>\\).");
	assert.equal(bibliographyText("See https://en.wikipedia.org/wiki/Foo_(bar) now"), "See <https://en.wikipedia.org/wiki/Foo_(bar)> now");
	const result = renderLiterature(entry, "Author (2026). Example. https://doi.org/10.1162/tacl_a_00099", DEFAULT_SETTINGS, null);
	assert.match(result.content, /> \[!Cite\]\n> Author \\\(2026\\\)\. Example\. <https:\/\/doi\.org\/10\.1162\/tacl_a_00099>$/m);
});

test("new annotation blocks splice after the last annotation block, then the heading, then EOF (T05)", () => {
	const first = render(null).content;
	const withProse = `${first}\n## My reading log\n\nWrote this after reading.\n`;
	const extra = { ...annotation, key: "ANNOT002", text: "New evidence" };
	const grown = { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [annotation, extra] }] };
	const updated = render(withProse, grown);
	assert.deepEqual(updated.conflicts, []);
	assert.ok(updated.content.indexOf("New evidence") < updated.content.indexOf("## My reading log"));
	assert.ok(updated.content.endsWith("## My reading log\n\nWrote this after reading.\n"));
	assert.match(updated.content, /<!-- \/cmds-zotero:annotation-ATTACH01-ANNOT001 -->\n\n<!-- cmds-zotero:annotation-ATTACH01-ANNOT002:[a-f0-9]{64} -->/);
	assert.match(updated.content, /<!-- \/cmds-zotero:annotation-ATTACH01-ANNOT002 -->\n\n## My reading log/);
	assert.equal(render(updated.content, grown).content, updated.content);
	// No annotation blocks yet: the block goes under the heading, above later prose.
	const bare = render(null, { ...entry, attachments: [] }).content;
	assert.match(bare, /## Annotations\n+$/);
	const bareWithProse = `${bare}\n## Log\n\nText.\n`;
	const headed = render(bareWithProse, entry).content;
	assert.match(headed, /## Annotations\n\n<!-- cmds-zotero:annotation-ATTACH01-ANNOT001:[a-f0-9]{64} -->[\s\S]*<!-- \/cmds-zotero:annotation-ATTACH01-ANNOT001 -->\n\n## Log\n\nText\.\n$/);
	// Neither markers nor heading: append at end of file.
	const headless = bare.replace("## Annotations\n", "");
	const appended = render(headless, entry).content;
	assert.match(appended, /## Notes\n\n<!-- cmds-zotero:annotation-ATTACH01-ANNOT001:[a-f0-9]{64} -->[\s\S]*<!-- \/cmds-zotero:annotation-ATTACH01-ANNOT001 -->\n$/);
});

test("YAML tags mirror normalized slugs while zotero_tags and the Tags field stay raw (T06)", () => {
	assert.equal(normalizeTag("H.5.2; I.2.7; H.3.3"), "H52-I27-H33");
	assert.equal(normalizeTag("지식 공유"), "지식-공유");
	assert.equal(normalizeTag("  Artificial Intelligence (cs.AI) "), "Artificial-Intelligence-csAI");
	assert.equal(normalizeTag("2024"), null);
	assert.equal(normalizeTag("()"), null);
	// Nested-tag hygiene: no empty path segments, no leading/trailing separators.
	assert.equal(normalizeTag("/a"), "a");
	assert.equal(normalizeTag("a/"), "a");
	assert.equal(normalizeTag("a//b"), "a/b");
	assert.equal(normalizeTag("a/b"), "a/b");
	assert.equal(normalizeTag("-x-"), "x");
	assert.equal(normalizeTag("/"), null);
	assert.equal(normalizeTag("-/-"), null);
	assert.deepEqual(normalizedTags(["theme", "Theme", "theme", "42"]), ["theme"]);
	const item = { ...entry, tags: ["H.5.2; I.2.7; H.3.3", "지식 공유", "조직행동", "2024", "obscite"] };
	const result = render(null, item);
	assert.match(result.content, /^tags: \["zotero","H52-I27-H33","지식-공유","조직행동"\]$/m);
	assert.match(result.content, /^zotero_tags: \["H\.5\.2; I\.2\.7; H\.3\.3","지식 공유","조직행동","2024"\]$/m);
	assert.match(result.content, /\*\*Tags\*\*:: H\.5\.2; I\.2\.7; H\.3\.3, 지식 공유, 조직행동, 2024$/m);
	assert.match(render(null).content, /^tags: \["zotero","a-b","true"\]$/m);
});

test("empty sticky notes render a placeholder body instead of an empty callout (T07)", () => {
	const empty = { ...annotation, key: "ANNOT005", type: "note", text: "", comment: "" };
	const blank = { ...annotation, key: "ANNOT006", type: "note", text: "", comment: "   " };
	const result = render(null, { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [empty, blank] }] });
	assert.equal((result.content.match(/> \[!Note\] p\. ii\n> \*\(empty note\)\* \[p\. ii\]\(zotero:/g) ?? []).length, 2);
	assert.doesNotMatch(result.content, /\n>  /);
});

test("the managed Zotero related field is always emitted and the Synth Related line stays user-owned (T08)", () => {
	const none = render(null).content;
	assert.match(none, /^> \*\*Zotero related\*\*::$/m);
	assert.match(none, /^> \*\*Related\*\*::$/m);
	assert.equal((none.match(/\*\*Related\*\*::/g) ?? []).length, 1);
	const some = renderLiterature(entry, "APA", DEFAULT_SETTINGS, none, new Map(), { related: ["doe2019", "roe2020"] });
	assert.deepEqual(some.conflicts, []);
	assert.match(some.content, /^> \*\*Zotero related\*\*:: \[\[@doe2019\]\], \[\[@roe2020\]\]$/m);
	assert.match(some.content, /^> \*\*Related\*\*::$/m);
	const filled = none.replace("> **Related**::", "> **Related**:: [[@mine]]");
	assert.match(renderLiterature(entry, "APA", DEFAULT_SETTINGS, filled, new Map(), { related: ["doe2019"] }).content, /^> \*\*Related\*\*:: \[\[@mine\]\]$/m);
});

test("automatic link-target rewrites inside hashed sections are not reported as user edits (T14)", () => {
	assert.equal(normalizeLinkTargets("![Annotation image](Reference%20images/a/b.png) [p. 1](zotero://open-pdf/library/items/K?page=1)"), "![Annotation image](b.png) [p. 1](K?page=1)");
	assert.equal(normalizeLinkTargets("![x](<Moved folder/b.png>) [[Refs/@doe2019|Doe]] [[@roe2020#Heading]]"), "![x](b.png) [[@doe2019|Doe]] [[@roe2020#Heading]]");
	const imageEntry = { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [{ ...annotation, imagePath: "/synthetic/figure.png" }] }] };
	const digest = "b".repeat(64);
	const hashes = new Map([["/synthetic/figure.png", digest]]);
	const settings = { ...DEFAULT_SETTINGS, imageFolder: "Reference images" };
	const initial = renderLiterature(imageEntry, "APA", settings, null, hashes).content;
	const moved = initial.replace("](Reference%20images/", "](Moved%20images/");
	assert.notEqual(moved, initial);
	const result = renderLiterature(imageEntry, "APA", settings, moved, hashes);
	assert.deepEqual(result.conflicts, []);
	assert.equal(result.content, initial);
	// Stored hashes stay raw: the marker hash is the SHA-256 of the raw body, not of the normalized body.
	const [, storedHash, body] = /<!-- cmds-zotero:annotation-ATTACH01-ANNOT001:([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- \/cmds-zotero:annotation-ATTACH01-ANNOT001 -->/.exec(initial) ?? [];
	assert.equal(storedHash, hashText(body ?? ""));
	assert.notEqual(storedHash, hashText(normalizeLinkTargets(body ?? "")));
	// A real edit of the image line is still preserved and reported.
	const edited = initial.replace("![Annotation image]", "![My caption]");
	assert.match(renderLiterature(imageEntry, "APA", settings, edited, hashes).conflicts.join(" "), /Edited generated section/);
});

test("link-target normalization handles image folders containing parentheses (T14, live vault path)", () => {
	assert.equal(normalizeLinkTargets("![Annotation image](80.%20References/84.%20References%20(Zotero)/images/a.png) [p. 1](zotero://open-pdf/library/items/K?page=1)"), "![Annotation image](a.png) [p. 1](K?page=1)");
	assert.equal(normalizeLinkTargets("![i](84.%20References%20%28Zotero%29/img/a.png) tail"), "![i](a.png) tail");
	const imageEntry = { ...entry, attachments: [{ ...entry.attachments[0]!, annotations: [{ ...annotation, imagePath: "/synthetic/figure.png" }] }] };
	const hashes = new Map([["/synthetic/figure.png", "c".repeat(64)]]);
	const settings = { ...DEFAULT_SETTINGS, imageFolder: "80. References/84. References (Zotero)/images" };
	const initial = renderLiterature(imageEntry, "APA", settings, null, hashes).content;
	assert.match(initial, /!\[Annotation image\]\(80\.%20References\/84\.%20References%20\(Zotero\)\/images\/user-1-ATTACH01-ANNOT001-c{64}\.png\)/);
	const rewrites = [
		initial.replace("(Zotero)/images/", "(Zotero)/img/"),
		initial.replace("84.%20References%20(Zotero)/images/", "84.%20References%20%28Zotero%29/img/"),
		initial.replace("80.%20References/84.%20References%20(Zotero)/images/", "Reference%20images/"),
	];
	for (const moved of rewrites) {
		assert.notEqual(moved, initial);
		const result = renderLiterature(imageEntry, "APA", settings, moved, hashes);
		assert.deepEqual(result.conflicts, []);
		assert.equal(result.content, initial);
	}
	// Still a real edit when the image basename itself changes.
	const renamed = initial.replace("-ANNOT001-", "-ANNOT999-");
	assert.match(renderLiterature(imageEntry, "APA", settings, renamed, hashes).conflicts.join(" "), /Edited generated section/);
});
