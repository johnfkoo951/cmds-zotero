[![한국어](https://img.shields.io/badge/한국어-README.ko.md-blue)](README.ko.md)

# CMDS Zotero

Verified Zotero sources, citations, annotations, and literature notes for a local-first research vault. By CMDSPACE.

**Version 0.4.0 is in development/release preparation, not a published or community-approved release.** Its ten-action agent contract adds identity, citation validation, guarded hub reconciliation, PDF text and quote locators without new UI. See the [contract](docs/agent-contract-v2/contract.md) and [implementation status](docs/0.4-agent-contract-plan.md). The following 0.3.0 description and live checks are historical, not acceptance evidence for 0.4.0. 0.3.0 adds inline citekey completion, references and annotation sidebars, batch note updates, and a callout-based literature note layout after a review of ZotLit 2.1.4 and the archived Zotero Integration plugin; see [`docs/plugin-landscape-2026-09.md`](docs/plugin-landscape-2026-09.md) for what was adopted and what was deliberately left out. The 0.2.0 baseline below still describes the live-tested scope. It has been tested on Obsidian 1.13.7 with Zotero 9.0.6 / Better BibTeX 9.0.63 in two desktop vaults. Live checks cover index rebuilding, APA bibliography, text/image imports, preservation on repeat imports, renamed-note deep links, and cross-vault lookup. Group libraries, the interactive citation picker, and Hookmark hooks made from each copied link form still require manual acceptance in your own setup. Keep existing integrations until your workflow is verified.

## Scope

- Cite As You Write citation insertion through Better BibTeX (BBT).
- A versioned, machine-readable index that separates citekeys from canonical Zotero item, attachment, and annotation identities.
- Literature-note and annotation import using a standalone built-in CMDS template, with preview and preservation boundaries.
- Zotero/PDF/evidence links, diagnostics, paper-ingest integration, and opt-in peer-vault navigation.
- Copyable Markdown links for Hookmark (Zotero item, Obsidian file, rename-safe identity link) and an "Open link under cursor" command; no Hookmark bookmark creation, scripting, or frontmatter hook records.
- Inline `[@` citekey completion, a references sidebar with CSL bibliography for the active note, an annotations sidebar, citing-notes lookup, and batch update of owned notes, all served from the local index.

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

## Writing and reviewing with the sidebars

- **Citekey completion.** Type `[@` and part of a citekey, title, author, or year (use `_` for spaces). Enter inserts `[@citekey]`; Shift+Enter inserts `@citekey`; inside `[[` the wikilink form is completed. The suggester reads only the local index and triggers a background index load when none is cached. Set the trigger to "At sign" to also complete after a bare `@` at a word start, or "Off".
- **References sidebar** (`Open references sidebar`). Scans the active note for `[@key]`, `@key`, and `[[@key]]`, skipping frontmatter and code fences, and lists each source once with the bibliography text from BBT in the configured style. Unresolved and ambiguous keys are shown in red with the reason. Actions open the literature note, the Zotero item, or the PDF; the text jumps to the first citation; "Copy bibliography" copies the resolved list as plain text.
- **Annotations sidebar** (`Open annotations sidebar`, ribbon highlighter). Follows the active literature note through its `zoteroID` or citekey, or pins any indexed item. Each card shows the color, page label, text, comment, and tags. Actions open the annotation in Zotero's reader, insert it at the cursor as the same callout the import produces, copy its link, or copy its text. Image annotations are linked, not copied; use the import command for validated image copies.
- **Find notes citing a source** scans the vault for the current and previous citekeys of an item and opens the note at the first citation.
- **Update all owned literature notes** re-renders managed sections of every note owned by this plugin and reports updated, unchanged, and skipped notes. Edited generated sections, duplicate identities, and unowned notes are skipped rather than overwritten.
- **Open link under cursor** opens a `zotero://select` link in Zotero, routes a `zotero://open-pdf` link through the indexed attachment key to its parent item (page and annotation honoured, never guessed), and opens the item actions for `[@citekey]`, `@citekey`, or `[[@citekey]]`. Anything else shows a notice. A malformed Zotero URI is treated as nothing, not as the nearest match.
- **Find literature across vaults** lists every note for an item in this vault and in each registered peer vault as a normal `obsidian://open?vault=…&file=…` row (an `obsidian://advanced-uri?…&filepath=…` row when the peer vault's community plugin list includes Advanced URI), paper hubs and `@citekey` notes first. The plugin's own `obsidian://cmds-zotero` protocol is kept for the rename-safe identity link and agent transport only.

Imported notes use the CMDS callout layout: `[!Cite]`, `[!Abstract]`, an `[!md]` callout with inline Dataview fields (creators by role, journal, volume, issue, publisher, pages, DOI, ISBN, collections, related items as `[[@citekey]]`), `[!LINK]` with the Zotero select URI and `file://` attachment links, then `[!Highlight]`, `[!Image]`, and `[!Note]` annotation callouts. Highlight text is wrapped in `<mark class="cmds-zotero-hl-<color>">`; the color is the nearest Zotero palette hue. Highlights in the configured heading color (default gray) become `#####` headings for structural reading. Tags listed under "Excluded tags" (default `obscite`) are left out. Frontmatter includes `zotero_title`, `zotero_author`, `zotero_year`, `zotero_journal`, `zotero_doi`, `zotero_url`, and `zotero_tags` alongside the identity keys, and stays user-owned after creation.

## Hookmark

Hookmark support is **copy-only**. The plugin puts a Markdown link on the clipboard; Hookmark's own **Hook to Copied Link** does the rest. There is no bookmark creation, no AppleScript or `osascript`, no `hook://` records in frontmatter, and Hookmark is not required for any Zotero link. If hook/unhook automation is ever wanted it belongs in a separate sibling plugin, not here.

Three commands (also offered in the item actions modal) copy `[title](url)` **without** angle brackets around the URL, so Hookmark and clipboard scripts that split on `](` receive a clean absolute URL; whitespace and parentheses in a URL are percent-encoded instead. Notes and sidebars keep the bracketed `[title](<url>)` form.

| Command | Copies | Use it when |
| --- | --- | --- |
| Copy Zotero item link (Hookmark-compatible) | `zotero://select/library/items/KEY` | Hooking anything to the Zotero item. For the user library this is the same address Hookmark itself uses for Zotero items, so hooks made from either side land on one bookmark. |
| Copy Obsidian file link (Hookmark-native) | `obsidian://open?vault=…&file=…` | Hooking the literature note and seeing the hook in Hookmark's window while the note is open. It is the address Obsidian copies and Hookmark records through `hook-get-address`; it breaks when the note is renamed or moved. |
| Copy literature note identity link (rename-safe) | `obsidian://cmds-zotero?vault=…&libraryID=…&itemKey=…&target=note` | A link that must survive renames (resolved through `zoteroID`). It opens the note from Hookmark, but Hookmark keys hooks on the address its Obsidian integration returns, so a hook made with this link is **not listed** in Hookmark's window inside the note. |

What is verified from Hookmark's documentation and its recorded addresses: Hookmark → Zotero through the select URI; Hookmark → Obsidian through `obsidian://open` (native) or `obsidian://cmds-zotero` (the plugin's protocol handler; Obsidian must allow URI callbacks); Hook to Copied Link accepts the copied Markdown link. Not verified: group-library items and behaviour after a vault rename. If Hookmark's clipboard or AppleScript commands start timing out (Apple event error `-1712`), quit and relaunch Hookmark.

## Index and integration contract

The TypeScript contract in [`src/types.ts`](src/types.ts) is authoritative. Schema **2** has `generatedAt`, `source: "better-bibtex"`, `count`, `entries`, `capabilities`, `diagnostics`, and `complete`. Entries retain citation/display fields, but identity is `libraryType` + local `libraryID` + canonical `itemKey`; group URIs additionally need the real `groupID`. CSL `id` and citekeys are **not item keys**. Attachments have their own keys and verified `openURI`; annotation links carry attachment/annotation identity and 1-based PDF pages. Printed page labels are separate.

Resolution distinguishes **resolved**, **ambiguous**, **not-found**, and **unavailable**. Consumers must not silently choose the first candidate or treat offline as absence. Legacy indexes are identity-untrusted until rebuilt. Attachment enrichment failure is not evidence that an item has no PDF. Read local indexes as sensitive data, not as public source fixtures.

See [`src/ingest-api.ts`](src/ingest-api.ts) and [`scripts/ingest.mjs`](scripts/ingest.mjs) for the paper-ingest service and CLI contract. The plugin provides no independent HTTP listener. Consumers should use the CLI’s capability-aware offline fallback rather than infer success from firing an asynchronous UI command. Do not copy older string-based BBT item.search curl examples: BBT 9.0.64 was measured rejecting that shape; use the documented filtered RPC contract.

### Agent CLI (contract 2)

| Action | Purpose | Offline |
| --- | --- | --- |
| connection | Probe local BBT readiness and host state | Yes |
| info | Index age/counts/libraries/settings and privacy warnings; no refresh | Yes |
| refresh | Explicit index refresh, optionally `--if-older-than` | No |
| resolve | Citekey, item key/library, DOI, arXiv, title or query | Yes |
| identity | Proposed hub YAML/S01, bibliography, current/pending PIN state | Yes |
| cites | Body/frontmatter citation verdicts and References text | Yes |
| reconcile | Hub audit; five-key writes only with explicit `--apply` | Dry-run |
| diagnostics | Index, identity, citation and privacy diagnostics | Yes |
| pdf-text | Bundled pdf.js extraction into a private cache | No |
| locate | Quote locations from that cache, with verification state | Yes |

```sh
node scripts/ingest.mjs --vault "Research" --action connection
node scripts/ingest.mjs --vault "Research" --action refresh --if-older-than 60
node scripts/ingest-ro.mjs --vault "Research" --action identity --citekey example2024Graph --doi "10.1234/example"
node scripts/ingest-ro.mjs --vault "Research" --offline --vault-path /path/to/vault --action cites --path "20. Wiki/25. Questions" --recursive --strict
node scripts/ingest.mjs --vault "Research" --action pdf-text --citekey example2024Graph --pages "1-5"
node scripts/ingest-ro.mjs --vault "Research" --action locate --citekey example2024Graph --quote "An exact quotation from the source"
node scripts/ingest-ro.mjs --vault "Research" --action reconcile
```

All responses add `contract:2`, `apiVersions:[1,2]`, `ok`, `checkedAt`, and `connection`.
The four legacy actions retain payload `apiVersion:1`; the six new ones use 2.
Exit **0** includes usable not-found/ambiguous/dry-run reports; **1** means unavailable/refused/partial apply failure
or strict error diagnostics; **2** means invalid arguments. Structured failures are JSON on stdout plus a reason on stderr.
A timeout after submission has an uncertain outcome: never automatically repeat a write. Inspect with a read-only action.

Read-only actions no longer implicitly refresh or publish note maps. `ingest-ro.mjs` rejects mutations and cannot
route to an old live API that might write on read. Offline queries use the configured index (default
`80. References/zotero-index.json`); missing, invalid, incomplete or unknown-age evidence cannot prove absence.
A stale negative is withheld unless `--allow-stale`; that flag **never authorizes apply**.

**The non-owned-note write exception:** after inspecting a dry-run, explicit `reconcile --apply` may update only
`citekeyProvisional`, `zoteroID`, `zoteroSelectURI`, `zoteroStatus`, and `zoteroCheckedAt` on paper hubs.
It requires live BBT, a fresh complete index and the legacy plugin disabled. It preserves citekey, DOI, bodies and
Raw Sources, refuses malformed/conflicting identities and unsafe YAML, and reports concurrent changes and partial failures.
No whole-file CAS against external editors is promised. There is no automatic repair or rollback over concurrent edits.
`resolved` plus `citekeyProvisional:true` means registered but not pinned; manually pin `Citation Key: <vault-key>`
in Zotero Extra and explicitly refresh. Historical keys are not proof of a current PIN.

`pdf-text` reads local PDFs up to 64 MiB using the bundled public pdf.js API. The cache contains **full paper text**.
The plugin protects `.cmds-zotero/` with an internal `.gitignore`; also ignore the configured index in your repository.
Git diagnostics distinguish ignored from already tracked data. Untracking does not erase published history.
`locate` separates physical page position from printed page labels and uses attachment keys in PDF links.
Unverified/changed-source/fuzzy results are not confirmed quote evidence.

Install the copied agent skill with `node scripts/install-skill.mjs`; inspect options with `--help`.
The [portable reference](skills/cmds-zotero/references/cli-contract-v2.md) is generated from the canonical contract;
`node scripts/sync-contract.mjs --check` detects drift.

Imported notes use `zoteroID` to retain their paths after renaming or citekey changes. Initial YAML becomes user-owned; refreshed metadata lives in managed sections. Annotation image names include library scope and content hashes: changed source images create new versions without deleting older or user-modified assets. Existing notes without ownership markers are not automatically adopted. Change the output folder to import alongside them.

## Support boundaries and validation

| Area | Intended support | Acceptance boundary |
| --- | --- | --- |
| Personal-library metadata and canonical links | BBT-only identity resolution | Verify against your installed BBT version |
| Text/image annotations and repeat imports | Built-in CMDS template and plugin-owned sections | Test actual image availability, human edits, conflicts, and repeat imports |
| Group libraries | Explicit local library ID / group ID distinction | Synthetic/source validation is not live group-library validation |
| Peer vaults | Opt-in, read-only lookup and navigation | Test both indexes and renamed notes in your environment |
| Hookmark | Copy Zotero item, Obsidian file, and rename-safe identity links as bare Markdown links | Copy-only: Hookmark → Zotero and Hookmark → Obsidian are documented address forms; hook visibility inside a note depends on the link form (see Hookmark) |
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
node scripts/version-bump.mjs 0.4.0 # synchronizes package, lock, manifest, versions
node scripts/verify-release.mjs 0.4.0
```

Tests use synthetic fixtures. The sanitizer reports matching file/line/rule without printing secrets; it is a heuristic and does not replace manual staged-diff inspection or review of private repository links. CI uses `npm ci`, lint, typecheck, tests, and production build on Node 22. The prepared release workflow requires an exact stable semver tag **without `v`**, matching manifest/package/lock/versions; it builds three plugin assets and publishes their provenance bundle. **Pushing such a tag publishes a release: obtain approval first.** A prepared workflow does not imply a release, successful CI run, or community submission has occurred.

## Author and license

[Yohan Koo (CMDSPACE)](https://cmdspace.work). MIT; see [LICENSE](LICENSE).
