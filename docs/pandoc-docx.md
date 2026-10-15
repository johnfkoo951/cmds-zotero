# Pandoc DOCX from an Obsidian manuscript (CMDS Zotero 0.5–0.6.2)

The plugin never produces DOCX itself and never runs pandoc. It produces what pandoc's citeproc is missing: a
bibliography file for the `[@citekey]` citations in a note, in CSL-JSON (recommended), BibTeX or BibLaTeX, exported
through Better BibTeX's `item.export` (one call per Zotero library, Zotero read-only). Since 0.6.2 it can also write
the whole export kit (section 0). Nothing below edits the source note.

## 0. The export kit (0.6.2)

Command palette: **Export pandoc kit for current note**. It writes a folder under *Export kit folder* (Settings →
Bibliography and references; default `CMDS Zotero exports/`), one subfolder per note:

| File | What it is |
| --- | --- |
| `<note>.md` | A cleaned copy of the note (below). The source note is not touched. |
| `references.json` | CSL-JSON of exactly the cited items, from Better BibTeX's `item.export` (`abstract` and `note` removed). |
| `defaults.yaml` | A pandoc defaults file: `citeproc`, the bibliography, the CSL file, `lang`, `link-citations`, resource paths and the output `<note>.docx`. |
| `cmds-zotero-export.json` | The kit manifest (SHA-256 of each file the plugin wrote). |

The command line is copied to the clipboard and shown in the report:

```sh
pandoc --defaults '/path/to/Research/CMDS Zotero exports/Manuscript/defaults.yaml'
```

Paths inside `defaults.yaml` are relative to the defaults file (`${.}`) or the home directory (`${HOME}`), so the
kit names no absolute vault path and runs from any working directory. `${.}` needs pandoc 2.17 or later.

What the cleaned copy changes:

- `[[@citekey]]`, and wikilinks or embeds that resolve to a literature note (by the note's identity, never a first
  match), become `[@citekey]`; image embeds become Markdown images (`![](<path>)`, resolved through the vault root
  in `resource-path`); links to other notes become their text; an embedded note is written as its name (not inlined).
  Links that cannot be resolved are written as their text and listed in the report.
- A citation of a former citekey (renamed in Zotero) is written with the item's current key, which is the `id` the
  CSL-JSON carries.
- `%%` comments, the plugin's own markers and block IDs (`^id`) are removed; callouts become blockquotes with a bold
  title; `==highlights==` become `[text]{.mark}`; the managed references section (below) becomes pandoc's
  `::: {#refs}` placeholder, so the bibliography lands under your heading.
- The literature-note identity keys (`zoteroID`, `zoteroSelectURI`, `zotero-key`, `citekey`) are dropped from the
  copy's frontmatter so an exported literature note is never taken for a second note of the same item. Everything
  else (frontmatter, fenced and inline code, HTML comments) is copied as it is.

The CSL file is the note's `csl` when that names a `.csl` file in the vault or an absolute path, else the installed
Zotero style the note uses (a dependent style uses its installed parent, which pandoc needs). Without a file the kit
says so and pandoc uses its default style (Chicago author-date).

Running the command again replaces the earlier kit only while its files are unchanged (the manifest hashes match). If
you edited one of them, the earlier kit is kept and a fresh folder (`<note> 2`, …) is offered instead. Files you add to
the folder, such as the `.docx` pandoc writes, are left alone.

The copy is a normal Markdown file in the vault, so "Find notes citing a source" also lists it; exclude the export
folder from search or delete old kits if that is in the way.

## Style, locale and the cited keys (0.6.2)

- **Installed styles.** *Choose style* (Settings → Bibliography and references) and the command **Choose bibliography
  style from installed styles** list `<Zotero data directory>/styles/*.csl` (read-only; symlinked files are skipped).
  A chosen style is rendered once by Better BibTeX before it is saved; a style it cannot render is refused with the
  reason. Changing the style or the locale by hand is checked the same way on Save.
- **Locale.** *Bibliography locale* (for example `ko-KR`) is passed to `item.bibliography`; empty keeps the style's
  default locale, as before.
- **Per note.** A note's own `csl` and `lang` frontmatter (pandoc's keys) override the style and locale for that note's
  references sidebar, copied bibliography, references section and kit. `csl: apa.csl` or `csl: styles/apa.csl` is
  matched to an installed style by file name.
- **Cited keys follow pandoc.** Citations in fenced or inline code, HTML comments and `%%` comments, an escaped `\@`
  and e-mail addresses do not count; `-@key` does; keys in `nocite` are added (`@*` is noted, not expanded).
- **Order.** *Bibliography order* decides the copied bibliography and the references section: as the style orders it
  (Better BibTeX renders the whole list, per library), order of first citation, or alphabetical.
- **Copy bibliography** (references sidebar or command) puts formatted (HTML) and plain text on the clipboard, so it
  pastes formatted into Word or Google Docs.
- **Insert or update references section** writes a plugin-owned block at the end of the note
  (`<!-- cmds-zotero-references:<sha256> -->` … `<!-- /cmds-zotero-references -->`) after a preview and a backup of the
  note. An unedited block is updated in place; an edited block is kept as it is; change its marker to
  `<!-- cmds-zotero-references:detached -->` to keep it as yours for good. For pandoc output you do not need it: the kit
  replaces it with `::: {#refs}`.
- **Check citations in current note** lists unknown, ambiguous and former keys, keys without a literature note and
  nocite keys from the saved index (Zotero is not asked); each occurrence opens in the note.

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

Keep the CSL file in the vault (`<vault>/.pandoc/apa.csl` here) or reference one from the Zotero styles folder. The
same `csl` and `lang` keys also set the style and locale CMDS Zotero uses for this note (0.6.2).

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
/References/Zotero/zotero-index.json
```

Use your own *Index path* if you changed it (installs from before 0.6.5 often use `/80. References/zotero-index.json`).

Ignore rules do not untrack files already committed; `git rm --cached` them first.
