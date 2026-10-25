// 0.5 R8
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { patchFrontmatterBlock, readFrontmatterBlock, frontmatterText, serializeScalar, valueEnd, type PatchChanges } from "../src/agent/frontmatter-patch";
import { parseNoteText } from "../src/frontmatter-read";
import { editFrontmatterLines, frontmatterAndBody, verifyFrontmatterEdit } from "../src/note-frontmatter";

const IDENTITY: PatchChanges = { citekeyProvisional: false, zoteroID: "1:AHNAAAA1", zoteroSelectURI: "zotero://select/library/items/AHNAAAA1", zoteroStatus: "resolved", zoteroCheckedAt: "2026-09-16T10:00:00.000Z" };

/** Synthetic copy of a hand-written wiki hub: quoted scalars, a folded description, comment lines, a block list, a flow list and a trailing comment. */
const WIKI_HUB = [
	"---",
	"type: paper-hub",
	"title: \"Prompts as Contracts: A Synthetic Study\"",
	"citekey: \"ahn2026promptsContracts\"",
	"citekeyProvisional: true",
	"doi: \"10.1000/synthetic.2026\"",
	"authors:",
	"  - \"Ahn, Synthetic\"",
	"  - \"Lee, Synthetic\"",
	"year: 2026",
	"tags: [paper, hub, synthetic]",
	"description: >-",
	"  A folded description that runs well past the eighty-column mark and therefore wraps onto a",
	"  second line, exactly the way hand-written wiki hubs do.",
	"# identity keys below are managed by cmds-zotero reconcile",
	"zoteroStatus: not-found   # last checked offline",
	"zoteroCheckedAt: 2026-01-01T00:00:00.000Z",
	"---",
	"# Ahn 2026 hub",
	"",
	"Prose that mentions zoteroStatus: resolved and must stay untouched.",
	"",
].join("\n");

/** The Template_Paper Hub shape: Templater placeholders that are not even valid YAML on some lines. */
const TEMPLATE_HUB = [
	"---",
	"type: paper-hub",
	"title: \"{{title}}\"",
	"citekey: \"{{citekey}}\"",
	"citekeyProvisional: true",
	"doi: \"\"",
	"authors:",
	"  - \"{{author}}\"",
	"year: {{year}}",
	"status: draft",
	"zoteroStatus: not-found",
	"zoteroCheckedAt: \"\"",
	"---",
	"## S01 Identity",
	"- **citekey**: `{{citekey}}` (provisional)",
	"",
].join("\n");

test("wiki hub: allowed key lines are replaced or appended; every other byte, the trailing comment and the body are preserved", () => {
	const outcome = patchFrontmatterBlock(WIKI_HUB, IDENTITY);
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.replaced, ["citekeyProvisional", "zoteroStatus", "zoteroCheckedAt"]);
	assert.deepEqual(outcome.appended, ["zoteroID", "zoteroSelectURI"]);
	const expected = WIKI_HUB
		.replace("citekeyProvisional: true\n", "citekeyProvisional: false\n")
		.replace("zoteroStatus: not-found   # last checked offline\n", "zoteroStatus: resolved   # last checked offline\n")
		.replace("zoteroCheckedAt: 2026-01-01T00:00:00.000Z\n---\n", "zoteroCheckedAt: \"2026-09-16T10:00:00.000Z\"\nzoteroID: 1:AHNAAAA1\nzoteroSelectURI: zotero://select/library/items/AHNAAAA1\n---\n");
	assert.equal(outcome.text, expected);
	const block = readFrontmatterBlock(outcome.text);
	assert.ok(block && block !== "unterminated");
	const fm = parse(frontmatterText(block)) as Record<string, unknown>;
	assert.equal(fm.zoteroStatus, "resolved");
	assert.equal(fm.zoteroCheckedAt, "2026-09-16T10:00:00.000Z");
	assert.equal(fm.citekeyProvisional, false);
	assert.equal(fm.zoteroID, "1:AHNAAAA1");
	assert.deepEqual(fm.tags, ["paper", "hub", "synthetic"]);
	assert.match(fm.description as string, /wraps onto a second line/);
	const before = parse(frontmatterText(readFrontmatterBlock(WIKI_HUB) as Exclude<ReturnType<typeof readFrontmatterBlock>, null | "unterminated">)) as Record<string, unknown>;
	for (const key of ["type", "title", "citekey", "doi", "authors", "year", "tags", "description"]) assert.deepEqual(fm[key], before[key], key);
});

