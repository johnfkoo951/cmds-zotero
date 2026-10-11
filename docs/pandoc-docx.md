# Pandoc DOCX from an Obsidian manuscript (CMDS Zotero 0.5)

The plugin never produces DOCX itself. It produces the one input pandoc's citeproc is missing: a bibliography
file for the `[@citekey]` citations in a note, in CSL-JSON (recommended), BibTeX or BibLaTeX, exported through
Better BibTeX's `item.export` (one call per Zotero library, Zotero read-only). Everything below is a recipe
around that file; nothing in it edits the note.

## 1. Produce the bibliography sidecar

Either of these writes `.cmds-zotero/bibliography/<note basename>.json` inside the vault. The folder is
plugin-owned and covered by `.cmds-zotero/.gitignore` (the plugin ensures that file before every write).

- Command palette: **Write pandoc bibliography sidecar for current note**. The notice repeats the YAML line to add.
  **Copy CSL-JSON for cited sources** (also the "Copy CSL-JSON" button in the References sidebar) puts the same
  array on the clipboard instead.
- Agent CLI (live host; `ingest-ro.mjs` refuses `--out`):

  ```sh
  node scripts/ingest.mjs --vault "Research" --action cites --path "Drafts/manuscript.md" --bibliography --format csl-json --out
  ```

  `--format bibtex|biblatex` writes `.bib`; `--out <vault-relative path>` chooses another location. A path
  outside `.cmds-zotero/` is written only when the file is absent or starts with the generator marker
  (`% cmds-zotero bibliography` for `.bib`, `<!-- cmds-zotero bibliography -->` for `.md`/`.txt`); CSL-JSON
  must stay a plain array, so an existing `.json` there needs `--force`; an existing Markdown note is never
  replaced. The response reports `out: {path, written, bytes}` and `references.unresolved` (keys with no entry
  in the export: dangling, hub-only, ambiguous, or a citekey renamed in Zotero — `references.renamed` lists
  `[@old]` keys exported under their current key; fix the citation or pin the old key in Zotero).

CSL-JSON `abstract` and `note` fields are removed (`references.stripped`); `id` and `citation-key` are kept because
citeproc matches `[@key]` against `id`.

## 2. Note frontmatter

Pandoc reads its options from the note's YAML block. Paths are resolved from pandoc's working directory, so the
vault-relative form works when pandoc runs from the vault root (the shell recipe below); otherwise use absolute paths.

```yaml
---
title: Manuscript
bibliography: .cmds-zotero/bibliography/manuscript.json
csl: .pandoc/apa.csl
link-citations: true
lang: ko-KR
---
```

Absolute-path alternative (safe from any working directory, e.g. when obsidian-pandoc runs from the note's folder):

```yaml
bibliography: /path/to/Research/.cmds-zotero/bibliography/manuscript.json
csl: /path/to/Research/.pandoc/apa.csl
```

Keep the CSL file in the vault (`<vault>/.pandoc/apa.csl` here) or reference one from the Zotero styles folder.

## 3. Export

Shell, from the vault root:

```sh
cd "/path/to/Research"
pandoc "Drafts/manuscript.md" --citeproc --bibliography .cmds-zotero/bibliography/manuscript.json --csl .pandoc/apa.csl -o manuscript.docx
```

The command-line `--bibliography`/`--csl` are only needed when the YAML block does not carry them. Add
`--reference-doc template.docx` for house styles.

obsidian-pandoc plugin: set **Export from** to *Markdown* (not "HTML", which bypasses citeproc), add
`--citeproc` under **Extra pandoc arguments**, and keep `bibliography:`/`csl:` in the YAML block (absolute paths are
the safest choice there because the plugin's working directory is not the vault root). Then run *Pandoc → Export
as Word Document*.

## 4. Korean manuscripts

- `lang: ko-KR` in the YAML block selects the Korean CSL locale for citeproc terms ("및", "쪽", "n.d." equivalents)
  when the style ships or references a `locales-ko-KR.xml`; APA and most CSL styles do. Without `lang`, terms stay
  English even though the entries are Korean.
- Many styles alphabetise Korean author names correctly only when Zotero stores them in the family/given form;
  the export is verbatim, so fix the Zotero record, not the sidecar.
- Fonts are a DOCX concern: pass `--reference-doc` with a document whose Normal style uses a Korean font.

## 5. Keep private data out of git

The sidecar contains bibliographic metadata only (abstracts and notes are stripped), but `.cmds-zotero/` also holds
full-text PDF caches. The plugin writes `.cmds-zotero/.gitignore` with `*`; for a vault that is a repository the
root `.gitignore` should also carry:

```gitignore
/.cmds-zotero/
/80. References/zotero-index.json
```

Ignore rules do not untrack files already committed; `git rm --cached` them first.
