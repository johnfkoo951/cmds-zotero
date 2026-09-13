# Feature comparison: Zotero ↔ Obsidian plugins (2026-09-13)

Versions: CMDS Zotero 0.3.0 (dev), ZotLit 2.1.4 (2026-09-11), Zotero Integration 3.2.1 (2024-08-11, community archive), Pandoc Reference List 2.0.25 (archive), Zotero Bridge/Link 1.6 (low activity), Citations 0.1.3 (stale), Zotero Sync Client 1.4.0 (2026-07). Behaviour taken from official docs and changelogs; nothing was copied from other projects. Companion decision record: `plugin-landscape-2026-09.md`.

## Connection

| | CMDS Zotero | ZotLit | Zotero Integration | Pandoc Ref List | Bridge/Link | Sync Client |
| --- | --- | --- | --- | --- | --- | --- |
| Data path | BBT JSON-RPC + CAYW | Direct SQLite read + Companion add-on (WAL checkpoint) | BBT CAYW + PDF Utility binary | `.bib` export + external Pandoc | Zotero local API | Zotero Web/local API, read-only mirror |
| Needs BBT / running Zotero | yes / yes | no / no | yes / yes | no / no | no / yes | no / no |
| Own HTTP server | no | optional (live updates) | no | no | Bridge exposes API | no |
| Identity | libraryID + itemKey, citekey history | item ID + `source-id` | citekey | citekey | key | key |

## Writing citations

| | CMDS Zotero | ZotLit | Zotero Integration | Pandoc Ref List | Citations |
| --- | --- | --- | --- | --- | --- |
| Inline suggester | `[@` (+ optional `@`), local index | `[@` / `@`, all libraries in scope | no (CAYW picker) | no | yes |
| CAYW picker | yes | no | yes | no | no |
| In-text rendering / popover | no | yes (bundled Pandoc, CSL) | no | no | no |
| References sidebar | yes (BBT bibliography, cached) | yes (numbered, CSL) | no | yes | no |
| Cited-by | command, vault scan | sidebar | no | no | no |
| Ambiguous citekeys | refused, shown | refused, Reference Error | silent | silent | silent |
| DOCX/HTML export | no | yes | no | via Pandoc plugin | no |

## Literature notes

| | CMDS Zotero | ZotLit | Zotero Integration |
| --- | --- | --- | --- |
| Template engine | none; built-in callout layout + settings | Liquid (`zt.*`), optional Eta/JS, Data Explorer, Template Workbench | Nunjucks (`persist`, `filterby`) |
| Update model | per-section hashes; edited generated text preserved and reported | managed region replaced wholesale; metadata-only and overwrite commands | `persist` blocks only |
| Note identity | `zoteroID` + citekey history (survives renames) | `zotero-key` frontmatter | filename |
| Child notes | rendered into a section | imported as separate files, colored highlights | `markdownNotes` |
| Filename | fixed `@citekey.md`, tracked after rename | template with collision suffix | path template |

## Annotations

| | CMDS Zotero | ZotLit | Zotero Integration |
| --- | --- | --- | --- |
| Source | Zotero native via BBT | Zotero native via SQLite | PDF parsing (PDF Utility) |
| Images | hashed copies, versioned, never deleted | copied after approval | extracted JPG |
| Colors | hue-mapped 8 names, `<mark>` classes | 9 names | `colorCategory` |
| Sidebar | follow note / pin; filter; open, insert, copy | follow note / reader / pin; drag; search and filters | none |

## Updates, batch, protocol

| | CMDS Zotero | ZotLit | Zotero Integration |
| --- | --- | --- | --- |
| Batch | all owned notes, conflicts skipped | library or collection, from Zotero menu / command / protocol | none |
| Index | versioned JSON, diagnostics, rollback | none (DB read) | none |
| Protocol | `obsidian://cmds-zotero?target=note\|pdf\|import` | `obsidian://zotlit/{open,update,update-many,import-note(s),update-all,import-all-notes,explore}` | import trigger |
| External entry | Hookmark-compatible links, peer-vault note map, ingest CLI | Companion context menu, note-status column | none |

## Position of CMDS Zotero 0.3.0

Unique: canonical identity index with diagnostics and rollback, per-section preservation with edit detection, rename/citekey-change tracking, cross-vault navigation, Hookmark links, ingest CLI, migration tooling. ZotLit-only: in-text rendering, DOCX export, reader following, library/collection batches, companion menus, template engine, works with Zotero closed. Deliberately excluded from 0.3.0: template engine, SQLite, companion add-on, HTTP listener, two-way sync, DOCX export, MCP exposure.
