# CMDS Zotero Agent CLI Contract v2 — Reference

Complete specification for 10 actions spanning item resolution, identity capture, citation scanning, PDF text extraction, hub reconciliation, and diagnostics.

## 1. connection

**Status**: apiVersion 1 (unchanged)  
**Live**: Yes  
**Offline**: Yes (`--offline` enables fallback)  
**Pre-flight**: Used before `/ingest` to confirm Zotero + BBT + bibliography support

### Flags
- `--vault NAME` *(required)*
- `--offline` — Use vault-file mode if index exists

### Response
```json
{
  "ok": true,
  "connection": {
    "mode": "live|offline",
    "obsidian": true,
    "plugin": { "installed": true, "enabled": true, "version": "0.4.0" },
    "bbt": { "installed": true, "http": "http://127.0.0.1:23119", "version": "14.0.0" },
    "index": { "present": true, "path": ".cmds-zotero/index.json", "schemaVersion": 2 },
    "git": { "installed": true, "remote": "https://github.com/...", "branch": "main" }
  },
  "capabilities": ["zotero", "betterbibtex", "metadata", "attachments", "annotations", "bibliography"]
}
```

### Reasons (ok:false)
- `bbt-unreachable` — BBT HTTP down
- `obsidian-unreachable` — Obsidian app down (in live mode)
- `index-missing` — `--offline` requested but no index file exists

---

## 2. info

**Status**: apiVersion 2 (new; replaces "status")  
**Live**: Yes  
**Offline**: Yes (uses vault-path or obsidian.json)  
**Decision table entry**: Run first to understand vault state and determine next action

### Flags
- `--vault NAME` *(required)*
- `--vault-path ABS_PATH` — Explicit vault path (for offline mode)
- `--offline` — Use vault-file mode

### Response
```json
{
  "ok": true,
  "index": {
    "present": true,
    "path": ".cmds-zotero/index.json",
    "schemaVersion": 2,
    "generatedAt": "2026-09-14T10:00:00Z",
    "ageMinutes": 30,
    "stale": false,
    "count": 1250,
    "complete": true,
    "libraries": {
      "My Library": { "count": 800, "items": 800, "pdfs": 120 },
      "Group1": { "count": 450, "items": 450, "pdfs": 85 }
    },
    "withPdf": 205,
    "withAnnotations": 45
  },
  "settings": {
    "vaultName": "my-vault",
    "indexPath": ".cmds-zotero/index.json",
    "citekeyConvention": "lowercase-hyphenated",
    "maxPdfSize": "64MB"
  },
  "git": {
    "branch": "main",
    "lastCommit": "a703476",
    "uncommittedChanges": false
  },
  "warnings": [
    { "code": "legacy-plugin-enabled", "message": "Old Zotero plugin detected; may conflict." }
  ]
}
```

### Reasons (ok:false)
- `index-missing` — No index found (run `refresh` to generate)
- `index-corrupted` — Schema version mismatch or parse error

---

## 3. refresh

**Status**: apiVersion 1  
**Live**: Yes only  
**Offline**: No  
**Purpose**: Rebuild index from live Zotero + BBT; prevents accidental overwrite with stale-check flag

### Flags
- `--vault NAME` *(required)*
- `--if-older-than MINUTES` — Skip if index exists and is fresher than N minutes

### Response
```json
{
  "ok": true,
  "refreshed": true,
  "reason": "forced",
  "ageMinutesBefore": 0,
  "ageMinutesAfter": 0,
  "itemsIndexed": 1250,
  "pdfsExtracted": 205
}
```

### Reasons (ok:false)
- `fresh` — Index exists and is fresh; no rebuild (when `--if-older-than` used)
- `bbt-unreachable` — Cannot reach BBT HTTP
- `obsidian-unreachable` — Cannot reach Obsidian app

---

## 4. resolve

**Status**: apiVersion 1 (v1 citekey/itemKey/id fields preserved; new ranked/indexed/citekeyShape)  
**Live**: Yes  
**Offline**: Yes  
**Purpose**: Resolve selector to ranked matches; entry point for disambiguation

### Flags
- `--vault NAME` *(required)*
- `--vault-path ABS_PATH` — For offline mode
- `--offline` — Use vault-file mode
- `--citekey KEY` | `--item-key KEY` | `--doi DOI` | `--arxiv ID` | `--title TITLE` *(one required)*

