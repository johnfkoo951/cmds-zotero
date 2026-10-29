# CMDS Zotero user guide
Send what you read and mark up in Zotero to Obsidian literature notes. Metadata, highlights and comments, Zotero notes, citations and links back to the source end up in one note, and the text you write yourself stays untouched. Zotero is treated as read-only.

## Version and release status
This guide covers **CMDS Zotero 0.6.7**, released on **2026-10-29**. The [GitHub release](https://github.com/johnfkoo951/cmds-zotero/releases/tag/0.6.7) carries `main.js`, `manifest.json` and `styles.css`, built and attested by CI. Install it from **Settings → Community plugins → Browse**, manually, or with BRAT.
0.6.5 builds the index of a new install at `References/Zotero/zotero-index.json`, next to the literature notes, instead of a numbered `80. References` folder; an install that already has an index there keeps it. 0.6.4 readied the plugin for the Community directory: choosing an installed style now updates the settings field on Obsidian 1.13 and later, and commands for the current note appear only while a note is open. 0.6.3 finds literature notes you moved, names new notes from fixed tokens, imports by search, shows a review list before every batch, adopts notes made by other Zotero plugins, and adds per-note update, rebuild, frontmatter refresh, legacy-key cleanup and merged-item relink. 0.6.2, released the same day, added a citation editor, bibliographies in Zotero's installed styles and locales, Check citations, a references section and a pandoc export kit. 0.6.1 added note layout settings, Insert item content, a richer annotations sidebar, fielded search, Zotero selection commands and Diagnose setup. 0.6.0 made refreshes, startup and batch updates faster, keeps refreshes going past bad items, lets the citation picker wait for you, reorganises the settings tab and adds agent actions; the [changelog](https://github.com/johnfkoo951/cmds-zotero/blob/main/CHANGELOG.md) lists every change. It was verified with Obsidian 1.14.4, Zotero 10.0.6 and Better BibTeX 9.0.71 on macOS. Checks of 0.5 on a real library covered the recently read list, creating and updating four literature notes, PDF text extraction for four papers (one of them a scan) and quote location. Group libraries and Windows/Linux are outside the verified scope.
Coming from 0.6.1, four things look different with the default settings: citekey problems are underlined in the editor, a copied bibliography keeps the style's own order, **Update all owned literature notes** first shows a review list, and literature notes you moved out of the output folder are updated where they are. New notes keep the names and folders 0.6.1 gave them.

## Requirements and terms
- **Obsidian desktop 1.7.2 or later**. Mobile is not supported.
- A running [Zotero](https://www.zotero.org/) with [Better BibTeX](https://retorque.re/zotero-better-bibtex/) (BBT). The plugin talks only to BBT's local JSON-RPC.
- **Recently read papers** use the reading history Zotero records when a PDF opens in its reader; this was verified on Zotero 10.
- The default local endpoint is `http://127.0.0.1:23119/better-bibtex`. No Zotero Web API key, native Local API setting, SQLite access or separate PDF tool is needed.
A **citekey** such as `Example2026` is a citation label, not a permanent identifier. The plugin identifies an item by library type, local library ID and Zotero item key. Attachments and annotations have their own keys; a parent item is not a PDF.

## Installation
**Community plugins**: open **Settings → Community plugins → Browse**, search for **CMDS Zotero**, select **Install**, then **Enable**.

**Manual**
1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/johnfkoo951/cmds-zotero/releases/latest).
2. Put the three files in `<vault>/.obsidian/plugins/cmds-zotero/`.
3. Reload Obsidian and enable **CMDS Zotero** under **Settings → Community plugins**.

**BRAT**: add `johnfkoo951/cmds-zotero` as a beta plugin in BRAT.

Upgrading keeps your settings (`data.json`) and index. Back up the plugin folder first. If the old `cmds-link-zotero` plugin shares the index path, disable it, or index refreshes are refused.

## First success: send recently read papers to notes
1. Start Zotero with Better BibTeX enabled.
2. In **Settings → CMDS Zotero**, set **Output folder**, **Image folder** and **Index path** (vault-relative) and press **Save configuration**. **Test connection** tests the saved settings.
3. Run **Refresh citekey index** once from the command palette (Ctrl/Cmd+P).
4. Open a paper's PDF in Zotero's reader and add a highlight or a comment.
5. Run **Send recently read papers to notes**, or click the open-book ribbon icon.
6. Each row shows the state of its literature note: *No literature note yet*, *N new annotations not in the note*, *Note is up to date*, or a note CMDS Zotero did not create (never overwritten).
7. Papers that need sending are preselected. **Send** creates the note or refreshes only its managed sections.
8. Open the result with the row's note button and compare annotations, page links and metadata with Zotero.
9. Write a sentence under `## Synthesis` or `## Notes`, add another highlight in Zotero and send again. Your sentence stays and only the new annotation is added: that is the first success.

The **Reading window** offers 7, 30, 90 or 365 days; the default is the **Recently read window** setting (30 days). Zotero must be running for the list.

## Importing and updating literature notes
**Import literature note** lets you pick a source, shows a preview (path, per-section states, conflicts) and applies it. The picker lists recently read papers first, labelled like `· read 3 days ago`. **Open or import literature note** opens the source's note, or shows the import preview when the vault has none yet.
Imports render from **Zotero's current data** (that item's export plus its attachments and annotations), not from the saved index, so highlights made a minute ago are included without refreshing the index. If the citekey changed in Zotero, the item is found again by item key; another item is never substituted. With Zotero closed, the preview uses the saved index and says so. Creating a new note needs bibliography text, so Zotero must be running for a first import.