test("template hub: placeholder lines that are not valid YAML are never touched", () => {
	const outcome = patchFrontmatterBlock(TEMPLATE_HUB, { citekeyProvisional: false, zoteroStatus: "resolved", zoteroID: "1:TPL00001" });
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.replaced, ["citekeyProvisional", "zoteroStatus"]);
	assert.deepEqual(outcome.appended, ["zoteroID"]);
	assert.equal(outcome.text, TEMPLATE_HUB.replace("citekeyProvisional: true\n", "citekeyProvisional: false\n").replace("zoteroStatus: not-found\n", "zoteroStatus: resolved\n").replace("zoteroCheckedAt: \"\"\n---", "zoteroCheckedAt: \"\"\nzoteroID: 1:TPL00001\n---"));
	assert.match(outcome.text, /year: \{\{year\}\}\n/);
	assert.match(outcome.text, /citekey: "\{\{citekey\}\}"\n/);
});

test("CRLF, BOM, single quotes and trailing whitespace on other lines survive; appended lines reuse the fence's line ending", () => {
	const source = "﻿---\r\ntype: paper-hub\r\ncitekey: 'kim2024'  \r\nnote: 'it''s quoted' \r\nzoteroStatus: \"not-found\"\r\n---\r\nbody line  \r\n";
	const outcome = patchFrontmatterBlock(source, { zoteroStatus: "resolved", zoteroID: "1:KIM00001" });
	assert.ok(outcome.ok);
	assert.equal(outcome.text, "﻿---\r\ntype: paper-hub\r\ncitekey: 'kim2024'  \r\nnote: 'it''s quoted' \r\nzoteroStatus: resolved\r\nzoteroID: 1:KIM00001\r\n---\r\nbody line  \r\n");
	assert.deepEqual(outcome.replaced, ["zoteroStatus"]);
	assert.deepEqual(outcome.appended, ["zoteroID"]);
});

test("indented occurrences are not key lines; the empty change set is a no-op copy", () => {
	const source = "---\ntype: paper-hub\nmeta:\n  zoteroStatus: old\n---\nbody\n";
	const outcome = patchFrontmatterBlock(source, { zoteroStatus: "resolved" });
	assert.ok(outcome.ok);
	assert.equal(outcome.text, "---\ntype: paper-hub\nmeta:\n  zoteroStatus: old\nzoteroStatus: resolved\n---\nbody\n");
	assert.deepEqual(outcome.appended, ["zoteroStatus"]);
	const empty = patchFrontmatterBlock(source, {});
	assert.ok(empty.ok);
	assert.equal(empty.text, source);
	assert.deepEqual([empty.replaced, empty.appended], [[], []]);
	const closingAtEnd = patchFrontmatterBlock("---\ntype: paper-hub\n---", { zoteroStatus: "resolved" });
	assert.ok(closingAtEnd.ok);
	assert.equal(closingAtEnd.text, "---\ntype: paper-hub\nzoteroStatus: resolved\n---");
});

test("refusals: no frontmatter, unterminated fence, foreign key, duplicate key, block scalar, flow collection, continuation, unterminated quote", () => {
	const refuse = (text: string, changes: PatchChanges = { zoteroStatus: "resolved" }) => { const outcome = patchFrontmatterBlock(text, changes); assert.equal(outcome.ok, false); return outcome as Extract<ReturnType<typeof patchFrontmatterBlock>, { ok: false }>; };
	assert.equal(refuse("plain body").refuse, "no-frontmatter");
	assert.equal(refuse("--- \ntype: x\n---\n").refuse, "no-frontmatter");
	assert.equal(refuse("---\ntype: paper-hub\n").refuse, "unterminated");
	assert.equal(refuse("---").refuse, "unterminated");
	const foreign = refuse("---\ntype: paper-hub\n---\n", { citekey: "x" } as unknown as PatchChanges);
	assert.equal(foreign.refuse, "key-not-patchable");
	assert.equal(foreign.key, "citekey");
	const duplicate = refuse("---\nzoteroStatus: a\ntype: paper-hub\nzoteroStatus: b\n---\n");
	assert.equal(duplicate.refuse, "duplicate-key");
	assert.equal(duplicate.key, "zoteroStatus");
	for (const text of [
		"---\nzoteroStatus: |\n  resolved\n---\n",
		"---\nzoteroStatus: >-\n  resolved\n---\n",
		"---\nzoteroStatus: [resolved]\n---\n",
		"---\nzoteroStatus: {a: 1}\n---\n",
		"---\nzoteroStatus:\n  nested: 1\n---\n",
		"---\nzoteroStatus:\n- resolved\n---\n",
		"---\nzoteroStatus: plain\n  continued\n---\n",
		"---\nzoteroStatus: \"unterminated\n---\n",
		"---\nzoteroStatus: 'unterminated\n---\n",
		"---\nzoteroStatus: \"closed\" trailing\n---\n",
	]) assert.equal(refuse(text).refuse, "multiline-value", text);
	// An indented comment after the key line is not a continuation; a value that is only a comment is empty.
	const commentOnly = patchFrontmatterBlock("---\nzoteroStatus: # todo\n  # note\n---\n", { zoteroStatus: "resolved" });
	assert.ok(commentOnly.ok);
	assert.equal(commentOnly.text, "---\nzoteroStatus: resolved # todo\n  # note\n---\n");
});

