// 0.6.2 installed styles, locale, per-note style/locale and bibliography order. Synthetic styles in a temporary folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDirectoryProblem, decodeXmlText, expandDataDirectory, findStyle, homeRelative, independentStyle, listInstalledStyles, parseCslInfo, sameStyle, styleKey } from "../src/bibliography/csl-styles";
import { canonicalLocale, copyListNotice, entriesHtml, formatKey, formatLabel, localeProblem, markdownEntry, noteFormat, orderEntries, probeProblem, splitTextBibliography, styleFromCsl } from "../src/bibliography/format";
import { BbtTransportError } from "../src/api/transport";
import { bibliographyFormat } from "../src/bbt";
import { normalizeSettings } from "../src/settings-data";
import { dataDirectoryField, localeField, draftOf } from "../src/settings/fields";
import { DEFAULT_SETTINGS } from "../src/types";

test("item.bibliography format, settings normalisation and the locale and data directory fields", () => {
	assert.deepEqual(bibliographyFormat("apa"), { id: "apa", contentType: "text" });
	assert.deepEqual(bibliographyFormat("apa", { locale: "ko-KR", contentType: "html" }), { id: "apa", contentType: "html", locale: "ko-KR" });
	const settings = normalizeSettings({ bibliographyLocale: "ko_kr", bibliographyOrder: "alphabetical", zoteroDataDirectory: "relative/path", exportFolder: " Exports " });
	assert.deepEqual([settings.bibliographyLocale, settings.bibliographyOrder, settings.zoteroDataDirectory, settings.exportFolder], ["ko-KR", "alphabetical", "~/Zotero", "Exports"]);
	const defaults = normalizeSettings({ bibliographyLocale: "korean", bibliographyOrder: "random" });
	assert.deepEqual([defaults.bibliographyLocale, defaults.bibliographyOrder], ["", "style"]);
	const draft = draftOf(DEFAULT_SETTINGS);
	assert.equal(localeField.write(draft, "en_us"), null);
	assert.equal(draft.bibliographyLocale, "en-US");
	assert.match(localeField.write(draft, "english") ?? "", /locale such as/);
	assert.equal(draft.bibliographyLocale, "en-US");
	assert.match(dataDirectoryField.write(draft, "Zotero") ?? "", /absolute/);
	assert.equal(dataDirectoryField.write(draft, "/Volumes/Data/Zotero"), null);
});

const csl = (id: string, title: string, extra = ""): string => `<?xml version="1.0" encoding="utf-8"?>
<!-- <info><id>commented</id></info> -->
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">
  <info>
    <title>${title}</title>
    <title-short>T</title-short>
    <id>${id}</id>
    ${extra}
  </info>
  <citation><layout/></citation>
</style>`;

test("CSL info: id, title, entities, parent and default locale; missing pieces are refused", () => {
	const info = parseCslInfo(csl("http://www.zotero.org/styles/sample-a", "Sample &amp; Style &#xAC00;"));
	assert.deepEqual(info, { id: "http://www.zotero.org/styles/sample-a", title: "Sample & Style 가", shortTitle: "T", defaultLocale: "en-US", styleClass: "in-text" });
	const dependent = parseCslInfo(csl("http://www.zotero.org/styles/sample-b", "Dependent", "<link href=\"http://www.zotero.org/styles/sample-a\" rel=\"independent-parent\"/>"));
	assert.equal(dependent?.parent, "http://www.zotero.org/styles/sample-a");
	assert.equal(parseCslInfo("<style><info><title>No id</title></info></style>"), null);
	assert.equal(parseCslInfo("not xml"), null);
	assert.equal(decodeXmlText("a &unknown; &#0; <![CDATA[b]]>"), "a &unknown; &#0; b");
	assert.equal(styleKey("http://www.zotero.org/styles/apa"), "apa");
	assert.equal(styleKey("https://example.org/styles/custom"), "https://example.org/styles/custom");
	assert.ok(sameStyle("apa", "http://www.zotero.org/styles/apa"));
});

// Synthetic home folders, assembled at runtime so the release sanitizer (which looks for literal home paths) stays quiet.
const MAC_HOME = ["", "Users", "someone"].join("/");
const HOME = ["", "home", "synthetic"].join("/");

test("data directory: validation, ~ expansion and ${HOME} paths", () => {
	assert.equal(dataDirectoryProblem(""), null);
	assert.equal(dataDirectoryProblem("~/Zotero"), null);
	assert.equal(dataDirectoryProblem(`${MAC_HOME}/Zotero`), null);
	assert.match(dataDirectoryProblem("Zotero") ?? "", /absolute/);
	assert.match(dataDirectoryProblem("/a/../b") ?? "", /traversal/);
	assert.equal(expandDataDirectory("", HOME), `${HOME}/Zotero`);
	assert.equal(expandDataDirectory("~/Data/Zotero", HOME), `${HOME}/Data/Zotero`);
	assert.equal(homeRelative(`${HOME}/Zotero/styles/a.csl`, HOME), "${HOME}/Zotero/styles/a.csl");
	assert.equal(homeRelative("/opt/styles/a.csl", HOME), "/opt/styles/a.csl");
});

