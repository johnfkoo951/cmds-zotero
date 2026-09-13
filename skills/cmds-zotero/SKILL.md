---
name: cmds-zotero
description: Agent CLI for the CMDS Zotero Obsidian plugin (contract 2) — resolve a paper by citekey, DOI, arXiv id or title; emit verified Zotero identity frontmatter and the S01 block for paper hubs; validate [@citekey] citations and generate ## References; extract Zotero PDF text and recover page locators for [!quote] callouts; reconcile provisional citekeys; read plugin diagnostics. Use when the user says "paper ingest", "citekey", "Zotero identity", "DOI lookup", "arXiv lookup", "page locator", "quote page", "References 생성", "provisional citekey", "/lint identity", or when an agent needs Zotero data inside an Obsidian vault. NOT for ZotLit, Zotero's UI, or editing Zotero items (the plugin is read-only toward Zotero).
---

# CMDS Zotero Agent CLI (contract v2)

Teach agents to use the CMDS Zotero agent CLI for resolving bibliographic items, capturing verified identities, scanning citations, extracting and locating quoted text in PDFs, and reconciling Zotero hub metadata with vault frontmatter.

## Command Form

All commands require `--vault VAULT_NAME`. Many support `--vault-path ABS_PATH` and `--offline` for vault-file-based queries. Live-only actions are `refresh` and `pdf-text` (with `--file` for cache-only).

```bash
node ${CMDS_ZOTERO_ROOT}/scripts/ingest.mjs --vault <VaultName> --action <action> [flags]
# read-only wrapper for commands that must not refresh, extract or write:
node ${CMDS_ZOTERO_ROOT}/scripts/ingest-ro.mjs --vault <VaultName> --action <action> [flags]
```

`${CMDS_ZOTERO_ROOT}` is rewritten to the absolute plugin repository path by `scripts/install-skill.mjs`; the skill is copied, never symlinked.

### Exit Codes
- **0**: ok:true — action succeeded
- **1**: ok:false — action ran but returned an error (check reason field)
- **2**: argument error — invalid flags, missing required args, or unrecognized action

## Decision Table: When to Use Each Action

| Goal | Action | Flags | Notes |
|------|--------|-------|-------|
| Start: inspect vault + index | `info` | `--vault` | Returns index metadata, settings, warnings. Entry point for diagnosis. |
| Refresh index (live only) | `refresh` | `--vault [--if-older-than MINUTES]` | Returns reason (forced, stale, fresh). Prevents accidental rebuilds. |
| Resolve item by selector | `resolve` | `--vault --citekey/--doi/--title/--item-key` | Returns status (resolved, ambiguous, not-found, unavailable), matches, entry. |
| Get verified identity + frontmatter | `identity` | `--vault --citekey/--doi/--title/--item-key` | Returns citekey, DOI, zoteroID, zoteroSelectURI, zoteroStatus, pinInstruction if needed. |
| Scan citations in notes | `cites` | `--vault --path FILE/FOLDER [--recursive] [--bibliography] [--allow-stale]` | Returns files, citations, referencesSection, keys array, diagnostics. |
| Locate quoted text in PDFs | `locate` | `--vault --path ATOM.md --quote TEXT \| --citekey KEY --quote TEXT` | Returns matches with page, locator (p.N or p.N-M), URI, score, snippet. |
| Extract PDF text (live only) | `pdf-text` | `--vault --citekey KEY \| --item-key KEY --library ID \| --file REL.pdf [--pages "1-5"]` | Returns pages array, cache metadata, extractedAt. Caches in `.cmds-zotero/pdf-text/`. |
| Reconcile hub records | `reconcile` | `--vault [--folders PATH] [--apply] [--allow-stale]` | Dry-run by default. --apply commits citekeyProvisional, zoteroID, zoteroSelectURI, zoteroStatus, zoteroCheckedAt. |
| Check connection + capabilities | `connection` | `--vault [--offline]` | Returns capabilities (zotero, betterbibtex, metadata, attachments, annotations, bibliography). Pre-flight for /ingest. |
| Run diagnostics | `diagnostics` | `--vault` | Returns codes (citekey-unregistered, identity-desync, index-stale, etc.). Respects --strict. |

