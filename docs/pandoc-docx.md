# Pandoc DOCX from an Obsidian manuscript (CMDS Zotero 0.5–0.6.6)

The plugin never produces DOCX itself, and runs pandoc only when you turn on *Run pandoc after export* (section 0c). It produces what pandoc's citeproc is missing: a
bibliography file for the `[@citekey]` citations in a note, in CSL-JSON (recommended), BibTeX or BibLaTeX, exported
through Better BibTeX's `item.export` (one call per Zotero library, Zotero read-only). Since 0.6.2 it can also write
the whole export kit (section 0), and since 0.6.6 a Word kit whose citations stay live Zotero fields (section 0b). Nothing below edits the source note.

## 0. The export kit (0.6.2)

Command palette: **Export pandoc kit for current note**. It writes a folder under *Export kit folder* (Settings →
Bibliography and references; default `CMDS Zotero exports/`), one subfolder per note:

| File | What it is |
| --- | --- |
| `<note>.md` | A cleaned copy of the note (below). The source note is not touched. |
| `references.json` | CSL-JSON of exactly the cited items, from Better BibTeX's `item.export` (`abstract` and `note` removed). |
| `defaults.yaml` | A pandoc defaults file: citeproc and then the kit's filter, the bibliography, the CSL file, `lang`, `link-citations`, resource paths and the output `<note>.docx`. |
| `cmds-zotero-docx.lua` | Runs after citeproc and removes the citeproc settings from the metadata (0.6.6). They hold paths on this computer (the CSL file under your home folder), and pandoc would keep them in the `.docx` as document properties. |
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
- The copy's frontmatter keeps only what the document needs (0.6.6): `title`, `subtitle`, `author`, `date`, `abstract`,
  `keywords`, `subject`, `lang`, `dir`, `nocite`, and for citeproc `csl`, `reference-section-title`,
  `suppress-bibliography`, `link-citations`, `link-bibliography` and `notes-after-punctuation`. Wikilinked names
  become names (`[[Jane Doe]]` → `Jane Doe`). Pandoc stores every other metadata field in a `.docx` as a custom
  document property that travels with the file, so vault fields (`description`, `tags`, `CMDS`, session links, the
  literature-note identity keys) stay in the vault; the report lists them. Fenced and inline code and HTML comments are
  copied as they are.

The CSL file is the note's `csl` when that names a `.csl` file in the vault or an absolute path, else the installed
Zotero style the note uses (a dependent style uses its installed parent, which pandoc needs). Without a file the kit
says so and pandoc uses its default style (Chicago author-date).

Running the command again replaces the earlier kit only while its files are unchanged (the manifest hashes match). If
you edited one of them, the earlier kit is kept and a fresh folder (`<note> 2`, …) is offered instead. Files you add to
the folder, such as the `.docx` pandoc writes, are left alone.

The copy is a normal Markdown file in the vault, so "Find notes citing a source" also lists it; exclude the export
folder from search or delete old kits if that is in the way.

## 0b. Word with live Zotero citations (0.6.6)

The kit above renders the citations once: the `.docx` holds text, and the style is changed by exporting again. When the
document goes on in Word (co-authors, reviewers, a journal asking for another style), use **Export Word kit with live
Zotero citations for current note** instead. Pandoc then writes every citation as a Zotero field, the same field the
Zotero Word plugin inserts, and Word's Zotero plugin formats the citations and the bibliography from then on.

It writes `<export folder>/<note> (Word)/`:

| File | What it is |
| --- | --- |
| `<note>.md` | The same cleaned copy as the pandoc kit. |
| `defaults.yaml` | No `citeproc`, no bibliography file. Runs `cmds-zotero-word.lua` and then Better BibTeX's `zotero.lua`, with the note's style for `zotero.lua`. |
| `cmds-zotero-word.lua` | The kit's filter (below). |
| `cmds-zotero-export.json` | The kit manifest. |

