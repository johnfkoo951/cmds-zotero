# CMDS Zotero

A desktop-only, local-first Zotero integration: verified identities and index, citations, preservation-aware literature and annotation import, paper-ingest service, diagnostics, cross-vault navigation and Hookmark-compatible links.

## Safety and scope

- Zotero is read-only. Use documented Better BibTeX RPCs; never modify Zotero preferences/database, citation keys or library records.
- Do not copy implementation code from other plugins. Public examples/tests contain synthetic records only; user templates and library exports stay outside this repository.
- Preserve user-written notes and annotations. Import only into new files or plugin-owned sections. Detect manual edits before replacing generated sections.
- Group IDs and local library IDs differ; citekeys and CSL IDs are not stable item keys. Never open a parent item as a PDF or silently resolve to the first search match.
- No self-updater, telemetry, own HTTP server, automatic Hookmark scripting, or silent changes to other plugins.
- Hookmark stays copy-only: the three Hookmark copy commands put bare `[title](url)` Markdown links on the clipboard and nothing else; other copy actions (PDF page link, sidebars) keep `[title](<url>)`. Frontmatter never records hooks (`hook://`, `hookmarkHookedAt` or similar); the hub key set is closed. Any hook/unhook automation belongs to a future sibling plugin, not here.
- Local install scripts explicitly back up, migrate and verify the old plugin ID. Keep other Zotero plugins installed until replacement is validated.

## Development

