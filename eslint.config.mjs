import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

// 0.5 R15: the sentence-case rule keeps running; only its brand vocabulary is adjusted (the option replaces the default list,
// so brands added upstream later must be re-imported here). "Hookmark" is a product name that appears mid-label; "Cursor"
// (the editor) is dropped so the text caret in "Open link under cursor" is not rewritten as a brand. The deep import has no
// exports-map contract (plugin pinned to 0.4.2 in package.json); a plugin restructure fails loudly at lint time, by design.
// 0.6 OPT-22: "Better BibTeX" (the Zotero add-on this plugin talks to) is a product name too.
// 0.6.6: "Word" (Microsoft Word, the target of the Word export kit) as well.
const SENTENCE_CASE_BRANDS = [...DEFAULT_BRANDS.filter(brand => brand !== "Cursor"), "Hookmark", "Better BibTeX", "Word"];
// 0.5 R10: "CSL" (Citation Style Language) is an acronym that appears in labels such as "Copy CSL-JSON"; same replace-the-list caveat.
// 0.6 OPT-22: "CAYW" (Better BibTeX's cite-as-you-write endpoint) as well.
const SENTENCE_CASE_ACRONYMS = [...DEFAULT_ACRONYMS, "CSL", "CAYW"];

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { enforceCamelCaseLower: true, brands: SENTENCE_CASE_BRANDS, acronyms: SENTENCE_CASE_ACRONYMS }],
    },
  },
];
