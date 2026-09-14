[![English](https://img.shields.io/badge/English-README-134538)](README.md) [![한국어](https://img.shields.io/badge/한국어-README-E985A2)](README.ko.md)

# CMDS Zotero
Connect Zotero sources, citations, annotations and literature notes with verified identities and preservation-aware imports.

**Public source: 0.2.0. Local 0.3.0 development: not yet published.** No GitHub release or Community Plugins listing as of 2026-09-14.

Obsidian 1.7.2+ | Desktop only.

## 0.3 development preview
- Rebuild a local Better BibTeX index and resolve canonical source/PDF identities.
- Insert citations and bibliography; review references and annotations in sidebars.
- Preview a single literature-note import and preserve human-owned content.
- Find citing notes and opt-in peer-vault references without writing to Zotero.

## Install and first use
Public `main` currently builds **0.2.0**, not the local 0.3 implementation described in the manual. Use the [public 0.2 baseline guide](https://github.com/johnfkoo951/cmds-zotero/blob/b58adb733bcd5bc0734ca2f31d6cb420fd8e8fbe/README.md) when trying the available source. There is no public 0.3 install path yet; the 0.3 manual is a development preview, not a promise that public-clone builds include those features.

## Read the manual
- [English user guide](docs/guide.md)
- [한국어 사용설명서](docs/guide.ko.md)
- [Web manual](https://apps.cmdspace.work/plugins/cmds-zotero/)
- [Product family](https://apps.cmdspace.work/plugins/)
- [Issues and support](https://github.com/johnfkoo951/cmds-zotero/issues)

## Privacy and limits
No published release or Community installation yet. Unpublished local 0.3 features are not the separate 0.4 work. Group libraries, interactive picker acceptance and Hookmark round trips remain environment-specific tests. Existing templates are not drop-in compatible. Batch update does not ask per note.
Citekey completion uses `[@` by default. Completion, tag-exclusion and heading-highlight preferences are not yet exposed in the settings UI.

## Development
```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```
These commands build whichever checkout you actually have. Public `main` is 0.2.0; they do not fetch unpublished 0.3 code.
[Changelog](CHANGELOG.md)

## Credits and license
**Yohan Koo (CMDSPACE)**, https://cmdspace.work. **MIT**, [LICENSE](LICENSE).
