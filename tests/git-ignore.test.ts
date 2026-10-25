import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_DIR, gitCoverage, isDirectoryCovered, isIgnored, parseGitignore } from "../src/agent/git-ignore";

const INDEX = "80. References/zotero-index.json";

test("comments, blank lines and trailing spaces are handled like git", () => {
	const text = "# comment\n\n   \n\\#literal\nnotes/   \nkeep\\ \n";
	const rules = parseGitignore(text);
	assert.deepEqual(rules.map(r => r.pattern), ["\\#literal", "notes", "keep\\ "]);
	assert.equal(isIgnored(text, "#literal"), true);
	assert.equal(isIgnored(text, "notes/a.md"), true);
	assert.equal(isIgnored(text, "keep "), true);
	assert.equal(isIgnored(text, "keep"), false);
	assert.equal(isIgnored("", INDEX), false);
	assert.equal(isIgnored("!\n/\n", INDEX), false);
});

test("directory patterns cover everything below and only match directories", () => {
	const text = `${CACHE_DIR}/\n`;
	assert.equal(isIgnored(text, `${CACHE_DIR}/`), true);
	assert.equal(isIgnored(text, `${CACHE_DIR}/pdf-text/user-1-AAAAAAA1-0123456789abcdef.json`), true);
	assert.equal(isIgnored(text, `${CACHE_DIR}/note-map.json`), true);
	assert.equal(isIgnored(text, `sub/${CACHE_DIR}/note-map.json`), true);
	assert.equal(isIgnored(text, CACHE_DIR), false);
	assert.equal(isIgnored(text, `${CACHE_DIR}.bak/x.json`), false);
	assert.equal(isIgnored(text, INDEX), false);
});

test("anchored patterns match only at the root; unanchored names match at any depth", () => {
	const anchored = `${INDEX}\n/build\n`;
	assert.equal(isIgnored(anchored, INDEX), true);
	assert.equal(isIgnored(anchored, `nested/${INDEX}`), false);
	assert.equal(isIgnored(anchored, "build/out.js"), true);
	assert.equal(isIgnored(anchored, "src/build/out.js"), false);
	const loose = "zotero-index.json\n";
	assert.equal(isIgnored(loose, INDEX), true);
	assert.equal(isIgnored(loose, "a/b/zotero-index.json"), true);
	assert.equal(isIgnored(loose, "zotero-index.json.bak"), false);
});

test("star globs stop at separators, ** crosses them, ? and [] match single characters", () => {
	assert.equal(isIgnored("*.json\n", INDEX), true);
	assert.equal(isIgnored("*.json\n", "80. References/index.md"), false);
	assert.equal(isIgnored("80. References/*.json\n", INDEX), true);
	assert.equal(isIgnored("80. References/*.json\n", "80. References/deep/x.json"), false);
	assert.equal(isIgnored("80. References/**/*.json\n", "80. References/deep/er/x.json"), true);
	assert.equal(isIgnored("80. References/**/*.json\n", INDEX), true);
	assert.equal(isIgnored("**/zotero-index.json\n", `a/b/${INDEX}`), true);
	assert.equal(isIgnored("80. References/**\n", INDEX), true);
	assert.equal(isIgnored("80. References/**\n", "80. References"), false);
	assert.equal(isIgnored("a/**/b\n", "a/b"), true);
	assert.equal(isIgnored("a/**/b\n", "a/x/y/b"), true);
	assert.equal(isIgnored("a/**/b\n", "a/xb"), false);
	assert.equal(isIgnored("index-?.json\n", "index-1.json"), true);
	assert.equal(isIgnored("index-?.json\n", "index-12.json"), false);
	assert.equal(isIgnored("index-[0-9].json\n", "index-7.json"), true);
	assert.equal(isIgnored("index-[!0-9].json\n", "index-7.json"), false);
	assert.equal(isIgnored("index-[!0-9].json\n", "index-a.json"), true);
	assert.equal(isIgnored("weird[.json\n", "weird[.json"), true);
	assert.equal(isIgnored("esc\\*.md\n", "esc*.md"), true);
	assert.equal(isIgnored("esc\\*.md\n", "escaped.md"), false);
});

