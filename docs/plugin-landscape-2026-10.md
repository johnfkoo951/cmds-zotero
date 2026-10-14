# Zotero ↔ Obsidian plugin landscape (2026-10) and 0.6 feature decisions

Survey dates: 2026-10-12 and 2026-10-13. This record follows `plugin-landscape-2026-09.md` and records what CMDS Zotero 0.6 absorbs from other plugins, what it adapts, and what it deliberately leaves out. As before, nothing was copied from another project. Only documented behaviour, changelogs and issue trackers were reviewed; ZotLit, Zotero Integration and several forks are AGPL or GPL. Better BibTeX behaviour was confirmed with read-only JSON-RPC calls against Zotero 10.0.6 and Better BibTeX 9.0.71.

## Method

Twelve research passes covered:

- ZotLit and its companion add-on
- Zotero Integration and its forks
- the citation and pandoc plugins
- plugins built on the Zotero local API or web API
- Zotero-side add-ons that serve an Obsidian workflow
- every matching entry in `community-plugins.json`
- open feature requests in the ZotLit and Zotero Integration trackers, plus 2025–2026 forum threads
- an inventory of CMDS Zotero 0.5.0
- a measured performance audit
- a Better BibTeX capability survey
- a release-readiness audit

The passes found 144 plugins and add-ons and 522 features. Merged across plugins, these became 223 distinct capabilities:

| Classification | Count |
| --- | --- |
| Absorb within the existing rules | 126 |
| Absorb with an adapted mechanism | 40 |
| Needs a user decision | 36 |
| CMDS already equal or better | 21 |

## What changed since 2026-09

- **ZotLit 2.2.0-beta** (2026-10-11) still reads `zotero.sqlite` directly. Its companion add-on adds annotation editing and a note-status column inside Zotero. AGPL-3.0.
- **Zotero Integration** now sits in the Obsidian Community Archive. Its last release is 3.2.1 from 2024-08-11, and users report silent failures on Zotero 8 and 9. Community forks such as grub-basket 3.3.3 and the jin083 Zotero 9 fork patch the picker and import. Its users need a migration path: adopting existing notes, named citation formats and inserting formatted bibliographies.
- **New in 2026:**
  - Citation Extended, a maintained Citations fork.
  - Citation Suite: CAYW with locators, a citeproc preview, unknown-key marks, Zotero-installed styles.
  - Citation Links: `[[@key]]` rendered as citations.
  - Zotero Citations: footnote and in-text modes, Word with live fields.
  - Due Credit and Pandoc GUI: pandoc export with pre-checks.
  - Simple Citations: auto-export watching.
  - Better Pandoc Reference List: Zotero local API sync.
  - Refwright: CSL-JSON notes and an MCP server.
  - ZotFlow: web API two-way sync.
  - Zotero Annotations and Paper Trail: local API reads and writes.
  - Several citation-graph plugins on OpenAlex, Semantic Scholar and Crossref.
- **Zotero-side:** Better Notes 3.3.3 (two-way Markdown sync), Actions & Tags 2.6.2 (Zotero 10; community "Open in Obsidian" scripts), Reading List 1.7.1, Attanger 1.5.0 and MarkDB-Connect 0.2.4 (marks items that have vault notes).
- **Zotero 10 / Better BibTeX 9.0.71:** the read-only RPCs cover:
  - collection trees (`user.groups(true)`) and collection, tag, date, retracted and annotation-text searches (`item.search`)
  - CSL bibliographies with style and locale (`item.bibliography`)
  - pandoc live-citation data (`item.pandoc_filter`)
  - exports through any installed translator
  - reading the library-pane selection on demand

  They do not expose installed styles, full text, reading position or citation-key history.

## Decisions (user, 2026-10-13)

| Question | Decision | Consequence |
| --- | --- | --- |
| Third-party engines and tools | Read Zotero's installed CSL styles folder read-only; no bundled citeproc-js, no template engine, no running pandoc or tesseract | Real style picker and CSL paths for pandoc. Editor citations are author-date approximations. Exports are a kit (cleaned copy, cited CSL-JSON, pandoc defaults, command line) that the user runs. Layout knobs and profiles stand in for templates |
| Zotero, network and scope boundaries | All kept | Zotero stays read-only through BBT. Nothing leaves localhost. No listener, companion add-on, SQLite, local API or MCP server. Group libraries and reading status stay out. Adapted alternatives ship instead: following the Zotero selection by polling, Zotero's own retraction flags, related-items canvases |
| Editing existing notes | Per-note previewed line patches | Opt-in frontmatter refresh, legacy-key cleanup, merged-item relink and note rebuild, each with preview, backup and hash checks (R8). Vault-wide rewrites stay report-only. No plugin-owned spans inside prose |
| Release | 0.6.0 core first, then 0.6.x releases | Optimization, robustness and the core absorbed features ship in 0.6.0; the rest follows in 0.6.1, 0.6.2 and so on. Each release is installed into both vaults with backups. Community-directory submission comes later, after a separate approval |