`zotero.lua` (Better BibTeX's pandoc filter, <https://retorque.re/zotero-better-bibtex/exporting/pandoc/>) turns each
`[@citekey]` into a Zotero field but, for `.docx`, writes no document preferences and no bibliography, so Word would ask
for Document Preferences and the bibliography would have to be added by hand. The kit's filter adds both:

- **Document preferences** (style, locale, footnotes for a note style) as the custom document properties
  `ZOTERO_PREF_1…n`, where Zotero keeps them (Word allows 255 characters per property). The first Refresh in Word uses
  the note's style without asking.
- **Footnotes for a note style** (Chicago notes and bibliography, for example): a citation in the text becomes a
  footnote after the punctuation that follows it, as pandoc's citeproc places notes. Citations you wrote inside your own
  footnotes stay there. An author-in-text citation (`@key` without brackets) stays in the text as the author's name and
  a field.
- **The bibliography field** where the managed references section was (`::: {#refs}`), so it lands under your heading. A note without a references section gets it at the end, under a heading taken from the first line of *References headings* (default `References`); a style without a bibliography gets none.

The copy's frontmatter is filtered as in the pandoc kit (section 0), without the citeproc keys: no citeproc runs here.

Two layout notes for Korean manuscripts. A caption written on the line right after an image becomes part of the
image's paragraph; leave one blank line between them. Pandoc's built-in reference document marks East Asian text as
Chinese (Word shows "Chinese (Simplified)" and checks spelling with it) whatever `lang` says; a reference document whose
Normal style uses Korean fixes that (`pandoc -o reference.docx --print-default-data-file reference.docx`, change the
language and font in Word, then add `reference-doc:` to `defaults.yaml`).

Steps:

1. Once per machine, put `zotero.lua` into pandoc's filters folder (the report shows this line when the file is
   missing; read the file first if you like, it is plain Lua):

   ```sh
   mkdir -p ~/.local/share/pandoc/filters && curl -fsSL -o ~/.local/share/pandoc/filters/zotero.lua https://retorque.re/zotero-better-bibtex/exporting/zotero.lua
   ```

2. The note's style must be installed in Zotero (Settings → Cite), because Word's Zotero plugin formats with Zotero's
   styles. A `csl:` that names a `.csl` file outside Zotero is refused with that reason.
3. Run the copied command **while Zotero is open**: pandoc asks Better BibTeX for the cited items. With *Run pandoc after export* on (section 0c) the plugin runs it and opens the `.docx` itself. A citekey Zotero does
   not know stays as `[@key]` text and pandoc prints its name.
4. Open the `.docx` in Word and press **Refresh** in the Zotero tab once. From then on add citations, refresh and change
   the style (Document Preferences) in Word.

`zotero.lua` also checks retorque.re for a newer version of itself each time pandoc runs it; that request is pandoc's,
not the plugin's. The plugin only checks whether the file exists (see the README's disclosures).

After the hand-off the `.docx` is the document: edits made in Word do not come back to the note. Decide when a
manuscript moves to Word (for example, when it goes to co-authors) and keep writing in Obsidian until then.

## 0c. Export folder outside the vault, pandoc from Obsidian, Hookmark (0.6.6)

Three settings under Settings → Bibliography and references, all off by default:

| Setting | Off (default) | On |
| --- | --- | --- |
| Allow export kits outside the vault | *Export kit folder* must be a vault folder | *Export kit folder* may also be an absolute folder or one under `~/`, e.g. `~/Documents/CMDS Zotero exports`. Kits, filters and the `.docx` then stay out of the vault; the copies no longer show in search, the graph or "Find notes citing a source". An absolute path inside the vault is used as that vault folder |
| Run pandoc after export | The export commands copy the pandoc command line | They run pandoc on the kit and open the `.docx` with its default app. The report lists citekeys Zotero did not find. The Word kit runs pandoc only while Zotero answers; otherwise the command is copied as before |
| Link exports in Hookmark | — | macOS with Hookmark: after pandoc, the `.docx` and the note (its `obsidian://open` address) become two Hookmark bookmarks hooked together, so either opens the other from Hookmark. macOS asks once to let Obsidian control Hookmark |

*Pandoc path* names the pandoc to run; empty looks in `/opt/homebrew/bin`, `/usr/local/bin` and the other usual folders
(on Windows `%LOCALAPPDATA%\Pandoc` and `C:\Program Files\Pandoc`), then on the system's search path (Obsidian, as a
GUI app on macOS, does not see the shell's `PATH`).

On Windows, pandoc's filters folder is `%APPDATA%\pandoc\filters`; the report shows a PowerShell line that puts
`zotero.lua` there, and copied commands use double quotes. Hookmark is macOS-only; with it missing the report says so.

If typing `[@` does not open the citation list, another plugin's completion is answering first. **Diagnose setup**
names it: Various Complements (add `[` and `@` to its *First characters to disable suggestions*) or Pandoc Reference
List (turn off its citekey autocomplete).

With an outside folder the kit's `defaults.yaml` reaches the vault by its path under `${HOME}` (for images and a `csl`
file in the vault), so the kit still names no user name.

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
- Use `ko-KR` only when the bibliography should read in Korean. A Korean manuscript whose references follow an English
  style (Western-language sources in Chicago or APA, as in classics or theology) keeps `lang: en-US`: with `ko-KR`
  citeproc also writes the role terms in Korean ("편집자：", "번역자：" in place of "ed.", "trans."), mixed into English
  entries. The same `lang` sets the locale of the Word kit's Zotero document preferences.
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
