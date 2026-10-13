---
name: cmds-zotero
description: Agent CLI for CMDS Zotero (contract 2). List papers recently read in Zotero and send them to their literature (metadata) notes; resolve papers by citekey, DOI, arXiv or title; produce hub identity and S01 text; validate citations and generate References; extract PDF text and locate quotes; reconcile provisional citekeys. Use for "최근 읽은 논문", "문헌노트로 보내기", paper ingest, Zotero identity, DOI lookup, page locators, quote pages, References 생성, or provisional citekey diagnostics. NOT for editing Zotero items or driving ZotLit UI.
---

# CMDS Zotero agent CLI

Use the versioned service, not hand-written BBT curl or asynchronous UI commands.
Zotero is always read-only. Returned YAML/Markdown is a proposal, not evidence that notes were updated.

## Commands

```sh
node ${CMDS_ZOTERO_ROOT}/scripts/ingest.mjs --vault "Research" --action info
node ${CMDS_ZOTERO_ROOT}/scripts/ingest-ro.mjs --vault "Research" --action resolve --doi "10.1234/example"
```

The installer replaces `${CMDS_ZOTERO_ROOT}` with the repository path and copies the skill; it never symlinks it.
Use `ingest-ro.mjs` for read-only contexts such as query. It rejects refresh, extraction and apply.
Every call needs `--vault`. `--vault-path` is an optional absolute path for offline discovery.
Run `--help` for the complete action-specific flag list.

| Need | Action | Example flags |
| --- | --- | --- |
| Papers recently read in Zotero (0.5) | recent | optional `--days 30` (1–365); each item says whether its literature note is missing (`none`), behind Zotero (`behind`, N new annotations) or current |
| Create or update a literature note (0.5) | import | `--citekey KEY` or `--item-key KEY --library ID`; dry run by default, `--apply` writes the plugin-owned note; `--allow-stale` only when Zotero is closed and the saved index is acceptable |
| Inspect index age/counts/libraries/settings | info | none; never refreshes |
| Probe Obsidian/plugin/BBT | connection | optionally `--offline` |
| Explicitly refresh | refresh | optionally `--if-older-than 60` |
| Resolve identity | resolve | one of `--citekey`, `--item-key ... --library ...`, `--doi`, `--arxiv`, `--title`, `--query` |
| Propose hub YAML and S01 | identity | selectors as above; optionally vault `--citekey` plus one other selector, `--raw-source`, `--no-bibliography`, `--style` |
| Validate body/frontmatter citations | cites | `--path "20. Wiki/25. Questions" --recursive --bibliography`; optional `--strict` |
| Pandoc-ready bibliography (0.5) | cites | `--path "Drafts/manuscript.md" --bibliography --format csl-json` (or `bibtex`/`biblatex`; `text`/`markdown` keep the References block); `--out` writes `.cmds-zotero/bibliography/<slug>.json` (live only, `ingest-ro` refuses it), `--out "Drafts/refs.bib"` a guarded path, `--force` replaces an unmarked non-note file |
| Audit hubs | reconcile | default dry-run; optional `--folders "40. Paper Analyses"`, `--strict` |
| Apply reviewed hub identity fields | reconcile | `--apply`; explicit authorization required |
| Extract PDF text | pdf-text | `--citekey KEY` or `--item-key KEY --library ID` or `--file "80. References/Attachments/example.pdf"`; optional `--attachment`, `--pages "1-5,9"`, `--force` |
| Find exact quote pages | locate | `--citekey KEY --quote "quoted text"`, or `--path "40. Paper Analyses/example2024Graph/Atom.md"`; optional explicit PDF target |
| Combined diagnostics | diagnostics | optional `--allow-stale` |

`--year` and `--author` narrow title/query selectors. Query/prefix matches rank candidates; they do not resolve by themselves.
`--refresh` is explicit and live-only on resolve/identity. `--pages` selects text to inline, not a partial-source cache.
PDF extraction is live-only even with `--file`; offline locate reads an existing cache.
Structured bibliography formats and `--out` are live-only (offline answers `referencesReason: offline`, `content: null`).
The References section of a note is any `##`–`######` heading titled per the plugin's `referencesHeadings` setting
(default `References`, `Bibliography`, `Works Cited`, `참고 문헌`, `참고 자료`); `referencesSection.heading` reports it and
`--format markdown` reuses it. See `docs/pandoc-docx.md` in the repository for the DOCX recipe.

## Recently read papers to literature notes (0.5)

1. `recent --days 30` (Zotero must be running) lists what the user read, newest first, with `note.state`.
2. For each item with `note.needsImport`, run `import --citekey KEY` (dry run), check `preview` and `ok`, then
   `import --citekey KEY --apply`. Never hand-write or rewrite a literature note: the managed sections carry integrity
   hashes, and hard conflicts (`reason: note-conflict`) mean a human must look first.
3. To read the paper, run `pdf-text --citekey KEY`. If `textLayer.ocrRecommended` is true the PDF is scanned: run OCR
   with another tool and say so; never present empty extraction as the paper's content.
4. Write your own synthesis only in user-owned regions of the note: the `## Synthesis` callout (`**Contribution**::`,
   `**Related**::`), `## Notes`, or text outside `<!-- cmds-zotero:... -->` blocks. Cite quotes with `locate` so page
   links are verified. A later `import --apply` keeps all of that text.

## Response and exit interpretation

