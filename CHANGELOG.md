# Changelog

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
