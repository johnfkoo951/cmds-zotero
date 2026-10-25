// 0.6.2 WP6: check-citations, the managed references section, the sanitized export copy and the pandoc kit. Synthetic only.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoteroIndexEntry } from "../src/types";
import { citedKeySet } from "../src/citations/cited-keys";
import { checkCitations, checkRowDetail, checkRowsInReportOrder, checkSummary } from "../src/citations/check";
import { locateReferencesBlock, planReferencesSection, referencesBlock, withoutReferencesBlock } from "../src/citations/references-block";
import { sanitizeForExport, sanitizeSummary, withoutIdentityKeys, type LinkTarget } from "../src/export/sanitize";
import { defaultsYaml, kitDecision, kitFolder, kitName, manifestText, pandocCommand, sha256, shellQuote, vaultRootFrom } from "../src/export/kit";

const entry = (id: string, citekey: string, history: string[] = []): ZoteroIndexEntry => ({ id, citekey, citekeyHistory: history, title: `Title ${citekey}`, authors: ["Doe, Jane"], year: "2020" }) as ZoteroIndexEntry;

test("check-citations: unknown, ambiguous, former, no note and nocite rows; negatives only with a loaded snapshot", () => {
	const entries = [entry("1:A0000001", "known2020"), entry("1:A0000002", "now2021", ["old2019"]), entry("1:A0000003", "twin2022"), entry("2:A0000004", "twin2022"), entry("1:A0000005", "nonote2023")];
	const set = citedKeySet("---\nnocite: \"@known2020 @extra2000 @*\"\n---\nA [@known2020], [@old2019], @twin2022, @nope2024 and @nonote2023.\n");
	const notes = (item: ZoteroIndexEntry): number => (item.citekey === "nonote2023" ? 0 : 1);
	const report = checkCitations(set, entries, { loaded: true, stale: false, ageMinutes: 5 }, notes);
	const status = Object.fromEntries(report.rows.map(row => [row.citekey, [row.status, row.noNote, row.nocite]]));
	assert.deepEqual(status, {
		known2020: ["ok", false, true], old2019: ["renamed", false, false], twin2022: ["ambiguous", null, false],
		nope2024: ["unknown", null, false], nonote2023: ["ok", true, false], extra2000: ["unknown", null, true],
	});
	assert.equal(report.rows.find(row => row.citekey === "old2019")?.currentKey, "now2021");
	assert.equal(report.nociteAll, true);
	assert.deepEqual(checkRowsInReportOrder(report.rows).map(row => row.citekey), ["nope2024", "extra2000", "twin2022", "old2019", "nonote2023", "known2020"]);
	assert.match(checkSummary(report), /2 unknown · 1 ambiguous · 1 former · 1 without a literature note · 2 from nocite · nocite lists @\*/);
	assert.match(checkRowDetail(report.rows.find(row => row.citekey === "extra2000")!, report.snapshot), /nocite only/);
	const stale = checkCitations(set, entries, { loaded: true, stale: true, ageMinutes: 600 }, notes);
	assert.match(checkRowDetail(stale.rows.find(row => row.citekey === "nope2024")!, stale.snapshot), /saved index \(10 h old\)/);
	const unloaded = checkCitations(set, [], { loaded: false, stale: false, ageMinutes: null }, () => null);
	assert.ok(unloaded.rows.every(row => row.status === "unchecked"));
});