### Response
```json
{
  "ok": true,
  "status": "resolved",
  "entry": {
    "id": "12345",
    "itemKey": "ABC123",
    "libraryID": "user",
    "citekey": "doe-2024-intro",
    "citekeyHistory": ["smith-2024", "doe-2024-intro"],
    "title": "Introduction to Methodology",
    "authors": ["John Doe"],
    "year": 2024,
    "doi": "10.1234/EXAMPLE",
    "zoteroSelectURI": "zotero://select/library/items/ABC123"
  },
  "matchedBy": "citekey",
  "matchedHistory": ["citekey", "title-exact"],
  "candidates": [
    {
      "rank": 1,
      "id": "12345",
      "citekey": "doe-2024-intro",
      "title": "Introduction to Methodology",
      "year": 2024,
      "matchedBy": "citekey",
      "score": 1.0
    },
    {
      "rank": 2,
      "id": "12346",
      "citekey": "doe-2024-advanced",
      "title": "Advanced Methodology Topics",
      "year": 2024,
      "matchedBy": "titleTokens",
      "score": 0.85
    }
  ],
  "vaultNotes": {
    "classification": "literature-note|hub|raw|atom",
    "path": "40. Docs/Literature/doe-2024.md",
    "citeKeysCurrent": ["doe-2024-intro"]
  }
}
```

### Reasons (ok:false)
- `not-found` — No item matched selector
- `ambiguous` — Multiple items matched equally
- `unavailable` — Item exists but metadata unavailable
- `stale-index` — Index old and --allow-stale not given

---

## 5. identity

**Status**: apiVersion 2 (new; forward only)  
**Live**: Yes  
**Offline**: Yes  
**Purpose**: Resolve selector to full identity + frontmatter + S01 citation lines + pinInstruction + bibliography

### Flags
- `--vault NAME` *(required)*
- `--vault-path ABS_PATH` — For offline mode
- `--offline` — Use vault-file mode
- `--citekey KEY` | `--item-key KEY` | `--doi DOI` | `--title TITLE` *(one required)*

### Response (extended)
```json
{
  "ok": true,
  "status": "resolved",
  "matchedBy": "citekey",
  "item": {
    "id": "12345",
    "itemKey": "ABC123",
    "libraryID": "user",
    "citekey": "doe-2024-intro",
    "citekeyHistory": ["smith-2024"],
    "title": "Introduction to Methodology",
    "authors": ["John Doe", "Jane Smith"],
    "year": 2024,
    "doi": "10.1234/EXAMPLE",
    "zoteroSelectURI": "zotero://select/library/items/ABC123"
  },
  "citekeyCurrent": "doe-2024-intro",
  "vaultNotes": {
    "classification": "literature-note",
    "path": "40. Docs/Literature/doe-2024.md",
    "hubs": ["epistemology"],
    "raw": false,
    "atoms": ["methodology"]
  },
  "frontmatter": {
    "citekey": "doe-2024-intro",
    "citekeyProvisional": false,
    "doi": "10.1234/EXAMPLE",
    "zoteroID": 12345,
    "zoteroSelectURI": "zotero://select/library/items/ABC123",
    "zoteroStatus": "resolved",
    "zoteroCheckedAt": "2026-09-14T10:30:00Z"
  },
  "yaml": "citekey: doe-2024-intro\ncitekeyProvisional: false\ndoi: 10.1234/EXAMPLE\nzoteroID: 12345\nzoteroSelectURI: zotero://select/library/items/ABC123\nzoteroStatus: resolved\nzoteroCheckedAt: \"2026-09-14T10:30:00Z\"\n",
  "s01": {
    "fullCitation": "Doe, J., & Smith, J. (2024). Introduction to Methodology. 10.1234/EXAMPLE",
    "citekey": "doe-2024-intro",
    "doi": "10.1234/EXAMPLE",
    "zoteroLine": "zotero://select/library/items/ABC123",
    "pdfLine": "[PDF](zotero://open-pdf/library/items/PDF123KEY?page=1)",
    "rawSourceLine": "https://example.com/doe-2024.pdf"
  },
  "callout": null,
  "citekeyCheck": {
    "shape": "valid",
    "conventionOk": true,
    "p7Valid": true,
    "existsInIndex": true,
    "collisions": 0,
    "pinInstruction": null,
    "recommendation": null
  },
  "bibliography": {
    "style": "chicago-author-date",
    "text": "Doe, John, and Jane Smith. \"Introduction to Methodology.\" 2024. https://doi.org/10.1234/EXAMPLE.",
    "reason": null
  },
  "pdf": {
    "pdfStatus": "present",
    "attachmentKey": "PDF123KEY",
    "openURI": "zotero://open-pdf/library/items/PDF123KEY?page=1",
    "path": "/path/to/Zotero/storage/ABC123/doe-2024.pdf",
    "candidates": [
      { "attachmentKey": "PDF123KEY", "title": "doe-2024.pdf", "bytes": 2048576 }
    ]
  }
}
```

