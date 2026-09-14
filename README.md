[![English](https://img.shields.io/badge/English-README-134538)](README.md) [![한국어](https://img.shields.io/badge/한국어-README-E985A2)](README.ko.md)

# CMDS Zotero
Connect Zotero sources, citations, annotations and literature notes with verified identities and preservation-aware imports.

**0.3.0 development, unreleased.** No GitHub release or Community Plugins listing as of 2026-09-14.

Obsidian 1.7.2+ | Desktop only.

## What it does
- Rebuild a local Better BibTeX index and resolve canonical source/PDF identities.
- Insert citations and bibliography; review references and annotations in sidebars.
- Preview a single literature-note import and preserve human-owned content.
- Find citing notes and opt-in peer-vault references without writing to Zotero.

## Install and first use
For developers/testers only: build the root source, install the three plugin files in a backed-up test vault, start Zotero with Better BibTeX, **Save configuration**, **Test**, then **Refresh citekey index**. Preview and import one sample before any batch operation.

## Read the manual
- [English user guide](docs/guide.md)
- [한국어 사용설명서](docs/guide.ko.md)
- [Web manual](https://apps.cmdspace.work/plugins/cmds-zotero/)
- [Product family](https://apps.cmdspace.work/plugins/)
- [Issues and support](https://github.com/johnfkoo951/cmds-zotero/issues)

## Privacy and limits
No published release or Community installation yet. Root 0.3 features are not the separate 0.4 work. Group libraries, interactive picker acceptance and Hookmark round trips remain environment-specific tests. Existing templates are not drop-in compatible. Batch update does not ask per note.
Citekey completion uses `[@` by default. Completion, tag-exclusion and heading-highlight preferences are not yet exposed in the settings UI.

## Development
```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```
Build the plugin assets for local development.
[Changelog](CHANGELOG.md)

## Credits and license
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. **MIT**, [LICENSE](LICENSE).
