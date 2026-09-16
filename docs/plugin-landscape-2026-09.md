# Zotero ↔ Obsidian plugin landscape (2026-09) and 0.3.0 feature decisions

Survey date: 2026-09-13. Purpose: decide which behaviours from other plugins CMDS Zotero should adopt, and which it deliberately will not. No implementation code was copied from any project; only documented behaviour was reviewed.

## Plugins reviewed

| Plugin | Last release | Connection | Status |
| --- | --- | --- | --- |
| ZotLit 2.1.4 | 2026-09-11 | Direct SQLite read (reflink/immutable) + ZotLit Companion add-on; optional local HTTP server for live updates | Active, full rewrite (Liquid templates, AGPL) |
| Zotero Integration 3.2.1 | 2024-08-11 | BBT CAYW + external PDF Utility binary | Community archive, no releases since 2024 |
| Pandoc Reference List 2.0.25 | archived | `.bib` export + external Pandoc | Community archive |
| Zotero Bridge / Zotero Link | 2024 | Zotero local API | Low activity |
| Citations (hans) | stale | BibLaTeX / CSL-JSON export | Stale, forks only |
| Zotero Sync Client 1.4 | 2026-07 | Zotero Web API / local API, read-only mirror | Active |
| Zotero Better Notes | active | Zotero-side, two-way Markdown sync | Active (Zotero add-on) |
| Zotero Actions & Tags, Reading List, Attanger | active | Zotero-side | Active (Zotero add-ons) |

## What ZotLit 2.x does that matters

- `[@` / `@` inline citation suggester over the whole library scope, with primary and alternate formats.
- References sidebar for the active note, citation popover, cited-by sidebar, copy bibliography, DOCX/HTML export through a bundled Pandoc engine.
- Managed region `%%zt-managed%%` re-rendered wholesale on update; user writing outside is preserved. No conflict detection inside the region.
- Annotation view following the active note (or the Zotero reader when the server is on); drag to insert; copy backlink.
- Batch create/update across a library or collection, via Zotero context menu, commands, or `obsidian://zotlit/*` links.
- Zotero child-note import, colored highlight import, Template Data Explorer, agent-editable templates.

## Decisions for CMDS Zotero 0.3.0

Adopted (adapted to the existing read-only BBT contract and preservation model):

1. **Inline citekey suggester** (`[@` and optional `@`), served from the local index, no BBT round trip.
2. **References sidebar** for the active note: scans Pandoc, bare, and wikilink citekeys, resolves through the index, shows CSL bibliography from BBT with open note / Zotero / PDF actions and a copy-bibliography button. Replaces Pandoc Reference List for this workflow.
3. **Citing-notes lookup** (cited-by): vault-wide scan for a source's citekey and citekey history.
4. **Annotation sidebar** following the active literature note: color, page label, text, comment; open in PDF, insert at cursor, copy link. Reader-following is not adopted because it requires a plugin-owned HTTP listener.
5. **Batch update of owned literature notes** using the existing preview/apply preservation path; conflicts are reported, never forced.
6. **Literature note layout v2** matching the CMDS callout template used with Zotero Integration: `[!Cite]`, `[!md]` inline fields, `[!LINK]` attachment links, `[!Abstract]`, `[!Highlight]`/`[!Image]` annotation callouts with color classes, gray highlights as structural headings, related items as `[[@citekey]]`, compatible `zotero_*` frontmatter.
7. **Protocol `target=import`** to open or create a literature note from an external link.

Deliberately not adopted:

- Direct SQLite reads, a Zotero companion add-on, a local HTTP server, or live push updates. The plugin stays BBT-only and listener-free.
- A general template engine (Liquid/Nunjucks/Eta). The renderer stays built-in and preservation-aware; layout options are settings, not scripts.
- Wholesale managed-region replacement. CMDS Zotero keeps per-section hashes so edited generated text is preserved and reported.
- Two-way sync to Zotero, PDF Utility style annotation extraction, DOCX export, MCP exposure, read-status columns.

## CMDS Zotero 0.4 direction (2026-09-14)

| Area | 0.4 implementation target | Deliberate boundary |
| --- | --- | --- |
| Agent access | Ten-action contract, live/offline snapshots, identity and citation diagnostics | No MCP server or new UI |
| Hub lifecycle | Explicit five-key reconcile apply with monotonic transitions and conflict guards | No automatic Zotero PIN, note renaming, Raw Source/body writes |
| Quote provenance | Bundled pdf.js page text and scope-bound private caches | No external PDF utility; unverified matches remain unverified |
| Coexistence | Existing 0.3 UI remains; human reading/writing UX can stay in ZotLit | No SQLite, companion, template-engine or AGPL code adoption |

This is release-preparation scope, not a claim of a published release or completed live acceptance.
See [the contract](agent-contract-v2/contract.md) and [implementation evidence](0.4-agent-contract-plan.md).