### Special Cases
- **citekeyProvisional: true**: Item unregistered or registered under different key. `pinInstruction` shows how to register in Zotero Extra field.
- **callout**: `[!info]` block when `citekeyCurrent !== frontmatter.citekey` (pin pending).
- **bibliography.reason**: `bbt-unreachable`, `offline`, `style-error`, `disabled` when text unavailable.
- **S01 lines**: Byte-exact; must match on re-render.

### Reasons (ok:false)
Same as resolve + `bbt-unreachable` (bibliography), `offline` (BBT unavailable)

---

## 6. cites

**Status**: apiVersion 2 (new; forward only)  
**Live**: Yes  
**Offline**: Yes (with --offline flag)  
**Purpose**: Scan vault notes for citations; return files, keys, referencesSection, diagnostics

### Flags
- `--vault NAME` *(required)*
- `--vault-path ABS_PATH` — For offline mode
- `--offline` — Use vault-file mode
- `--allow-stale` — Proceed if index is stale (marks verdicts unchecked)
- `--path FILE|FOLDER` *(required)*
- `--recursive` — Scan subfolders
- `--bibliography` — Generate references markdown
- `--style STYLE` — Citation style (default: chicago-author-date)
- `--strict` — Exit 1 on any error-level diagnostic

### Response
```json
{
  "ok": true,
  "files": [
    {
      "path": "40. Docs/notes/research.md",
      "citations": [
        {
          "citekey": "doe-2024-intro",
          "where": "body",
          "citeStatus": "resolved",
          "matchedHistory": ["citekey"]
        },
        {
          "citekey": "unknown-2020",
          "where": "body",
          "citeStatus": "dangling",
          "matchedHistory": []
        }
      ]
    }
  ],
  "referencesSection": {
    "present": true,
    "listed": ["doe-2024-intro"],
    "missing": ["smith-2020"],
    "notCited": []
  },
  "keys": [
    {
      "citekey": "doe-2024-intro",
      "citeStatus": "resolved",
      "count": 3
    },
    {
      "citekey": "unknown-2020",
      "citeStatus": "dangling",
      "count": 1
    }
  ],
  "references": {
    "resolved": ["Doe, John, and Jane Smith..."],
    "unresolved": ["unknown-2020"],
    "markdown": "## References\n\n- Doe, John, and Jane Smith..."
  },
  "summary": {
    "filesScanned": 15,
    "citesFound": 42,
    "resolved": 38,
    "dangling": 4,
    "ratioDangling": 0.095
  },
  "diagnostics": [
    {
      "code": "dangling-cite",
      "file": "40. Docs/notes/research.md",
      "citekey": "unknown-2020",
      "severity": "warning"
    }
  ]
}
```

### Reasons (ok:false)
- `stale-index` — Index old and --allow-stale not given
- `path-not-found` — --path does not exist

---

## 7. locate

**Status**: apiVersion 2 (new; pure cache query; offline-capable)  
**Live**: No  
**Offline**: Yes (uses .cmds-zotero/pdf-text/ cache)  
**Purpose**: Extract callouts from a note; find quoted text in cached PDFs; return page, locator, URI

### Flags
- `--vault NAME` *(required)*
- `--path ATOM.md` | `--citekey KEY --quote TEXT` | `--item-key KEY --library ID --quote TEXT` | `--file REL.pdf` *(one required)*

