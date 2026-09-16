import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

// 0.5 R15: the sentence-case rule keeps running; only its brand vocabulary is adjusted (the option replaces the default list).
// "Hookmark" is a product name that appears mid-label; "Cursor" (the editor) is dropped so the text caret in
// "Open link under cursor" is not rewritten as a brand.
const SENTENCE_CASE_BRANDS = [...DEFAULT_BRANDS.filter(brand => brand !== "Cursor"), "Hookmark"];

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { enforceCamelCaseLower: true, brands: SENTENCE_CASE_BRANDS }],
    },
  },
];
