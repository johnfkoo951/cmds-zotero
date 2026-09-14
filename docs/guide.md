# CMDS Zotero development user guide
Connect verified Zotero identities, citations, annotations and literature notes to a research vault, while keeping Zotero read-only and preserving human-written notes.

## Development status: read this first
**0.3.0 is a development version, not a published plugin release.** On **2026-09-14**, the public repository had no GitHub releases and no entry in Obsidian's Community Plugins registry. The local root manifest is 0.3.0. Separate 0.4 development is not part of this manual or an installation promise.
The earlier 0.2 baseline records local testing with Obsidian 1.13.7, Zotero 9.0.6 and Better BibTeX 9.0.63: index rebuilds, APA bibliography, text/image import, repeat-import preservation, renamed-note links and cross-vault lookup. These are historical baseline checks, **not fresh acceptance of every 0.3 feature**. Live group-library behavior, interactive citation-picker acceptance and Hookmark receiving/round trips still need manual testing.
Use a backed-up test vault. Keep existing Zotero integrations installed until your own workflow is verified. This is not full ZotLit/Zotero Integration compatibility and does not accept their Nunjucks templates as a drop-in API.

## Requirements and terminology
- **Obsidian desktop 1.7.2+**. Mobile is not supported.
- Running [Zotero](https://www.zotero.org/) and [Better BibTeX](https://retorque.re/zotero-better-bibtex/). BBT is the Zotero add-on that exposes the local citation/metadata facilities this plugin uses.
- A local endpoint, default `http://127.0.0.1:23119/better-bibtex`. No Zotero Web API key, native Local API preference change, SQLite access, or external PDF utility is required by this implementation.
- A source item and local PDF with one harmless text annotation for first testing. Annotation-image import additionally needs a readable source image file.
- **Node.js 22** for building/maintenance scripts, not as a separate requirement for an installed plugin. Plugin code is MIT; Zotero storage services and optional commercial Hookmark software have their own terms.
A **citekey** is a citation label such as `Example2026`. It is not a stable item identity. Canonical identity combines library type, local library ID and Zotero item key. Attachments and annotations have their own identities; a parent item is not a PDF.

## Build and install for a local test
There is no released asset set to download yet. For developers/testers, clone the public repository into a development directory and build the root source:
```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```
Copy only `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/cmds-zotero/`. Reload Obsidian and enable **CMDS Zotero** manually. Never copy another machine's settings or private indexes. The commands above are instructions, not a claim they were executed during this documentation pass.
If migrating from `cmds-link-zotero`, use the dedicated migration appendix below instead of overwriting a live install. Do not enable both plugin IDs.

## First success: connect, index, import one source
1. Start Zotero with Better BibTeX enabled.
2. Open **Settings → CMDS Zotero** and inspect **Server endpoint**, **Output folder**, **Image folder**, and **Index path**. Paths for output/index are relative to the current vault, not arbitrary absolute paths.
3. Click **Save configuration** first. Edits remain a draft until saved. **Test connection → Test** tests the saved configuration, not unsaved text.
4. Run **Refresh citekey index** from Ctrl/Cmd+P. This makes a full discovery/export scan and bounded attachment requests; it is not a server-side incremental cursor.
5. Run **Diagnose index and links**. Resolve unavailable or ambiguous identities before relying on links.
6. Run **Search literature** or **Import literature note**, choose the sample source, and inspect the **Literature import preview**, destination path and conflict report.
7. Click **Apply import** only when the preview is correct. A conflict disables that action. The plugin creates a new note or updates its own managed sections, not arbitrary existing prose.
8. Open the imported note, follow its Zotero/PDF link, and check the text annotation against Zotero.
9. Write a sentence in your own section outside generated markers, import again, and verify it remains. Do this before a batch update.
Success means the intended source identity, PDF/annotation link and preservation behavior all match. A connection success alone is not proof that a particular attachment exists.

## Citation and sidebar workflow
### Cite while writing
Run **Insert citation from Zotero** in an editor to open Better BibTeX's interactive Cite As You Write picker (CAYW). The default `pandoc` format inserts `[@citekey]`. This picker path still needs environment-specific acceptance.
The 0.3 source also implements local completion: type `[@` and an ASCII citekey/title/author/year fragment; `_` can stand for spaces. The current trigger accepts up to 80 letters/numbers or `_ : . + / -`, not Korean characters. Enter completes `[@citekey]`; inside existing brackets Shift+Enter also retains the bracket structure. Bare `@citekey` insertion with Shift+Enter applies outside brackets when the non-default bare-at trigger is configured. Wikilink completion keeps its existing structure. Suggestions read the cached index, not a BBT request for every keystroke. Warm-up/refresh can still happen in the background.
The data model supports `bracket`, `at`, and `off` triggers, but **there is no “Writing → Citekey completion” settings control in the inspected 0.3 UI**. Older README/changelog wording naming such a control is not an installation instruction. Use the default bracket trigger for beginner testing.
### References sidebar
**Open references sidebar** lists sources cited in the active note using `[@key]`, bare `@key`, or citation wikilinks. It skips frontmatter and fenced code, deduplicates sources, shows bibliography text in the chosen CSL style and identifies unresolved/ambiguous keys. Actions open the note, Zotero item or PDF; selecting the citation text navigates to its first occurrence. Copy bibliography produces plain text, not a live citation field in Word.
### Annotations sidebar
**Open annotations sidebar** (also the highlighter ribbon) follows an identified literature note or a pinned indexed item. Cards show color, page label, text, comment and tags. Open in Zotero, insert at the cursor, copy link or copy text. Image cards can link an image without copying its bytes: use explicit import for validated vault copies. It does not continuously follow Zotero's live reader position.
### Find citations and update notes
**Find notes citing a source** scans notes for current and previous citekeys. **Update all owned literature notes** immediately loops over owned notes using the preservation engine, reports updated/unchanged/skipped results, and skips conflicts. It does **not** open an approval preview for every item. Back up and test single-note re-import before invoking this batch command.

## Complete command reference

| Exact command | Purpose / boundary |
|---|---|
| Insert citation from Zotero | Interactive CAYW insertion into the active editor |
| Refresh citekey index | Full index refresh from local BBT |
| Search literature | Pick an indexed source and open its actions |
| Open source PDF at page | Resolve a source and choose PDF page position, starting at 1 |
| Import literature note | Preview a single preservation-aware import |
| Update all owned literature notes | Batch-update owned managed sections; no per-note confirmation |
| Insert bibliography | Insert one selected source's CSL bibliography into the editor |
| Open references sidebar | Review citations in the active note |
| Open annotations sidebar | Review/insert annotations for an identified or pinned source |
| Find notes citing a source | Find occurrences of current and previous citekeys |
| Copy Hookmark-compatible link | Copy a validated Zotero Markdown link; does not create a Hookmark bookmark |
| Copy stable literature note link | Copy an identity-based note navigation link |
| Diagnose index and links | Inspect connection/index/identity diagnostics |
| Find literature across vaults | Read opt-in peer maps and navigate to matches |

PDF page numbers are **1-based file positions**, not printed page labels (a page labeled “12” may be file page 18). Group links need a real group ID distinct from the local library ID. Missing/ambiguous sources must not silently resolve to the first match.

## Actual settings in 0.3.0
Click **Save configuration** after edits. Testing or refreshing before saving still uses saved values. Configuration changes are blocked while the ingest service is busy refreshing.

| Visible control | Default / range / meaning |
|---|---|
| Server endpoint | `http://127.0.0.1:23119/better-bibtex`; localhost HTTP(S) only, no credentials/query/fragment |
| Test connection | Saved endpoint test, without the citation picker |
| Request timeout | 20 seconds; 1–180 |
| Attachment timeout | 60 seconds; 1–180 |
| Index path | `80. References/zotero-index.json`; vault-relative |
| Maximum index age | 60 minutes; 1–10080; stale queries may refresh a full snapshot |
| Parallel requests | 2; 1–8 attachment-request concurrency |
| Refresh saved index | Run refresh using saved configuration |
| Output folder | `References/Zotero`; new literature notes |
| Image folder | `References/Zotero/images`; explicitly imported annotation images |
| Bibliography style | `apa`; a CSL style installed in Zotero |
| Citation format | `pandoc`; CAYW format |
| Peer vaults | Empty by default; one line `Vault name` plus a pipe plus its absolute folder path |
| Save configuration | Validate and save the draft settings |

The schema also contains `citationTrigger`, `excludedTags` (default `obscite`), `headingHighlightColor` (default gray), and `referencesFollowActiveNote` (true). **These are data-model settings without matching controls in the current settings tab.** Do not search for invented “Excluded tags” or heading-color UI. Manual settings-file modification is not required for first use and is not part of this beginner workflow.

## Imported note structure and preservation
The built-in template uses Cite/Abstract/metadata/Link callouts and Highlight/Image/Note annotation callouts, with inline fields suitable for Dataview when that separate plugin is installed. Highlight classes choose the nearest Zotero palette color; the default gray heading color becomes a fifth-level heading. Excluded tags are omitted according to the data model.
Initial frontmatter includes source metadata (`zotero_title`, `zotero_author`, `zotero_year`, journal, DOI, URL and tags) alongside identity keys. **After creation the frontmatter is user-owned**; fresh metadata goes in managed body sections. `zoteroID` helps preserve note location after renaming or citekey changes.
Owned section IDs include `overview`, `citation`, `metadata`, `notes`, and per-annotation identifiers. Do not remove/edit ownership markers as a formatting cleanup. Manual changes to a generated region cause conflict detection; move your analysis to an unowned section rather than forcing an overwrite.
Existing unowned notes are not automatically adopted. Choose a separate output folder to import alongside them. Imported image names include library identity and content hashes; a changed source image creates a new version rather than deleting older or user-modified assets.

## Cross-vault and Hookmark use
Peer-vault access is opt-in and read-only: enter named absolute vault paths, publish/refresh the relevant index/maps in each vault, and use **Find literature across vaults**. A different vault with the same citekey is not automatically the same source; resolve canonical identity.
Copyable Hookmark-compatible links are Markdown links only. The plugin does not change Hookmark settings, script it, create bookmarks, or require it for ordinary Zotero navigation. Test the receiving application separately before assuming round-trip compatibility. Renamed-note deep links rely on the correct installed plugin and identity maps.

## Data and privacy
Requests go to the local BBT endpoint for metadata, citation selection, bibliography, attachments and annotations. Endpoint validation limits it to local HTTP(S). Zotero remains **read-only**: no preference/database edits, citation-key pinning or library record changes.
Explicit image imports may read attachment/annotation image paths **outside the vault** and copy them into the image folder. Peer-vault discovery reads other local vault maps when configured. Settings, indexes, maps and reports can contain private paths, bibliographic metadata, annotation text and source identities; do not publish them.
The runtime writes current-vault settings, indexes, requested notes and imported images. There is no telemetry, plugin-owned HTTP listener, self-updater or built-in paid service. Opening a deliberate website or external-app link delegates to that app and its policies. Local-first does not make later Share/AI publication automatically safe.

## Troubleshooting and acceptance checklist

| Symptom | Check next |
|---|---|
| Test uses old endpoint | Save configuration first, then Test |
| Connection fails | Zotero running, BBT installed/enabled, valid localhost endpoint and request timeout |
| Index refresh fails or is partial | Read diagnostics; preserve last usable snapshot, do not treat failure as an empty library |
| No completion results | Use `[@`, refresh/warm the index, check known title/citekey; do not look for a nonexistent UI toggle |
| Wrong/ambiguous citekey | Resolve canonical identity; duplicate keys are not safe first-match selections |
| PDF opens on wrong page | Use file page position, not printed label; verify attachment identity |
| Missing annotation image | Confirm source image file exists and is readable; try explicit import rather than sidebar insertion |
| Import blocked | Inspect manual edits, ownership, duplicate identity and destination conflicts; keep the original |
| Group-library link fails | Check real group ID versus local library ID; live group support remains unverified |
| Peer note missing | Confirm opt-in path, maps refreshed in both vaults, canonical identity and actual note location |

Before relying on the plugin test: offline/partial index retention, missing attachment, duplicate citekeys, import → handwritten section → re-import, missing image, PDF/annotation navigation, note rename, peer navigation and rollback. A successful bulk run is not a substitute for these small checks.

## Migration from the old plugin ID
Quit Obsidian and pause vault-sync writers before using `scripts/migrate-local.mjs`. It does not stop running plugins for you. `dry-run` and `check` are read-only; `apply` writes files and registries and needs the exact fingerprint from check. Inspect that plan and use a **new private backup directory outside both vault and repository**, with an existing parent.
```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode dry-run
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode check
```
Only after reviewing the result:
```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode apply --expect CHECK_FINGERPRINT
```
The helper snapshots both installs/registries, installs the three assets, maps existing old-ID enablement/hotkeys, and preserves the old installation. It copies old settings only when the new file is absent; differing settings or conflicting hotkeys stop for resolution. It does not enable a previously disabled integration, disable unrelated plugins, or repair old index identities. Rebuild the index afterward.
Rollback is explicit:
```sh
node scripts/migrate-local.mjs --vault /path/to/vault --backup /path/to/private-backups/migration-001 --mode rollback
```
Rollback refuses changed deployed files/settings rather than overwriting later work. Keep the backup and resolve conflicts manually. After restarting Obsidian, ensure only the intended new ID is enabled and verify settings, index and one source before regular work. No migration was executed while preparing this guide.

## Integration and development reference
[Source types](https://github.com/johnfkoo951/cmds-zotero/blob/main/src/types.ts) define schema 2 with generated time, count, entries, capabilities, diagnostics and completeness. Resolution distinguishes `resolved`, `ambiguous`, `not-found`, and `unavailable`. Legacy indexes remain identity-untrusted until rebuilt.
The [ingest API](https://github.com/johnfkoo951/cmds-zotero/blob/main/src/ingest-api.ts) and [CLI](https://github.com/johnfkoo951/cmds-zotero/blob/main/scripts/ingest.mjs) provide a bounded job/result contract without an independent HTTP listener. Consumers should keep direct-BBT/offline fallbacks rather than assume a UI command returned completed data.
```sh
node scripts/ingest.mjs --vault "Research" --action connection
node scripts/ingest.mjs --vault "Research" --action refresh
node scripts/ingest.mjs --vault "Research" --action resolve --citekey Example2026
node scripts/ingest.mjs --vault "Research" --action diagnostics
```
These examples use a fictional vault/key. CLI integration requires Obsidian and its intended command/API path to be available; it is not a remote SaaS endpoint.
Development checks are lint, typecheck, tests and build. Release automation being present does not mean a release was published. Exact semver tags without `v` trigger the release workflow; do not push release tags as a documentation or local-test step.

## Updates, support, and license
[Web manual](https://apps.cmdspace.work/plugins/cmds-zotero/) | [Repository](https://github.com/johnfkoo951/cmds-zotero) | [Issues](https://github.com/johnfkoo951/cmds-zotero/issues) | [Changelog](https://github.com/johnfkoo951/cmds-zotero/blob/main/CHANGELOG.md).
Use source/release notes appropriate to the version you actually run. For a report include plugin/Obsidian/Zotero/BBT versions, OS, sanitized diagnostics and synthetic records. Never attach actual indexes, personal attachment paths, private annotation exports or settings. Keep existing integrations until the replacement is validated.
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. MIT; [LICENSE](https://github.com/johnfkoo951/cmds-zotero/blob/main/LICENSE).
This manual checked root 0.3 source (`main.ts`, `settings.ts`, `settings-data.ts`, `types.ts`, `modals.ts`) and public distribution state. It did not run new imports, migrations, group tests, Hookmark tests or separate 0.4 work. No current screenshot is claimed or fabricated.
