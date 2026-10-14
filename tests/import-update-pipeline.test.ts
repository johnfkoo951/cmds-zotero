// 0.6.3 WP8 import and update pipeline: pure modules (paths, scope, repair, frontmatter patches, adopt, batch plans,
// moved notes). Synthetic records only (AGENTS.md).
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { DEFAULT_SETTINGS, type ZoteroIndexEntry } from "../src/types";
import { DEFAULT_FILENAME_PATTERN, newNotePath, noteFilename, notePatternProblem, noteSubfolders, sanitizeSegment } from "../src/note-path";
import { managedBlock, ownerMarker, renderLiterature, sectionGroup } from "../src/note-writer";
import { repairManagedMarkers } from "../src/note-repair";
import { editFrontmatterLines, frontmatterRefreshChanges, legacyKeysIn, mergedItemCandidates, relinkBody, relinkEdit, verifyFrontmatterEdit } from "../src/note-frontmatter";
import { AdoptIndex, adoptCandidates, adoptedNoteText, adoptRefusal, hasBetterNotesSync } from "../src/note-adopt";
import { includedRows, lastZoteroChange, localDayStart, planSummary, reviewRow, scopeEntries, unchangedReason, zoteroTime } from "../src/batch/plan";
import { doctorChecks } from "../src/doctor/checks";
import { IdentityMap } from "../src/batch/identity-map";
import { normalizeSettings } from "../src/settings-data";

const parseYaml = (yaml: string): unknown => parse(yaml) as unknown;
const entry = (o: Partial<ZoteroIndexEntry> = {}): ZoteroIndexEntry => ({
	id: "1:ITEMAAA1", libraryID: 1, libraryType: "user", itemKey: "ITEMAAA1", citekey: "doe2024", citekeyHistory: [],
	title: "A synthetic study: of things", authors: ["Doe, Jane"], year: "2024", doi: "10.1234/example.1", url: "", collections: [], tags: ["method"],
	attachmentPath: "", zoteroSelectURI: "zotero://select/library/items/ITEMAAA1", attachments: [], attachmentStatus: "complete", contentHash: "",
	metadata: { itemType: "journalArticle", creators: [{ creatorType: "author", lastName: "Doe", firstName: "Jane" }], dateModified: "2024-05-01T10:00:00Z" }, ...o,
});
const bib = "Doe, J. (2024). A synthetic study.";