## Boundaries (unchanged)

- Zotero is read-only. Only documented Better BibTeX RPCs are used, and Zotero preferences, databases, citation keys and records are never written.
- No SQLite, Zotero local API, Zotero web API, companion add-on, plugin-owned HTTP listener or MCP server. No network traffic beyond the configured Better BibTeX endpoint. No telemetry and no self-updater.
- No template engine and no bundled citation processor. No external binaries beyond the existing `git` probe.
- User-written text is preserved. CMDS writes only to new files, plugin-owned managed sections, and previewed per-note line patches.
- Hookmark stays copy-only.

## Absorbed in 0.6.0

Optimization and robustness work (refresh hashing, digest storage, editor-time lookups, parallel vault scans, CLI poll backoff, Git probe cache) plus these capability rows:

| Row | What shipped |
| --- | --- |
| `settings-ux` | Every stored setting has a control; per-area sections, validation as you type, settings search |
| `batch-performance-progress` | Batch updates read the literature folder once, with progress and Cancel |
| `off-main-thread-index-load` | Index load after layout-ready, chunked validation, delayed stale refresh |
| `references-sidebar-render-cost` | References sidebar does not probe Zotero per edit while it is not answering |
| `references-refresh-rerender` | References Refresh re-renders instead of rebuilding the index |
| `cayw-picker-wait-cancel` | Citation picker with its own wait, readiness probe and Cancel |
| `bbt-rpc-error-envelope` | Better BibTeX error replies read correctly (renamed citekeys import again) |
| `index-refresh-resilience` | One bad item no longer aborts a refresh; feeds and same-named libraries handled |
| `group-library-validation` | Report-only library diagnostics (empty, not indexed) |
| `attachment-content-type` | PDF, EPUB and snapshot attachments told apart |
| `epub-snapshot-annotations` | EPUB and web-snapshot annotations indexed |
| `collection-membership-index` | Collection membership and paths in the index |
| `retraction-flags-from-zotero` | Zotero's retraction flags as diagnostics |
| `recent-reads-efficiency` | Recent reads dated by bisection, confirmed per day; Zotero 10 gate |
| `reconcile-line-patch` | reconcile --apply patches hub frontmatter line by line (R8) |
| `agent-annotations-action` | Agent action annotations |
| `agent-cited-by-action` | Agent action citing |
| `ai-via-external-agents` | resolve --stdin and skill recipes for external agents |
| `cli-config-dir` | Offline CLI --config-dir |

## Deferred to 0.6.x

The 0.6.0-tier feature rows of the second wave move to 0.6.1 and later, so the optimization and robustness work ships first. Approved rows keep their decision.

- **citations-editor**: `suggester-unicode-query`, `suggester-alternate-insert`, `multi-source-citation-cluster`, `citation-locators-affixes`, `named-citation-formats`, `citekey-problem-marks`, `ambiguous-citekey-chooser`, `citation-hover-preview`, `author-date-rendering`, `open-note-at-cursor`, `click-citation-open`, `pdf-at-locator-page`, `context-aware-citing-actions`, `renamed-citekey-fix`, `zotero-drop-paste-citation`, `copy-pdf-page-link-key`, `context-menus-active-target`
- **references-bibliography-export**: `per-note-style-locale`, `probe-validated-style-picker`, `check-citations`, `bibliography-style-order`, `rich-text-bibliography-copy`, `citation-occurrence-navigation`, `cited-key-set-pandoc-semantics`, `managed-references-section`, `bibliography-locale`, `wikilinks-to-citations-on-export`, `export-sanitized-copy`, `pandoc-export-kit`, `installed-csl-style-picker`
- **note-rendering**: `layout-knobs`, `item-type-aware-fields`, `rich-text-markup`, `insert-item-content`, `join-continued-annotations`, `annotation-tags-as-obsidian-tags`, `image-annotation-placeholder`
- **import-update-pipeline**: `find-moved-notes`, `filename-folder-pattern`, `open-or-create-note`, `selective-update-scope`, `better-notes-guard`, `adopt-existing-notes`, `batch-import-by-scope`, `batch-dry-run-review`, `update-changed-since`, `update-current-note`, `frontmatter-refresh`, `legacy-key-cleanup`, `merged-item-relink`, `rebuild-or-repair-note`
- **annotations-pdf**: `annotation-search-insert`, `annotation-sidebar-facets`, `annotation-sidebar-modes`, `annotation-sidebar-live-read`, `annotation-drag-insert`, `annotation-card-actions`, `follow-zotero-selection`, `resume-reading-position`
- **library-integration-ui**: `collection-tag-filters`, `index-status-menu`, `zotero-menu-actions-recipe`, `zotero-selection-commands`, `doctor-report`