### Response
```json
{
  "ok": true,
  "item": {
    "id": "12345",
    "citekey": "doe-2024-intro"
  },
  "attachment": {
    "key": "PDF123KEY",
    "openURI": "zotero://open-pdf/library/items/PDF123KEY?page=1",
    "path": "/path/to/Zotero/storage/ABC123/doe-2024.pdf"
  },
  "cache": {
    "path": ".cmds-zotero/pdf-text/PDF123KEY.json",
    "sha256": "abc123...",
    "extractedAt": "2026-09-14T09:00:00Z",
    "pageCount": 250,
    "verified": true
  },
  "results": [
    {
      "line": 5,
      "quote": {
        "raw": "epistemology defines how we know",
        "normalized": "epistemology defines how we know",
        "chars": 32
      },
      "matchStatus": "exact",
      "matches": [
        {
          "page": 1,
          "pageLabel": "1",
          "locator": "p.1",
          "uri": "zotero://open-pdf/library/items/PDF123KEY?page=1",
          "method": "exact",
          "score": 1.0,
          "snippet": "...epistemology defines how we know..."
        }
      ],
      "calloutTitle": null
    },
    {
      "line": 12,
      "quote": {
        "raw": "methodology spans pages 5-7",
        "normalized": "methodology spans pages 5 7",
        "chars": 25
      },
      "matchStatus": "exact-spansPages",
      "matches": [
        {
          "page": 5,
          "pageLabel": "5",
          "locator": "p.5-7",
          "uri": "zotero://open-pdf/library/items/PDF123KEY?page=5",
          "method": "exact-spansPages",
          "score": 1.0,
          "snippet": "methodology spans pages..."
        }
      ],
      "calloutTitle": "원문 (p.5-7)"
    }
  ],
  "summary": {
    "total": 2,
    "found": 2,
    "multiple": 0,
    "fuzzy": 0,
    "notFound": 0
  }
}
```

### Matching Strategy
1. **Exact**: quote found character-for-character (after normalization)
2. **Exact-spansPages**: exact match across consecutive pages → locator "p.N-M"
3. **Fuzzy**: token window match (score ≥0.6), ≤5 pages

### Locator Rules
- Single page: "p.5"
- Span: "p.5-6" (consecutive pages only)
- Page labels empty or non-numeric: fallback to String(page)
- Format: "p.5" or "p.5-6" (no "pp.")

### Reasons (ok:false)
- `quote-not-found` — No match in cache or PDF missing
- `cache-missing` — No PDF cache exists for this citekey

---

## 8. pdf-text

**Status**: apiVersion 2 (new; live only)  
**Live**: Yes only  
**Offline**: Partial (--file works with cache)  
**Purpose**: Extract PDF text; cache in `.cmds-zotero/pdf-text/` with version, sha256, mtimeMs

### Flags
- `--vault NAME` *(required)*
- `--citekey KEY` | `--item-key KEY --library ID` | `--file REL.pdf` *(one required)*
- `--pages "1-5,9"` — Extract only these pages (inclusive ranges)
- `--force` — Re-extract, ignore cache
- `--timeout SECONDS` — PDF.js timeout (default: 30)

### Response
```json
{
  "ok": true,
  "item": {
    "id": "12345",
    "citekey": "doe-2024-intro"
  },
  "attachment": {
    "key": "PDF123KEY",
    "openURI": "zotero://open-pdf/library/items/PDF123KEY?page=1",
    "path": "/path/to/Zotero/storage/ABC123/doe-2024.pdf",
    "bytes": 2048576,
    "sha256": "abc123..."
  },
  "pageCount": 250,
  "hasPageLabels": true,
  "pages": [
    {
      "page": 1,
      "pageLabel": "1",
      "chars": 3500,
      "truncated": false,
      "text": "Introduction\n\nThis document explores..."
    }
  ],
  "cache": {
    "path": ".cmds-zotero/pdf-text/PDF123KEY.json",
    "hit": false,
    "evicted": []
  },
  "extractedAt": "2026-09-14T10:30:00Z",
  "tool": "pdfjs/3.11.174"
}
```

### Cache File (.cmds-zotero/pdf-text/)
Stored as `{ATTACHMENT_KEY}.json`:
```json
{
  "version": 2,
  "sha256": "abc123...",
  "bytes": 2048576,
  "mtimeMs": 1694000000000,
  "pageCount": 250,
  "extractedAt": "2026-09-14T10:30:00Z",
  "pages": [
    { "page": 1, "pageLabel": "1", "chars": 3500, "text": "..." }
  ],
  "id": "12345",
  "attachmentKey": "PDF123KEY",
  "path": "/path/to/Zotero/storage/ABC123/doe-2024.pdf",
  "tool": "pdfjs/3.11.174"
}
```

