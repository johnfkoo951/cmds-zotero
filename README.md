[![한국어](https://img.shields.io/badge/한국어-README.ko.md-blue)](README.ko.md)

# CMDS Zotero

Verified Zotero sources, citations, annotations, and literature notes for a local-first research vault. By CMDSPACE.

**Version 0.2.0 is a development version, not a community-approved release.** It has been tested on Obsidian 1.13.7 with Zotero 9.0.6 / Better BibTeX 9.0.63 in two desktop vaults. Live checks cover index rebuilding, APA bibliography, text/image imports, preservation on repeat imports, renamed-note deep links, and cross-vault lookup. Group libraries, the interactive citation picker, and receiving/round-tripping links in Hookmark still require manual acceptance. Keep existing integrations until your workflow is verified.

## Scope

- Cite As You Write citation insertion through Better BibTeX (BBT).
- A versioned, machine-readable index that separates citekeys from canonical Zotero item, attachment, and annotation identities.
- Literature-note and annotation import using a standalone built-in CMDS template, with preview and preservation boundaries.
- Zotero/PDF/evidence links, diagnostics, paper-ingest integration, and opt-in peer-vault navigation.
- Copyable Markdown links suitable for passing to Hookmark; no Hookmark bookmark creation or scripting.

This is **not full Zotero Integration or ZotLit compatibility**. Existing templates are not accepted as interchangeable: Nunjucks extensions such as `persist`, `filterby`, `format`, and `lastImportDate` are not promised as a drop-in template API. Keep existing templates and notes. Only turn other plugins off manually after your citation, bibliography, text/image annotation, and re-import workflows have been verified.

## Requirements

- Obsidian desktop **1.7.2+**; mobile is not supported.
- A running [Zotero](https://www.zotero.org/) installation with [Better BibTeX](https://retorque.re/zotero-better-bibtex/).
- BBT must expose the required RPC contracts. Version numbers alone do not establish compatibility; use connection/index diagnostics.
- Node.js **22** for development and maintenance scripts; not a separate requirement for using an installed plugin.

The implementation uses BBT `api.ready`, filtered `item.search`, `item.export` with **BetterBibTeX JSON**, `item.attachments`, and bibliography/CAYW facilities. Metadata discovery and attachment enrichment are distinct. No native Zotero local-API toggle, Web API key, SQLite access, or external PDF Utility is required. Refresh is a full discovery/export with content hashes, **not a since-cursor incremental sync**.

## Data and privacy disclosures

**Network.** The plugin sends requests to the configured local BBT server, defaulting to `http://127.0.0.1:23119/better-bibtex`, for citations, metadata, attachments/annotations, and bibliography. Bibliographic text and citation queries are exchanged with that server. Keep the endpoint on your own machine. Opening an item, PDF, or peer-vault link delegates the URI to the desktop application responsible for it; websites opened deliberately are outside this plugin's privacy boundary.

**Files outside the vault.** Zotero attachment/annotation image paths may point outside the vault. Explicit imports may read local annotation images and copy them into the configured vault image folder. Peer-vault paths are optional user-provided settings and are used for read-only index/note discovery; no peer-vault writes are intended. Indexes can contain local attachment paths and sensitive bibliographic metadata. Do not publish your index or `data.json`.

**Writes.** Zotero remains read-only: no library edits, citation-key pinning, database changes, or preference changes. The plugin writes its own settings/index and user-requested notes/assets in the current vault. It does not silently rewrite existing literature notes. No telemetry, plugin-managed self-updater, own HTTP server, or paid service is included. Hookmark is optional separate software with its own licensing; it is not required for normal Zotero links.

## Install or migrate locally

Build first:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

For a fresh manual installation, copy only `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/cmds-zotero/`, then enable **CMDS Zotero** manually. Never overwrite an existing `data.json` with one from a development machine.

For an existing `cmds-link-zotero` installation, use the explicit, reversible helper. The following paths are placeholders; substitute absolute paths. **Quit Obsidian and pause vault-sync writers before check/apply/rollback.** Filesystem hashes detect changes but are not a cross-process lock. The helper does not disable/enable running plugins, launch a protocol, or reload Obsidian.

```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode dry-run
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode check
# Inspect the listed changes; copy the exact fingerprint returned by check.
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode apply --expect CHECK_FINGERPRINT
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode rollback
```

- `dry-run` (default) and `check` are read-only; both inspect source assets, installations, enabled registry, and hotkeys.
- `--backup` must be a **new directory outside both the vault and repository**; its parent must exist. Backup records contain private paths/settings and must stay private.
- `--source ABS` optionally selects a different built plugin directory.
- Apply snapshots both installations and registries, checks the fingerprint again, and copies the three release assets. It copies old `data.json` only if the new file does not exist; differing old/new settings require manual resolution.
- Only the old enabled-plugin ID is mapped to the new ID. An absent/disabled old ID does not cause the new plugin to be enabled. Old hotkey prefixes are mapped only when present; conflicting targets stop the migration. Other plugin IDs/settings are untouched.
- The old installation is retained, **not deleted**. Do not enable both IDs. The helper is not an index identity repair: rebuild legacy indexes from BBT after installation.
- `migration.json` and hashed backups support rollback. Rollback refuses to overwrite a changed deployed file, including changed settings/registries; retain the backup and resolve the conflict manually. Empty directories created during installation may remain after rollback.

After migration, launch Obsidian yourself, verify only the new ID is enabled, inspect preserved settings, refresh the index, and test commands. Keep the previous plugins installed until replacement is actually validated.

## Index and integration contract

The TypeScript contract in [`src/types.ts`](src/types.ts) is authoritative. Schema **2** has `generatedAt`, `source: "better-bibtex"`, `count`, `entries`, `capabilities`, `diagnostics`, and `complete`. Entries retain citation/display fields, but identity is `libraryType` + local `libraryID` + canonical `itemKey`; group URIs additionally need the real `groupID`. CSL `id` and citekeys are **not item keys**. Attachments have their own keys and verified `openURI`; annotation links carry attachment/annotation identity and 1-based PDF pages. Printed page labels are separate.

Resolution distinguishes **resolved**, **ambiguous**, **not-found**, and **unavailable**. Consumers must not silently choose the first candidate or treat offline as absence. Legacy indexes are identity-untrusted until rebuilt. Attachment enrichment failure is not evidence that an item has no PDF. Read local indexes as sensitive data, not as public source fixtures.

See [`src/ingest-api.ts`](src/ingest-api.ts) and [`scripts/ingest.mjs`](scripts/ingest.mjs) for the paper-ingest service and CLI contract. The plugin provides no independent HTTP listener. Consumers should retain their direct-BBT/offline fallback rather than infer success from firing an asynchronous UI command.

The CLI starts one bounded in-memory job and waits for its terminal JSON result, rather than relying on long promises being returned by the desktop CLI:

```sh
node scripts/ingest.mjs --vault "Research" --action connection
node scripts/ingest.mjs --vault "Research" --action refresh
node scripts/ingest.mjs --vault "Research" --action resolve --citekey Example2026
node scripts/ingest.mjs --vault "Research" --action diagnostics
```

Imported notes use `zoteroID` to retain their paths after renaming or citekey changes. Initial YAML becomes user-owned; refreshed metadata lives in managed sections. Annotation image names include library scope and content hashes: changed source images create new versions without deleting older or user-modified assets. Existing notes without ownership markers are not automatically adopted. Change the output folder to import alongside them.

## Support boundaries and validation

| Area | Intended support | Acceptance boundary |
| --- | --- | --- |
| Personal-library metadata and canonical links | BBT-only identity resolution | Verify against your installed BBT version |
| Text/image annotations and repeat imports | Built-in CMDS template and plugin-owned sections | Test actual image availability, human edits, conflicts, and repeat imports |
| Group libraries | Explicit local library ID / group ID distinction | Synthetic/source validation is not live group-library validation |
| Peer vaults | Opt-in, read-only lookup and navigation | Test both indexes and renamed notes in your environment |
| Hookmark | Copy validated Zotero Markdown links and stable note deep links | Link generation only; receiving links and round trips are not guaranteed |
| Other plugins/templates | Coexistence during migration | No full parity or automatic disabling |

Before relying on this version, test offline/partial refresh retention, missing attachments, duplicate citekeys, new import → handwritten notes → re-import, missing images, a PDF page/annotation link, note rename navigation, peer-vault routing, and rollback. Do not run bulk imports to prove a small test case.

## Development and release preparation

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
node scripts/sanitize.mjs           # tracked working-tree files
node scripts/sanitize.mjs --staged  # staged additions/changes, reads index bytes
node scripts/version-bump.mjs 0.2.1 # synchronizes package, lock, manifest, versions
node scripts/verify-release.mjs 0.2.1
```

Tests use synthetic fixtures. The sanitizer reports matching file/line/rule without printing secrets; it is a heuristic and does not replace manual staged-diff inspection or review of private repository links. CI uses `npm ci`, lint, typecheck, tests, and production build on Node 22. The prepared release workflow requires an exact stable semver tag **without `v`**, matching manifest/package/lock/versions; it builds three plugin assets and publishes their provenance bundle. **Pushing such a tag publishes a release: obtain approval first.** A prepared workflow does not imply a release, successful CI run, or community submission has occurred.

## Author and license

[Yohan Koo (CMDSPACE)](https://cmdspace.work). MIT; see [LICENSE](LICENSE).
