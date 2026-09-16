import { test } from "node:test";
import assert from "node:assert/strict";
import { citedKeys, citesDiagnostics, citesForNote, classifyKeys, findReferencesSection, hubFullCitationLine, keysForFiles, referencesMarkdown, referencesPayload, referencesSection, summarize, type FileCites, type KeyVerdict, type NoteLookups } from "../src/agent/cites-core";
import { noteRef, type NoteRecord } from "../src/agent/types";
import type { ZoteroIndex, ZoteroIndexEntry } from "../src/types";

const entry = (o: Partial<ZoteroIndexEntry>): ZoteroIndexEntry => ({ id: "1:AAAA0001", libraryID: 1, libraryType: "user", itemKey: "AAAA0001", citekey: "alpha2020memory", citekeyHistory: [], title: "Alpha memory study", authors: ["Alpha, Ann"], year: "2020", doi: "", url: "", collections: [], tags: [], attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/AAAA0001", attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...o });

const index = {
	schemaVersion: 2, generatedAt: "2026-01-01T00:00:00Z", source: "better-bibtex", complete: true, diagnostics: [],
	capabilities: { zotero: "7", betterbibtex: "7", metadata: true, attachments: true, annotations: true, bibliography: true },
	entries: [
		entry({}),
		entry({ id: "1:BBBB0001", itemKey: "BBBB0001", citekey: "beta2021agent", citekeyHistory: ["beta2021old"] }),
		entry({ id: "1:CCCC0001", itemKey: "CCCC0001", citekey: "gamma2019dup" }),
		entry({ id: "2:CCCC0001", libraryID: 2, libraryType: "group", itemKey: "CCCC0001", citekey: "gamma2019dup" }),
		entry({ id: "1:DDDD0001", itemKey: "DDDD0001", citekey: "deltaA2018", citekeyHistory: ["delta2018moved"] }),
		entry({ id: "1:DDDD0002", itemKey: "DDDD0002", citekey: "deltaB2018", citekeyHistory: ["delta2018moved"] }),
		entry({ id: "1:EEEE0001", itemKey: "EEEE0001", citekey: "epsilon2017key" }),
		entry({ id: "1:EEEE0002", itemKey: "EEEE0002", citekey: "epsilon2017new", citekeyHistory: ["epsilon2017key"] }),
	],
} satisfies ZoteroIndex;
index.count = index.entries.length;

const hubRef = noteRef("SynthVault", "20. Hubs/hubonly2022note.md");
const bothHubRef = noteRef("SynthVault", "20. Hubs/both2024note.md");
const rawRef = noteRef("SynthVault", "10. Raw/rawonly2023note.md");
const bothRawRef = noteRef("SynthVault", "10. Raw/both2024note (raw).md");
const lookups: NoteLookups = {
	hubByCitekey: new Map([["hubonly2022note", hubRef], ["both2024note", bothHubRef]]),
	rawByCitekey: new Map([["rawonly2023note", rawRef], ["both2024note", [bothRawRef]]]),
};
const allKeys = ["alpha2020memory", "beta2021old", "gamma2019dup", "delta2018moved", "epsilon2017key", "hubonly2022note", "rawonly2023note", "both2024note", "nowhere2025gone"];

const note = (path: string, frontmatter: Record<string, unknown> | null, bodyLines: string[], frontmatterParse: "ok" | "error" = "ok"): NoteRecord & { body: string } => {
	const yaml = frontmatter ? ["---", ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---"] : [];
	return { path, basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path, frontmatter, frontmatterParse, body: [...yaml, ...bodyLines].join("\n") };
};

test("classifyKeys yields every citeStatus, prefers exact citekeys over history and reports matchedHistory", () => {
	const verdicts = classifyKeys(allKeys, index, lookups, false, false);
	assert.deepEqual(verdicts.get("alpha2020memory"), { citeStatus: "resolved", entryId: "1:AAAA0001", matchedHistory: false });
	assert.deepEqual(verdicts.get("beta2021old"), { citeStatus: "resolved", entryId: "1:BBBB0001", matchedHistory: true, citekeyCurrent: "beta2021agent" });
	assert.deepEqual(verdicts.get("gamma2019dup"), { citeStatus: "ambiguous" });
	assert.deepEqual(verdicts.get("delta2018moved"), { citeStatus: "ambiguous" });
	assert.deepEqual(verdicts.get("epsilon2017key"), { citeStatus: "ambiguous" });
	assert.deepEqual(verdicts.get("hubonly2022note"), { citeStatus: "hub-only", hub: hubRef });
	assert.deepEqual(verdicts.get("rawonly2023note"), { citeStatus: "raw-only", raw: rawRef });
	assert.deepEqual(verdicts.get("both2024note"), { citeStatus: "hub-only", hub: bothHubRef, raw: bothRawRef });
	assert.deepEqual(verdicts.get("nowhere2025gone"), { citeStatus: "dangling" });
	assert.equal(classifyKeys(["alpha2020memory", "alpha2020memory"], index, lookups, false, false).size, 1);
});


test("classifyKeys unions current/history identities and refuses ambiguous or malformed note sources", () => {
	const duplicateIdentity = {
		...index,
		entries: [entry({ id: "1:SAME0001", itemKey: "SAME0001", citekey: "same2024key", citekeyHistory: ["same2024key"] })],
		count: 1,
	};
	assert.deepEqual(classifyKeys(["same2024key"], duplicateIdentity, lookups, false, false).get("same2024key"), { citeStatus: "resolved", entryId: "1:SAME0001", matchedHistory: false });
	const ambiguousNotes: NoteLookups = { hubByCitekey: new Map([["local2024key", [hubRef, bothHubRef]]]), rawByCitekey: new Map() };
	assert.deepEqual(classifyKeys(["local2024key"], index, ambiguousNotes, false, false).get("local2024key"), { citeStatus: "ambiguous" });
	const malformed: NoteLookups = { hubByCitekey: new Map(), rawByCitekey: new Map(), skipped: ["broken.md"] };
	assert.deepEqual(classifyKeys(["unknown2024key"], index, malformed, false, false).get("unknown2024key"), { citeStatus: "unchecked", uncheckedReason: "discovery-incomplete" });
});

test("a stale index withholds negative verdicts as unchecked (stale-index) unless allowed", () => {
	const withheld = classifyKeys(allKeys, index, lookups, true, false);
	assert.equal(withheld.get("alpha2020memory")?.citeStatus, "resolved");
	assert.equal(withheld.get("gamma2019dup")?.citeStatus, "ambiguous");
	assert.deepEqual(withheld.get("hubonly2022note"), { citeStatus: "hub-only", hub: hubRef });
	assert.deepEqual(withheld.get("rawonly2023note"), { citeStatus: "unchecked", raw: rawRef, uncheckedReason: "stale-index" });
	assert.deepEqual(withheld.get("nowhere2025gone"), { citeStatus: "unchecked", uncheckedReason: "stale-index" });
	const allowed = classifyKeys(allKeys, index, lookups, true, true);
	assert.equal(allowed.get("nowhere2025gone")?.citeStatus, "dangling");
	assert.equal(allowed.get("rawonly2023note")?.citeStatus, "raw-only");
	assert.equal(allowed.get("nowhere2025gone")?.uncheckedReason, undefined);
});

test("incomplete discovery withholds vault-absence verdicts as discovery-incomplete, keeps hub evidence, and is not lifted by allow-stale", () => {
	const camelHub = noteRef("SynthVault", "40. Paper Analyses/ahn2026promptsContracts/Ahn 2026 - S00 Hub.md");
	const incomplete: NoteLookups = { hubByCitekey: new Map([["ahn2026promptsContracts", camelHub], ["hubonly2022note", hubRef]]), rawByCitekey: new Map([["rawonly2023note", rawRef]]), skipped: ["70. Outputs/broken.md"] };
	const keys = ["ahn2026promptsContracts", "hubonly2022note", "rawonly2023note", "nowhere2025gone", "alpha2020memory"];
	for (const [stale, allowStale] of [[false, false], [false, true], [true, false], [true, true]] as const) {
		const verdicts = classifyKeys(keys, index, incomplete, stale, allowStale);
		assert.deepEqual(verdicts.get("ahn2026promptsContracts"), { citeStatus: "hub-only", hub: camelHub }, `camelCase hub stays hub-only (stale ${stale}, allowStale ${allowStale})`);
		assert.deepEqual(verdicts.get("hubonly2022note"), { citeStatus: "hub-only", hub: hubRef });
		assert.deepEqual(verdicts.get("rawonly2023note"), { citeStatus: "unchecked", raw: rawRef, uncheckedReason: "discovery-incomplete" });
		assert.deepEqual(verdicts.get("nowhere2025gone"), { citeStatus: "unchecked", uncheckedReason: "discovery-incomplete" });
		assert.equal(verdicts.get("alpha2020memory")?.citeStatus, "resolved");
	}
	const verdicts = classifyKeys(keys, index, incomplete, false, true);
	assert.equal(referencesMarkdown(["nowhere2025gone"], verdicts, new Map(), new Map()), "## References\n- [@nowhere2025gone] (unchecked: vault discovery incomplete)");
	const payload = referencesPayload(["nowhere2025gone", "rawonly2023note"], verdicts, new Map(), new Map());
	assert.deepEqual(payload.unresolved.map(u => [u.citekey, u.citeStatus, u.uncheckedReason]), [["nowhere2025gone", "unchecked", "discovery-incomplete"], ["rawonly2023note", "unchecked", "discovery-incomplete"]]);
	for (const item of payload.unresolved) {
		assert.match(item.hint, /Vault discovery incomplete/);
		assert.match(item.hint, /--allow-stale does not apply/);
		assert.doesNotMatch(item.hint, /pass --allow-stale/);
	}
	const file = citesForNote(note("q.md", null, ["[@nowhere2025gone] and [@ahn2026promptsContracts]"]), verdicts);
	assert.equal(file.citations[0].uncheckedReason, "discovery-incomplete");
	assert.equal(file.citations[1].uncheckedReason, undefined);
	const diagnostics = citesDiagnostics([file]);
	assert.equal(diagnostics[0].code, "cite-unchecked");
	assert.match(diagnostics[0].message, /vault discovery was incomplete/);
	assert.doesNotMatch(diagnostics[0].message, /index is stale/);
	assert.equal(keysForFiles([file])[0].uncheckedReason, "discovery-incomplete");
	const stale = classifyKeys(["nowhere2025gone"], index, lookups, true, false);
	const staleFile = citesForNote(note("s.md", null, ["[@nowhere2025gone]"]), stale);
	assert.match(citesDiagnostics([staleFile])[0].message, /index is stale; refresh or pass --allow-stale/);
	assert.equal(referencesPayload(["nowhere2025gone"], stale, new Map(), new Map()).unresolved[0].uncheckedReason, "stale-index");
});

test("references section: RQ-like note cites three keys but lists two", () => {
	const rq = note("30. Questions/RQ-synthetic.md", { type: "research-question", cites: ["alpha2020memory", "beta2021old", "nowhere2025gone"] }, [
		"# RQ synthetic",
		"Body cites [@alpha2020memory] again.",
		"",
		"## References",
		"- [@alpha2020memory] Alpha, A. (2020). Alpha memory study.",
		"- [@beta2021old] Beta, B. (2021). Beta agent study.",
		"",
		"## Notes",
		"- [@gamma2019dup] mentioned after the section, so it is a citation, not a listing.",
	]);
	assert.deepEqual(citedKeys(rq), ["alpha2020memory", "beta2021old", "nowhere2025gone", "gamma2019dup"]);
	const section = referencesSection(rq.body, citedKeys(rq));
	assert.deepEqual(section, { present: true, listed: ["alpha2020memory", "beta2021old"], missingFromReferences: ["nowhere2025gone", "gamma2019dup"], notCited: [] });
	const drift = referencesSection(rq.body, ["alpha2020memory", "beta2021old", "nowhere2025gone"]);
	assert.deepEqual(drift.missingFromReferences, ["nowhere2025gone"]);
	assert.deepEqual(referencesSection(rq.body, ["alpha2020memory"]).notCited, ["beta2021old"]);
	assert.deepEqual(referencesSection("No section here [@alpha2020memory]", ["alpha2020memory"]), { present: false, listed: [], missingFromReferences: ["alpha2020memory"], notCited: [] });
});

test("references section skips fenced code and frontmatter, ends at the next heading and reads only the leading key", () => {
	const lines = ["---", "title: \"## References\"", "---", "```", "## References", "- [@fence2000code]", "```", "## references ##", "- [@alpha2020memory, p. 3] see also [@beta2021old]", "* [-@gamma2019dup]", "- plain text line", "- [@alpha2020memory] duplicate line", "### Sub", "- [@delta2018moved]", "## Next", "- [@nowhere2025gone]"];
	const span = findReferencesSection(lines);
	assert.deepEqual(span, { start: 7, end: 14, listed: ["alpha2020memory", "gamma2019dup", "delta2018moved"] });
	assert.equal(findReferencesSection(["# Title", "text"]), null);
});

test("citesForNote merges frontmatter and body citations with verdicts, 1-based positions and evidenceFor mixed forms", () => {
	const atom = note("40. Atoms/atom-synthetic.md", {
		type: "paper-analysis", citekey: "alpha2020memory", supports: ["beta2021old"], evidenceFor: ["[[Some wiki note]] and [@hubonly2022note] plus bare @rawonly2023note", "[[@gamma2019dup]] is a wikilink"], hypotheses: "H1 rests on [@rawonly2023note; @nowhere2025gone]",
	}, [
		"# Atom",
		"Own key cited in the body [@alpha2020memory] and @both2024note bare.",
		"## References",
		"- [@alpha2020memory] listed",
	]);
	const verdicts = classifyKeys(citedKeys(atom), index, lookups, false, false);
	const file = citesForNote(atom, verdicts);
	assert.equal(file.type, "paper-analysis");
	assert.equal(file.frontmatterParse, "ok");
	assert.deepEqual(file.citations.map(c => [c.citekey, c.where, c.field ?? c.line, c.form, c.citeStatus]), [
		["beta2021old", "frontmatter", "supports", "bare", "resolved"],
		["hubonly2022note", "frontmatter", "evidenceFor", "pandoc", "hub-only"],
		["rawonly2023note", "frontmatter", "hypotheses", "pandoc", "raw-only"],
		["nowhere2025gone", "frontmatter", "hypotheses", "pandoc", "dangling"],
		["alpha2020memory", "body", 9, "pandoc", "resolved"],
		["both2024note", "body", 9, "bare", "hub-only"],
	]);
	assert.deepEqual(file.citations[0], { citekey: "beta2021old", where: "frontmatter", field: "supports", form: "bare", citeStatus: "resolved", matchedHistory: true, entryId: "1:BBBB0001", citekeyCurrent: "beta2021agent" });
	assert.deepEqual(file.citations[4], { citekey: "alpha2020memory", where: "body", line: 9, column: 28, form: "pandoc", citeStatus: "resolved", matchedHistory: false, entryId: "1:AAAA0001" });
	assert.deepEqual(file.citations[5].hub, bothHubRef);
	assert.deepEqual(file.referencesSection, { present: true, listed: ["alpha2020memory"], missingFromReferences: ["beta2021old", "hubonly2022note", "rawonly2023note", "nowhere2025gone", "both2024note"], notCited: [] });
	assert.throws(() => citesForNote(atom, new Map()), /was not classified/);
});

test("a note with unparsable frontmatter still reports body citations and a warning", () => {
	const broken: NoteRecord & { body: string } = { path: "50. Broken/broken.md", basename: "broken", frontmatter: null, frontmatterParse: "error", body: "---\ncites: [unterminated\n---\nText [@alpha2020memory]." };
	const verdicts = classifyKeys(citedKeys(broken), index, lookups, false, false);
	const file = citesForNote(broken, verdicts);
	assert.equal(file.type, null);
	assert.deepEqual(file.citations.map(c => [c.citekey, c.line, c.column]), [["alpha2020memory", 4, 7]]);
	const diagnostics = citesDiagnostics([file]);
	assert.deepEqual(diagnostics, [{ code: "frontmatter-parse-error", severity: "warning", message: "Frontmatter could not be parsed; frontmatter citations were not scanned", path: "50. Broken/broken.md" }]);
});

test("references markdown is byte-exact per status, including the hub full citation and pointer fallbacks", () => {
	const keys = ["alpha2020memory", "beta2021old", "hubonly2022note", "both2024note", "rawonly2023note", "nowhere2025gone", "gamma2019dup", "alpha2020memory"];
	const verdicts = classifyKeys(keys, index, lookups, false, false);
	const bibliography = new Map([["alpha2020memory", "Alpha, A. (2020). Alpha memory study. Journal of Synthetic Tests, 1(1), 1-2.\n"], ["beta2021old", "Beta, B. (2021).\n  Beta agent study."]]);
	const hubFullCitation = new Map([["hubonly2022note", "Hub, H. (2022). Hub only paper. Synthetic Press."]]);
	const markdown = referencesMarkdown(keys, verdicts, bibliography, hubFullCitation);
	assert.equal(markdown, [
		"## References",
		"- [@alpha2020memory] Alpha, A. (2020). Alpha memory study. Journal of Synthetic Tests, 1(1), 1-2.",
		"- [@beta2021old] Beta, B. (2021). Beta agent study.",
		"- [@hubonly2022note] Hub, H. (2022). Hub only paper. Synthetic Press. (provisional)",
		"- [@both2024note] [[both2024note]] (provisional)",
		"- [@rawonly2023note] (raw source only: [[rawonly2023note]])",
		"- [@nowhere2025gone] (unresolved)",
		"- [@gamma2019dup] (ambiguous: several Zotero items)",
	].join("\n"));
	const stale = classifyKeys(["nowhere2025gone"], index, lookups, true, false);
	assert.equal(referencesMarkdown(["nowhere2025gone"], stale, new Map(), new Map()), "## References\n- [@nowhere2025gone] (unchecked: index stale)");
	assert.equal(referencesMarkdown(["alpha2020memory"], verdicts, new Map(), new Map()), "## References\n- [@alpha2020memory] (bibliography unavailable)");
	const payload = referencesPayload(keys, verdicts, bibliography, hubFullCitation);
	assert.deepEqual(payload.resolved, [{ citekey: "alpha2020memory", text: "Alpha, A. (2020). Alpha memory study. Journal of Synthetic Tests, 1(1), 1-2." }, { citekey: "beta2021old", text: "Beta, B. (2021). Beta agent study." }]);
	assert.deepEqual(payload.unresolved.map(u => [u.citekey, u.citeStatus]), [["hubonly2022note", "hub-only"], ["both2024note", "hub-only"], ["rawonly2023note", "raw-only"], ["nowhere2025gone", "dangling"], ["gamma2019dup", "ambiguous"]]);
	assert.ok(payload.unresolved.every(u => u.hint.length > 0));
	assert.equal(payload.markdown, markdown);
});

test("hub S01 full citation line parses and rejects the template placeholder", () => {
	assert.equal(hubFullCitationLine("## S01\n- **Full citation**: Hub, H. (2022). Hub only paper.  \n- **citekey**: `hubonly2022note`"), "Hub, H. (2022). Hub only paper.");
	assert.equal(hubFullCitationLine("- **Full citation**: {APA complete reference as printed}"), null);
	assert.equal(hubFullCitationLine("- **Full citation**:   "), null);
	assert.equal(hubFullCitationLine("no S01 here"), null);
});

test("diagnostics map every non-resolved status to its code and severity; keys and summary aggregate occurrences", () => {
	const first = note("a.md", { cites: ["alpha2020memory", "nowhere2025gone", "nowhere2025gone"] }, ["Text [@hubonly2022note] and [@rawonly2023note] and [@gamma2019dup]."]);
	const second = note("b.md", null, ["[@nowhere2025gone] again, [@alpha2020memory]"]);
	const verdicts = classifyKeys([...citedKeys(first), ...citedKeys(second)], index, lookups, false, false);
	const files: FileCites[] = [citesForNote(first, verdicts), citesForNote(second, verdicts)];
	assert.deepEqual(citesDiagnostics(files).map(d => [d.code, d.severity, d.path, d.citekey]), [
		["dangling-cite", "error", "a.md", "nowhere2025gone"],
		["cite-hub-only", "info", "a.md", "hubonly2022note"],
		["cite-raw-only", "warning", "a.md", "rawonly2023note"],
		["citekey-ambiguous", "error", "a.md", "gamma2019dup"],
		["dangling-cite", "error", "b.md", "nowhere2025gone"],
	]);
	assert.match(citesDiagnostics(files)[0].message, /@nowhere2025gone .* \(2 occurrences\)$/);
	const staleVerdicts = new Map<string, KeyVerdict>([...verdicts].map(([key, verdict]) => [key, verdict.citeStatus === "dangling" ? { citeStatus: "unchecked" } : verdict]));
	assert.equal(citesDiagnostics([citesForNote(second, staleVerdicts)])[0].code, "cite-unchecked");
	assert.deepEqual(keysForFiles(files), [
		{ citekey: "alpha2020memory", citeStatus: "resolved", entryId: "1:AAAA0001", count: 2, files: ["a.md", "b.md"] },
		{ citekey: "nowhere2025gone", citeStatus: "dangling", count: 3, files: ["a.md", "b.md"] },
		{ citekey: "hubonly2022note", citeStatus: "hub-only", hub: hubRef, count: 1, files: ["a.md"] },
		{ citekey: "rawonly2023note", citeStatus: "raw-only", raw: rawRef, count: 1, files: ["a.md"] },
		{ citekey: "gamma2019dup", citeStatus: "ambiguous", count: 1, files: ["a.md"] },
	]);
	assert.deepEqual(summarize(files, true), { files: 2, citations: 8, resolved: 2, hubOnly: 1, rawOnly: 1, dangling: 3, ambiguous: 1, unchecked: 0, truncated: true });
	assert.equal(summarize([]).truncated, false);
});