### Guards
- Max 64 MiB per file (checked via magic bytes)
- Max 2000 pages
- Per-page text ≤200K chars (inlined only if --pages given and total <200KB)
- Symlink check (local-file.ts)
- Path-outside-vault check

### Reasons (ok:false)
- `file-too-large` — Exceeds 64 MiB
- `file-not-readable` — Permissions or symlink issue
- `extraction-timeout` — PDF.js timeout exceeded
- `path-outside-vault` — --file path escapes vault root

---

## 9. reconcile

**Status**: apiVersion 2 (new; hubs + raw sources only)  
**Live**: Mixed (dry-run yes; --apply requires live Obsidian + BBT + fresh index)  
**Offline**: Dry-run yes; --apply no  
**Purpose**: Dry-run audit of hub records vs. Zotero; --apply commits 5 allowedKeys to frontmatter

### Flags
- `--vault NAME` *(required)*
- `--vault-path ABS_PATH` — For offline mode (dry-run only)
- `--offline` — Use vault-file mode (dry-run only)
- `--allow-stale` — Permit stale index for dry-run
- `--folders PATH` — Scan only these folders (comma-separated)
- `--apply` — Commit frontmatter changes (requires live mode + fresh index)
- `--strict` — Exit 1 on any error-level diagnostic

### Allowed Keys (--apply only)
- `citekeyProvisional`
- `zoteroID`
- `zoteroSelectURI`
- `zoteroStatus`
- `zoteroCheckedAt`

### Response
```json
{
  "ok": true,
  "mode": "dry-run",
  "notes": [
    {
      "path": "40. Docs/Literature/doe-2024.md",
      "classification": "literature-note|hub|raw",
      "citekey": "doe-2024-intro",
      "status": "registered-consistent",
      "findings": "Citekey matches Zotero; no changes needed.",
      "observed": {
        "citekey": "doe-2024-intro",
        "zoteroID": 12345
      },
      "proposed": null,
      "pinInstruction": null,
      "applied": false
    },
    {
      "path": "40. Docs/Literature/smith-2020.md",
      "classification": "hub",
      "citekey": "smith-2020-framework",
      "status": "registered-unpinned",
      "findings": "Citekey provisional; ready to pin (paste to Zotero Extra).",
      "observed": {
        "citekey": "smith-2020-framework",
        "citekeyProvisional": true,
        "zoteroID": null
      },
      "proposed": {
        "citekeyProvisional": false,
        "zoteroID": 12346,
        "zoteroSelectURI": "zotero://select/library/items/XYZ789",
        "zoteroStatus": "resolved",
        "zoteroCheckedAt": "2026-09-14T10:30:00Z"
      },
      "pinInstruction": "Paste into Zotero item Extra: Obsidian Citekey Provisional: smith-2020-framework",
      "applied": false
    }
  ],
  "summary": {
    "scanned": 25,
    "registered-consistent": 20,
    "registered-desynced": 2,
    "registered-unpinned": 1,
    "provisional-now-registered": 1,
    "unregistered-flagged": 1,
    "unregistered-unflagged": 0,
    "ambiguous": 0,
    "unchecked": 0
  }
}
```

### Status Enum
- `registered-consistent` — Citekey matches Zotero, frontmatter current
- `registered-desynced` — Citekey matches, but zoteroID/zoteroSelectURI mismatch
- `registered-unpinned` — citekeyProvisional: true; waiting for Zotero Extra paste
- `provisional-now-registered` — Was provisional, now BBT-registered; ready to pin
- `unregistered-flagged` — Citekey not in BBT; marked for review
- `unregistered-unflagged` — Citekey not in BBT; may be raw or legacy
- `ambiguous` — Multiple Zotero matches for citekey
- `unchecked` — Index stale; verdict withheld

### Reasons (ok:false)
- `index-stale-apply` — --apply used with stale index
- `live-mode-required` — --apply without Obsidian reachable
- `bbt-unreachable` — BBT unavailable for --apply
- `legacy-plugin-enabled` — Old plugin detected; refuses reconcile

---

## 10. diagnostics

