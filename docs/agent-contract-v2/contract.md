# Agent contract 2

Normative supplement to [the 0.4 implementation plan](../0.4-agent-contract-plan.md).
This document supersedes conflicting examples in the earlier WIP reference and ephemeral worker instructions.
Implementation status and test evidence belong in the plan, not in claims that examples have been executed.

## Scope

Ten CLI actions, no new UI. Zotero remains read-only through documented Better BibTeX RPCs.
No database access, companion add-on, HTTP listener, telemetry, or automatic citekey changes.
The only write to non-plugin-owned notes is explicitly requested `reconcile --apply`.
Neither `identity` nor `cites` nor `locate` applies the Markdown it returns.

## Actions and envelope

| Action | Payload API version | Offline | Side effects |
| --- | --- | --- | --- |
| connection | 1 | Yes | Local BBT readiness probe only |
| info | 2 | Yes | None; no refresh or BBT probe |
| refresh | 1 | No | Explicit index/cache publication |
| resolve | 1 | Yes | None unless explicit `--refresh` |
| identity | 2 | Yes | None unless explicit `--refresh` |
| cites | 2 | Yes | None |
| reconcile | 2 | Dry-run only | Five-key hub update only with `--apply` |
| diagnostics | 1 | Yes | None |
| pdf-text | 2 | No | Private PDF text cache |
| locate | 2 | Yes | None |

Every structured response has `apiVersion`, `contract: 2`, `apiVersions: [1,2]`, `action`, `vault`,
`ok`, `checkedAt` (UTC ISO timestamp), and `connection`. Failures add `reason` and `message`.
The service advertises API 2 while the four legacy action payloads retain API 1.
Legacy fields preserve their values/types; new envelope fields are additive, not a promise of identical whole-JSON bytes.

`connection` includes mode, Obsidian availability, plugin version/capabilities, BBT reachability,
index source/path/schema/generation/age/completeness/staleness/threshold, legacy-plugin state, and Git coverage.
Unknown is represented as unknown/null, never fabricated success. Ignored and already-tracked files are separate concerns.

Existing implicit refresh in read-only legacy operations is intentionally removed.
The read-only wrapper must not call an old host that might refresh on a read.
New CLI clients may use the offline core for old-host read-only capabilities; unsupported live writes fail explicitly.
No new flags may be silently discarded when talking to an old plugin.

### Exit codes and transport

- `0`: structured usable results, including ambiguous, not-found, dry-run and diagnostics reports.
- `1`: `ok:false`, apply refusal/failure, legacy unavailable, or `--strict` with error-severity diagnostics.
- `2`: malformed arguments; plain stderr, no JSON.
- Structured errors appear exactly once on stdout, with one reason line on stderr.
- Repeat validation for direct API callers; a valid CLI parser is not a trust boundary.
- Read-only fallback is allowed before submission. Once accepted, or submission outcome is uncertain,
  never automatically resubmit or fall back. A timeout is not evidence that a write did not occur.
- Only explicit pre-acceptance capacity rejection retries, after 1, 2 and 4 seconds.
- Side-effect-free discovery reads may be retried on a transient bridge failure (empty CLI output) before
  submission; a CLI that cannot spawn or exits non-zero is immediate bridge loss. After submission, transient
  bridge failures (empty CLI output, transport errors) are retried until the deadline and then reported as timeout.

Jobs retain creation/completion timestamps. At most 16 unacknowledged jobs exist; `ackJob(id)` releases a
terminal job, so direct API callers acknowledge what they have read.
Completed/failed jobs expire after ten minutes; pending jobs are not evicted by that TTL.
A completed result persists until the client acknowledges it or its ten-minute TTL elapses; repeated reads
return the same result. Lost delivery is an uncertain outcome;
inspect the current state with read-only reconcile rather than automatically reapplying.
Unloading prevents late completion from recreating jobs or performing later writes.
A pending job is failed by the host after a per-action timeout (`pdf-text` 900 s, every other action 300 s); the
failure text names the action and the timeout, releases the write gate that blocks reconfiguration, and a late
settlement never reverses it. A timed-out write is an uncertain outcome like any other timeout.