test("scalars: booleans and safe strings bare; timestamps, empties, reserved words, numbers, indicators and quotes double-quoted", () => {
	assert.equal(serializeScalar(true), "true");
	assert.equal(serializeScalar(false), "false");
	for (const bare of ["resolved", "not-found", "1:ITEM0001", "zotero://select/library/items/ITEM0001", "zotero://select/groups/4711/items/ABCD1234", "ahn2026promptsContracts", "한글키", "a.b-c_d/e"]) assert.equal(serializeScalar(bare), bare);
	assert.equal(serializeScalar("2026-09-16T10:00:00.000Z"), "\"2026-09-16T10:00:00.000Z\"");
	assert.equal(serializeScalar("2026-09-16"), "\"2026-09-16\"");
	assert.equal(serializeScalar(""), "\"\"");
	for (const word of ["true", "False", "null", "~", "yes", "no", "on", "off", "y", "N", "123", "-1", "1.5", "1e3", ".5", "0x1F", "0o17", "1:30", "1_000", ".inf", ".NaN"]) assert.equal(serializeScalar(word), JSON.stringify(word), word);
	for (const leading of ["-x", "?x", ":x", ",x", "[x", "]x", "{x", "}x", "#x", "&x", "*x", "!x", "|x", ">x", "'x", "\"x", "%x", "@x", "`x"]) assert.equal(serializeScalar(leading), JSON.stringify(leading), leading);
	assert.equal(serializeScalar("a: b"), "\"a: b\"");
	assert.equal(serializeScalar("ends with:"), "\"ends with:\"");
	assert.equal(serializeScalar("a #b"), "\"a #b\"");
	assert.equal(serializeScalar(" padded"), "\" padded\"");
	assert.equal(serializeScalar("padded "), "\"padded \"");
	assert.equal(serializeScalar("line\nbreak"), "\"line\\nbreak\"");
	assert.equal(serializeScalar("tab\there"), "\"tab\\there\"");
	assert.equal(serializeScalar("say \"hi\""), "\"say \\\"hi\\\"\"");
	assert.equal(serializeScalar("O'Brien"), "\"O'Brien\"");
	assert.equal(serializeScalar("back\\slash"), "\"back\\\\slash\"");
	assert.equal(serializeScalar("C:\\path\\to"), "\"C:\\\\path\\\\to\"");
	// JSON leaves these raw; YAML 1.1 reads U+2028/U+2029/U+0085 as line breaks and DEL/C1 are not printable, so they are escaped.
	assert.equal(serializeScalar("a\u2028b"), "\"a\\u2028b\"");
	assert.equal(serializeScalar("a\u0085b\u007fc\ufeffd"), "\"a\\u0085b\\u007fc\\ufeffd\"");
	for (const quoted of ["0b101", "+.inf", "-.Inf", "0x_1F", "1:2:3", "Yes", "NO", "a:", "a,b", "a[0]", "a b", "x\\", "C:\\x", "a\"b", "😀", "a\u00a0b"]) assert.match(serializeScalar(quoted), /^".*"$/s, quoted);
	for (const bare of ["123abc", "1.2.3", "v1.0", "a:b", "a@b", "50%", "x+y~z", "Ünïcödé", "日本語", "e\u0301"]) assert.equal(serializeScalar(bare), bare, bare);
	// Everything the serializer emits parses back to the same value.
	const values = ["resolved", "1:ITEM0001", "2026-09-16T10:00:00.000Z", "", "true", "123", "a: b", "a #b", "-x", "#x", "line\nbreak", "say \"hi\"", "O'Brien", "한글키",
		"back\\slash", "\\", "\\n", "C:\\path\\to", "trailing\\", "a\u2028b", "a\u2029b", "a\u0085b", "a\u007fb", "\ufeffbom", "tab\there", "cr\rlf", "0b101", "+.inf", "~", "-", "?", ">", "|", "!tag", "&a", "*a", "%x", "@x", "`x", "{x}", "[x]", "a,b", "1:2:3", "😀", "a\u00a0b", "  ", "x #y", "a: "];
	for (const value of values) {
		assert.equal(parse(`k: ${serializeScalar(value)}`).k, value, JSON.stringify(value));
		assert.equal(parse(`k: ${serializeScalar(value)}`, { version: "1.1" }).k, value, `YAML 1.1: ${JSON.stringify(value)}`);
	}
});