**Status**: apiVersion 1 (core unchanged; adds reconcile + cites codes)  
**Live**: Yes  
**Offline**: Yes  
**Purpose**: Union of resolved items, citations, identity mismatches, plugins, index state

### Flags
- `--vault NAME` *(required)*
- `--vault-path ABS_PATH` — For offline mode
- `--offline` — Use vault-file mode
- `--strict` — Exit 1 on any error-level diagnostic

### Response
```json
{
  "ok": true,
  "diagnostics": [
    {
      "code": "citekey-unregistered",
      "severity": "warning",
      "message": "Citekey 'unknown-2020' not found in Zotero index."
    },
    {
      "code": "index-stale",
      "severity": "info",
      "message": "Index is 120 minutes old. Run 'refresh' for current data."
    },
    {
      "code": "legacy-plugin-enabled",
      "severity": "warning",
      "message": "Old Zotero plugin detected. Keep until CMDS Zotero replacement is validated."
    }
  ]
}
```

### Diagnostic Codes
- **citekey-unregistered** — Citation exists but not in index
- **citekey-not-pinned** — citekeyProvisional: true, waiting for Zotero registration
- **identity-desync** — Citekey + zoteroID mismatch
- **provisional-now-registered** — Provisional flag outdated; rerun reconcile --apply
- **attachment-missing-for-hub** — Hub note references PDF but attachment not found
- **dangling-cite** — Citation in body but no referencesSection entry
- **cite-hub-only** — Citation resolves to hub only, not raw
- **cite-raw-only** — Citation resolves to raw source, not item
- **cite-unchecked** — Index stale; verdict uncertain
- **citekey-ambiguous** — Multiple items match same citekey
- **legacy-plugin-enabled** — Old plugin running alongside CMDS Zotero
- **index-stale** — Index older than default threshold
- **index-in-git** — Index file committed to git (should be .gitignored)

### Reasons (ok:false)
- `vault-not-found` — Vault name not recognized

---

## Envelope Fields (All Actions)

| Field | Type | Present | Meaning |
|-------|------|---------|---------|
| `apiVersion` | 1 or 2 | Always | Version of response shape (1 = classic resolve/refresh, 2 = identity/cites/locate/pdf-text/reconcile) |
| `contract` | 2 | Always | Agent CLI contract version |
| `apiVersions` | [1,2] | Always | Supported versions |
| `action` | string | Always | Action name (resolve, identity, etc.) |
| `vault` | string | Always | Vault name from flag |
| `ok` | boolean | Always | Success flag (true = action ran; false = error occurred) |
| `reason` | string \| null | When ok:false | Machine-readable error code |
| `message` | string \| null | When ok:false | Human-readable error message |
| `checkedAt` | ISO 8601 | Always | Timestamp of request |
| `connection` | object | Always | Connection + index + plugin status |
| Action-specific fields | varies | Always | Varies by action (entry, status, matches, etc.) |

---

## Error Handling

All errors return exit code 1 with `ok: false`, a `reason`, and optionally a `message`. Argument errors return exit code 2 with a brief message to stderr.

Example error response:
```json
{
  "ok": false,
  "reason": "not-found",
  "message": "No item found matching citekey 'nonexistent-2020'.",
  "vault": "my-vault",
  "connection": { ... }
}
```

Exit code 2 (argument error) example:
```
stderr: Error: --path is required for cites action
exit: 2
```

---

## Summary: When to Use Each Action

| When You Need To | Action | Notes |
|------------------|--------|-------|
| Start: inspect vault state | `info` | Decision table entry point |
| Rebuild index from Zotero | `refresh` | Live only; use --if-older-than to prevent accidental rebuilds |
| Resolve item by ID | `resolve` | Returns ranked matches; can use offline |
| Get full identity + frontmatter | `identity` | apiVersion 2; includes pinInstruction, bibliography, PDF metadata |
| Scan notes for citations | `cites` | Returns files, keys, referencesSection, diagnostics |
| Find quote in PDF | `locate` | Cache-only; returns page, locator, URI |
| Extract PDF text | `pdf-text` | Live only; caches in .cmds-zotero/pdf-text/ |
| Audit + commit hub metadata | `reconcile` | Dry-run by default; --apply requires live mode + fresh index |
| Check plugin connectivity | `connection` | Pre-flight before /ingest |
| Run diagnostics | `diagnostics` | Returns codes for citekeys, index, plugins, citations |