Failure `reason` values come from typed errors and the request, never from message text: an index refusal keeps its
own reason; a local-file refusal maps by code (`too-large` → `pdf-too-large`, any other → `pdf-invalid`), so an
oversized or non-PDF `--file` target is named precisely; `apply-failed` is reserved for a `reconcile` that was asked
to write (`--apply`), while a failing dry-run or read reports `invalid-request`.
`locate --path` and `cites --path` resolve a note with or without its `.md` extension; an unknown note is a
structured `invalid-request`, and a path that cannot lie inside the vault is `path-outside-vault`.

## Identity and matching

`zoteroID` is a string such as `1:AAAA2345`, never a numeric database row ID.
Parent items, PDF attachments and annotations have distinct eight-character keys.
Selection URIs identify the parent; `zotero://open-pdf/.../items/BBBB2345?page=3` uses the attachment.
Group-library IDs and local library IDs are not interchangeable.

Hub fields are `citekey`, `doi`, `citekeyProvisional`, `zoteroID`, `zoteroSelectURI`,
`zoteroStatus`, and `zoteroCheckedAt`. The plugin may apply only the last five identity keys,
not `citekey` or `doi`. Existing plugin-owned literature-note fields remain supported.

- The vault citekey is the requested/existing hub key, never implicitly the current index key.
  DOI-only identity responses without a vault key omit `frontmatter.citekey`.
- Current/history matches are unioned by stable item identity. Collisions across different items are ambiguous.
- History may identify an item but does not prove that the vault key is pinned now.
- `citekeyProvisional:false` requires unambiguous identity and exact equality with the current BBT key.
  `zoteroStatus:resolved` plus `citekeyProvisional:true` is valid: registration exists, pinning is pending.
- Pin instruction: add `Citation Key: <requested-key>` to the Zotero item's Extra field manually.
- Resolve exactly one selector family: citekey, item-key plus library, DOI, arXiv, title, or query.
  Identity additionally accepts a vault citekey paired with one other lookup selector.
- DOI matching URL-decodes and normalizes case; emission preserves case. Keep one shared implementation.
- arXiv input must fully match a recognized identifier or arXiv URL, not an arbitrary URL substring.
- Author narrowing uses token boundaries. Exact normalized titles may resolve; prefixes/tokens/query rank only.
- Duplicate matches never select the first candidate. Multiple hubs return null plus a warning.
- Malformed YAML, unreadable notes and truncated discovery must be exposed, not silently treated as absent.

## Evidence availability

Absent, invalid, incomplete or unknown-age/future-dated indexes cannot establish absence.
A stale negative answer is withheld unless explicitly allowed, retaining the underlying verdict as `indexAnswer`.
`--allow-stale` does not make missing, malformed or incomplete evidence complete and never authorizes apply.
Positive identity evidence and source availability are separate from permission to write.

Vault-discovery incompleteness (notes skipped for malformed frontmatter, or a truncated scan) affects hub/raw
classification and reconcile apply, never the Zotero-index verdict: `resolve`/`identity` still return `not-found`
(`citekeyProvisional:true`) beside unrelated unparseable notes. Every such payload carries `scan {skipped, truncated}`
and a `vaultNotes.warnings` entry; truncated discovery (notes may be missing entirely) is reported as
`ok:false, reason: discovery-incomplete` with the skipped count and up to ten paths, while the index `status` stands.
`--allow-stale` addresses index age only and never lifts `discovery-incomplete`. Only the stale gate yields `stale-index`.

`cites` scans body and relevant frontmatter citations, unions canonical/history identities, and reports
resolved, hub-only, raw-only, dangling, ambiguous or unchecked. Hub/raw evidence is attached before any gate and
citekeys match exactly (case-preserving, as pandoc does), so provisional hub-only citations remain usable
when the Zotero index is stale or discovery is incomplete. Raw-only/dangling negative claims are withheld as
`unchecked` when evidence is insufficient, with `uncheckedReason: stale-index` (stale gate; `--allow-stale` lifts it)
or `discovery-incomplete` (skipped/truncated notes; repair them, `--allow-stale` does not apply); hints, diagnostics
and References lines name that cause. References output is deterministic and returned for review, not written into the note.

## Reconcile transition contract

Discovery is by frontmatter type; folders only narrow it. Raw sources are report-only.
The Raw Sources root is never writable even if a file is mislabeled paper-hub.
ID/URI/key/history/folder/DOI/arXiv can contribute identity evidence, but precedence never overrides a contradiction.
Present-but-invalid fields retain their presence: null, empty strings, wrong types and duplicate keys are not absent.
Conflicting identities, malformed fields, ambiguous results and unchecked evidence produce no automatic patch.

