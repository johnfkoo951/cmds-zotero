# CMDS Zotero

A desktop-only, local-first Zotero integration: verified identities and index, citations, preservation-aware literature and annotation import, paper-ingest service, diagnostics, cross-vault navigation and Hookmark-compatible links.

## Safety and scope

- Zotero is read-only. Use documented Better BibTeX RPCs; never modify Zotero preferences/database, citation keys or library records.
- Do not copy implementation code from other plugins. Public examples/tests contain synthetic records only; user templates and library exports stay outside this repository.
- Preserve user-written notes and annotations. Import only into new files or plugin-owned sections. Detect manual edits before replacing generated sections.
- Group IDs and local library IDs differ; citekeys and CSL IDs are not stable item keys. Never open a parent item as a PDF or silently resolve to the first search match.
- No self-updater, telemetry, own HTTP server, automatic Hookmark scripting, or silent changes to other plugins.
- Local install scripts explicitly back up, migrate and verify the old plugin ID. Keep other Zotero plugins installed until replacement is validated.

## Development

- Shared data contracts: `src/types.ts`. Keep modules independently testable with synthetic fixtures.
- BBT transport uses Node HTTP for local server compatibility (desktop-only). Bound timeouts/concurrency and validate response shapes. Do not replace it with browser fetch based on obsolete guidance.
- Prefer Obsidian public APIs for vault writes, UI and protocol registration. Use `Setting.setHeading()`, CSS classes and safe text construction.
- Command IDs: kebab-case without plugin ID or `command`. Sentence-case labels. No global eslint rule suppression.
- Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- Public release tags equal manifest versions without a `v` prefix; CI builds and attests assets. Release/community submission require explicit approval.

## API contract

- `api.ready` for Zotero/BBT versions; CAYW only for explicit user interaction.
- Filtered `item.search` discovers parent items; `item.export` with BetterBibTeX JSON supplies canonical item keys, local library IDs and metadata.
- `item.attachments` returns an array with `open`, `path`, optional `annotations`. Parse and validate its URI rather than expecting a `key` property.
- Annotations have 0-based position.pageIndex; Zotero PDF URIs have 1-based page numbers. Image paths are local and must never be committed.
- Native Zotero local API is optional and not required by this implementation. No SQLite access.
