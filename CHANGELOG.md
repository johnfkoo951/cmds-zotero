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

Links people actually use (Hookmark stays copy-only; no scripting, no frontmatter hook records):

- **One canonical `obsidian://open` builder.** `obsidianOpenURI(vault, path)` percent-encodes both values (`%20`, never `+`) and strips `.md`, matching the address Obsidian's Copy Obsidian URL produces (Hookmark records the same form; byte-level path-encoding parity with Hookmark is not yet verified). It now backs "Find literature across vaults" rows, agent `NoteRef.uri` values (`resolve`, `identity`, `cites` payloads: same address, different encoding of spaces), and the new file-link command.
- **Peer-vault rows carry the note path.** "Find literature across vaults" links each peer note as `obsidian://open?vault=<peer>&file=<path>` (or `obsidian://advanced-uri?vault=<peer>&filepath=<path>.md` when the peer vault's `community-plugins.json` lists Advanced URI, checked read-only under this vault's configuration folder name; a peer using a different folder name falls back to `obsidian://open`) instead of one identical identity link per row; rows are ordered paper hub / `@citekey` first, then by path. `obsidian://cmds-zotero` remains the rename-safe identity link and agent transport only.
- **Hookmark copies are bare Markdown links.** The three Hookmark copy commands emit `[title](url)` without angle brackets (whitespace and parentheses in the URL are percent-encoded), the form Hookmark's "Hook to Copied Link" and `](`-splitting clipboard scripts accept. Notes and sidebars keep `[title](<url>)`.
- **Self-describing copy commands.** `copy-hookmark-link` is now "Copy Zotero item link (Hookmark-compatible)", `copy-note-link` is "Copy literature note identity link (rename-safe)", and new `copy-file-link` "Copy Obsidian file link (Hookmark-native)" copies the `obsidian://open` address of the entry's literature note (visible in Hookmark's window inside the note; breaks on rename). Command IDs of existing commands are unchanged.
- **New `open-link-under-cursor`.** `zotero://select` opens Zotero; `zotero://open-pdf` is parsed and resolved against the index (attachment key first, then a parent item key as Zotero itself accepts) within the link's library, and opened through the PDF path with page/annotation honoured; `[@citekey]`, `@citekey`, `[[@citekey]]`, `[[@citekey|alias]]` and `[[@citekey#heading]]` open the item actions; a bare link followed by sentence punctuation still counts; anything else (including a malformed Zotero URI, selected or not) shows a notice.
- README gains a Hookmark section stating what is verified from Hookmark's documentation and address log, the context-window caveat of identity links, and the `-1712` relaunch hint.
Identity keys and ownership (R14):

- **One literature-note key set for new notes.** Initial frontmatter is exactly `type: zotero` plus `LITERATURE_IDENTITY_KEYS`: `zoteroID`, `zoteroSelectURI` (new; carries library/group scope), `zotero-key` (ZotLit-compatible), `citekey`, `doi`, `title`, `authors`, `year`, `tags`, and the `zotero_*` display-parity group. `zotero-id`, `zotero-library-id`, `zoteroItemKey`, `zoteroLibraryID`, `zoteroLibraryType` and `zoteroGroupID` are no longer written (all derivable from `zoteroID`/`zoteroSelectURI`). Existing notes are never rewritten; the dead `zotero_citekey` read is gone.
- **Foreign-identity guard.** Note identity resolves `zoteroID`, then `zoteroSelectURI`, then `zotero-key` (only while the index holds one library), then citekey/history — and citekey evidence counts only for `@`-prefixed basenames or `type` in {`zotero`, `paper-hub`, `paper-analysis`, `raw-source`, `literature-zotero`}. Notes carrying `bookendsID` or any other `type` are never claimed, nor are untyped notes carrying a `bookends://` or `x-devonthink-item://` link (a typed hub or raw source may link its PDF through DEVONthink and still resolves), so Bookends `lastname+year` notes no longer become "linked literature notes"; wiki summaries without a type or `@` prefix drop out of the note map and `vaultNotes.other`.
- **Owned-only batch update.** "Update all owned literature notes" owns a note only when it resolves, lies in the output folder and carries the `cmds-zotero-owner` marker; other linked notes are reported once as `Linked but not owned: M (not updated)` and never reach BBT. Pure helper `partitionOwnedNotes()` in `src/note-ownership.ts`.
- **`reconcile` reports pre-0.5 literature notes.** `type: zotero` notes still carrying the dropped keys appear as `type: literature` rows with the informational finding `legacy-frontmatter-dialect` (`skippedReason: not-paper-hub`, never apply-eligible); `reconcile`/`diagnostics` surface one aggregated `info` diagnostic with the count and up to 5 sample paths, not one per note.

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