**Where new notes go.** **New note file name** and **New note subfolder** (Settings → Literature notes) are built from the fixed tokens `{citekey}`, `{title}`, `{shortTitle}`, `{year}`, `{firstAuthor}`, `{itemType}` and `{collection}`, for example `{year} {shortTitle}` in the subfolder `{itemType}`. Characters that cannot be in file names are replaced, long names are shortened, and the preview shows the resulting path. The defaults (`@{citekey}`, no subfolder) keep the earlier names, and existing notes keep theirs. These are fixed tokens, not a template language.

**Moved notes.** A literature note you move or rename anywhere in the vault is found by its identity (its `zoteroID` together with the plugin's owner marker) and updated where it is, instead of being imported again. A note that only names the item, without the owner marker, is not treated as the literature note. **Diagnose setup** lists literature notes outside the output folder.

**Updating one note.** **Update current literature note** opens the update preview for the open note. For an existing note the preview has a **Refresh** group: switch off *Title and abstract*, *Bibliography entry*, *Metadata and links*, *Zotero notes* or *Annotations*, and those sections stay exactly as they are in this update.

**Batches with a review list.** **Update all owned literature notes**, **Update literature notes changed in Zotero**, **Import literature notes by search** and **Adopt existing literature notes** first show a review list: what happens to each note (*Create*, *Update*, *Adopt*, or *Skip* with the reason) and a box per row, with **Select all** and **Select none**. Nothing is read from Zotero or written before you press the apply button, and Cancel changes nothing. While the batch runs, a progress notice offers Cancel; the rest is then left as it was.
- **Update all owned literature notes** refreshes the managed sections of every ticked note and reports *Updated*, *Partial (edited sections preserved)*, *Unchanged* and *Skipped*. Several notes with one identity are skipped, and notes that link the item but were not created by CMDS Zotero are skipped with a hint to adopt them.
- **Update literature notes changed in Zotero** opens the same list for notes whose item or annotations changed since the note was last written. **Changed in Zotero since** switches to *Any time* or a date. The dates come from the saved index, so refresh the index first; an unknown date is never treated as unchanged.
- **Import literature notes by search** takes a fielded search such as `col:methods`, `tag:method`, `type:book` or `year:2020-` and creates notes only for matching items that have none yet. If two items would get the same file name, the second is skipped rather than written over the first.
- Notes synced by the Zotero add-on Better Notes are skipped by batches, because Better Notes would overwrite the update; a single update shows a warning instead.

**Adopting notes from other plugins.** **Adopt current note as literature note** takes a note made by Zotero Integration or ZotLit, or one named by citekey, and matches it to its item by citekey, DOI or Zotero link (when several items match, you choose). After a preview and a backup it adds the missing identity keys line by line and appends the generated sections below your text; nothing you wrote is changed. **Adopt existing literature notes** does the same for every matching note in the vault, after the review list; a match by DOI alone starts unticked. Notes whose `type` is `paper-hub`, `paper-analysis` or `raw-source`, notes under `10. Raw Sources`, notes that belong to Bookends or Better Notes, and notes CMDS Zotero already owns are refused.

**Repairing a note.** **Rebuild current literature note** backs up the note, renders the generated sections again and repairs damaged, duplicate and missing markers. Every line you wrote stays; an edited or detached duplicate keeps its text.

**Frontmatter and identity.** These commands work on the open note. Each shows a line-by-line preview (only the lines marked `-` and `+` change), copies the note to the backup folder first, and checks that the note did not change before, during and after the write.
- **Refresh frontmatter of current note from Zotero** updates only the plugin's metadata keys the note already has. It never touches `zoteroID` or `tags` and adds no keys.
- **Remove legacy keys from current note** removes the keys that versions 0.3 and 0.4 wrote. **Report notes with legacy Zotero keys** lists the notes that still carry them, without changing anything.
- **Relink current note to merged Zotero item**: when Zotero merged the note's item into another one, it points the note to the surviving item. It works only with a complete index; with several candidates you choose.

## Note layout and preservation
A new note's frontmatter holds `type: zotero`, `zoteroID`, `zoteroSelectURI`, `zotero-key`, `citekey`, `doi`, `title`, `authors`, `year`, `tags` and the `zotero_*` fields such as `zotero_title`. **Frontmatter is written once and is yours afterwards.** Updates never change it; only the frontmatter commands above do, after a preview.
The body follows this order:
- Title and abstract (`overview`), bibliography text (`citation`)
- `## Synthesis`: your area (`**Contribution**::`, `**Related**::`)
- Metadata and links (`metadata`): creators, journal, DOI, URL, tags, collections, related Zotero items, links that open Zotero and the PDF
- `## Zotero notes` (`notes`): Zotero child notes as Markdown with headings, lists and links kept; code blocks pass through unchanged
- `## Notes`: your area
- `## Annotations`: one block per annotation, in Zotero's reading order, so an annotation added later on an earlier page still lands in place. Highlights, underlines, images, comments and ink drawings are distinguished, and page links open that spot in Zotero's reader.

Managed sections sit between `<!-- cmds-zotero:<id>:<hash> -->` and `<!-- /cmds-zotero:<id> -->`. If you edit one, only that section is kept as **edited (preserved)** while the rest of the note updates. In the preview you choose per section:
- **Keep this time**: leave it as it is for this update.
- **Detach**: make the block permanently yours; it is never rendered again.
- **Reset from Zotero**: replace it with Zotero's content; the previous note is first backed up to `.cmds-zotero/backups/notes/`.
Damaged or duplicate markers, a note CMDS Zotero did not create, or several notes with one identity block the write, with the reason and line number shown; **Rebuild current literature note** repairs damaged markers. Blocks for annotations deleted in Zotero are never removed from the note.

## Citations, bibliographies and sidebars
**Inserting citations**
- **Insert citation from Zotero** uses BBT's Cite As You Write picker; the default format is `[@citekey]`. A notice with a Cancel button shows while the picker is open, and the command waits up to **Picker wait** (10 minutes). If you switch notes meanwhile, the citation goes to the clipboard instead.
- Typing part of a citekey, title, author or year after `[@` in the editor opens local completion. It reads the cached index, so Zotero is not called on every keystroke. Korean is found whether it is typed composed or decomposed, and accents are ignored (`é` matches `e`). Enter inserts the citation, Shift+Enter a narrative `@key`, Mod+Enter a link to the literature note.
- A new citation joins the one at the cursor: typing `[@` right after `[@kim2020]`, or citing from Zotero's picker, the Zotero selection or the literature picker, gives `[@kim2020; @lee2021]` without repeating a key.
- Pandoc prefixes, locators and suffixes are understood, as in `[see @kim2020, pp. 33–35; also -@lee2021, ch. 1]`. **Edit citation locator** changes the locator of the citation at the cursor.
- In Korean sentences, do not attach a particle right after `@key`: pandoc reads it as part of the citekey. Add a space (`@key 는`) or attach the particle after a bracket. To write a Korean author as "구요한 외(2005)", write the name and cite only the year: `구요한 외[-@key]는`; styles do not produce "외". With a note style, use `[@key]` only. Rendered examples are on the [Korean docs site](https://zotero.cmdspace.work/citations/).
- **Insert citation from the literature index** picks a source from the index and inserts it in the **Default citation format**. Each format also has its own command: **Insert pandoc citation** (`[@key]`), **Insert narrative citation** (`@key`), **Insert citekey wikilink** (`[[@key]]`), **Insert author-date citation text** (`(Kim & Lee, 2020)`, an approximation from the index), **Insert Zotero item link** and **Insert literature note link**. These are fixed formats, not templates.
- Pickers and completion understand fields: `author:`, `title:`, `year:2019-2021`, `tag:`, `col:<collection path>`, `lib:`, `type:` and `has:pdf|note|annotations`, each negatable with `-`; quote values with spaces.
- **Insert item content from Zotero** inserts a source's Zotero notes, bibliography entry, metadata, abstract, links or annotations into the current note as text you own.
- **Paste Zotero links as citations** (off by default): pasting or dropping Zotero item links (`zotero://select/…`) inserts a citation in the default format, matched by library and item key. Links the index does not know are pasted as they are.

**Citations in the editor**
- Citekeys the index does not have, that several items carry, or that are a former key of an item are underlined (**Mark citekey problems**, on by default). Nothing is marked before the index loads, and an incomplete index never marks a key as unknown.
- **Citation hover preview** shows a card with title, authors, year and bibliography entry, and **Show citations as author-date** shows `[@kim2020, p. 3]` as "(Kim & Lee, 2020, p. 3)" in reading view and live preview. Both are off by default and never change the note text.
- **Mod+click on a citation** can open the literature note or the PDF at the locator page (off by default). Right-click menu entries act on the clicked citation, not on the cursor.
- **Citation actions at cursor** lists what you can do with the citation under the cursor. The same actions are separate commands: **Open literature note for citation at cursor** (offers the import preview when there is no note), **Open PDF at citation locator** (the locator's page label is matched to Zotero's page labels when the index knows them; the notice says how the page was found), **Copy PDF page link for citation at cursor**, and **Fix renamed citekey in this note**, which previews every citation of the former key in this note's body and replaces them in one undo step.
- A citekey that several items carry asks which item you mean instead of failing.

**Bibliographies and references**
- **Bibliography style**: **Choose style** (Settings → Bibliography and references) and the command **Choose bibliography style from installed styles** list the styles in Zotero's `styles` folder, read-only (set **Zotero data directory** if it is not `~/Zotero`). A style Better BibTeX cannot render is refused with the reason. A style or locale typed by hand is checked the same way when you press **Save configuration**.
- **Bibliography locale** sets the language and region of bibliography terms and dates, for example `ko-KR` or `de-DE`; empty keeps the style's default.
- A note's own `csl` and `lang` frontmatter set the style and locale for that note: its references sidebar, Insert bibliography, copied bibliography, references section and export kit. `csl: apa.csl` is matched to an installed style by file name. `lang` sets the language of the bibliography terms, not of the manuscript: a Korean manuscript citing English sources in English style keeps `en-US`, while `ko-KR` only translates the terms inside the English style ("Eds." becomes "편집자", "et al." becomes "기타"). Three `csl`/`lang` recipes are on the [Korean docs site](https://zotero.cmdspace.work/references/).
- **Open references sidebar** collects `[@key]`, `@key` and citation wikilinks in the current note and shows their bibliography and unresolved states. With Zotero closed it uses saved bibliography text (`.cmds-zotero/bibliography.json`). It counts citations the way pandoc does: citations in code, HTML comments and `%%` comments, an escaped `\@` and e-mail addresses are left out; `-@key` and keys in `nocite` are counted. Each row jumps to the previous or next occurrence, and **Go to next occurrence of the citation at cursor** and **Go to previous occurrence of the citation at cursor** do the same from the editor.
- **Check citations in current note** lists unknown, ambiguous and former keys, keys without a literature note and `nocite` keys, from the saved index; each occurrence opens in the note.
- **Copy bibliography for current note** (also a button in the references sidebar) puts formatted (HTML) and plain text on the clipboard, so it pastes formatted into word processors. **Bibliography order** decides the order: as the style orders it (default), order of first citation, or alphabetical.
- **Insert or update references section** writes a plugin-owned block at the end of the note after a preview; the note is backed up before the first insert. An unedited block is updated in place, an edited one is kept as it is, and changing its opening marker to `<!-- cmds-zotero-references:detached -->` keeps it as yours for good.
- **Insert bibliography** inserts one source's CSL bibliography text.
- **Open annotations sidebar** shows the annotations of the current literature note, the item selected in Zotero, the citekey at the cursor or a pinned source. Filter by colour, type, tag or attachment, sort and group, fetch the latest annotations from Zotero, drag a card into a note, or use a card's More actions menu. **Search annotations** searches every indexed annotation and inserts it as a callout or quote.

**Exporting with pandoc**
- **Export pandoc kit for current note** writes into **Export kit folder** (default `CMDS Zotero exports`), one subfolder per note: a cleaned copy of the note (literature links become `[@key]`, callouts become blockquotes, comments and markers are removed), the cited sources as CSL-JSON, a pandoc defaults file and a small filter that keeps local paths out of the `.docx`. The copy's frontmatter keeps only the fields meant for the document. The pandoc command line goes to the clipboard. The source note is not changed, the plugin never runs pandoc, and an earlier kit you changed is never overwritten; a new folder is offered instead.
- **Export Word kit with live Zotero citations for current note** (0.6.6) writes `<note> (Word)` in the same folder: the cleaned copy, a defaults file and a small filter. Run the copied command while Zotero is open; the `.docx` holds Zotero fields, so in Word you press Refresh in the Zotero tab once and then add citations, refresh and change the style there. The note's style must be installed in Zotero, and Better BibTeX's `zotero.lua` must be in pandoc's filters folder (the report shows the install line). See [pandoc-docx.md](pandoc-docx.md) §0b.
- **Copy CSL-JSON for cited sources** and **Write pandoc bibliography sidecar for current note** copy the current note's cited sources as CSL-JSON, or save them to `.cmds-zotero/bibliography/<note>.json` and show the `bibliography:` line for the frontmatter.
- The [pandoc/DOCX guide](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/pandoc-docx.md) explains the kit and the export step by step.

## All commands

| Command | What it does |
|---|---|
| Send recently read papers to notes | Shows papers recently read in Zotero with their note states and sends them |
| Import literature note | Previews and imports or updates one source |
| Open or import literature note | Opens a source's note, or shows the import preview when there is none |
| Update current literature note | Previews an update of the open note, with a choice of sections to refresh |
| Update all owned literature notes | Refreshes managed sections of every note the plugin created, after a review list |
| Update literature notes changed in Zotero | Like Update all, limited to notes whose item or annotations changed |
| Import literature notes by search | Creates notes for the items matching a fielded search, after a review list |
| Adopt current note as literature note | Turns a note from another Zotero plugin into a CMDS Zotero note, keeping your text |
| Adopt existing literature notes | Adopts every matching note in the vault, after a review list |
| Rebuild current literature note | Re-renders the generated sections and repairs markers, after a backup |
| Refresh frontmatter of current note from Zotero | Updates the plugin's metadata keys the note already has, after a preview |
| Remove legacy keys from current note | Removes the keys 0.3 and 0.4 wrote, after a preview |
| Report notes with legacy Zotero keys | Lists notes that still carry legacy keys; changes nothing |
| Relink current note to merged Zotero item | Points the note to the item Zotero merged it into |
| Refresh citekey index | Rebuilds the index from BBT |
| Search literature | Picks a source and an action (open, import, copy links and more) |
| Insert citation from Zotero | Inserts a citation from Zotero's picker, with Cancel |
| Insert citation from the literature index | Inserts a citation in the default format from the index |
| Insert pandoc citation, Insert narrative citation, Insert citekey wikilink, Insert author-date citation text, Insert Zotero item link, Insert literature note link | Inserts a citation in that format |
| Citation actions at cursor | Lists the actions for the citation under the cursor |
| Edit citation locator | Changes the locator of the citation at the cursor |
| Open literature note for citation at cursor | Opens the cited source's note, or the import preview |
| Open PDF at citation locator | Opens the PDF at the locator's page |
| Copy PDF page link for citation at cursor | Copies a link to that PDF page |
| Fix renamed citekey in this note | Replaces a former citekey in this note, after a preview |
| Go to next / previous occurrence of the citation at cursor | Jumps between occurrences of one citation |
| Check citations in current note | Lists unknown, ambiguous, former and note-less keys |
| Insert bibliography | Inserts one source's bibliography |
| Copy bibliography for current note | Copies the cited sources' bibliography as formatted and plain text |
| Insert or update references section | Writes or updates a managed references block at the end of the note |
| Choose bibliography style from installed styles | Picks a style from Zotero's styles folder and checks it with BBT |
| Export pandoc kit for current note | Writes a cleaned copy, CSL-JSON and pandoc defaults for export |
| Export Word kit with live Zotero citations for current note | Writes a cleaned copy and pandoc defaults whose `.docx` keeps Zotero fields for Word |
| Copy CSL-JSON for cited sources | Copies CSL-JSON for the current note's citations |
| Write pandoc bibliography sidecar for current note | Saves a bibliography file for pandoc |
| Open references sidebar | Reviews the current note's citations |
| Open annotations sidebar | Reviews and inserts annotations |
| Open source PDF at page | Opens the PDF at a file-position page |
| Open link under cursor | Opens the Zotero link or `[@citekey]` under the cursor |
| Find notes citing a source | Finds notes that use the current or a previous citekey |
| Find literature across vaults | Finds notes for the same source in allowed peer vaults |
| Copy Zotero item link (Hookmark-compatible) | Copies a Markdown link to the Zotero item |
| Copy literature note identity link (rename-safe) | Copies a link that keeps working after the note is renamed |
| Copy Obsidian file link (Hookmark-native) | Copies the literature note's `obsidian://open` address |
| Diagnose index and links | Diagnoses connection, index and identities |
| Diagnose setup | Report-only setup checks with a copyable report |
| Insert item content from Zotero | Inserts a source's notes, citation, metadata, abstract, links or annotations |
| Search annotations | Searches every annotation and inserts it |
| Open / Import / Cite Zotero selection | Acts on the items selected in Zotero, read when you run the command |
| Copy Zotero action script | Copies an Actions & Tags script that opens notes from Zotero menus ([setup](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/zotero-side.md)) |
| Annotations sidebar: … | Follow modes, pin, unpin and fetch latest for the annotations sidebar |

PDF page numbers are **one-based file positions**, not printed page labels.

## Settings
Settings are grouped by area; request limits and the agent-only References headings are under **Advanced**. Values are checked as you type. Switches and menus are saved as soon as they change (0.6.7). After typing a value, press **Save configuration**; until then the previous value applies.

| Section | Setting | Default and meaning |
|---|---|---|
| Connection | Server endpoint | `http://127.0.0.1:23119/better-bibtex`; localhost only |
| Connection | Test connection | Tests the saved endpoint |
| Literature index | Index path | `References/Zotero/zotero-index.json` (before 0.6.5: `80. References/zotero-index.json`, kept where an index already is) |
| Literature index | Maximum index age | 60 min (1–10080); older indexes refresh in the background on the next read |
| Literature index | Refresh saved index | Refreshes the index now |
| Citations | Citation trigger | Bracket: completion opens after `[@`; At sign: also after a bare `@`; Off |
| Citations | Citation format | `pandoc`; the format of Zotero's citation picker |
| Citations | Picker wait | 600 s (30–1800); how long inserting a citation waits for your pick |
| Citations | Default citation format | Pandoc citation (`[@key]`); used for citations from the literature index and for pasted Zotero links |
| Citations | Mark citekey problems | On; underlines unknown, ambiguous and former citekeys |
| Citations | Citation hover preview | Off; a card with title, authors, year and bibliography entry |
| Citations | Show citations as author-date | Off; author-date display in reading view and live preview, the text is unchanged |
| Citations | Mod+click on a citation | Nothing; or Literature note, or PDF (at the locator page) |
| Citations | Paste Zotero links as citations | Off; pasted or dropped Zotero item links become citations |
| Literature notes | Output folder | `References/Zotero`; where new literature notes go |
| Literature notes | New note file name | `@{citekey}`; fixed tokens `{citekey}`, `{title}`, `{shortTitle}`, `{year}`, `{firstAuthor}`, `{itemType}`, `{collection}` |
| Literature notes | New note subfolder | Empty (directly in the output folder); same tokens, `/` between levels |
| Literature notes | Image folder | `References/Zotero/images`; copies of image annotations |
| Literature notes | Excluded tags | `obscite`; Zotero tags left out of notes and annotation tags, one per line |
| Note layout | Abstract, Bibliography entry, Metadata fields, Links, Zotero notes, Synthesis scaffold | On; a switched-off part keeps an empty generated block |
| Note layout | Fields by item type | Off; metadata fields chosen per Zotero item type |
| Note layout | Join continued highlights | Off; a highlight whose comment starts with `+` joins the one before it |
| Note layout | Zotero rich text | Off; italics, bold and line breaks from Zotero as Markdown |
| Note layout | Annotation tags | Plain; or Obsidian tags (`#tag`) |
| Note layout | Synthesis lines, Annotations heading, callout types | The 0.6.0 note; rename to fit your theme |
| Annotations | Heading highlight color | Gray; highlights in this color become headings (None keeps every highlight a callout) |
| Annotations | Follow the Zotero selection | Off; on window focus, or also every few seconds while the sidebar shows the selection |
| Annotations | Selection check interval | 10 s (3–30) |
| Bibliography and references | Bibliography style | `apa`; an installed Zotero CSL style ID, checked with BBT on Save; a note's `csl` overrides it |
| Bibliography and references | Choose an installed style | **Choose style** lists Zotero's installed styles and checks the one you pick |
| Bibliography and references | Bibliography locale | Empty (the style's default); for example `ko-KR`; a note's `lang` overrides it |
| Bibliography and references | Bibliography order | As the style orders it; or order of first citation, or alphabetical |
| Bibliography and references | Zotero data directory | `~/Zotero`; the folder that holds Zotero's `styles` folder, read only |
| Bibliography and references | Allow export kits outside the vault | Off; on lets *Export kit folder* be an absolute folder or one under `~/` (0.6.6) |
| Bibliography and references | Export kit folder | `CMDS Zotero exports`; where the export kits go, one subfolder per note |
| Bibliography and references | Run pandoc after export | Off; on runs pandoc on the kit and opens the `.docx` (0.6.6) |
| Bibliography and references | Pandoc path | Empty: the usual install folders, then the system's search path |
| Bibliography and references | Link exports in Hookmark | Off; on (macOS) hooks the `.docx` and the note in Hookmark (0.6.6) |
| Bibliography and references | References sidebar follows the active note | On; when off the sidebar keeps its note until you press Refresh |
| Recently read | Recently read window | 30 days (7/30/90/365); the recently read list and picker ordering |
| Connected vaults | Peer vaults | One `Vault name \| absolute path` per line, for cross-vault lookup |
| Advanced | Request timeout | 20 s (1–180) |
| Advanced | Attachment timeout | 60 s (1–180); attachments that need image rendering can take longer |
| Advanced | Parallel requests | 2 (1–8); requests at once for exports, bibliographies and reading history |
| Advanced | Refresh requests | 4 (1–8); requests at once during an index refresh; lower it if Zotero slows down |
| Advanced | References headings | Headings that mark a References section for the agent `cites` action; defaults `References`, `Bibliography`, `Works Cited`, `참고 문헌`, `참고 자료` |

## PDF text and agents
AI agents and scripts use the same features through the CLI. It hands work to the plugin in the running Obsidian and answers read-only requests from the index file when Obsidian is not available.
```sh
node scripts/ingest.mjs --vault "Research" --action recent --days 30
node scripts/ingest.mjs --vault "Research" --action import --citekey Example2026
node scripts/ingest.mjs --vault "Research" --action import --citekey Example2026 --apply
node scripts/ingest.mjs --vault "Research" --action pdf-text --citekey Example2026 --pages 1-3
node scripts/ingest.mjs --vault "Research" --action locate --citekey Example2026 --quote "quoted text"
```
- `recent` returns read days and note states (`none`, `behind`, `current`, `foreign`, `duplicate`).
- `import` previews only unless `--apply` is given. Hard conflicts are refused with `note-conflict`. If Zotero cannot be read fresh, nothing is written unless `--allow-stale` is given.
- `pdf-text` extracts text with Obsidian's bundled pdf.js into a private cache (`.cmds-zotero/pdf-text/`), with the character maps CJK fonts need. A scan without a text layer reports `textLayer: none` and an OCR warning; watermarks repeated on every page are not counted as body text.
- `locate` finds the page of a quote and returns a link into Zotero's reader.
- `annotations` (0.6) returns a paper's annotations by attachment in reading order, filtered by `--color`, `--type`, `--tag` or `--attachment`; `--fresh` reads Zotero now and `--today` picks the paper opened today.
- `citing` (0.6) lists the notes that cite a paper, former citekeys included, with line and excerpt.
- `resolve --stdin` (0.6) answers up to 500 lookups given one JSON object per line.
- In read-only contexts use `scripts/ingest-ro.mjs`, which refuses writes and `--apply`.
Agents never edit managed sections; their own summaries go under `## Synthesis` or `## Notes`. The full rules are in the [agent contract](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/agent-contract-v2/contract.md).

## Cross-vault and Hookmark
The plugin reads the note maps of vaults listed in **Peer vaults**, read-only, and **Find literature across vaults** opens them. The same citekey in another vault can be a different source, so check the identity.
The Hookmark link commands only copy links to the clipboard. Bookmarks are made only when you turn on **Link exports in Hookmark** (off by default, macOS): after pandoc, the `.docx` and its source note become two bookmarks hooked together.

## Data and privacy
- The plugin asks the local BBT for metadata, citations, bibliographies, attachments and annotations, and reading history. It never changes Zotero settings, the database, citekeys or library records.
- Importing image annotations, or inserting one as a callout from the annotations sidebar or Search annotations, reads Zotero's cached image outside the vault and copies it into the image folder. Listing Zotero's installed styles (choosing a style, a note whose `csl` names one, the pandoc export kit) reads the `.csl` files in Zotero's `styles` folder, read-only.
- In the vault it writes settings, the index, literature notes, image copies, export kits you ask for and private files under `.cmds-zotero/` (bibliography, note map, backups, PDF text caches). It creates `.cmds-zotero/.gitignore` first so the folder stays out of git. PDF text caches hold full paper text; do not share them.
- The index and note map can contain bibliographic data, private paths and annotations. Keep them out of public repositories.
- For agent requests and the **Diagnose setup** and **Diagnose index and links** commands, when the vault is a Git repository, the plugin runs `git` read-only (`ls-files`, `check-ignore`) to report whether private files are ignored. Three opt-in settings (all off by default) start other programs only during an export: **Run pandoc after export** runs pandoc on the kit and opens the `.docx`, and **Link exports in Hookmark** runs `osascript` to make the Hookmark bookmarks. Each runs without a shell and with a time limit. It runs nothing else.
- No telemetry, own HTTP server or self-updater.

## Troubleshooting

| Symptom | Check |
|---|---|
| The recently read list is empty | Zotero is running, the reading window, and the PDF was opened in Zotero's reader |
| A new highlight is missing from the note | Zotero is running; with Zotero closed the saved index is used |
| A note is refused as "not created by CMDS Zotero" | Another plugin created it; it is never overwritten. Check the output folder and file name, or take it over with **Adopt current note as literature note** |
| Import blocked by damaged markers | Fix the marker at the line shown in the preview, use Reset, or run **Rebuild current literature note** |
| **Update all owned literature notes** shows a list instead of starting | Since 0.6.3 every batch shows a review list first; tick the rows you want and press the apply button |
| A note is skipped as synced by Better Notes | Better Notes would overwrite the update; update that note alone, which warns before writing |
| **Update literature notes changed in Zotero** skips a note you just annotated | The dates come from the saved index; run **Refresh citekey index** first |
| A bibliography style is refused | Better BibTeX could not render it; the message gives the reason. Check that the style is installed in Zotero, the **Zotero data directory** and the **Bibliography locale** |
| A citekey is underlined in the editor | The index does not have it, several items carry it, or it is a former key: refresh the index, run **Check citations in current note** or **Fix renamed citekey in this note**; switch off **Mark citekey problems** to hide the marks |
| The export kit offers a new folder | You changed a file of the earlier kit, which is never overwritten |
| Index refresh refused | Whether the old `cmds-link-zotero` plugin is enabled |
| Connection fails | Zotero and BBT are running, the localhost endpoint, timeouts; run **Diagnose setup** |
| The citation picker reports no pick | The picker was closed or **Picker wait** ran out; run the command again |
| "Recently read" says Zotero 10 is needed | Reading history needs Zotero 10 or later |
| A PDF opens on the wrong page | Page numbers are file positions, not printed labels |
| `pdf-text` returns nothing | The `textLayer` value; `none` means a scan that needs OCR |

## Migrating from the old plugin ID
To move from `cmds-link-zotero`, quit Obsidian and run `scripts/migrate-local.mjs` as `dry-run`, then `check`, then `apply`, with a new private backup folder outside the vault and the repository.
```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode dry-run
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode check
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode apply --expect CHECK_FINGERPRINT
```
`rollback` mode undoes it and refuses to overwrite files changed after deployment. Afterwards check that only the new ID is enabled and rebuild the index.

## Updates, support and license
[Web guide](https://apps.cmdspace.work/plugins/cmds-zotero/) | [Korean docs site](https://zotero.cmdspace.work) | [Repository](https://github.com/johnfkoo951/cmds-zotero) | [Releases](https://github.com/johnfkoo951/cmds-zotero/releases) | [Issues](https://github.com/johnfkoo951/cmds-zotero/issues) | [Changelog](https://github.com/johnfkoo951/cmds-zotero/blob/main/CHANGELOG.md)
When reporting a problem, include the plugin, Obsidian, Zotero and BBT versions, your OS and diagnostics with private data removed. Do not post real indexes, private paths, annotation text or PDF text caches.
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. MIT, [LICENSE](https://github.com/johnfkoo951/cmds-zotero/blob/main/LICENSE).