- Shared data contracts: `src/types.ts`. Keep modules independently testable with synthetic fixtures.
- Pure modules stay free of the `obsidian` import so `tsx --test` can load them: `note-writer`, `citations/scan`, `citations/score`, `citations/reference-rows`, `annotations/colors`, `annotations/filter`, `related`, `settings-data`, `index-service`, `index-digest`, `index-derived`, `note-aliases`, `note-ownership`, `recent/recent-reads`, `pdf/text-layer`, `batch/identity-map`, `batch/batch-run`, `plugin/warm-state`. UI lives in `citations/suggest`, `views/*`, `modals`, `settings`.
- Sidebars and the suggester read `plugin.cachedEntries()` only; they never block on BBT. Bibliography text goes through `plugin.bibliographyFor()` (cached per index generation and style).
- Lookups derived from the index (alias index, citekey/id/item-key maps, completion rows) come from `indexDerived(entries)`, a WeakMap keyed by the published entries array and built on first use. A new generation is a new array; never mutate a published entries array or its entries, and treat derived lookups as read-only.
- Human UI reads use the newest validated snapshot regardless of age and label its age; they never block on BBT. UI negatives are shown only with a loaded snapshot. Writes keep their gates. Background warm-up peeks first, refreshes only a stale or missing snapshot, refuses to collect while the legacy `cmds-link-zotero` plugin is enabled, and backs off for 60 s after a failure with one Notice per index generation (0.6: the first warm-up starts after layout-ready at an idle moment, a stale snapshot's collection waits 30 s while a missing one never waits, and a loaded snapshot is validated in chunks of 500 entries that yield; nothing reads it before it passed). BBT faults are classified once in `src/api/transport.ts` (`BbtTransportError`, `transportReasonOf`); `classifyRefreshError` maps them to contract reasons: connection refused or HTTP 404 → `bbt-unreachable`, timed out → `timeout`, the plugin's own abort → cancelled (never a failure). A `stale-fallback` outcome carries the raw `cause`; hosts rebuild the refusal with `refreshRefusal()` so forced and non-forced refreshes report one payload. The note map is rewritten only when its content changes, so a read never dirties a git-tracked vault. 0.6: `VaultLinks` keeps the recognized literature notes per index generation and resolves again only the notes reported through `IndexController.noteChanged(path)` / `noteMoved` (metadata `changed`, vault rename/delete) or, for changes not pinned to paths, `scheduleMap()`; code that writes or moves notes reports their paths. Edit-time publications (`publishIfChanged`) touch the disk only when a note's identity or path changed.
- Rendered literature notes keep managed section IDs `overview`, `citation`, `metadata`, `notes`, `annotation-<attachment>-<annotation>`; adding IDs breaks in-place updates of older notes. Marker grammar (0.5 R5): `<!-- cmds-zotero:<id>:<sha256> -->` … `<!-- /cmds-zotero:<id> -->` is managed; `<!-- cmds-zotero:<id>:detached -->` freezes the block as user-owned (never re-rendered, never reported as edited or missing, never re-owned by any command; Reset replaces it after a note backup). An edited managed block is a soft conflict (kept verbatim, rest of the note written); missing, duplicate or damaged markers are hard conflicts reported per id with a line number. The ID set is unchanged.
- Recently read (0.5): Zotero 10's reading history comes from Better BibTeX `item.search` with `["resultLevel","item"]` plus `lastRead` conditions (`isInTheLast` for the window, `is` with a local `YYYY-MM-DD` for the day); no other source has `lastRead`. Sending a paper renders from one fresh `item.export` + `item.attachments` (`BbtService.collectEntry`, identity-pinned, never another item) and the saved index is not rewritten. The picker only reads the last remembered answer. Note states come from managed annotation markers, never from BBT.
- Feature decisions against other plugins: `docs/plugin-landscape-2026-09.md`. No SQLite, companion add-on, template engine, or HTTP listener.
- Index entries are hashed once, after their last change (`sealEntry` in `identity`), and never changed afterwards: build a new object instead. In-process checks (`verifyIndex`, `verifyEntry`) trust entries this process sealed; bytes from disk or another process always go through `validateIndex`. `VaultIndexStorage` keeps only a SHA-256 digest of the last index text it read or wrote, never the text. A refresh reads attachments at `attachmentConcurrency` (twice the setting, at most 8).
- BBT transport uses Node HTTP for local server compatibility (desktop-only). Bound timeouts/concurrency and validate response shapes. Do not replace it with browser fetch based on obsolete guidance.
- Prefer Obsidian public APIs for vault writes, UI and protocol registration. Use `Setting.setHeading()`, CSS classes and safe text construction.
- Command IDs: kebab-case without plugin ID or `command`. Sentence-case labels. No global eslint rule suppression.
- Note addresses shown to people and agents come from `obsidianOpenURI` (`obsidian://open?vault=&file=`, percent-encoded, `.md` stripped: the form Obsidian's Copy Obsidian URL produces; Hookmark records the same form, path-encoding parity unverified). Peer rows use `peerNoteURI` (Advanced URI when the peer lists that plugin). `noteDeepLink` (`obsidian://cmds-zotero`) is only for the rename-safe identity link and the protocol handler.
- Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- Public release tags equal manifest versions without a `v` prefix; CI builds and attests assets. Release/community submission require explicit approval.

## API contract

- `api.ready` for Zotero/BBT versions; CAYW only for explicit user interaction.
- Filtered `item.search` discovers parent items; `item.export` with BetterBibTeX JSON supplies canonical item keys, local library IDs and metadata.
- `item.attachments` returns an array with `open`, `path`, optional `annotations`. Parse and validate its URI rather than expecting a `key` property.
- Annotations have 0-based position.pageIndex; Zotero PDF URIs have 1-based page numbers. Image paths are local and must never be committed.
- Native Zotero local API is optional and not required by this implementation. No SQLite access.

## Agent contract 2

- Normative behavior: `docs/agent-contract-v2/contract.md`; implementation status: `docs/0.4-agent-contract-plan.md`.
- Shared agent types live in `src/agent/types.ts`. Pure `src/agent/*`, `pdf/cache`, `pdf/locate`, `frontmatter-read`, and `local-file` must load without a runtime `obsidian` import. Host adapters own environment access.
- Read-only actions use a snapshot/peek, never an implicit refresh or note-map publication. Zotero writes are forbidden. Never replay an accepted or uncertain mutating request after a timeout.
- Missing, malformed, incomplete or unknown-age index evidence cannot prove absence. `allow-stale` changes only stale read verdicts; it never authorizes reconcile writes.
- Reconcile writes only the five `HUB_WRITABLE_KEYS`, only actual paper hubs outside Raw Sources, and only monotonic transitions. Preserve raw presence of malformed values; do not turn malformed into absent. Current key equality alone proves pinning; history and registration are insufficient.
- Keep source-change, YAML round-trip, callback-time and post-write checks. Never claim whole-file CAS against external editors or automatically roll back over a concurrent edit.
- PDF/image reads use the shared no-symlink, bounded, magic-checked local reader. PDF links use attachment keys. Scope/hash-bind cache reads and never issue confirmed callout titles from changed evidence.
- Caches contain full paper text. Ensure private ignore rules before writes; ignored and tracked states differ. Fixtures/docs must be synthetic and must not contain local user paths or library exports.
- `recent` and `import` (0.5) are live-only. `import` writes only with `apply`, through the same `ImportService` preview/apply as the UI; hard conflicts are `note-conflict`, a non-fresh read is refused unless `allowStale`. The host lists its actions (`service.actions`) and the CLI refuses newer actions on an older host as `plugin-too-old`.
- The portable skill reference is generated: edit the canonical contract, run `node scripts/sync-contract.mjs`, then `--check`. Test skill installation only into a fixture target unless real installation is requested.
