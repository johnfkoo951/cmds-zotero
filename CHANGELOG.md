# Changelog

## 0.5.0 — Development, unreleased

Note-writer correctness (literature note rendering; managed section IDs unchanged, so the managed sections of existing notes update in place — frontmatter of existing notes stays user-owned and is never rewritten):

- **No more `<…>` data loss in plain-text fields.** Titles, creators, tags, DOIs, URLs and the bibliography go through `plainText()` (control-character filtering and Markdown escaping only); HTML tag stripping and entity decoding apply only to the abstract and Zotero child notes. SICI-style DOIs such as `10.1016/S0378-7206(98)00080-9` and titles containing `<B>` survive intact. Trade-off: Zotero rich-text markup in titles and annotation comments (`<i>`, `<sup>`, `<span class="nocase">`) is now shown literally as escaped text instead of being stripped; converting that small tag set to Markdown is a possible follow-up.
- **DOI, URL and citekey values are written verbatim** when they match strict patterns, so Obsidian autolinks and Dataview values no longer carry `\_` or `\(`; `%20` stays intact. A DOI is strict when it has no whitespace and none of `` [ ] * | ` `` and `<` does not start an HTML tag (SICI `<799::AID>` still qualifies); anything else falls back to single-line escaped text. BBT's double-encoded `%25XX` sequences are decoded only in DOI URLs (`doi.org` host or a DOI-prefixed path) and only when the result is still a valid URL; other URLs keep a literal `%25`. In the `[!Cite]` text, `https?://` tokens become `<url>` autolinks with minimal percent-encoding and trailing punctuation or an unbalanced closing `)`/`]` left outside the link; surrounding prose is escaped as before.
- **New annotation blocks are spliced after the last existing annotation block** (else after `## Annotations`, else at end of file), so user prose written below the annotation list stays below it.
- **YAML `tags` mirror Obsidian-valid slugs** on newly created notes only (whitespace to `-`, characters outside letters/numbers/`_`/`/`/`-` dropped, repeated `/` collapsed, leading/trailing `/` and `-` trimmed, empty and all-numeric tags skipped, deduped); `zotero_tags` and the `**Tags**::` field keep the raw Zotero tags. Existing notes keep their frontmatter as is.
- **Empty sticky notes** render `*(empty note)*` instead of an empty `[!Note]` callout.
- **`**Related**::` in `[!md]` is renamed `**Zotero related**::` and the key is always present** (empty when the item has no relations), so the appearance of relations changes the field value rather than the callout layout; the `[!Synth]` `**Related**::` line stays user-owned.
- **Obsidian's automatic link updates are not reported as user edits.** Section comparison accepts a body that differs from the fresh render only by Markdown/wiki link targets (moved image folder, renamed note, including folders with parentheses such as `84. References (Zotero)/images`); stored hashes stay raw. Consequence: link targets inside managed sections are plugin-owned and are regenerated on update — retarget by moving the file rather than editing the link.
- No change: page-label rendering (`p. -` placeholders fall back to the PDF page position since 0.3.0).

Performance and hygiene: the deep-link protocol handler and "Open source PDF at page" resolve against the in-memory index only (no whole-vault note scan or git probe per click; agents keep the full `resolve` action through jobs); "Update all owned literature notes", open-note and copy-link group notes by entry in one vault pass (`VaultLinks.localFilesByEntry`) instead of one pass per entry; the cross-vault note map is serialized deterministically (sorted entry ids and paths), compared in memory against the last published fingerprint (seeded from disk on the first publication) and written only when it changes, and renames/deletes of attachments or images no longer schedule it; `cites`, `diagnostics` and `reconcile` list the vault once per request; failure reasons come from typed errors first — an oversized `--file` PDF reports `pdf-too-large` and a non-PDF `pdf-invalid` (local-file refusals surface by code through one shared `hashLocalPdf`, in the live host and the offline CLI alike), typed extraction failures map by code (`pdfjs-unavailable`, `pdf-invalid`, `pdf-too-large`), `apply-failed` is reserved for `reconcile --apply`, and a failing dry-run reports `invalid-request`; the offline CLI derives contract-2 support from the installed manifest's numeric major.minor (0.4.1, 0.5.0 and later advertise API 2; unparsable stays unknown); the agent host and PDF cache store resolve the vault base path once so a vault opened through a symlink passes the guarded local reader; `locate --path` accepts extension-less and leading-slash note paths exactly like `cites` and returns `invalid-request` for an unknown note (or `path-outside-vault` for a path that cannot be inside the vault) instead of throwing (`cites` keeps `path-outside-vault` for a path without notes); vault-file PDF caches are named `file-<pathHash16>-<sha16>.json` (hash of the normalized path, so `./A/x.pdf` and `A/x.pdf` agree) so identical bytes at two vault paths never share or evict a cache, and eviction opens only caches of the same path (pre-0.5 `file-<sha16>.json` caches are ignored; re-run `pdf-text`); a note renamed away from `.md` still refreshes the cross-vault note map; ingest jobs time out per action (`pdf-text` 900 s, others 300 s), failing the job (the text says whether a write may have completed or the job was read-only) and releasing the settings guard, whose message now names the pending write jobs.

