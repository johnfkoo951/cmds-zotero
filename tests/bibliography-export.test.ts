// 0.5 R10: pandoc-ready bibliography — format mapping, per-library export grouping, CSL-JSON merge/strip, References
// heading detection (Korean included), sidecar path derivation and overwrite rules, offline/live action behaviour, CLI flags.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	BIBLIOGRAPHY_DIR, BIBLIOGRAPHY_FORMATS, CSL_STRIPPED_FIELDS, EXPORT_TRANSLATORS, GENERATOR_MARKERS, SIDECAR_EXTENSIONS, bibtexKeys, classifyKeys, defaultSidecarPath,
	findReferencesSection, groupEntriesByLibrary, groupResolvedByLibrary, isStructuredFormat, mergeExports, referencesHeadingPattern, referencesPayload, referencesSection,
	sidecarContent, sidecarSlug, sidecarWriteDecision, structuredReferencesPayload, validateSidecarPath, type NoteLookups,
} from "../src/agent/cites-core";
import { runAction, validateActionRequest, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { normalizeSettings } from "../src/settings-data";
import { DEFAULT_REFERENCES_HEADINGS, DEFAULT_SETTINGS, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";
import type { NoteRecord } from "../src/agent/types";
import { entryHash } from "../src/identity";

const now = new Date("2026-09-16T10:00:00.000Z");
const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({ id: "1:AAAA0001", libraryID: 1, libraryType: "user", itemKey: "AAAA0001", citekey: "alpha2020memory", citekeyHistory: [], title: "Alpha memory study", authors: ["Alpha, Ann"], year: "2020", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/AAAA0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...o });
const entries = [
	entry({}),
	entry({ id: "1:BBBB0001", itemKey: "BBBB0001", citekey: "beta2021agent", citekeyHistory: ["beta2021old"] }),
	entry({ id: "3:CCCC0001", libraryID: 3, libraryType: "group", groupID: 77, itemKey: "CCCC0001", citekey: "gamma2019group" }),
];
const index: ZoteroIndex = { schemaVersion: 2, generatedAt: now.toISOString(), source: "better-bibtex", count: entries.length, entries, capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete: true };
const noLookups: NoteLookups = { hubByCitekey: new Map(), rawByCitekey: new Map() };
const byId = new Map(entries.map(item => [item.id, item]));

test("format vocabulary: translator labels, sidecar extensions and the structured/text split", () => {
	assert.deepEqual([...BIBLIOGRAPHY_FORMATS], ["text", "markdown", "csl-json", "bibtex", "biblatex"]);
	assert.deepEqual(EXPORT_TRANSLATORS, { "csl-json": "Better CSL JSON", bibtex: "Better BibTeX", biblatex: "Better BibLaTeX" });
	assert.deepEqual(SIDECAR_EXTENSIONS, { text: "txt", markdown: "md", "csl-json": "json", bibtex: "bib", biblatex: "bib" });
	assert.deepEqual(BIBLIOGRAPHY_FORMATS.filter(isStructuredFormat), ["csl-json", "bibtex", "biblatex"]);
	assert.deepEqual([...CSL_STRIPPED_FIELDS], ["abstract", "note"]);
});

test("resolved keys are grouped per library under the entry's current citekey; history hits are reported as renamed", () => {
	const keys = ["alpha2020memory", "beta2021old", "gamma2019group", "nowhere2025gone", "alpha2020memory"];
	const verdicts = classifyKeys(keys, index, noLookups, false, false);
	const { groups, renamed } = groupResolvedByLibrary(keys, verdicts, byId);
	assert.deepEqual(groups, [{ libraryID: 1, citekeys: ["alpha2020memory", "beta2021agent"] }, { libraryID: 3, citekeys: ["gamma2019group"] }]);
	assert.deepEqual(renamed, [{ cited: "beta2021old", current: "beta2021agent" }]);
	assert.deepEqual(groupEntriesByLibrary([entries[2], entries[0], entries[2]]), [{ libraryID: 3, citekeys: ["gamma2019group"] }, { libraryID: 1, citekeys: ["alpha2020memory"] }]);
});

test("CSL-JSON outputs of several libraries merge into one plain array with abstract and note stripped; ids stay", () => {
	const first = JSON.stringify([{ id: "alpha2020memory", "citation-key": "alpha2020memory", type: "article-journal", title: "Alpha", abstract: "private prose", note: "reading notes" }]);
	const second = JSON.stringify([{ id: "gamma2019group", type: "book", title: "Gamma" }]);
	const merged = mergeExports("csl-json", [first, "", second]);
	const parsed: unknown = JSON.parse(merged.content);
	assert.ok(Array.isArray(parsed));
	assert.deepEqual(parsed, [{ id: "alpha2020memory", "citation-key": "alpha2020memory", type: "article-journal", title: "Alpha" }, { id: "gamma2019group", type: "book", title: "Gamma" }]);
	assert.deepEqual(merged.exported, ["alpha2020memory", "gamma2019group"]);
	assert.deepEqual(merged.stripped, ["abstract", "note"]);
	assert.deepEqual(mergeExports("csl-json", [second]).stripped, []);
	assert.ok(merged.content.endsWith("]\n"));
	assert.throws(() => mergeExports("csl-json", ["{\"items\":[]}"]), /must be an array/);
	assert.throws(() => mergeExports("csl-json", ["[1]"]), /non-object/);
});

test("BibTeX and BibLaTeX outputs are concatenated with one blank line and their entry keys are read", () => {
	const a = "@article{alpha2020memory,\n  title = {Alpha},\n}\n";
	const b = "@comment{jabref-meta: x}\n@book{gamma2019group,\n  title = {Gamma}\n}";
	const merged = mergeExports("bibtex", [a, "  ", b]);
	assert.equal(merged.content, "@article{alpha2020memory,\n  title = {Alpha},\n}\n\n@comment{jabref-meta: x}\n@book{gamma2019group,\n  title = {Gamma}\n}\n");
	assert.deepEqual(merged.exported, ["alpha2020memory", "gamma2019group"]);
	assert.deepEqual(merged.stripped, []);
	assert.deepEqual(bibtexKeys("@Article{ Key1 ,\n}\n  @misc{key2,}\n@preamble{\"x\"}\nnote = {see @book{inline,} text}"), ["Key1", "key2"]);
	assert.deepEqual(mergeExports("biblatex", []), { content: "", exported: [], stripped: [] });
});

test("References heading detection accepts the documented titles (Korean included), levels 2-6, qualifiers and closing hashes", () => {
	const pattern = referencesHeadingPattern();
	const accepted = ["## References", "### references", "## Bibliography", "#### Works Cited", "## works cited ##", "## 참고 문헌", "## 참고문헌", "###### 참고 자료", "## 참고자료", "## References (APA 7)", "## 참고 문헌 (인용 순)", "## References  ###  "];
	const rejected = ["# References", "## Reference list", "## References and notes", "## References (a very long qualifier that runs past forty characters)", "##References", "text ## References", "## Refs"];
	for (const line of accepted) assert.ok(pattern.test(line), `should accept ${line}`);
	for (const line of rejected) assert.ok(!pattern.test(line), `should reject ${line}`);
	assert.deepEqual([...DEFAULT_REFERENCES_HEADINGS], ["References", "Bibliography", "Works Cited", "참고 문헌", "참고 자료"]);
	// A configured list replaces the defaults; an empty list falls back to "References" so detection never goes blind.
	assert.ok(referencesHeadingPattern(["Literatur"]).test("## Literatur") && !referencesHeadingPattern(["Literatur"]).test("## References"));
	assert.ok(referencesHeadingPattern([]).test("## References"));
	assert.ok(!referencesHeadingPattern(["a.b"]).test("## axb"), "titles are escaped, not regex");
});

test("a Korean References section is found, its heading is reported and reused, and it ends at a sibling or parent heading", () => {
	const lines = ["# 제목", "본문 [@alpha2020memory]", "### 참고 문헌", "- [@alpha2020memory] Alpha (2020).", "#### 하위", "- [@beta2021old] still inside", "### 다음 절", "- [@gamma2019group] outside"];
	const span = findReferencesSection(lines);
	assert.deepEqual(span, { start: 2, end: 6, listed: ["alpha2020memory", "beta2021old"], heading: "### 참고 문헌", level: 3 });
	const section = referencesSection(lines.join("\n"), ["alpha2020memory", "gamma2019group"]);
	assert.deepEqual(section, { present: true, listed: ["alpha2020memory", "beta2021old"], missingFromReferences: ["gamma2019group"], notCited: ["beta2021old"], heading: "### 참고 문헌" });
	assert.equal(referencesSection("## 참고 문헌\n- x", ["k"], ["Literatur"]).present, false);
	const verdicts = classifyKeys(["alpha2020memory"], index, noLookups, false, false);
	const payload = referencesPayload(["alpha2020memory"], verdicts, new Map([["alpha2020memory", "Alpha, A. (2020). Alpha memory study."]]), new Map(), { format: "markdown", heading: span?.heading, style: "apa" });
	assert.equal(payload.markdown, "### 참고 문헌\n- [@alpha2020memory] Alpha, A. (2020). Alpha memory study.");
	assert.equal(payload.content, payload.markdown);
	assert.deepEqual({ format: payload.format, style: payload.style, heading: payload.heading }, { format: "markdown", style: "apa", heading: "### 참고 문헌" });
	const text = referencesPayload(["alpha2020memory", "nowhere2025gone"], classifyKeys(["alpha2020memory", "nowhere2025gone"], index, noLookups, false, false), new Map([["alpha2020memory", "Alpha, A. (2020).\n Alpha memory study."]]), new Map());
	assert.deepEqual({ format: text.format, heading: text.heading, content: text.content }, { format: "text", heading: "## References", content: "Alpha, A. (2020). Alpha memory study." });
	assert.equal(text.markdown.split("\n")[0], "## References");
});

test("sidecar paths derive from the note or folder name under the plugin-owned folder; explicit paths are validated", () => {
	assert.equal(sidecarSlug("20. Wiki/25. Questions/Why memory.md", true), "Why-memory");
	assert.equal(sidecarSlug("40. Paper Analyses/alpha2020memory/Atom: one?.md", true), "Atom-one");
	assert.equal(sidecarSlug("/20. Wiki/25. Questions/", false), "25.-Questions");
	assert.equal(sidecarSlug("", false), "vault");
	assert.equal(sidecarSlug("...md", true), "vault");
	assert.equal(defaultSidecarPath("manuscript.md", true, "csl-json"), `${BIBLIOGRAPHY_DIR}/manuscript.json`);
	assert.equal(defaultSidecarPath("manuscript.md", true, "biblatex"), ".cmds-zotero/bibliography/manuscript.bib");
	assert.equal(defaultSidecarPath("Drafts", false, "markdown"), ".cmds-zotero/bibliography/Drafts.md");
	assert.equal(validateSidecarPath("/Drafts//manuscript.bib/"), "Drafts/manuscript.bib");
	for (const bad of ["", "   ", "../x.bib", "a/../b.json", "C:\\x.bib", "file:///x", "a//./b", "x\0y"]) assert.throws(() => validateSidecarPath(bad), `should refuse ${JSON.stringify(bad)}`);
});

test("overwrite rule: plugin folder always, elsewhere only absent or marked files; CSL-JSON needs --force; notes never", () => {
	const marked = `${GENERATOR_MARKERS.bibtex}\n@article{x,}\n`;
	assert.deepEqual(sidecarWriteDecision(`${BIBLIOGRAPHY_DIR}/m.bib`, "bibtex", "anything", false), { ok: true });
	assert.deepEqual(sidecarWriteDecision("Drafts/m.bib", "bibtex", null, false), { ok: true });
	assert.deepEqual(sidecarWriteDecision("Drafts/m.bib", "bibtex", marked, false), { ok: true });
	assert.deepEqual(sidecarWriteDecision("Drafts/m.bib", "bibtex", `\uFEFF${marked}`, false), { ok: true });
	assert.equal(sidecarWriteDecision("Drafts/m.bib", "bibtex", "@article{x,}\n", false).ok, false);
	assert.deepEqual(sidecarWriteDecision("Drafts/m.bib", "bibtex", "@article{x,}\n", true), { ok: true });
	const json = sidecarWriteDecision("Drafts/m.json", "csl-json", "[]", false);
	assert.equal(json.ok, false);
	assert.match(json.ok ? "" : json.message, /--force/);
	assert.deepEqual(sidecarWriteDecision("Drafts/m.json", "csl-json", "[]", true), { ok: true });
	assert.deepEqual(sidecarWriteDecision("Drafts/refs.md", "markdown", `${GENERATOR_MARKERS.markdown}\n## References`, false), { ok: true });
	const note = sidecarWriteDecision("Drafts/manuscript.md", "markdown", "---\ntitle: x\n---\n", true);
	assert.equal(note.ok, false);
	assert.match(note.ok ? "" : note.message, /never replaced/);
	assert.equal(sidecarContent("csl-json", "[]\n"), "[]\n");
	assert.equal(sidecarContent("bibtex", "@article{x,}"), "% cmds-zotero bibliography\n@article{x,}\n");
	assert.equal(sidecarContent("text", "A.\n\nB.\n"), "<!-- cmds-zotero bibliography -->\nA.\n\nB.\n");
});

function host(options: { exporter?: ActionHost["exportBibliography"]; sidecar?: ActionHost["sidecar"]; offline?: boolean; notes?: NoteRecord[]; bodies?: Map<string, string> } = {}): ActionHost {
	const notes = options.notes ?? [{ path: "Drafts/manuscript.md", basename: "manuscript", frontmatter: { title: "M" }, frontmatterParse: "ok" }];
	const bodies = options.bodies ?? new Map([["Drafts/manuscript.md", "---\ntitle: M\n---\nText [@alpha2020memory; @beta2021old] and [@gamma2019group] and [@nowhere2025gone].\n\n## 참고 문헌\n- [@alpha2020memory] listed\n"]]);
	const connection = buildConnection({ mode: options.offline ? "offline" : "live", obsidian: options.offline ? "unavailable" : "ok", pluginVersion: "0.5.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: null }, index: { source: options.offline ? "offline-file" : "plugin", path: "80. References/zotero-index.json", generatedAt: index.generatedAt, count: index.count, complete: true, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now });
	return {
		vault: "Research", now, connection, settings: DEFAULT_SETTINGS, indexView: { index, stale: false, ageMinutes: 0 }, indexFailure: null,
		reader: { vaultName: () => "Research", scanWarnings: () => ({ skipped: [], truncated: false }), listNotes: async () => notes, readNote: async path => { const body = bodies.get(path); if (body === undefined) throw new Error(`Note not found: ${path}`); return body; }, exists: async path => bodies.has(path) },
		bibliography: options.offline ? null : async entry => `${entry.authors[0]} (${entry.year}). ${entry.title}.`, bibliographyReason: options.offline ? "offline" : null,
		vaultLinks: async () => ({ links: [], warnings: [] }), pdfCache: { list: async () => [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
		...(options.exporter ? { exportBibliography: options.exporter } : {}), ...(options.sidecar ? { sidecar: options.sidecar } : {}),
	};
}

function fakeExporter(calls: { citekeys: string[]; format: string; libraryID: number }[], fail = false): NonNullable<ActionHost["exportBibliography"]> {
	return async (citekeys, format, libraryID) => {
		calls.push({ citekeys: [...citekeys], format, libraryID });
		if (fail) throw new Error("boom");
		if (format === "csl-json") return JSON.stringify(citekeys.map(key => ({ id: key, type: "article", abstract: "x" })));
		return citekeys.map(key => `@article{${key},\n  title = {${key}}\n}`).join("\n");
	};
}

test("cites --format csl-json: one export per library, merged array, stripped fields, renamed history keys, unresolved keys", async () => {
	const calls: { citekeys: string[]; format: string; libraryID: number }[] = [];
	const result = await runAction(host({ exporter: fakeExporter(calls) }), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "csl-json" });
	assert.equal(result.ok, true);
	assert.deepEqual(calls, [{ citekeys: ["alpha2020memory", "beta2021agent"], format: "csl-json", libraryID: 1 }, { citekeys: ["gamma2019group"], format: "csl-json", libraryID: 3 }]);
	const references = result.references as Record<string, unknown>;
	assert.equal(references.format, "csl-json");
	assert.equal(references.heading, "## 참고 문헌");
	assert.deepEqual(JSON.parse(references.content as string), [{ id: "alpha2020memory", type: "article" }, { id: "beta2021agent", type: "article" }, { id: "gamma2019group", type: "article" }]);
	assert.deepEqual(references.exported, ["alpha2020memory", "beta2021agent", "gamma2019group"]);
	assert.deepEqual(references.stripped, ["abstract"]);
	assert.deepEqual(references.renamed, [{ cited: "beta2021old", current: "beta2021agent" }]);
	assert.deepEqual((references.unresolved as { citekey: string; citeStatus: string }[]).map(item => [item.citekey, item.citeStatus]), [["nowhere2025gone", "dangling"]]);
	assert.equal(result.referencesReason, undefined);
	assert.equal(result.out, undefined);
	const files = result.files as { referencesSection: { present: boolean; heading?: string } }[];
	assert.deepEqual(files[0].referencesSection, { present: true, listed: ["alpha2020memory"], missingFromReferences: ["beta2021old", "gamma2019group", "nowhere2025gone"], notCited: [], heading: "## 참고 문헌" });
});

test("cites --format bibtex concatenates per-library exports; a resolved key missing from the export is reported unresolved", async () => {
	const exporter: NonNullable<ActionHost["exportBibliography"]> = async (citekeys, _format, libraryID) => libraryID === 1 ? `@article{${citekeys[0]},}` : "";
	const result = await runAction(host({ exporter }), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "bibtex" });
	const references = result.references as Record<string, unknown>;
	assert.equal(references.format, "bibtex");
	assert.equal(references.content, "@article{alpha2020memory,}\n");
	assert.deepEqual(references.exported, ["alpha2020memory"]);
	assert.equal(references.stripped, undefined);
	assert.deepEqual((references.unresolved as { citekey: string; citeStatus: string }[]).map(item => [item.citekey, item.citeStatus]), [["beta2021old", "resolved"], ["gamma2019group", "resolved"], ["nowhere2025gone", "dangling"]]);
});

test("offline core: structured formats are unavailable with referencesReason offline; text and markdown still work from hub lines", async () => {
	const calls: never[] = [];
	const structured = await runAction(host({ offline: true }), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "csl-json" });
	assert.equal(structured.ok, true);
	assert.equal(structured.referencesReason, "offline");
	const references = structured.references as Record<string, unknown>;
	assert.equal(references.content, null);
	assert.deepEqual(references.exported, []);
	assert.deepEqual((references.unresolved as { citekey: string; hint: string }[]).map(item => item.citekey), ["alpha2020memory", "beta2021old", "gamma2019group", "nowhere2025gone"]);
	assert.match((references.unresolved as { hint: string }[])[0].hint, /live host/);
	assert.equal(calls.length, 0);
	const hubRef = { path: "Hubs/hub.md", basename: "hub", uri: "obsidian://open?vault=Research&file=Hubs%2Fhub" };
	const offlineHost = host({ offline: true, notes: [{ path: "Drafts/m.md", basename: "m", frontmatter: {}, frontmatterParse: "ok" }, { path: "Hubs/hub.md", basename: "hub", frontmatter: { type: "paper-hub", citekey: "hubonly2022note" }, frontmatterParse: "ok" }], bodies: new Map([["Drafts/m.md", "[@hubonly2022note] and [@alpha2020memory]\n\n## Bibliography\n"], ["Hubs/hub.md", "- **Full citation**: Hub, H. (2022). Hub only paper."]]) });
	const markdown = await runAction(offlineHost, "cites", { path: "Drafts/m.md", bibliography: true, format: "markdown" });
	assert.equal(markdown.referencesReason, "offline");
	const md = markdown.references as Record<string, unknown>;
	assert.equal(md.format, "markdown");
	assert.equal(md.content, "## Bibliography\n- [@hubonly2022note] Hub, H. (2022). Hub only paper. (provisional)\n- [@alpha2020memory] (bibliography unavailable)");
	void hubRef;
});

test("cites --out: default plugin-owned path, explicit guarded path, refusals, and requires-obsidian without a sidecar store", async () => {
	const written: { path: string; content: string }[] = [];
	const existing = new Map<string, string>([["Drafts/old.json", "[]"], ["Drafts/note.md", "# a note"], ["Drafts/marked.bib", `${GENERATOR_MARKERS.bibtex}\nold`]]);
	const sidecar: ActionHost["sidecar"] = { read: async path => existing.get(path) ?? null, write: async (path, content) => { written.push({ path, content }); return Buffer.byteLength(content); } };
	const live = (): ActionHost => host({ exporter: fakeExporter([]), sidecar });
	const dflt = await runAction(live(), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "csl-json", out: true });
	assert.equal(dflt.ok, true);
	assert.deepEqual(dflt.out, { path: ".cmds-zotero/bibliography/manuscript.json", written: true, bytes: written[0].content.length });
	assert.ok(written[0].content.startsWith("[\n"), "CSL-JSON sidecar is a plain array");
	const bib = await runAction(live(), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "biblatex", out: "Drafts/marked.bib" });
	assert.deepEqual(bib.out, { path: "Drafts/marked.bib", written: true, bytes: Buffer.byteLength(written[1].content) });
	assert.ok(written[1].content.startsWith("% cmds-zotero bibliography\n@article{alpha2020memory,"));
	const refusedJson = await runAction(live(), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "csl-json", out: "Drafts/old.json" });
	assert.equal(refusedJson.ok, false);
	assert.equal(refusedJson.reason, "invalid-request");
	assert.deepEqual(refusedJson.out, { path: "Drafts/old.json", written: false });
	assert.ok(refusedJson.references, "the payload still carries the bibliography");
	const forced = await runAction(live(), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "csl-json", out: "/Drafts/old.json", force: true });
	assert.deepEqual(forced.out, { path: "Drafts/old.json", written: true, bytes: Buffer.byteLength(written[2].content) });
	const note = await runAction(live(), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "markdown", out: "Drafts/note.md", force: true });
	assert.equal(note.reason, "invalid-request");
	assert.match(String(note.message), /never replaced/);
	const outside = await runAction(live(), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "bibtex", out: "../escape.bib" });
	assert.equal(outside.reason, "path-outside-vault");
	assert.deepEqual(outside.out, { path: "../escape.bib", written: false });
	assert.equal(written.length, 3);
	const offline = await runAction(host({ offline: true }), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "text", out: true });
	assert.equal(offline.reason, "requires-obsidian");
	assert.deepEqual(offline.out, { path: ".cmds-zotero/bibliography/manuscript.txt", written: false });
	const bbtDown = await runAction(host({ exporter: fakeExporter([], true), sidecar }), "cites", { path: "Drafts/manuscript.md", bibliography: true, format: "csl-json", out: true });
	assert.equal(bbtDown.ok, false);
	assert.equal(bbtDown.referencesReason, "export-invalid");
	assert.equal((bbtDown.out as { written: boolean }).written, false);
	assert.equal(written.length, 3);
});