Every structured response has `contract:2`, `apiVersions:[1,2]`, `apiVersion`, `action`, `vault`, `ok`,
`checkedAt`, and `connection`. The four legacy actions connection/refresh/resolve/diagnostics retain payload API 1.
New actions use API 2. Connection includes live/offline mode; Obsidian `ok|unavailable`; plugin status/version;
BBT `reachable:true|false|null`; index generation/age/completeness; legacy-plugin state; Git coverage.

- Exit **0**: usable result, including `status:not-found` or `ambiguous`, dry-run, and reports.
- Exit **1**: unavailable/invalid execution, apply refusal/partial failure, or strict error diagnostics.
- Exit **2**: arguments invalid; stderr only, no result JSON.
- Structured failures have `ok:false`, `reason` and `message` on stdout plus a reason line on stderr.
- Never choose the first ambiguous candidate. Never interpret connectivity failure as absence.
- Missing/invalid/incomplete/unknown-age indexes cannot prove absence. Stale negative answers are withheld as
  `reason: stale-index` (`indexAnswer` keeps the raw verdict); `--allow-stale` opts into stale lookup evidence,
  not writes or fabricated completeness.
- Unrelated unparseable notes never withhold a Zotero-index verdict: `not-found` and `citekeyProvisional:true` are
  returned beside them, with the omissions in `scan {skipped, truncated}` and `vaultNotes.warnings`. A truncated scan
  is `reason: discovery-incomplete` (hubs/raw sources may be missing, the index `status` stands); `--allow-stale`
  does not address it — repair or exclude the listed notes. In `cites`, `unchecked` carries `uncheckedReason`
  `stale-index` or `discovery-incomplete`; hub-only evidence is attached regardless.
- Timeouts and lost job results can have unknown outcomes. Do not automatically repeat a mutation;
  run read-only reconcile to inspect current state first.

## Hub identity vocabulary

| Key | Meaning |
| --- | --- |
| citekey | Requested/existing vault key, not automatically replaced by the BBT key; absent if none requested |
| doi | Case-preserved normalized DOI, or empty string if absent |
| citekeyProvisional | False only with unambiguous identity and exact CURRENT key equality |
| zoteroID | String `libraryID:itemKey`, for example `1:AAAA2345` |
| zoteroSelectURI | Parent-item selection URI |
| zoteroStatus | resolved, not-found, unavailable or ambiguous |
| zoteroCheckedAt | UTC ISO timestamp |

Example fragment for an item registered under the requested current key (synthetic, not a full response):

```yaml
citekey: "example2024Graph"
citekeyProvisional: false
doi: "10.1234/example"
zoteroID: "1:AAAA2345"
zoteroSelectURI: "zotero://select/library/items/AAAA2345"
zoteroStatus: "resolved"
zoteroCheckedAt: "2026-09-14T10:30:00.000Z"
```

Registered-but-unpinned is `resolved` plus `citekeyProvisional:true`.
History can resolve an item but is not proof of a current PIN.
To pin manually, add **`Citation Key: example2024Graph`** to the item's Zotero Extra field,
explicitly refresh the index, then verify identity again. Never rename vault files to match a BBT default key.
The plugin cannot pin items in Zotero.

## Offline use

```sh
node ${CMDS_ZOTERO_ROOT}/scripts/ingest-ro.mjs --vault "Research" --vault-path /path/to/vault --offline --action identity --citekey example2024Graph --doi "10.1234/example"
node ${CMDS_ZOTERO_ROOT}/scripts/ingest-ro.mjs --vault "Research" --offline --action cites --path "20. Wiki/25. Questions" --recursive
node ${CMDS_ZOTERO_ROOT}/scripts/ingest-ro.mjs --vault "Research" --offline --action locate --citekey example2024Graph --quote "An exact quotation from the source"
```

Without `--vault-path`, the CLI resolves the name from the desktop Obsidian vault registry; duplicate names require an explicit path.
The index defaults to `80. References/zotero-index.json`, overridden by plugin settings. Validate top-level `schemaVersion:2`.
Offline connection probes only local BBT readiness. Other offline actions do not contact BBT or write files.

## Reconcile and privacy boundaries

Dry-run first. Apply is allowed only on actual paper hubs outside Raw Sources and writes exactly:
`citekeyProvisional`, `zoteroID`, `zoteroSelectURI`, `zoteroStatus`, `zoteroCheckedAt`.
It never writes citekey, DOI, body/S01, atom notes, raw sources or filenames.
It refuses offline, stale/incomplete/invalid evidence, unreachable/unknown BBT, and enabled/unknown legacy state.
Malformed existing keys or conflicting identities require human review, not silent replacement.
Hand-formatted hubs are patched line by line: only the allowed key lines change and every other byte stays (0.6).
A note that changed since the dry-run is skipped as `changed-since-plan`; a block-scalar, multi-line, duplicated or quoted
allowed key as `frontmatter-not-patchable`. A parse-error note inside `--folders` refuses the whole apply; one elsewhere
that mentions a hub's citekey withholds only that hub (`blocked-by-parse-error`). No unconditional rollback or full-file CAS is promised.
Repeated no-op applies do not churn timestamps. Always inspect applied/skipped/integrity outcomes.

PDF page positions and printed labels are separate; open-pdf links use the ATTACHMENT key, not parent item key.
Use only unambiguous verified matches for confirmed quote callout titles. Fuzzy or changed-source evidence needs review.
`.cmds-zotero/pdf-text/` contains full paper text; `.cmds-zotero/bibliography/` holds the pandoc sidecars. Keep `.cmds-zotero/` and the configured index private and gitignored.
Ignored files can still be tracked; untracking does not erase prior public history.

See `references/cli-contract-v2.md` for the complete normative safety, limits, transport and transition contract.
