[![한국어](https://img.shields.io/badge/한국어-README.ko.md-blue)](README.ko.md)

# CMDS Zotero

Verified Zotero sources, citations, annotations, and literature notes for a local-first research vault. By CMDSPACE.

**Version 0.6.2 (2026-10-15).** Download `main.js`, `manifest.json` and `styles.css` from the [0.6.2 release](https://github.com/johnfkoo951/cmds-zotero/releases/tag/0.6.2) or install `johnfkoo951/cmds-zotero` with BRAT; it is not yet listed in Community Plugins. 0.6.2 adds a citation editor (Korean and accent-insensitive `[@` search, citation clusters, locators, named formats, citekey problem marks, hover cards, an optional author-date display, citation actions at the cursor and a renamed-citekey fix), bibliographies in Zotero's installed CSL styles and locales (per note with `csl`/`lang`), Check citations, a managed references section and a pandoc export kit. 0.6.1 added note layout settings (switchable parts, callout names, fields by item type, Zotero rich text, joined `+` highlights, annotation tags as Obsidian tags), Insert item content, an annotations sidebar with filters, follow modes, Fetch latest, card actions, search and drag, fielded search (`author:`, `col:`, `tag:` …) in pickers, Open/Import/Cite Zotero selection, a status-bar menu and a report-only Diagnose setup. 0.6.0 made refreshes, startup and batches faster and added the agent actions `annotations` and `citing`. See the [changelog](CHANGELOG.md). User guide: [docs/guide.md](docs/guide.md) · [web](https://apps.cmdspace.work/plugins/cmds-zotero/) · [한국어](docs/guide.ko.md). Zotero-side setup: [docs/zotero-side.md](docs/zotero-side.md). Verified with Obsidian 1.14.4, Zotero 10.0.6 and Better BibTeX 9.0.71 on macOS; group libraries and Windows/Linux are not live-tested.

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

**Files outside the vault.** Zotero attachment/annotation image paths may point outside the vault. Explicit imports may read local annotation images and copy them into the configured vault image folder. The agent `pdf-text` action reads attachment PDFs read-only from Zotero's storage folder. Peer-vault paths are optional user-provided settings and are used for read-only index/note discovery, including each peer vault's `community-plugins.json` to see whether it has Advanced URI; no peer-vault writes are intended. Indexes can contain local attachment paths and sensitive bibliographic metadata. Do not publish your index or `data.json`.

**Local processes.** For agent requests the plugin runs `git` read-only in the vault (`ls-files` and `check-ignore`, with optional locks off) to report whether the index and the private cache are tracked or ignored. It runs nothing else.

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

## From reading in Zotero to the literature note

1. Read and annotate PDFs in Zotero's reader as usual. Zotero 10 records the day each PDF was last opened.
2. Run **Send recently read papers to notes** (command palette or the open-book ribbon icon). The list shows the papers read in the last 30 days (7/30/90/365; setting *Recently read window*), newest first, with the state of each note: *No literature note yet*, *N new annotations not in the note*, *Note is up to date*, or a note that CMDS Zotero did not create (never overwritten).
3. Papers that need it are preselected; **Send** creates the note or refreshes its managed sections from Zotero's current data. Text you wrote — frontmatter, `## Synthesis`, `## Notes`, edited or detached blocks — is kept. The note button opens the result.

Zotero must be running for the list (it reads the reading history through Better BibTeX). **Import literature note** lists recently read papers first and also imports fresh data; with Zotero closed it falls back to the saved index and says so. Agents use the same path with `recent` and `import` (below).

## Writing and reviewing with the sidebars

- **Citekey completion.** Type `[@` and part of a citekey, title, author, or year (use `_` for spaces). Enter inserts `[@citekey]`; Shift+Enter inserts `@citekey`; inside `[[` the wikilink form is completed. The suggester reads only the local index and triggers a background index load when none is cached. Set the trigger to "At sign" to also complete after a bare `@` at a word start, or "Off".
- **References sidebar** (`Open references sidebar`). Scans the active note for `[@key]`, `@key`, and `[[@key]]`, skipping frontmatter and code fences, and lists each source once with the bibliography text from BBT in the configured style. Unresolved and ambiguous keys are shown in red with the reason. Actions open the literature note, the Zotero item, or the PDF; the text jumps to the first citation; "Copy bibliography" copies the resolved list as plain text.
- **Annotations sidebar** (`Open annotations sidebar`, ribbon highlighter). Follows the active literature note through its `zoteroID`, select URI, ZotLit key or `@citekey` basename, or pins any indexed item. Each card shows the color, page label, text, comment, and tags. Actions open the annotation in Zotero's reader, insert it at the cursor as the same callout the import produces, copy its link, or copy its text. Image annotations are linked, not copied; use the import command for validated image copies.
- **Find notes citing a source** scans the vault for the current and previous citekeys of an item and opens the note at the first citation.
- **Update all owned literature notes** re-renders managed sections of every marker-carrying note in the output folder and reports updated, partial (edited sections preserved), unchanged, skipped, and linked-but-not-owned notes. An edited generated section is kept as it is while the other sections of that note are refreshed; duplicate identities, malformed markers and unowned notes are skipped rather than overwritten.
- **Offline bibliography** (0.5). Bibliography text is served memory → `.cmds-zotero/bibliography.json` → BBT. The sidecar is written after each successful BBT rendering (keyed by style, entry, content hash and Better BibTeX version; 4 MB bound; no setting) and answers with Zotero closed: sidebar rows then carry a `cached <date>` tag, rows without any text an `offline: author-year fallback` tag, "Copy bibliography" reports `Copied N entries (M from cache, K fallback; Zotero offline).`, and the sidebar probes BBT once (2.5 s) per render instead of one request per row. Import and batch update never write a placeholder: an owned note keeps its `citation` section byte-identical until Zotero answers again, and the first import of an item needs Zotero running.
- **Open link under cursor** opens a `zotero://select` link in Zotero, routes a `zotero://open-pdf` link through the index to its item (attachment key first, then a parent item key as Zotero itself accepts; page and annotation honoured, never guessed across libraries), and opens the item actions for `[@citekey]`, `@citekey`, or `[[@citekey]]` (alias and heading suffixes ignored). A bare link followed by sentence punctuation still counts. Anything else shows a notice. A malformed Zotero URI, selected or not, is treated as nothing, not as the nearest match.
- **Find literature across vaults** lists every note for an item in this vault and in each registered peer vault as a normal `obsidian://open?vault=…&file=…` row (an `obsidian://advanced-uri?…&filepath=…` row when the peer vault's community plugin list includes Advanced URI; read from `<peer>/<this vault's configuration folder>/community-plugins.json`, so a peer using a different configuration folder name falls back to `obsidian://open`), paper hubs and `@citekey` notes first. The plugin's own `obsidian://cmds-zotero` protocol is kept for the rename-safe identity link and agent transport only.

Imported notes use the CMDS callout layout: `[!Cite]`, `[!Abstract]`, an `[!md]` callout with inline Dataview fields (creators by role, journal, volume, issue, publisher, pages, DOI, ISBN, collections, related items as `[[@citekey]]`), `[!LINK]` with the Zotero select URI and `file://` attachment links, then `[!Highlight]`, `[!Image]`, and `[!Note]` annotation callouts. Highlight text is wrapped in `<mark class="cmds-zotero-hl-<color>">`; the color is the nearest Zotero palette hue. Highlights in the configured heading color (default gray) become `#####` headings for structural reading. Tags listed under "Excluded tags" (default `obscite`) are left out. Frontmatter includes `zotero_title`, `zotero_author`, `zotero_year`, `zotero_journal`, `zotero_doi`, `zotero_url`, and `zotero_tags` alongside the identity keys, and stays user-owned after creation.

### Bibliography for pandoc

Pandoc's citeproc needs a bibliography file for the `[@citekey]` citations; the plugin produces it from Better BibTeX (one read-only `item.export` per Zotero library) and never edits the note. **Write pandoc bibliography sidecar for current note** writes `.cmds-zotero/bibliography/<note>.json` (CSL-JSON, `abstract`/`note` stripped, plugin-owned and gitignored) and shows the `bibliography:` YAML line to add; **Copy CSL-JSON for cited sources** and the References sidebar's "Copy CSL-JSON" button put the same array on the clipboard. Agents use `cites --bibliography --format csl-json|bibtex|biblatex [--out]`. A note's References section is recognised under `References`, `Bibliography`, `Works Cited`, `참고 문헌`, `참고 자료` (Settings → Bibliography → References headings). The DOCX recipe — obsidian-pandoc settings, `csl:`/`link-citations:`/`lang: ko-KR`, the shell command and `.gitignore` lines — is in [`docs/pandoc-docx.md`](docs/pandoc-docx.md).

## Hookmark

Hookmark support is **copy-only**. The plugin puts a Markdown link on the clipboard; Hookmark's own **Hook to Copied Link** does the rest. There is no bookmark creation, no AppleScript or `osascript`, no `hook://` records in frontmatter, and Hookmark is not required for any Zotero link. If hook/unhook automation is ever wanted it belongs in a separate sibling plugin, not here.

Three commands (also offered in the item actions modal) copy `[title](url)` **without** angle brackets around the URL, so Hookmark and clipboard scripts that split on `](` receive a clean absolute URL; whitespace and parentheses in a URL are percent-encoded instead. Notes and sidebars keep the bracketed `[title](<url>)` form.

| Command | Copies | Use it when |
| --- | --- | --- |
| Copy Zotero item link (Hookmark-compatible) | `zotero://select/library/items/KEY` | Hooking anything to the Zotero item. For the user library this is the same address Hookmark itself uses for Zotero items, so hooks made from either side land on one bookmark. |
| Copy Obsidian file link (Hookmark-native) | `obsidian://open?vault=…&file=…` | Hooking the literature note and seeing the hook in Hookmark's window while the note is open. It is the address Obsidian's Copy Obsidian URL produces; Hookmark records the same `obsidian://open?vault=&file=` form for notes (path-encoding parity with Hook to Copied Link not yet checked). It breaks when the note is renamed or moved. |
| Copy literature note identity link (rename-safe) | `obsidian://cmds-zotero?vault=…&libraryID=…&itemKey=…&target=note` | A link that must survive renames (resolved through `zoteroID`). It opens the note from Hookmark, but Hookmark keys hooks on the address its Obsidian integration returns, so a hook made with this link is **not listed** in Hookmark's window inside the note. |

What is verified from Hookmark's documentation and its recorded addresses: Hookmark → Zotero through the select URI; Hookmark → Obsidian through `obsidian://open` (native; Hookmark captures this address from the open note through its own `obsidian://hook-get-address` integration, which needs Obsidian to accept URI callbacks) or `obsidian://cmds-zotero` (the plugin's protocol handler); Hook to Copied Link accepts the copied Markdown link. Not verified: byte-level path-encoding parity between the copied file link and the address Hookmark records for the same note (a hook made from the copied link opens the note either way; only whether it coincides with Hookmark's own bookmark is unchecked), group-library items, and behaviour after a vault rename. If Hookmark's clipboard or AppleScript commands start timing out (Apple event error `-1712`), quit and relaunch Hookmark.

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
| resolve | Citekey, item key/library, DOI, arXiv, title or query; `--stdin` for up to 500 NDJSON lookups (0.6) | Yes |
| identity | Proposed hub YAML/S01, bibliography, current/pending PIN state | Yes |
| cites | Body/frontmatter citation verdicts and References text; `--format csl-json|bibtex|biblatex` and `--out` sidecar (0.5) | Yes (structured formats and `--out` live only) |
| reconcile | Hub audit; five-key writes only with explicit `--apply`, patched line by line (0.6) | Dry-run |
| diagnostics | Index, identity, citation and privacy diagnostics; `--env` adds setup checks (0.6.1) | Yes |
| pdf-text | Bundled pdf.js extraction into a private cache | No |
| locate | Quote locations from that cache, with verification state | Yes |
| recent | Papers recently read in Zotero with each literature note's state (0.5) | No |
| import | Create or update the plugin-owned literature note from fresh Zotero data; dry run unless `--apply` (0.5) | No |
| annotations | A paper's annotations by attachment in reading order, with color/type/tag/attachment filters; `--fresh` reads Zotero now, `--today` picks the paper opened today (0.6) | Yes (`--fresh`, `--today` live only) |
| citing | Notes citing a paper under its current or former citekeys, with positions and excerpts (0.6) | Yes |

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
Suggested main-vault `.gitignore` lines: `/.cmds-zotero/`, `/.cmds-zotero/bibliography.json` (rendered bibliography text; harmless but noisy), and the configured index path.
Git diagnostics distinguish ignored from already tracked data. Untracking does not erase published history.
`locate` separates physical page position from printed page labels and uses attachment keys in PDF links.
Unverified/changed-source/fuzzy results are not confirmed quote evidence.

Install the copied agent skill with `node scripts/install-skill.mjs`; inspect options with `--help`.
The [portable reference](skills/cmds-zotero/references/cli-contract-v2.md) is generated from the canonical contract;
`node scripts/sync-contract.mjs --check` detects drift.

Imported notes use `zoteroID` to retain their paths after renaming or citekey changes. Initial YAML becomes user-owned; refreshed metadata lives in managed sections. Annotation image names include library scope and content hashes: changed source images create new versions without deleting older or user-modified assets. Existing notes without ownership markers are not automatically adopted. Change the output folder to import alongside them.

**Preservation and conflict resolution (0.5).** Every generated section sits between `<!-- cmds-zotero:<id>:<hash> -->` and `<!-- /cmds-zotero:<id> -->`. A section you edited is a *soft* conflict: the preview lists it as "edited (preserved)", the block is kept verbatim, and the rest of the note is still updated; it no longer blocks the note. Per section you can choose **Detach** (the marker becomes `<!-- cmds-zotero:<id>:detached -->`: the block is yours, never re-rendered, never reported as edited or missing, and left alone even if the annotation disappears from Zotero) or **Reset** (the block is replaced by the fresh render; the previous note text is first copied to `.cmds-zotero/backups/notes/<basename>-<timestamp>.md` inside the plugin's gitignored private folder). Detaching is final by design: there is no command that re-owns a detached block; Reset is the only way back. Text pasted on the opening-marker line is moved below the block on the next update, and trailing whitespace before a closing marker is tolerated. Missing, duplicate or damaged markers remain *hard* conflicts, reported per section with the line number ("Malformed managed markers for `<id>` (line N)"), and the note is not written until you repair them.

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
npm run build:core                  # after changing a module bundled into the offline CLI
npm test
npm run build
node scripts/sanitize.mjs           # tracked working-tree files
node scripts/sanitize.mjs --staged  # staged additions/changes, reads index bytes
node scripts/version-bump.mjs 0.6.1 # synchronizes package, lock, manifest, versions
node scripts/verify-release.mjs 0.6.1
```

Tests use synthetic fixtures. The sanitizer reports matching file/line/rule without printing secrets; it is a heuristic and does not replace manual staged-diff inspection or review of private repository links. CI uses `npm ci`, lint, typecheck, tests, and production build on Node 22. The prepared release workflow requires an exact stable semver tag **without `v`**, matching manifest/package/lock/versions; it builds three plugin assets and publishes their provenance bundle. **Pushing such a tag publishes a release: obtain approval first.** A prepared workflow does not imply a release, successful CI run, or community submission has occurred.

## Author and license

[Yohan Koo (CMDSPACE)](https://cmdspace.work). MIT; see [LICENSE](LICENSE).