test("request validation: format vocabulary, out shape, and the bibliography dependency", () => {
	assert.doesNotThrow(() => validateActionRequest("cites", { path: "x", bibliography: true, format: "biblatex", out: true, force: true }));
	assert.doesNotThrow(() => validateActionRequest("cites", { path: "x", bibliography: true, out: "Drafts/x.bib" }));
	assert.throws(() => validateActionRequest("cites", { path: "x", bibliography: true, format: "ris" }), /format must be one of/);
	assert.throws(() => validateActionRequest("cites", { path: "x", format: "bibtex" }), /need bibliography/);
	assert.throws(() => validateActionRequest("cites", { path: "x", bibliography: true, out: "" }), /must be a non-empty bounded string|out must be/);
	assert.throws(() => validateActionRequest("cites", { path: "x", bibliography: true, out: 7 }), /out must be/);
});

test("referencesHeadings setting: plain strings, trimmed and deduplicated; empty or malformed keeps the defaults", () => {
	assert.deepEqual(normalizeSettings({}).referencesHeadings, [...DEFAULT_REFERENCES_HEADINGS]);
	assert.deepEqual(normalizeSettings({ referencesHeadings: [" Literatur ", "Literatur", 3, ""] }).referencesHeadings, ["Literatur"]);
	assert.deepEqual(normalizeSettings({ referencesHeadings: [] }).referencesHeadings, [...DEFAULT_REFERENCES_HEADINGS]);
	assert.deepEqual(normalizeSettings({ referencesHeadings: "References" }).referencesHeadings, [...DEFAULT_REFERENCES_HEADINGS]);
});

