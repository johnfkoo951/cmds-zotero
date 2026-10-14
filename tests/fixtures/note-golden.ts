// Synthetic records only: the literature notes the 0.6.0 renderer wrote for these entries are pinned as golden files
// (tests/fixtures/golden/*.md) so new layout options can prove that default settings reproduce them byte for byte.
import type { Annotation, ZoteroIndexEntry } from "../../src/types";

const annotation = (key: string, extra: Partial<Annotation>): Annotation => ({
	key, attachmentKey: "ATTACH01", type: "highlight", text: "", comment: "", color: "#ffd400", page: 1, pageLabel: "1", version: 1,
	uri: `zotero://open-pdf/library/items/ATTACH01?page=1&annotation=${key}`, tags: [], dateModified: "2026-03-01T10:00:00Z", ...extra,
});

export const GOLDEN_IMAGE_SOURCE = "/synthetic/cache/IMAGE001.png";
export const GOLDEN_IMAGE_HASHES: ReadonlyMap<string, string> = new Map([[GOLDEN_IMAGE_SOURCE, "a".repeat(64)]]);
export const GOLDEN_BIBLIOGRAPHY = "Author, A., & Writer, B. (2026). Synthetic evidence (part 1). Journal of Examples, 4(2), 10–20. https://doi.org/10.1234/example_(2026).";

const base = {
	libraryID: 1, libraryType: "user" as const, citekeyHistory: [], attachmentPath: "", attachmentStatus: "complete" as const, contentHash: "",
};

export const GOLDEN_ENTRIES: Record<string, ZoteroIndexEntry> = {
	"journal-article": {
		...base, id: "1:ITEM0001", itemKey: "ITEM0001", citekey: "Author2026", title: "Synthetic evidence (part 1): a *starred* study",
		authors: ["Author, A.", "Writer, B."], year: "2026", doi: "10.1234/example_(2026)", url: "https://doi.org/10.1234/example_%25282026%2529",
		collections: ["Reading/Methods", "자기효능감"], tags: ["method", "self efficacy", "obscite", "자기 효능감"], zoteroSelectURI: "zotero://select/library/items/ITEM0001",
		attachments: [{
			key: "ATTACH01", openURI: "zotero://open-pdf/library/items/ATTACH01", path: "/synthetic/papers/Author 2026.pdf", title: "Full text PDF",
			annotations: [
				annotation("ANNOT001", { text: "First highlighted claim.", comment: "Why it matters", color: "#ffd400", page: 3, pageLabel: "3", tags: ["theme", "질문"], sortIndex: "00002|000100|00010" }),
				annotation("ANNOT002", { type: "underline", text: "An underlined line", color: "#2ea8e5", page: 4, pageLabel: "iv", sortIndex: "00003|000010|00010" }),
				annotation("ANNOT003", { type: "note", comment: "A sticky note\nacross lines", color: "#5fb236", page: 5, pageLabel: "5", sortIndex: "00004|000010|00010" }),
				annotation("ANNOT004", { type: "ink", color: "#ff6666", page: 6, pageLabel: "-", sortIndex: "00005|000010|00010" }),
				annotation("ANNOT005", { type: "image", color: "#a28ae5", page: 7, pageLabel: "7", imagePath: GOLDEN_IMAGE_SOURCE, comment: "Figure 2", sortIndex: "00006|000010|00010" }),
				annotation("ANNOT006", { text: "Section heading", color: "#aaaaaa", page: 8, pageLabel: "8", comment: "heading note", sortIndex: "00007|000010|00010" }),
				annotation("ANNOT007", { text: "Uncoloured text [with] brackets", color: "", page: 9, pageLabel: "9", sortIndex: "00008|000010|00010" }),
			],
		}],
		metadata: {
			itemType: "journalArticle", publicationTitle: "Journal of Examples", volume: "4", issue: "2", pages: "10-20", DOI: "10.1234/example_(2026)",
			abstractNote: "<p>An abstract with &amp; entities and <b>bold</b> text.</p><p>Second paragraph.</p>",
			creators: [
				{ creatorType: "author", lastName: "Author", firstName: "A." },
				{ creatorType: "author", lastName: "Writer", firstName: "B." },
				{ creatorType: "editor", name: "Example Editors Group" },
			],
			notes: [{ note: "<h1>Reading note</h1><p>Point one.</p>" }, { note: "<p>Second note</p>" }],
		},
	},
	"book-section": {
		...base, id: "1:ITEM0002", itemKey: "ITEM0002", citekey: "Chapter2025", title: "A chapter on synthesis", authors: ["Chapter, C."], year: "2025",
		doi: "", url: "", collections: [], tags: [], zoteroSelectURI: "zotero://select/library/items/ITEM0002", attachments: [],
		metadata: {
			itemType: "bookSection", publicationTitle: "Handbook of Examples", publisher: "Example Press", place: "Seoul", pages: "101-130", ISBN: "978-0-00-000000-0",
			creators: [{ creatorType: "author", lastName: "Chapter", firstName: "C." }, { creatorType: "editor", lastName: "Editor", firstName: "E." }],
		},
	},
	thesis: {
		...base, id: "1:ITEM0003", itemKey: "ITEM0003", citekey: "Student2024", title: "A thesis about examples", authors: ["Student, S."], year: "2024",
		doi: "", url: "https://example.org/thesis", collections: ["Theses"], tags: ["dissertation"], zoteroSelectURI: "zotero://select/library/items/ITEM0003", attachments: [],
		metadata: {
			itemType: "thesis", university: "Example University", thesisType: "PhD dissertation", place: "Example City", date: "2024-05",
			creators: [{ creatorType: "author", lastName: "Student", firstName: "S." }, { creatorType: "contributor", lastName: "Advisor", firstName: "A." }],
		},
	},
	"web-page": {
		...base, id: "1:ITEM0004", itemKey: "ITEM0004", citekey: "Site2023", title: "An example web page", authors: ["Site Team"], year: "2023",
		doi: "", url: "https://example.org/page?x=1&y=2", collections: [], tags: [], zoteroSelectURI: "zotero://select/library/items/ITEM0004", attachments: [],
		metadata: { itemType: "webpage", websiteTitle: "Example Site", accessDate: "2023-01-02T03:04:05Z" },
	},
	preprint: {
		...base, id: "1:ITEM0005", itemKey: "ITEM0005", citekey: "Draft2026", title: "A preprint", authors: ["Draft, D."], year: "2026",
		doi: "10.48550/arXiv.2601.00001", url: "", collections: [], tags: [], zoteroSelectURI: "zotero://select/library/items/ITEM0005", attachments: [],
		metadata: { itemType: "preprint", repository: "arXiv", archiveID: "arXiv:2601.00001", DOI: "10.48550/arXiv.2601.00001", extra: "Citation Key: Draft2026\nOriginal Date: 2025" },
	},
};