test("references block: insert at the end, update unedited, keep edited, detached, damaged and CRLF blocks", () => {
	const note = "# Draft\n\nText [@a1].\n";
	const inserted = planReferencesSection(note, "Entry A.", "References");
	assert.equal(inserted.kind, "insert");
	const first = inserted.kind === "insert" ? inserted.text : "";
	assert.ok(first.startsWith("# Draft\n\nText [@a1].\n\n## References\n\n<!-- cmds-zotero-references:"));
	assert.ok(first.endsWith("Entry A.\n<!-- /cmds-zotero-references -->\n"));
	assert.equal(planReferencesSection(first, "Entry A.", "References").kind, "unchanged");
	assert.equal(planReferencesSection(first.replace(/\n/g, "\r\n"), "Entry A.", "References").kind, "unchanged");
	const updated = planReferencesSection(first, "Entry A.\n\nEntry B.", "References");
	assert.equal(updated.kind, "update");
	assert.ok(updated.kind === "update" && updated.text.includes("Entry B.") && updated.text.startsWith("# Draft"));
	const edited = first.replace("Entry A.", "Entry A, edited.");
	assert.equal(planReferencesSection(edited, "Entry C.", "References").kind, "edited");
	const detached = first.replace(/cmds-zotero-references:[a-f0-9]{64}/, "cmds-zotero-references:detached");
	assert.equal(planReferencesSection(detached, "Entry C.", "References").kind, "detached");
	const duplicate = `${first}\n${referencesBlock("Other.")}\n`;
	const conflict = planReferencesSection(duplicate, "x", "References");
	assert.equal(conflict.kind, "conflict");
	assert.equal(locateReferencesBlock(first.replace("<!-- /cmds-zotero-references -->", "")).kind, "conflict");
	assert.equal(locateReferencesBlock(first.replace(/:[a-f0-9]{64}/, ":abc")).kind, "conflict");
	// Citations inside the block never count, including with CRLF line endings.
	const withCitation = planReferencesSection(note, "Entry mentioning @hidden2000.", "References");
	const crlf = (withCitation.kind === "insert" ? withCitation.text : "").replace(/\n/g, "\r\n");
	assert.deepEqual(citedKeySet(withoutReferencesBlock(crlf)).keys, ["a1"]);
});

test("export copy: comments, markers, callouts, highlights, block IDs, wikilinks, embeds, former keys (including nocite) and CRLF", () => {
	const source = [
		"---", "title: Draft", "citekey: own2020", "zoteroID: \"1:ABCD0001\"", "nocite: \"@old2019\"", "aliases:", "  - x", "---",
		"Intro %%hidden%% text. ==Key point== here ^block-1",
		"See [[@smith2020|Smith]], [[@Lit Note Title]], [[Lit Note]], [[Plain Note#Part|shown]], [[Missing Note]] and ![[figure 1.png|300]].",
		"Former [@old2019, p. 2] and `[[@code]] %%kept%%`.",
		"![[Other Note]]",
		"<!-- cmds-zotero:overview:" + "a".repeat(64) + " -->",
		"Generated.",
		"<!-- /cmds-zotero:overview -->",
		"> [!quote]+ Title here",
		"> Body",
		"> [!note]",
		"%%",
		"block comment",
		"%%",
		"```",
		"[[@fenced]] ==kept== %%kept%%",
		"```",
		"<!-- user comment -->",
		"",
		"## References",
		"",
		referencesBlock("Entry."),
	].join("\r\n");
	const resolve = (path: string): LinkTarget => path === "Lit Note" || path === "@Lit Note Title" ? { kind: "literature", citekey: "lit2021" }
		: path === "figure 1.png" ? { kind: "image", path: "Assets/figure 1.png" }
		: path === "Plain Note" || path === "Other Note" ? { kind: "note", path: `${path}.md` } : { kind: "missing" };
	const { text, report } = sanitizeForExport(source, { resolve, renamed: new Map([["old2019", "new2019"]]) });
	const lines = text.split("\n");
	assert.deepEqual(lines.slice(0, 7), ["---", "title: Draft", "nocite: \"@new2019\"", "aliases:", "  - x", "---", "Intro  text. [Key point]{.mark} here"]);
	assert.equal(lines[7], "See [@smith2020], [@lit2021], [@lit2021], shown, Missing Note and ![](<Assets/figure 1.png>).");
	assert.equal(lines[8], "Former [@new2019, p. 2] and `[[@code]] %%kept%%`.");
	assert.equal(lines[9], "Other Note");
	assert.equal(lines[10], "Generated.");
	assert.deepEqual(lines.slice(11, 14), ["> **Title here**", "> Body", "> **Note**"]);
	assert.deepEqual(lines.slice(14, 17), ["```", "[[@fenced]] ==kept== %%kept%%", "```"]);
	assert.ok(text.includes("<!-- user comment -->"));
	assert.ok(text.endsWith("## References\n\n::: {#refs}\n:::"));
	assert.equal(report.citations, 3);
	assert.deepEqual(report.renamed, [{ from: "old2019", to: "new2019", count: 2 }]);
	assert.deepEqual(report.unresolved.map(item => item.link), ["[[Missing Note]]"]);
	assert.deepEqual(report.embedsNotInlined.map(item => item.link), ["![[Other Note]]"]);
	assert.deepEqual([report.images, report.links, report.comments, report.markers, report.callouts, report.highlights, report.blockIds, report.identityKeys], [1, 1, 2, 2, 2, 1, 1, 2]);
	assert.equal(report.referencesBlock, true);
	assert.ok(sanitizeSummary(report).some(line => line.includes("[[Missing Note]] could not be resolved")));
	assert.deepEqual(withoutIdentityKeys("---\r\ncitekey: a\r\ntags:\r\n  - b\r\nzotero-key: X\r\n---").text, "---\ntags:\n  - b\n---");
});