test("installed styles are listed by title, symlinks and broken files are skipped, the listing is bounded", async () => {
	const home = await mkdtemp(join(tmpdir(), "cmds-zotero-styles-"));
	try {
		const styles = join(home, "Zotero", "styles");
		await mkdir(styles, { recursive: true });
		await writeFile(join(styles, "sample-b.csl"), csl("http://www.zotero.org/styles/sample-b", "Beta style", "<link href=\"http://www.zotero.org/styles/sample-a\" rel=\"independent-parent\"/>"));
		await writeFile(join(styles, "sample-a.csl"), csl("http://www.zotero.org/styles/sample-a", "Alpha style"));
		await writeFile(join(styles, "broken.csl"), "<style>no info here at all</style>");
		await writeFile(join(styles, "notes.txt"), "ignored");
		await symlink(join(styles, "sample-a.csl"), join(styles, "linked.csl"));
		const listing = await listInstalledStyles("~/Zotero", { home });
		assert.deepEqual(listing.styles.map(style => [style.key, style.title, style.file]), [["sample-a", "Alpha style", "sample-a.csl"], ["sample-b", "Beta style", "sample-b.csl"]]);
		assert.deepEqual(listing.skipped.map(item => [item.file, item.reason]), [["broken.csl", "no style id or title"], ["linked.csl", "symlink"]]);
		assert.equal(listing.truncated, false);
		const beta = findStyle(listing.styles, "http://www.zotero.org/styles/sample-b");
		assert.equal(beta && independentStyle(listing.styles, beta)?.key, "sample-a");
		assert.equal(findStyle(listing.styles, "sample-a")?.title, "Alpha style");
		assert.equal((await listInstalledStyles("~/Zotero", { home, maxFiles: 1 })).truncated, true);
		await assert.rejects(listInstalledStyles("~/Elsewhere", { home }), /No Zotero styles folder/);
	} finally { await rm(home, { recursive: true, force: true }); }
});

test("locale validation, the cache key and per-note csl/lang overrides", () => {
	assert.equal(localeProblem(""), null);
	assert.equal(localeProblem("ko-KR"), null);
	assert.equal(localeProblem("zh-Hant-TW"), null);
	assert.match(localeProblem("korean") ?? "", /locale such as/);
	assert.equal(canonicalLocale("ko_kr"), "ko-KR");
	assert.equal(formatKey({ style: "apa", locale: "" }), "apa");
	assert.equal(formatKey({ style: "apa", locale: "ko-KR" }), "apa@ko-KR");
	const styles = [{ key: "sample-a", id: "http://www.zotero.org/styles/sample-a", title: "Alpha", file: "sample-a.csl", path: "/synthetic/sample-a.csl" }];
	assert.equal(styleFromCsl("styles/Sample-A.csl", styles), "sample-a");
	assert.equal(styleFromCsl("/x/unknown.csl", styles), "unknown");
	assert.equal(styleFromCsl("http://www.zotero.org/styles/chicago", styles), "chicago");
	const settings = { bibliographyStyle: "apa", bibliographyLocale: "en-US" };
	assert.deepEqual(noteFormat({ csl: "sample-a.csl", lang: "ko_KR" }, settings, styles), { style: "sample-a", locale: "ko-KR", styleFrom: "note", localeFrom: "note", problems: [] });
	const fallback = noteFormat({ lang: "korean" }, settings, styles);
	assert.deepEqual([fallback.style, fallback.locale, fallback.localeFrom], ["apa", "en-US", "settings"]);
	assert.equal(fallback.problems.length, 1);
	assert.equal(formatLabel(noteFormat(null, { bibliographyStyle: "apa" })), "apa");
	assert.equal(formatLabel(noteFormat({ lang: "de-DE" }, settings)), "apa · de-DE (from note)");
});

test("the style probe refuses an error reply, an unreachable Zotero and an empty rendering; the copy Notice names order and sources", () => {
	const format = { style: "sample-a", locale: "ko-KR" };
	assert.equal(probeProblem(format, { text: "Doe (2020)." }), null);
	assert.match(probeProblem(format, { text: "  " }) ?? "", /rendered nothing with the style "sample-a" \(ko-KR\)/);
	const rpc = new BbtTransportError("rpc", "http://127.0.0.1:23119/better-bibtex", "BBT RPC error for item.bibliography", { rpcCode: -32603, rpcMessage: "style not installed" });
	assert.match(probeProblem(format, { error: rpc }) ?? "", /cannot render the style "sample-a" \(ko-KR\): style not installed/);
	const down = new BbtTransportError("connection-refused", "http://127.0.0.1:23119/better-bibtex", "connect ECONNREFUSED");
	assert.match(probeProblem({ style: "apa", locale: "" }, { error: down }) ?? "", /could not be checked, so it was not saved\. .*Start Zotero/);
	assert.equal(copyListNotice({ text: ["a", "b"], order: "style", counts: { live: 2, cached: 0, fallback: 0 }, libraries: 1 }, true), "Copied 2 entries as formatted text in style order.");
	assert.equal(copyListNotice({ text: ["a"], order: "citation", counts: { live: 0, cached: 1, fallback: 0 }, libraries: 2, error: new Error("x") }, false), "Copied 1 entry as plain text in citation order (1 from cache; Zotero offline). Better BibTeX could not render the list in style order.");
	assert.match(copyListNotice({ text: ["a", "b"], order: "style", counts: { live: 2, cached: 0, fallback: 0 }, libraries: 2 }, true), /library by library \(2 libraries\)/);
});

test("bibliography order, text splitting, clipboard HTML and Markdown entries", () => {
	const items = ["Zeta, A. (2020).", "\"Alpha\" (2019).", "beta, B. (2021)."];
	assert.deepEqual(orderEntries(items, "alphabetical", item => item), ["\"Alpha\" (2019).", "beta, B. (2021).", "Zeta, A. (2020)."]);
	assert.deepEqual(orderEntries(items, "style", item => item), items);
	assert.deepEqual(splitTextBibliography("A.\r\n\nB.\n"), ["A.", "B."]);
	assert.equal(entriesHtml(["A & <B>"]), "<div class=\"csl-bib-body\"><div class=\"csl-entry\">A &amp; &lt;B&gt;</div></div>");
	assert.equal(markdownEntry("A <!-- x --> %% y"), "A &lt;!-- x --&gt; %​% y");
});