export const GOLDEN_RELATED: Record<string, string[]> = { "journal-article": ["Chapter2025", "Student2024"] };

/**
 * 0.6.1 review: Zotero rich text in a title and in annotations. tests/fixtures/golden/rich-text.md is what the 0.6.0
 * renderer wrote for it; with "Zotero rich text" off (the default) the note must stay byte-identical.
 */
export const RICH_TEXT_ENTRY: ZoteroIndexEntry = {
	...base, id: "1:ITEM0006", itemKey: "ITEM0006", citekey: "Rich2026", title: "The <i>E. coli</i> genome in a <span class=\"nocase\">iPhone</span> study of H<sub>2</sub>O",
	authors: ["Rich, R."], year: "2026", doi: "", url: "", collections: [], tags: [], zoteroSelectURI: "zotero://select/library/items/ITEM0006",
	attachments: [{
		key: "ATTACH01", openURI: "zotero://open-pdf/library/items/ATTACH01", path: "/synthetic/papers/Rich 2026.pdf", title: "Full text PDF",
		annotations: [
			annotation("ANNOT001", { text: "a <i>species</i> name", comment: "see <b>this</b>", page: 2, pageLabel: "2", sortIndex: "00001|000100|00010" }),
			annotation("ANNOT002", { type: "note", comment: "x<sup>2</sup><br>next", color: "#5fb236", page: 3, pageLabel: "3", sortIndex: "00002|000100|00010" }),
			annotation("ANNOT003", { type: "ink", comment: "<i>drawn</i>", color: "#ff6666", page: 4, pageLabel: "4", sortIndex: "00003|000100|00010" }),
			annotation("ANNOT004", { text: "<b>Methods</b>", color: "#aaaaaa", page: 5, pageLabel: "5", sortIndex: "00004|000100|00010" }),
		],
	}],
	metadata: { itemType: "journalArticle", publicationTitle: "Journal of Examples", creators: [{ creatorType: "author", lastName: "Rich", firstName: "R." }] },
};