test("filename-folder-pattern: the defaults give the 0.6.1 path; tokens are sanitised and bounded", () => {
	const item = entry({ collections: ["Thesis/Related work", "Archive"], metadata: { itemType: "journalArticle", shortTitle: "Synthetic study", creators: [{ creatorType: "author", lastName: "Doe", firstName: "Jane" }] } });
	assert.equal(newNotePath(item, DEFAULT_SETTINGS), "References/Zotero/@doe2024.md");
	assert.equal(newNotePath(item, { outputFolder: "Lit" }), "Lit/@doe2024.md");
	assert.equal(noteFilename(item, "{firstAuthor} {year} - {title}"), "Doe 2024 - A synthetic study of things");
	assert.equal(noteFilename(item, "{shortTitle} ({citekey})"), "Synthetic study (doe2024)");
	assert.deepEqual(noteSubfolders(item, "{collection}"), ["Archive"], "alphabetically first collection");
	assert.deepEqual(noteSubfolders(entry({ collections: ["Thesis/Related work"] }), "{itemType}/{collection}"), ["journalArticle", "Thesis", "Related work"]);
	assert.deepEqual(noteSubfolders(entry({ collections: ["Thesis/Related work"] }), "by {collection}"), ["by Thesis - Related work"]);
	assert.equal(newNotePath(item, { outputFolder: "Lit", noteFilenamePattern: "{year} {title}", noteFolderPattern: "{itemType}" }), "Lit/journalArticle/2024 A synthetic study of things.md");
	assert.equal(noteFilename(entry({ title: "", citekey: "x1" }), "{title}"), "@x1", "an empty name falls back to @citekey");
	assert.equal([...noteFilename(entry({ title: "가".repeat(300) }), "{title}")].length, 120);
	assert.equal(sanitizeSegment(" ..a/b:c#d^e[f]|g?h*  ", 60), "a b c d e f g h");
	assert.equal(notePatternProblem(DEFAULT_FILENAME_PATTERN), null);
	assert.match(notePatternProblem("{author}") ?? "", /Unknown token \{author\}/);
	assert.match(notePatternProblem("plain") ?? "", /at least one token/);
	assert.match(notePatternProblem("{citekey}/x") ?? "", /cannot contain \//);
	assert.match(notePatternProblem("a/../b", true) ?? "", /segments/);
	assert.equal(notePatternProblem("", true), null);
	assert.equal(normalizeSettings({ noteFilenamePattern: "{nope}" }).noteFilenamePattern, "@{citekey}", "an unusable stored pattern keeps the 0.6.1 name");
	assert.equal(normalizeSettings({ noteFolderPattern: "{year}" }).noteFolderPattern, "{year}");
});

test("selective-update-scope: groups outside the scope stay byte for byte; new annotations only with annotations", () => {
	const annotation = (key: string, text: string) => ({ key, attachmentKey: "ATTACHA1", type: "highlight", text, comment: "", color: "#ffd400", page: 1, pageLabel: "1", version: 1, uri: "", tags: [], dateModified: "2024-05-01T10:00:00Z" });
	const first = entry({ attachments: [{ key: "ATTACHA1", openURI: "zotero://open-pdf/library/items/ATTACHA1", path: null, title: "PDF", annotations: [annotation("ANNOTAA1", "one")] }] });
	const note = renderLiterature(first, bib, DEFAULT_SETTINGS, null).content;
	const later = entry({ title: "Renamed title", attachments: [{ key: "ATTACHA1", openURI: "zotero://open-pdf/library/items/ATTACHA1", path: null, title: "PDF", annotations: [annotation("ANNOTAA1", "one"), annotation("ANNOTAA2", "two")] }] });
	const metaOnly = renderLiterature(later, bib, DEFAULT_SETTINGS, note, new Map(), { scope: ["metadata"] });
	assert.deepEqual(metaOnly.conflicts, []);
	assert.match(metaOnly.content, /# A synthetic study/, "overview not refreshed");
	assert.match(metaOnly.content, /\*\*Title\*\*:: Renamed title/, "metadata refreshed");
	assert.doesNotMatch(metaOnly.content, /ANNOTAA2/, "no new annotation without the annotations group");
	assert.equal(metaOnly.sections.find(s => s.id === "overview")?.reason, "not in this update: left as it is");
	const all = renderLiterature(later, bib, DEFAULT_SETTINGS, note);
	assert.match(all.content, /# Renamed title/);
	assert.match(all.content, /ANNOTAA2/);
	const annotationsOnly = renderLiterature(later, bib, DEFAULT_SETTINGS, note, new Map(), { scope: ["annotations"] });
	assert.match(annotationsOnly.content, /ANNOTAA2/);
	assert.doesNotMatch(annotationsOnly.content, /Renamed title/);
	// A missing block of a group outside the scope is not a conflict.
	const withoutNotes = note.replace(/<!-- cmds-zotero:notes:[a-f0-9]{64} -->[\s\S]*?<!-- \/cmds-zotero:notes -->\n*/, "");
	assert.deepEqual(renderLiterature(later, bib, DEFAULT_SETTINGS, withoutNotes, new Map(), { scope: ["metadata"] }).conflicts, []);
	assert.deepEqual(renderLiterature(later, bib, DEFAULT_SETTINGS, withoutNotes).conflicts, ["Missing managed section: notes"]);
	assert.equal(sectionGroup("annotation-ATTACHA1-ANNOTAA1"), "annotations");
	assert.equal(sectionGroup("citation"), "citation");
});

test("rebuild-or-repair-note: duplicates, stray markers and missing sections are repaired; user lines stay", () => {
	const item = entry();
	const owner = ownerMarker(item.id);
	const note = renderLiterature(item, bib, DEFAULT_SETTINGS, null).content;
	const metadata = /<!-- cmds-zotero:metadata:[a-f0-9]{64} -->[\s\S]*?<!-- \/cmds-zotero:metadata -->/.exec(note)?.[0] ?? "";
	const edited = managedBlock("overview", "# My own title").replace(/:[a-f0-9]{64} -->/, `:${"0".repeat(64)} -->`);
	const broken = note
		.replace(/<!-- \/cmds-zotero:citation -->/, "") // citation loses its closing marker
		.replace("## Notes", `## Notes\n\nMy line one.\n\n${metadata}\n\n${edited}\n\nMy line two.`) // an unedited and an edited duplicate
		.replace(/<!-- cmds-zotero:notes:[a-f0-9]{64} -->[\s\S]*?<!-- \/cmds-zotero:notes -->/, "");
	const damaged = renderLiterature(item, bib, DEFAULT_SETTINGS, broken);
	assert.ok(damaged.conflicts.length >= 2, "the note has hard conflicts before the repair");
	const repaired = repairManagedMarkers(broken, owner);
	assert.ok(repaired.repairs.some(line => /Removed a second, unedited copy of metadata \(line \d+\)/.test(line)));
	assert.ok(repaired.repairs.some(line => /A second copy of overview \(line \d+\) was edited/.test(line)));
	assert.ok(repaired.repairs.some(line => /damaged marker of citation/.test(line)));
	assert.ok(repaired.repairs.some(line => /missing citation section/.test(line)));
	assert.ok(repaired.repairs.some(line => /missing notes section/.test(line)));
	for (const kept of ["My line one.", "My line two.", "# My own title", "## Synthesis", "[!Synth]"]) assert.ok(repaired.text.includes(kept), kept);
	const rendered = renderLiterature(item, bib, DEFAULT_SETTINGS, repaired.text);
	assert.deepEqual(rendered.conflicts, [], "the repaired note renders without hard conflicts");
	assert.match(rendered.content, /<!-- cmds-zotero:citation:[a-f0-9]{64} -->\n> \[!Cite\]/);
	assert.match(rendered.content, /<!-- cmds-zotero:notes:[a-f0-9]{64} -->\n## Zotero notes/);
	assert.equal((rendered.content.match(/<!-- cmds-zotero:metadata:/g) ?? []).length, 1);
	// Order: the missing notes block lands after metadata, the citation block after overview.
	assert.ok(rendered.content.indexOf("cmds-zotero:citation:") < rendered.content.indexOf("cmds-zotero:metadata:"));
	assert.ok(rendered.content.indexOf("cmds-zotero:metadata:") < rendered.content.indexOf("cmds-zotero:notes:"));
	assert.deepEqual(repairManagedMarkers(note, owner), { text: note, repairs: [] }, "a sound note is left as it is");
});

test("frontmatter line patch: set keeps quoting and list layout, remove takes continuation lines, others byte for byte", () => {
	const text = "---\r\ntype: zotero\r\n# a comment\r\ntitle: \"Old title\" # keep\r\nauthors:\r\n  - Doe, Jane\r\nyear: '2023'\r\nzotero-id: 12\r\nzoteroItemKey:\r\n  - x\r\ntags: [a, b]\r\n---\r\nBody stays\r\n";
	const edit = { set: { title: "New: title", authors: ["Doe, Jane", "Roe, Rick"], year: "2024" }, remove: ["zotero-id", "zoteroItemKey"] };
	const out = editFrontmatterLines(text, edit);
	assert.ok(out.ok);
	assert.equal(out.text, "---\r\ntype: zotero\r\n# a comment\r\ntitle: \"New: title\" # keep\r\nauthors:\r\n  - \"Doe, Jane\"\r\n  - \"Roe, Rick\"\r\nyear: '2024'\r\ntags: [a, b]\r\n---\r\nBody stays\r\n");
	assert.equal(verifyFrontmatterEdit(text, out.text, edit, parseYaml), null);
	const flow = editFrontmatterLines('---\nauthors: ["A","B"]\n---\n', { set: { authors: ["C"] } });
	assert.ok(flow.ok && flow.text === '---\nauthors: ["C"]\n---\n');
	assert.deepEqual(editFrontmatterLines("---\nabstract: |\n  long\n---\n", { set: { abstract: "x" } }), { ok: false, refuse: "multiline-value", key: "abstract", message: "abstract holds a block scalar or a nested value; edit it by hand." });
	assert.equal((editFrontmatterLines("---\na: 1\na: 2\n---\n", { remove: ["a"] }) as { refuse: string }).refuse, "duplicate-key");
	assert.equal((editFrontmatterLines("no frontmatter", { set: { a: "b" }, append: true }) as { refuse: string }).refuse, "no-frontmatter");
	const created = editFrontmatterLines("Body", { set: { zoteroID: "1:ITEMAAA1" }, append: true, create: true });
	assert.ok(created.ok && created.text === "---\nzoteroID: 1:ITEMAAA1\n---\nBody");
	assert.match(verifyFrontmatterEdit(text, text.replace("type: zotero", "type: other"), { set: {} }, parseYaml) ?? "", /type changed/);
	assert.match(verifyFrontmatterEdit(text, text.replace("Body stays", "Body changed"), { set: {} }, parseYaml) ?? "", /body/);
});

test("frontmatter-refresh, legacy-key-cleanup and merged-item-relink plans", () => {
	const item = entry({ title: "New title", year: "2025" });
	const fm = { type: "zotero", zoteroID: item.id, title: "Old", year: 2025, authors: ["Doe, Jane"], tags: ["mine"], zotero_title: "Old", "zotero-id": 1, zotero_citekey: "doe2024" };
	assert.deepEqual(frontmatterRefreshChanges(fm, item, DEFAULT_SETTINGS), { title: "New title", zotero_title: "New title" }, "year 2025 equals \"2025\"; missing keys are not added; tags never");
	assert.deepEqual(legacyKeysIn(fm), ["zotero-id"], "only keys this project wrote; zotero_citekey is left alone");
	const survivor = entry({ id: "1:ITEMBBB2", itemKey: "ITEMBBB2", citekey: "doe2024a", citekeyHistory: ["doe2024"], zoteroSelectURI: "zotero://select/library/items/ITEMBBB2" });
	const other = entry({ id: "1:ITEMCCC3", itemKey: "ITEMCCC3", citekey: "roe2020", doi: "10.1234/other", zoteroSelectURI: "zotero://select/library/items/ITEMCCC3" });
	const note = { basename: "@doe2024", frontmatter: { zoteroID: "1:GONEGON1", zoteroSelectURI: "zotero://select/library/items/GONEGON1", citekey: "doe2024", "zotero-id": 9 } };
	assert.deepEqual(mergedItemCandidates(note, { complete: false, entries: [survivor] }), { status: "incomplete" }, "an incomplete index cannot prove the item gone");
	const merged = mergedItemCandidates(note, { complete: true, entries: [survivor, other] });
	assert.ok(merged.status === "merged" && merged.candidates.length === 1 && merged.candidates[0].id === survivor.id);
	assert.deepEqual(mergedItemCandidates({ basename: "x", frontmatter: { zoteroID: survivor.id } }, { complete: true, entries: [survivor] }).status, "linked");
	const twin = entry({ id: "2:ITEMDDD4", libraryID: 2, itemKey: "ITEMDDD4", citekey: "doe2024", zoteroSelectURI: "zotero://select/groups/7/items/ITEMDDD4" });
	const ambiguous = mergedItemCandidates(note, { complete: true, entries: [survivor, twin] });
	assert.ok(ambiguous.status === "merged" && ambiguous.candidates.length === 2, "two survivors go to a chooser");
	assert.deepEqual(relinkEdit(note.frontmatter, survivor), { set: { zoteroID: survivor.id, zoteroSelectURI: survivor.zoteroSelectURI, citekey: "doe2024a" }, remove: ["zotero-id"] });
	const body = `---\nzoteroID: x\n---\n${ownerMarker("1:GONEGON1")}\ntext`;
	assert.equal(relinkBody(body, "1:GONEGON1", survivor.id), `---\nzoteroID: x\n---\n${ownerMarker(survivor.id)}\ntext`);
	assert.equal(relinkBody(body, "1:OTHEROTH", survivor.id), body);
});

test("adopt-existing-notes: matching never picks a first match; identity keys are added and sections appended", () => {
	const item = entry();
	const twin = entry({ id: "2:ITEMDDD4", libraryID: 2, itemKey: "ITEMDDD4", citekey: "roe2020", citekeyHistory: ["doe2024"], doi: "10.1234/example.1", zoteroSelectURI: "zotero://select/groups/7/items/ITEMDDD4" });
	const index = new AdoptIndex([item, twin]);
	const zotlit = adoptCandidates({ path: "ZotLit/doe2024.md", basename: "doe2024", frontmatter: { "zotero-key": "ITEMAAA1", title: "x" } }, index);
	assert.deepEqual(zotlit.candidates.map(e => e.id), [item.id, twin.id], "file name doe2024 is also a former key of the twin: both are offered");
	const link = adoptCandidates({ path: "Integration/Doe.md", basename: "Doe", frontmatter: { links: "[Zotero](zotero://select/library/items/ITEMAAA1)" } }, index);
	assert.deepEqual(link.candidates.map(e => e.id), [item.id]);
	assert.equal(link.strength, "strong");
	const doiOnly = adoptCandidates({ path: "Notes/paper.md", basename: "paper", frontmatter: { DOI: "10.1234/EXAMPLE.1" } }, index);
	assert.equal(doiOnly.strength, "doi");
	assert.equal(doiOnly.candidates.length, 2);
	assert.equal(adoptCandidates({ path: "Notes/none.md", basename: "none", frontmatter: null }, index).candidates.length, 0);
	assert.match(adoptRefusal({ path: "10. Raw Sources/a.md", basename: "a", frontmatter: {} }) ?? "", /Raw Sources/);
	assert.match(adoptRefusal({ path: "x.md", basename: "x", frontmatter: { type: "paper-hub" } }) ?? "", /paper-hub/);
	assert.match(adoptRefusal({ path: "x.md", basename: "x", frontmatter: { $libraryID: 1, $itemKey: "A" } }) ?? "", /Better Notes/);
	assert.match(adoptRefusal({ path: "x.md", basename: "x", frontmatter: {} }, `x ${ownerMarker("other")}`) ?? "", /already belongs/);
	assert.equal(hasBetterNotesSync({ $itemKey: "A" }), true);
	const original = "---\ntitle: \"Doe 2024\"\ncitekey: doe2024\n# mine\n---\n\n# My reading notes\n\nI liked it.\n\n## Annotations\n\n- a hand-copied quote\n";
	const sections = new Map([["overview", "# A synthetic study"], ["citation", "> [!Cite]\n> x"], ["metadata", "> [!md]"], ["notes", "## Zotero notes"], ["annotation-ATTACHA1-ANNOTAA1", "> [!Highlight] p. 1"]]);
	const adopted = adoptedNoteText(original, parseYaml("title: \"Doe 2024\"\ncitekey: doe2024") as Record<string, unknown>, item, sections, DEFAULT_SETTINGS);
	assert.ok(!("refuse" in adopted));
	assert.deepEqual(adopted.added, ["zoteroID", "zoteroSelectURI", "zotero-key"], "citekey present: kept");
	assert.ok(adopted.text.startsWith("---\ntitle: \"Doe 2024\"\ncitekey: doe2024\n# mine\nzoteroID: 1:ITEMAAA1\nzoteroSelectURI: zotero://select/library/items/ITEMAAA1\nzotero-key: ITEMAAA1\n---\n\n# My reading notes\n\nI liked it.\n\n## Annotations\n\n- a hand-copied quote\n\n" + ownerMarker(item.id)));
	assert.equal(verifyFrontmatterEdit(original, adopted.text, adopted.edit, parseYaml, adopted.text.slice(adopted.text.indexOf("---\n\n") + 4)), null);
	// The adopted note is owned: the normal update renders it without conflicts and keeps the user's text.
	const updated = renderLiterature(item, bib, DEFAULT_SETTINGS, adopted.text);
	assert.deepEqual(updated.conflicts, []);
	assert.ok(updated.content.includes("I liked it.") && updated.content.includes("- a hand-copied quote"));
	assert.match(updated.content, /<!-- cmds-zotero:annotation-ATTACHA1-ANNOTAA1:[a-f0-9]{64} -->/);
	const clash = adoptedNoteText("---\nzoteroID: 1:OTHEROTH\n---\n", { zoteroID: "1:OTHEROTH" }, item, sections, DEFAULT_SETTINGS);
	assert.deepEqual(clash, { refuse: "zoteroID in the note names another item (1:OTHEROTH)" });
});

test("batch plans: review rows, summary, changed-since and Zotero dates", () => {
	const rows = [reviewRow("a", "A", "x.md", "create", "new note", 1), reviewRow("b", "B", "y.md", "update", "owned", 2, false), reviewRow("c", "C", "z.md", "skip", "Better Notes", 3)];
	assert.equal(rows[2].include, false, "a skip row is never included");
	assert.equal(planSummary(rows), "1 to create · 1 skipped · 1 left out");
	assert.deepEqual(includedRows(rows).map(row => row.key), ["a"]);
	assert.equal(zoteroTime("2024-05-01T10:00:00Z"), Date.UTC(2024, 4, 1, 10));
	assert.equal(zoteroTime("2024-05-01 10:00:00"), Date.UTC(2024, 4, 1, 10), "Zotero's SQL form is UTC");
	assert.equal(zoteroTime("2024-05-01"), Date.UTC(2024, 4, 1));
	assert.equal(zoteroTime("May 1"), null);
	const item = entry({ attachments: [{ key: "ATTACHA1", openURI: "", path: null, title: "", annotations: [{ key: "ANNOTAA1", attachmentKey: "ATTACHA1", type: "highlight", text: "", comment: "", color: "", page: 1, pageLabel: "", version: 1, uri: "", tags: [], dateModified: "2024-06-01T00:00:00Z" }] }] });
	assert.equal(lastZoteroChange(item), Date.UTC(2024, 5, 1), "a newer annotation counts");
	assert.equal(unchangedReason(item, { kind: "any" }, null), null);
	assert.equal(unchangedReason(item, { kind: "note" }, Date.UTC(2024, 6, 1)), "no change in Zotero since the note was last written");
	assert.equal(unchangedReason(item, { kind: "note" }, Date.UTC(2024, 4, 1)), null);
	assert.equal(unchangedReason(item, { kind: "date", time: localDayStart("2024-07-01") ?? 0 }, null), "no change in Zotero since 2024-07-01");
	assert.equal(unchangedReason(entry({ metadata: {} }), { kind: "date", time: Date.UTC(2030, 0, 1) }, null), null, "an unknown date is never proof of no change");
	assert.equal(localDayStart("2024-02-30"), null);
	assert.equal(localDayStart("2024-02-03"), new Date(2024, 1, 3).getTime());
});

test("find-moved-notes: the identity map finds owned notes outside the folder, never hubs naming the item", async () => {
	const id = "1:ITEMAAA1";
	const files = new Map<string, string>([
		["References/Zotero/@other.md", "---\nzoteroID: 1:ITEMZZZ9\n---\n"],
		["Projects/Moved note.md", `---\nzoteroID: ${id}\n---\n${ownerMarker(id)}\n`],
		["Hubs/doe2024.md", `---\ntype: paper-hub\nzoteroID: ${id}\n---\nhub`],
	]);
	const source = { list: () => [...files.keys()], outside: () => ["Projects/Moved note.md", "Hubs/doe2024.md", "Gone.md"], reader: () => (path: string) => Promise.resolve(files.get(path) ?? null), parseYaml };
	const map = await IdentityMap.build("References/Zotero", source);
	assert.deepEqual(await map.pathsFor(id), ["Projects/Moved note.md"]);
	files.set("Elsewhere/renamed.md", files.get("Projects/Moved note.md") ?? "");
	files.delete("Projects/Moved note.md");
	map.noteChanged("Projects/Moved note.md");
	map.noteChanged("Elsewhere/renamed.md");
	assert.deepEqual(await map.pathsFor(id), ["Elsewhere/renamed.md"], "a rename outside the folder is followed");
	const folderOnly = await IdentityMap.build("References/Zotero", { list: source.list, reader: source.reader, parseYaml });
	assert.deepEqual(await folderOnly.pathsFor(id), [], "without the outside listing the map stays in the folder (0.6.1)");
});

test("batch-import-by-scope: fielded terms and plain words narrow the index; an empty search names nothing", () => {
	const a = entry({ id: "1:A", citekey: "a2020", title: "Methods of things", collections: ["Thesis/Methods"], tags: ["survey"], year: "2020" });
	const b = entry({ id: "1:B", citekey: "b2021", title: "Other study", collections: ["Thesis/Related"], tags: ["survey"], year: "2021" });
	const context = { libraryName: () => null };
	assert.deepEqual(scopeEntries([a, b], "col:Thesis", context).map(e => e.id), ["1:A", "1:B"]);
	assert.deepEqual(scopeEntries([a, b], "col:Thesis/Methods", context).map(e => e.id), ["1:A"]);
	assert.deepEqual(scopeEntries([a, b], "tag:survey year:2021-", context).map(e => e.id), ["1:B"]);
	assert.deepEqual(scopeEntries([a, b], "tag:survey methods", context).map(e => e.id), ["1:A"], "plain words must occur in title, authors or citekey");
	assert.deepEqual(scopeEntries([a, b], "  ", context), []);
});

test("find-moved-notes diagnostics: moved literature notes are named in the output-folder check, which stays ok", () => {
	const facts = { bbt: { reachable: true, zotero: "10.0.3", betterbibtex: "7" }, legacyPluginEnabled: false, index: { path: "i.json", count: 3, ageMinutes: 1, stale: false, maxAgeMinutes: 60, complete: true }, git: null, pdfjs: true, peers: [], outputFolder: { folder: "References/Zotero", notes: 2, unmatched: [], betterNotes: [], moved: ["Projects/Moved.md"] } };
	const check = doctorChecks(facts).find(row => row.id === "output-folder");
	assert.equal(check?.status, "ok");
	assert.match(check?.detail ?? "", /1 literature note lives elsewhere in the vault and is updated where it is/);
	assert.deepEqual(check?.paths, ["Projects/Moved.md"]);
});