// CLI: flag parsing, the read-only wrapper and the offline refusal of a sidecar write.
const script = join(process.cwd(), "scripts", "ingest.mjs");
const ro = join(process.cwd(), "scripts", "ingest-ro.mjs");
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function fixtureVault(): string {
	const root = mkdtempSync(join(tmpdir(), "cmds-zotero-r10-"));
	roots.push(root);
	mkdirSync(join(root, ".obsidian", "plugins", "cmds-zotero"), { recursive: true });
	mkdirSync(join(root, "80. References"), { recursive: true });
	mkdirSync(join(root, "Drafts"), { recursive: true });
	writeFileSync(join(root, ".obsidian", "plugins", "cmds-zotero", "data.json"), JSON.stringify({ zoteroIndexPath: "80. References/zotero-index.json", referencesHeadings: ["Literatur"] }));
	const base = { ...entries[0] };
	base.contentHash = entryHash(base);
	writeFileSync(join(root, "80. References", "zotero-index.json"), JSON.stringify({ ...index, generatedAt: new Date().toISOString(), count: 1, entries: [base] }));
	writeFileSync(join(root, "Drafts", "manuscript.md"), "Text [@alpha2020memory].\n\n## Literatur\n- [@alpha2020memory] x\n\n## References\n- [@zzz]\n");
	return root;
}
function run(file: string, args: string[]) { return spawnSync(process.execPath, [file, ...args], { encoding: "utf8" }); }