test("export kit: folder names, defaults with ${.} paths, manifest decisions and the command line", () => {
	assert.equal(kitName("a/b:c"), "a-b-c");
	assert.equal(kitName("..."), "note");
	assert.equal(kitFolder("CMDS Zotero exports/", "Draft"), "CMDS Zotero exports/Draft");
	assert.equal(kitFolder("CMDS Zotero exports", "Draft", 3), "CMDS Zotero exports/Draft 3");
	assert.equal(vaultRootFrom("CMDS Zotero exports/Draft"), "${.}/../..");
	const yaml = defaultsYaml({ input: "Draft.md", output: "Draft.docx", csl: "${HOME}/Zotero/styles/apa.csl", lang: "ko-KR", vaultRoot: "${.}/../..", noteFolder: "Notes", generator: "CMDS Zotero 0.6.2" });
	assert.match(yaml, /^citeproc: true$/m);
	assert.match(yaml, /^ {2}- "\$\{\.\}\/Draft\.md"$/m);
	assert.match(yaml, /^csl: "\$\{HOME\}\/Zotero\/styles\/apa\.csl"$/m);
	assert.match(yaml, /^ {2}lang: "ko-KR"$/m);
	assert.match(yaml, /^ {2}- "\$\{\.\}\/\.\.\/\.\.\/Notes"$/m);
	assert.doesNotMatch(defaultsYaml({ input: "a.md", output: "a.docx", vaultRoot: "${.}/..", noteFolder: "", generator: "x" }), /^csl:/m);
	assert.equal(pandocCommand("/tmp/x y/defaults.yaml"), "pandoc --defaults '/tmp/x y/defaults.yaml'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
	const files = new Map<string, string | null>([["Draft.md", "copy"], ["references.json", "[]"], ["defaults.yaml", "y"]]);
	const manifest = manifestText({ version: 1, source: "Notes/Draft.md", createdAt: "2026-10-14T00:00:00.000Z", files: { "Draft.md": sha256("copy"), "references.json": sha256("[]"), "defaults.yaml": sha256("y") } });
	assert.deepEqual(kitDecision(null, new Map([["Draft.md", null]])), { kind: "write" });
	assert.deepEqual(kitDecision(manifest, files), { kind: "replace" });
	assert.deepEqual(kitDecision(manifest, new Map([...files, ["Draft.md", "edited"]])), { kind: "changed", files: ["Draft.md"] });
	assert.deepEqual(kitDecision(manifest, new Map([...files, ["defaults.yaml", null]])), { kind: "changed", files: ["defaults.yaml"] });
	assert.deepEqual(kitDecision(null, files).kind, "foreign");
	assert.deepEqual(kitDecision("{not json", files).kind, "foreign");
});
