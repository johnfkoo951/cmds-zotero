# CMDS Zotero user guide
Send what you read and mark up in Zotero to Obsidian literature notes. Metadata, highlights and comments, Zotero notes, citations and links back to the source end up in one note, and the text you write yourself stays untouched. Zotero is treated as read-only.

## Version and release status
This guide covers **CMDS Zotero 0.5.0**, released on **2026-10-12**. The [GitHub release](https://github.com/johnfkoo951/cmds-zotero/releases/tag/0.5.0) carries `main.js`, `manifest.json` and `styles.css`, built and attested by CI. **The plugin is not yet listed in Obsidian Community Plugins**; install it manually or with BRAT.
It was verified with Obsidian 1.14.4, Zotero 10.0.5 and Better BibTeX 9.0.71 on macOS. Checks on a real library covered the recently read list, creating and updating four literature notes, PDF text extraction for four papers (one of them a scan) and quote location. Group libraries and Windows/Linux are outside the verified scope.

## Requirements and terms
- **Obsidian desktop 1.7.2 or later**. Mobile is not supported.
- A running [Zotero](https://www.zotero.org/) with [Better BibTeX](https://retorque.re/zotero-better-bibtex/) (BBT). The plugin talks only to BBT's local JSON-RPC.
- **Recently read papers** use the reading history Zotero records when a PDF opens in its reader; this was verified on Zotero 10.
- The default local endpoint is `http://127.0.0.1:23119/better-bibtex`. No Zotero Web API key, native Local API setting, SQLite access or separate PDF tool is needed.
A **citekey** such as `Example2026` is a citation label, not a permanent identifier. The plugin identifies an item by library type, local library ID and Zotero item key. Attachments and annotations have their own keys; a parent item is not a PDF.

## Installation
**Manual**
1. Download `main.js`, `manifest.json` and `styles.css` from the [0.5.0 release](https://github.com/johnfkoo951/cmds-zotero/releases/tag/0.5.0).
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
**Import literature note** lets you pick a source, shows a preview (path, per-section states, conflicts) and applies it. The picker lists recently read papers first, labelled like `· read 3 days ago`.
Imports render from **Zotero's current data** (that item's export plus its attachments and annotations), not from the saved index, so highlights made a minute ago are included without refreshing the index. If the citekey changed in Zotero, the item is found again by item key; another item is never substituted. With Zotero closed, the preview uses the saved index and says so. Creating a new note needs bibliography text, so Zotero must be running for a first import.
**Update all owned literature notes** walks every note this plugin created and refreshes its managed sections, reporting *Updated*, *Partial (edited sections preserved)*, *Unchanged* and *Skipped*. It does not ask per note, so run it after a small test.

## Note layout and preservation
A new note's frontmatter holds `type: zotero`, `zoteroID`, `zoteroSelectURI`, `zotero-key`, `citekey`, `doi`, `title`, `authors`, `year`, `tags` and the `zotero_*` fields such as `zotero_title`. **Frontmatter is written once and is yours afterwards.**
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
Damaged or duplicate markers, a note CMDS Zotero did not create, or several notes with one identity block the write, with the reason and line number shown. Blocks for annotations deleted in Zotero are never removed from the note.

## Citations, bibliographies and sidebars
- **Insert citation from Zotero** uses BBT's Cite As You Write picker; the default format is `[@citekey]`.
- Typing part of a citekey, title, author or year after `[@` in the editor opens local completion. It reads the cached index, so Zotero is not called on every keystroke.
- **Open references sidebar** collects `[@key]`, `@key` and citation wikilinks in the current note and shows their bibliography and unresolved states. With Zotero closed it uses saved bibliography text (`.cmds-zotero/bibliography.json`).
- **Open annotations sidebar** shows the annotations of the current literature note or a pinned source, to insert at the cursor or copy.
- **Insert bibliography** inserts one source's CSL bibliography text.
- **Copy CSL-JSON for cited sources** and **Write pandoc bibliography sidecar for current note** copy the current note's cited sources as CSL-JSON, or save them to `.cmds-zotero/bibliography/<note>.json` and show the `bibliography:` line for the frontmatter. The [pandoc/DOCX guide](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/pandoc-docx.md) explains the export.

## All commands

| Command | What it does |
|---|---|
| Send recently read papers to notes | Shows papers recently read in Zotero with their note states and sends them |
| Import literature note | Previews and imports or updates one source |
| Update all owned literature notes | Refreshes managed sections of every note the plugin created |
| Refresh citekey index | Rebuilds the index from BBT |
| Search literature | Picks a source and an action (open, import, copy links and more) |
| Insert citation from Zotero | Inserts a CAYW citation |
| Insert bibliography | Inserts one source's bibliography |
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

PDF page numbers are **one-based file positions**, not printed page labels.

## Settings
Press **Save configuration** after changing values; until then the previous values apply.

| Setting | Default and meaning |
|---|---|
| Server endpoint | `http://127.0.0.1:23119/better-bibtex`; localhost only |
| Test connection | Tests the saved endpoint |
| Request timeout | 20 s (1–180) |
| Attachment timeout | 60 s (1–180); attachments that need image rendering can take longer |
| Index path | `80. References/zotero-index.json` |
| Maximum index age | 60 min (1–10080); older indexes refresh in the background on the next read |
| Parallel requests | 2 (1–8) |
| Refresh saved index | Refreshes the index now |
| Output folder | `References/Zotero`; where new literature notes go |
| Image folder | `References/Zotero/images`; copies of image annotations |
| Bibliography style | `apa`; an installed Zotero CSL style ID |
| Citation format | `pandoc`; the CAYW format |
| Recently read window | 30 days (7/30/90/365); the recently read list and picker ordering |
| Peer vaults | One `Vault name \| absolute path` per line, for cross-vault lookup |
| References headings | Headings that mark a References section; defaults `References`, `Bibliography`, `Works Cited`, `참고 문헌`, `참고 자료` |

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
- In read-only contexts use `scripts/ingest-ro.mjs`, which refuses writes and `--apply`.
Agents never edit managed sections; their own summaries go under `## Synthesis` or `## Notes`. The full rules are in the [agent contract](https://github.com/johnfkoo951/cmds-zotero/blob/main/docs/agent-contract-v2/contract.md).

## Cross-vault and Hookmark
The plugin reads the note maps of vaults listed in **Peer vaults**, read-only, and **Find literature across vaults** opens them. The same citekey in another vault can be a different source, so check the identity.
The Hookmark commands only copy links to the clipboard. They do not change Hookmark settings, create bookmarks or run scripts.

## Data and privacy
- The plugin asks the local BBT for metadata, citations, bibliographies, attachments and annotations, and reading history. It never changes Zotero settings, the database, citekeys or library records.
- Importing image annotations reads Zotero's cached images outside the vault and copies them into the image folder.
- In the vault it writes settings, the index, literature notes, image copies and private files under `.cmds-zotero/` (bibliography, note map, backups, PDF text caches). It creates `.cmds-zotero/.gitignore` first so the folder stays out of git. PDF text caches hold full paper text; do not share them.
- The index and note map can contain bibliographic data, private paths and annotations. Keep them out of public repositories.
- No telemetry, own HTTP server or self-updater.

## Troubleshooting

| Symptom | Check |
|---|---|
| The recently read list is empty | Zotero is running, the reading window, and the PDF was opened in Zotero's reader |
| A new highlight is missing from the note | Zotero is running; with Zotero closed the saved index is used |
| A note is refused as "not created by CMDS Zotero" | Another plugin created it; it is never overwritten, so check the output folder and file name |
| Import blocked by damaged markers | Fix the marker at the line shown in the preview, or use Reset |
| Index refresh refused | Whether the old `cmds-link-zotero` plugin is enabled |
| Connection fails | Zotero and BBT are running, the localhost endpoint, timeouts |
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
[Web guide](https://apps.cmdspace.work/plugins/cmds-zotero/) | [Repository](https://github.com/johnfkoo951/cmds-zotero) | [Releases](https://github.com/johnfkoo951/cmds-zotero/releases) | [Issues](https://github.com/johnfkoo951/cmds-zotero/issues) | [Changelog](https://github.com/johnfkoo951/cmds-zotero/blob/main/CHANGELOG.md)
When reporting a problem, include the plugin, Obsidian, Zotero and BBT versions, your OS and diagnostics with private data removed. Do not post real indexes, private paths, annotation text or PDF text caches.
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. MIT, [LICENSE](https://github.com/johnfkoo951/cmds-zotero/blob/main/LICENSE).