test("CLI: --format is validated, --out/--format/--force need --bibliography, ingest-ro refuses --out, offline --out is requires-obsidian", () => {
	const root = fixtureVault();
	const common = ["--vault", "Research", "--vault-path", root, "--offline", "--action", "cites", "--path", "Drafts/manuscript.md"];
	assert.match(run(script, [...common, "--bibliography", "--format", "ris"]).stderr, /--format must be one of/);
	assert.equal(run(script, [...common, "--format", "bibtex"]).status, 2);
	assert.equal(run(script, [...common, "--out"]).status, 2);
	assert.equal(run(ro, [...common, "--bibliography", "--out"]).status, 2);
	assert.match(run(ro, [...common, "--bibliography", "--out"]).stderr, /--out is not allowed/);
	const offline = run(script, [...common, "--bibliography", "--format", "csl-json", "--out"]);
	assert.equal(offline.status, 1);
	const payload = JSON.parse(offline.stdout);
	assert.equal(payload.reason, "requires-obsidian");
	assert.match(payload.message, /cites --out requires the live host/);
	// The vault's own referencesHeadings setting drives detection offline: "## Literatur" is the section, "## References" is not.
	const csl = run(script, [...common, "--bibliography", "--format", "csl-json"]);
	assert.equal(csl.status, 0, csl.stderr);
	const result = JSON.parse(csl.stdout);
	assert.equal(result.referencesReason, "offline");
	assert.equal(result.references.format, "csl-json");
	assert.equal(result.references.content, null);
	assert.equal(result.references.heading, "## Literatur");
	assert.deepEqual(result.files[0].referencesSection.listed, ["alpha2020memory"]);
	const text = JSON.parse(run(script, [...common, "--bibliography"]).stdout);
	assert.equal(text.references.format, "text");
	assert.equal(text.references.markdown.split("\n")[0], "## Literatur");
	// `## References` is not a configured heading here, so its [@zzz] line counts as a citation (dangling).
	assert.deepEqual(text.keys.map((key: { citekey: string; citeStatus: string }) => [key.citekey, key.citeStatus]), [["alpha2020memory", "resolved"], ["zzz", "dangling"]]);
});