| Field | Allowed transition |
| --- | --- |
| zoteroID / zoteroSelectURI | Absent to validated value; existing values never overwritten or deleted |
| zoteroStatus | Absent to resolved or fresh not-found; not-found/unavailable/ambiguous to resolved; unavailable/ambiguous to fresh not-found |
| citekeyProvisional | Absent to boolean; true to false only when current key is exactly pinned; false is never reversed |
| zoteroCheckedAt | Written only alongside a material authorized change to another allowed field |

Existing identity evidence prevents an automatic negative transition. Resolved status never downgrades.
Malformed identities require human repair followed by a new dry-run; no repair action is added in 0.4.
S01 corrections are suggestions only; reconcile does not edit the body.

### Apply protocol

Require live host, valid complete fresh index, current BBT reachability and explicitly disabled legacy plugin.
Unknown preconditions fail closed. Serialize applies per canonical vault/path.
Bind each proposal to its source snapshot; re-read and check the source before writing.
Recheck current frontmatter and transition preconditions within `processFrontMatter` before assignments.
Existing YAML must pass the byte-identical parse/stringify round-trip guard.
Verify body bytes, non-allowed values and intended allowed values afterward, even after a possibly post-write exception.
No-op runs do not update timestamps. Per-file failures and actual writes are reported distinctly.
`apply.notes[].wrote` is `null` when a post-invocation read cannot establish the outcome; this is an integrity failure,
not proof of no write. Top-level note `applied` flags mirror successful writer outcomes. Revalidation may advance
`zoteroCheckedAt` while preserving the approved material patch. Each queued file rechecks evidence and the callback
rejects evidence that has expired before assignments.

The public API does not provide whole-file compare-and-swap against external editors.
Do not claim complete atomicity or automatically roll back over concurrent edits.
A verification mismatch is an integrity failure with actual-write/churn accounting, not a successful skip.
Stop further writes after integrity failure and let the user inspect current state.

## PDF evidence and private caches

Use the bundled public `loadPdfJs()` API and guarded local reads, not a new PDF service.
Capture the input byte length before passing a transferable buffer to pdf.js.
Page is one-based physical position; pageLabel is printed text. Empty/dash-only labels fall back to position.
`p.-` must never appear. Fuzzy/ambiguous/unverified matches must not masquerade as confirmed quote locations.

Cache names bind source scope and content hash: `<libraryType>-<libraryID>-<attachmentKey>-<sha16>.json` for
Zotero attachments and `file-<pathHash16>-<sha16>.json` for vault PDFs, where the path hash is the SHA-256 of the
vault-relative path. Attachment and vault-file caches cannot select/evict each other, and two vault PDFs with
identical bytes at different paths keep separate caches. Pre-0.5 `file-<sha16>.json` names are foreign: never
selected, never evicted; re-run `pdf-text` to rebuild.
Validate schema, source identity, file scope, page order/uniqueness, limits and metadata before use.
A changed PDF is verification failure; an unavailable original is unchecked. Preserve truncation warnings on cache hits.
Always clean up pdf.js tasks/documents on failure or completion.

| Limit | Value |
| --- | --- |
| PDF input | 64 MiB / 2,000 pages |
| Text per page | 200,000 characters, explicit truncation warning |
| Inline text response | 200 KB total |
| Quote | 8 KiB |
| Serialized cache read/write | 32 MiB; refuse unreadable oversized cache output |
| Markdown | 2 MiB |
| Citation folder walk | 2,000 files, report truncation |
| Vault discovery | 20,000 notes, report omissions/truncation |

Private data lives under `.cmds-zotero/`; ensure a protective `.cmds-zotero/.gitignore` before writing.
Index paths and full-paper caches are sensitive. Ignore rules do not untrack files or erase published history.
Never include real library exports, source PDFs, private paths or session identifiers in public fixtures/docs.

## Acceptance gates

Contract fixtures cover every action, API version, exit code and unsupported host capability.
Tests cover malformed/contradictory identities, all transitions, history/current collisions, parser failures,
stale/incomplete snapshots, queued edits, lifecycle changes, read-only behavior, cache boundaries and detached buffers.
The offline bundle must derive from current source and contain no runtime Obsidian import.
Full lint/typecheck/tests/build, public-source sanitization and release version checks run before release approval.
Live installation, user-hub apply, commits, pushes and releases require their own authorization.