test("negation re-includes a file unless a parent directory is excluded", () => {
	const reinclude = `*.json\n!${INDEX}\n`;
	assert.equal(isIgnored(reinclude, INDEX), false);
	assert.equal(isIgnored(reinclude, "other.json"), true);
	const parentExcluded = `${CACHE_DIR}/\n!${CACHE_DIR}/keep.md\n`;
	assert.equal(isIgnored(parentExcluded, `${CACHE_DIR}/keep.md`), true);
	const flipped = `${INDEX}\n!${INDEX}\n${INDEX}\n`;
	assert.equal(isIgnored(flipped, INDEX), true);
	assert.equal(isIgnored(`!${INDEX}\n`, INDEX), false);
});

test("paths are normalized before matching", () => {
	const text = `${CACHE_DIR}/\n${INDEX}\n`;
	assert.equal(isIgnored(text, `./${INDEX}`), true);
	assert.equal(isIgnored(text, `/${INDEX}`), true);
	assert.equal(isIgnored(text, `${CACHE_DIR}//pdf-text//x.json`), true);
	assert.equal(isIgnored(text, ""), false);
	assert.equal(isIgnored(text, "/"), false);
});

test("directory coverage accepts dir/, dir/** and dir/* forms", () => {
	assert.equal(isDirectoryCovered(`${CACHE_DIR}/\n`, CACHE_DIR), true);
	assert.equal(isDirectoryCovered(`${CACHE_DIR}\n`, `${CACHE_DIR}/`), true);
	assert.equal(isDirectoryCovered(`${CACHE_DIR}/**\n`, CACHE_DIR), true);
	assert.equal(isDirectoryCovered(`${CACHE_DIR}/*\n`, CACHE_DIR), true);
	assert.equal(isDirectoryCovered(`${CACHE_DIR}/*.json\n`, CACHE_DIR), false);
	assert.equal(isDirectoryCovered("*.json\n", CACHE_DIR), false);
	assert.equal(isDirectoryCovered(`${CACHE_DIR}/\n!${CACHE_DIR}/\n`, CACHE_DIR), false);
	assert.equal(isDirectoryCovered(`${CACHE_DIR}/*\n!${CACHE_DIR}/pdf-text/\n`, CACHE_DIR), false);
	assert.equal(isDirectoryCovered(`${CACHE_DIR}/**\n!${CACHE_DIR}/note-map.json\n`, CACHE_DIR), false);
	assert.equal(isDirectoryCovered(`${CACHE_DIR}/*\n!${CACHE_DIR}/keep.json\n${CACHE_DIR}/**\n`, CACHE_DIR), true);
	assert.equal(isDirectoryCovered("", CACHE_DIR), false);
});

test("gitCoverage reports both sensitive locations and treats a missing ignore file as uncovered", () => {
	assert.deepEqual(gitCoverage(null, INDEX, CACHE_DIR), { repo: true, indexIgnored: false, cacheIgnored: false });
	assert.deepEqual(Object.keys(gitCoverage(null, INDEX, CACHE_DIR)), ["repo", "indexIgnored", "cacheIgnored"]);
	assert.deepEqual(gitCoverage("", INDEX, CACHE_DIR), { repo: true, indexIgnored: false, cacheIgnored: false });
	assert.deepEqual(gitCoverage(`${CACHE_DIR}/\n`, INDEX, CACHE_DIR), { repo: true, indexIgnored: false, cacheIgnored: true });
	assert.deepEqual(gitCoverage(`${INDEX}\n`, INDEX, CACHE_DIR), { repo: true, indexIgnored: true, cacheIgnored: false });
	assert.deepEqual(gitCoverage(`# sensitive\n${INDEX}\n${CACHE_DIR}/\n`, INDEX, CACHE_DIR), { repo: true, indexIgnored: true, cacheIgnored: true });
	assert.deepEqual(gitCoverage("*.json\n.cmds-*/\n", INDEX, CACHE_DIR), { repo: true, indexIgnored: true, cacheIgnored: true });
	assert.deepEqual(gitCoverage(`*.json\n!${INDEX}\n`, INDEX, CACHE_DIR), { repo: true, indexIgnored: false, cacheIgnored: false });
	assert.deepEqual(gitCoverage("*\n", "custom/dir/index.json", CACHE_DIR), { repo: true, indexIgnored: true, cacheIgnored: true });
});

test("private catch-all covers caches without covering the separate index", () => {
 assert.deepEqual(gitCoverage(null, "refs/index.json", ".cmds-zotero", "*\n"), {repo:true,indexIgnored:false,cacheIgnored:true});
 assert.equal(gitCoverage(null, "refs/index.json", ".cmds-zotero", "*\n!pdf-text/\n").cacheIgnored,false);
});