## Identity Vocabulary (7 Keys + Canonical Ordering)

These keys form the response's `frontmatter` object and the vault note's YAML fragment. **Order is fixed** for byte-identical round-trips:

| Key | Type | Value Rules | When Set | Role |
|-----|------|-------------|----------|------|
| `citekey` | string | Lowercase, hyphenated (PDFs: ~key@suffix). Valid against `p7` convention. | Always, if resolved | Current BBT key |
| `citekeyProvisional` | boolean | `true` if item has no BBT key yet, or resolved under different key | When unregistered or renamed | Staging for Zotero Extra field |
| `doi` | string | Normalized (uppercase suffix, no URL prefix) | If item has DOI | Canonical reference |
| `zoteroID` | integer | Zotero item ID | Always, if resolved | Local reference |
| `zoteroSelectURI` | string | `zotero://select/library/items/ITEMKEY` | Always, if resolved | URI for Zotero selection |
| `zoteroStatus` | enum | `resolved \| not-found \| unavailable \| ambiguous \| provisional` | Always, if resolved | Last verify verdict |
| `zoteroCheckedAt` | ISO 8601 | Timestamp of last `resolve` or `identity` call | Always, if resolved | Cache freshness |

### YAML Fragment Rules
- One field per line; JSON-quoted string values; bare booleans; omit null
- Fixed order (canonical → reconciliation byte-matches)
- Example (all fields present):
```yaml
citekey: doe-2024-intro
citekeyProvisional: false
doi: 10.1234/EXAMPLE
zoteroID: 12345
zoteroSelectURI: zotero://select/library/items/ABC123DEF456
zoteroStatus: resolved
zoteroCheckedAt: "2026-09-14T10:30:00Z"
```

## Offline Mode & Vault Paths

**Offline flag**: `--offline` enables vault-file-based index fallback (no Obsidian/plugin required). Actions that support it: `connection`, `info`, `resolve`, `identity`, `cites`, `reconcile`, `diagnostics`, `locate`.

**Vault path resolution** (when `--offline` or explicit `--vault-path` used):
1. If `--vault-path ABS_PATH` given, use it directly
2. Else scan `vault-dir/.obsidian/app.json` → `baseDir` property
3. Fallback to home expansion if path is portable

**File-based index**: Lives at `.cmds-zotero/index.json` in vault root. Schema version in `meta.schemaVersion`. Older versions trigger `reason: stale-index`.

## Rules: Citekey, Resolution, & Provisional Flow

### Citekey Convention
- Lowercase, alphanumeric + hyphen: `[a-z0-9-]+`
- Optional suffix for disambiguation: `key@v1`, `key@alt`
- PDFs with same key: `key@pdf-1`, `key@pdf-2`
- Invalid citekeys (uppercase, spaces, special chars) fail validation and block reconcile --apply

### Resolution Matching (ranked)
1. **citekey exact**: item.citekey === selector
2. **title prefix**: item.title.toLowerCase().startsWith(selector.toLowerCase())
3. **title tokens**: item.title splits on word boundaries; selector matches 2+ tokens in order
4. **query**: full-text cross title, authors, DOI, arXiv ID, ISBN

### Provisional Citekey Pattern
When `identity` returns `citekeyProvisional: true`:
1. User copies `citekey` value from response (e.g., `smith-2020-methodology`)
2. User pastes into Zotero item's **Extra** field: `Obsidian Citekey Provisional: <citekey>`
3. User saves in Zotero
4. User runs `identity` again
5. Response now shows `citekeyProvisional: false` (item is registered)
6. Note's frontmatter auto-updates (if reconcile --apply was run)

## Stale Index Behavior

When index is older than `--if-older-than MINUTES` (or config default):
- `refresh` returns `reason: stale` and `ok: false` unless `--allow-stale`
- `info` returns `stale: true` + warning
- `cites`, `resolve`, `identity`: return `ok: false, reason: stale-index` **unless** `--allow-stale` supplied
- `reconcile`: returns verdicts marked `unchecked` (warning in summary)
- Diagnostics: emits `index-stale` code