test("empty frontmatter parses as {} with ok status and never bridges across a --- horizontal rule in the body", () => {
	const withRule = "---\n---\nFirst paragraph\n---\nSecond paragraph\n";
	const parsed = parseNoteText(withRule, text => parse(text));
	assert.equal(parsed.frontmatterParse, "ok");
	assert.deepEqual(parsed.frontmatter, {});
	assert.equal(parsed.body, "First paragraph\n---\nSecond paragraph\n");

	const crlf = "﻿---\r\n---\r\nBody\r\n---\r\nAfter\r\n";
	const parsedCrlf = parseNoteText(crlf, text => parse(text));
	assert.equal(parsedCrlf.frontmatterParse, "ok");
	assert.deepEqual(parsedCrlf.frontmatter, {});
	assert.equal(parsedCrlf.body, "Body\r\n---\r\nAfter\r\n");

	assert.deepEqual(frontmatterAndBody(withRule), { yaml: "", body: "First paragraph\n---\nSecond paragraph\n" });
	const bodyWithRule = "Body before rule\n\n---\n\nBody after rule\n";
	const adopted = editFrontmatterLines(bodyWithRule, { set: { zoteroID: "1:ITEM0001" }, append: true, create: true });
	assert.ok(adopted.ok);
	assert.equal(verifyFrontmatterEdit(`---\n---\n${bodyWithRule}`, adopted.text, { set: { zoteroID: "1:ITEM0001" }, append: true, create: true }, text => parse(text)), null);
});

test("valueEnd and splitValue handle blank/comment lines before continuations, tab/bare list dashes and quotes followed by #", () => {
	const refuse = (text: string) => {
		const outcome = patchFrontmatterBlock(text, { zoteroStatus: "resolved" });
		assert.equal(outcome.ok, false, text);
		return (outcome as Extract<ReturnType<typeof patchFrontmatterBlock>, { ok: false }>).refuse;
	};
	assert.equal(refuse("---\nzoteroStatus: \"resolved\"#notacomment\n---\n"), "multiline-value");
	assert.equal(refuse("---\nzoteroStatus: 'resolved'#notacomment\n---\n"), "multiline-value");
	assert.equal(refuse("---\nzoteroStatus: plain\n\n  # comment\n  continued\n---\n"), "multiline-value");
	assert.equal(refuse("---\nzoteroStatus:\n  # comment\n- item\n---\n"), "multiline-value");
	assert.equal(refuse("---\nzoteroStatus:\n-\titem\n---\n"), "multiline-value");
	assert.equal(refuse("---\nzoteroStatus:\n-\n---\n"), "multiline-value");

	const okQuotedComment = patchFrontmatterBlock("---\nzoteroStatus: \"not-found\" # comment\n---\n", { zoteroStatus: "resolved" });
	assert.ok(okQuotedComment.ok);
	assert.equal(okQuotedComment.text, "---\nzoteroStatus: resolved # comment\n---\n");

	const lines = ["authors: # comment", "  # inner comment", "", "- Smith, A", "  # trailing comment", "", "year: 2026"];
	assert.equal(valueEnd(lines, 0, true), 4, "blank and comment lines after the list stay outside end");
});