## 0.3.0 — Development, unreleased

Feature parity pass after reviewing ZotLit 2.1.4, Zotero Integration 3.2.1, Pandoc Reference List, and Zotero-side add-ons; decisions are recorded in `docs/plugin-landscape-2026-09.md`.

- **Inline citekey completion.** Typing `[@` (optionally a bare `@` at a word start) suggests items from the local index without contacting BBT; Shift+Enter inserts the bare key. Settings → Writing → Citekey completion.
- **References sidebar.** Lists the `[@citekey]`, `@citekey`, and `[[@citekey]]` citations of the active note with CSL bibliography text from BBT, open note/Zotero/PDF actions, ambiguity and not-found states, and a copy-bibliography button.
- **Annotations sidebar.** Follows the active literature note or a pinned item; shows color, page label, text, comment, and tags; opens the annotation in the Zotero reader, inserts it at the cursor, or copies its link. Reader-following is intentionally not included because it would require a plugin-owned HTTP listener.
- **Literature note layout v2.** `[!Cite]`, `[!Abstract]`, `[!md]` inline fields (creators by role, journal, volume, issue, publisher, pages, DOI, ISBN, related items as `[[@citekey]]`), `[!LINK]` Zotero and `file://` attachment links, `[!Highlight]`/`[!Image]`/`[!Note]` annotation callouts with `cmds-zotero-hl-<color>` marks, a configurable heading highlight color (default gray), excluded tags (default `obscite`), and `zotero_*` frontmatter compatible with earlier CMDS templates. Managed section IDs are unchanged, so 0.2.0 notes update in place.
- **Batch update.** "Update all owned literature notes" re-renders managed sections of every owned note through the existing preview/apply path; conflicts are reported and skipped.
- **Citing-notes lookup.** Vault-wide search for notes citing a source by its current or previous citekeys.
- **Protocol `target=import`** opens the import preview for a resolved item.
- Bibliography responses are cached per index generation; caches clear on refresh and on configuration changes.

Not included: a template engine, SQLite reads, a Zotero companion add-on, live push updates, two-way sync, DOCX export. Group libraries and Hookmark round-trips remain manually unverified.

## 0.2.0 — Development, unreleased

- Rename the plugin to **CMDS Zotero**, ID `cmds-zotero`.
- Replace citekey-derived identities with canonical BBT item identities and a versioned index contract.
- Prepare BBT attachment/annotation enrichment, preservation-aware built-in CMDS literature imports, diagnostics, paper-ingest integration, opt-in peer-vault navigation, and copyable Hookmark-compatible links.
- Add explicit, fingerprint-checked installation migration with private backups and conservative rollback; preserve the old installation and existing settings.
- Add bilingual documentation, Node 22 CI, exact-version release validation, version synchronization, and public-source sanitization tooling.

This is not a published release or a claim that live acceptance testing has completed. Group-library and Hookmark round-trip behavior remain unverified without environment-specific tests. Full Zotero Integration/ZotLit template compatibility is not included. No other plugin is automatically disabled by the plugin runtime.

## 0.1.0 — Local pilot

- Citation insertion, citekey index export, and source-PDF navigation under the previous `cmds-link-zotero` ID.
- Legacy exported indexes must not be treated as verified canonical item identities; rebuild from BBT before relying on source links.
