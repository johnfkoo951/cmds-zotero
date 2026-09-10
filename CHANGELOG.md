# Changelog

## 0.2.0 — Development, unreleased

- Rename the plugin to **CMDS Zotero**, ID `cmds-zotero`.
- Replace citekey-derived identities with canonical BBT item identities and a versioned index contract.
- Prepare BBT attachment/annotation enrichment, preservation-aware built-in CMDS literature imports, diagnostics, paper-ingest integration, opt-in peer-vault navigation, and copyable Hookmark-compatible links.
- Add explicit, fingerprint-checked installation migration with private backups and conservative rollback; preserve the old installation and existing settings.
- Add bilingual documentation, Node 22 CI, exact-version release validation, version synchronization, and public-source sanitization tooling.

This is not a published release or a claim that live acceptance testing has completed. Group-library and Hookmark round-trip behavior remain unverified without environment-specific tests. Full Zotero Integration/ZotLit template compatibility is not included. No other plugin is automatically disabled by the plugin runtime.

## 0.1.0 — Local pilot

- Citation insertion, citekey index export, and source-PDF navigation under the previous `cmds-link-zotero` ID.
- Legacy exported indexes must not be treated as verified canonical item identities; rebuild from BBT before relying on source links.