Rows the synthesis already placed in a later 0.6.x tier stay there (for example `citation-composer`, `cited-by-sidebar`, `layout-profiles`, `child-notes-as-files`, `reading-queue`, `korean-ui`).

## Not adopted

The needs-decision rows the 2026-10-13 decisions declined, with the boundary each one crosses. They are reconsidered only if the user raises them again.

| Row | Boundary |
| --- | --- |
| Bundled CSL processor (citeproc-js) for in-text and offline bibliography rendering (`full-csl-rendering`) | citeproc-bundle |
| Verify references against Crossref, OpenAlex, PubMed or SaaS checkers (`external-reference-verification`) | third-party-api |
| Vault-wide citekey rewrite and literature-note rename (`vault-wide-citekey-rewrite`) | vault-rewrite |
| Look up works outside the library, insert references or add them to Zotero (`external-work-lookup`) | third-party-api |
| Reference and citing-work lists from Semantic Scholar, OpenAlex or Crossref (`external-citation-graph`) | third-party-api |
| User-defined citation text through a template engine (`template-citation-formats`) | template-engine |
| Generated citation text stored in the note and refreshed (`inline-generated-citations`) | other:inline-managed-spans |
| Search and download styles from the Zotero style repository (`style-repository-search`) | other:remote-network |
| One-click export to DOCX, ODT, HTML, PDF, EPUB or LaTeX through pandoc (`pandoc-export-in-plugin`) | docx-export |
| Word document with live Zotero citation fields (`word-live-zotero-fields`) | docx-export |
| User template engine for literature notes (Liquid, Nunjucks, Eta or JavaScript) (`template-engine`) | template-engine |
| Create, edit, recolour, move and delete Zotero annotations from Obsidian (`zotero-annotation-writing`) | zotero-write |
| Save annotations into the PDF file (`write-annotations-into-pdf`) | zotero-write |
| OCR for scanned PDFs and image annotations (`ocr`) | external-binary |
| Import a vault PDF folder into Zotero (`import-pdfs-into-zotero`) | zotero-write |
| Library scope and first-class group libraries (`library-scope-groups`) | group-libraries |
| Several databases or bibliography files at once (`multiple-sources`) | other:non-bbt-source-identity |
| Zotero local API reads (version cursors, deletion feed, saved searches) (`local-api-reads`) | local-api |
| Zotero Web API mirror and cloud attachment download (`web-api-mirror`) | web-api |
| Read zotero.sqlite directly (Zotero closed, no BBT) (`sqlite-direct-read`) | sqlite |
| Per-item, git-diffable library mirror (`per-item-git-mirror`) | other:private-index-in-git |
| Live push from Zotero over a listener or companion (reader, annotations, connector) (`live-push-updates`) | http-listener |
| Write back to Zotero / two-way sync (`write-back-two-way-sync`) | zotero-write |
| Remove a property from all literature notes (`bulk-property-removal`) | vault-rewrite |
| Bundled Zotero companion add-on (note-status column, native menus, item-pane note view) (`zotero-note-status-column`) | companion-addon |
| Reading status read from Zotero add-ons (Extra lines and status tags) (`reading-status-readonly`) | reading-status |
| Set reading status from Obsidian (status columns or write-back) (`reading-status-write`) | reading-status |
| Zotero's own reader embedded in Obsidian, with annotation editing (`embedded-zotero-reader`) | zotero-write |
| Citation counts, open-access links, topics and cards from external APIs (`external-metadata-enrichment`) | third-party-api |
| MCP server for Claude Code, Codex and Cursor (`mcp-server`) | http-listener |
| AI chat, summaries, translation and cloud PDF conversion inside the plugin (`ai-chat-in-plugin`) | third-party-api |
| Plugin features on Obsidian mobile (`mobile-plugin-mode`) | other:desktop-only |