## Exit Code & Reason Examples

| Status | Exit | Reason | When |
|--------|------|--------|------|
| ✓ Resolved | 0 | (no reason) | Item matched uniquely |
| ✗ Not found | 1 | not-found | No item matches selector |
| ✗ Ambiguous | 1 | ambiguous | 2+ items match equally |
| ✗ Connection failed | 1 | bbt-unreachable | BBT HTTP timeout/404 |
| ✗ Offline + no cache | 1 | index-missing | --offline but no `.cmds-zotero/index.json` |
| ✗ Stale index | 1 | stale-index | Index old, --allow-stale not given |
| ✗ Arg error | 2 | (none) | Invalid flag, missing required arg |

## Response Envelope

All actions return JSON envelope:

```json
{
  "apiVersion": 1 or 2,
  "contract": 2,
  "apiVersions": [1, 2],
  "action": "resolve|identity|cites|...",
  "vault": "vault-name",
  "ok": true,
  "reason": null,
  "message": null,
  "checkedAt": "2026-09-14T10:30:00Z",
  "connection": {
    "mode": "live|offline",
    "obsidian": true|false,
    "plugin": { "installed": true, "enabled": true, "version": "0.4.0" },
    "bbt": { "installed": true, "http": "http://127.0.0.1:23119", "version": "14.0.0" },
    "index": { "present": true, "path": ".cmds-zotero/index.json", "schemaVersion": 2 },
    "git": { "installed": true, "remote": "https://github.com/...", "branch": "main" }
  },
  "…action-specific fields…": {}
}
```

### Connection Object
- **mode**: "live" (Obsidian reachable) or "offline" (file-based)
- **obsidian**: boolean; presence does not require plugin
- **plugin**: {installed, enabled, version} — bbexport-compatible fields
- **bbt**: {installed, http, version}
- **index**: {present, path, schemaVersion, ageMinutes, stale}
- **git**: {installed, remote, branch, lastCommit, uncommittedChanges}

## Offline Examples

### Check if offline mode is available
```bash
cmds-zotero connection --vault my-vault --offline
# Returns connection.mode: "offline" if vault-path is discoverable and index exists
```

### Resolve item in offline mode
```bash
cmds-zotero resolve --vault my-vault --offline --citekey doe-2024
# Falls back to .cmds-zotero/index.json; returns status from cached data
```

### Scan citations without Obsidian
```bash
cmds-zotero cites --vault my-vault --vault-path /abs/path/to/vault --offline --path notes/
# Reads files directly; no plugin needed
```

### Locate quotes in cached PDFs
```bash
cmds-zotero locate --vault my-vault --citekey doe-2024 --quote "epistemology" --offline
# Searches .cmds-zotero/pdf-text/ cache; returns matches with page + locator
```

## Key Behaviors by Action

- **refresh**: Live only; rebuilds index unless `--if-older-than` blocks it
- **resolve**: Stateless; can run offline from cache; returns ranked matches + vaultNotes classification
- **identity**: Like resolve + returns frontmatter YAML + S01 lines + pinInstruction + bibliography + PDF metadata
- **cites**: Scans vault notes; returns citations array + referencesSection + diagnostics; respects stale-index warning
- **locate**: Pure cache query (no API); extracts callouts from query citekey's PDF; returns page, locator, score, snippet
- **pdf-text**: Live only; extracts PDF text to `.cmds-zotero/pdf-text/` with `--force` re-extract option
- **reconcile**: Dry-run by default; --apply commits only 5 keys (citekeyProvisional, zoteroID, zoteroSelectURI, zoteroStatus, zoteroCheckedAt)
- **diagnostics**: Union of resolved items, citations, identity mismatches, plugins, index state

## Further Reading

See `references/cli-contract-v2.md` for detailed endpoint specifications, request/response shapes, and error codes per action.
