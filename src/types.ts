export interface PeerVault {
	name: string;
	path: string;
}

export type CitationTrigger = "bracket" | "at" | "off";

export interface CmdsZoteroSettings {
	bbtEndpoint: string;
	zoteroIndexPath: string;
	caywFormat: string;
	requestTimeoutMs: number;
	attachmentTimeoutMs: number;
	concurrency: number;
	indexMaxAgeMinutes: number;
	outputFolder: string;
	imageFolder: string;
	bibliographyStyle: string;
	peerVaults: PeerVault[];
	citationTrigger: CitationTrigger;
	excludedTags: string[];
	headingHighlightColor: string;
	referencesFollowActiveNote: boolean;
	// 0.5 R10: headings that mark a note's References section (case-insensitive; whitespace inside a title is flexible).
	referencesHeadings: string[];
	/** Days of Zotero reading history "Send recently read papers to notes" lists (1–365). */
	recentReadsDays: number;
	/**
	 * 0.6 OPT-10: parallel requests during an index refresh (attachment batches, per-library and collection searches), apart
	 * from `concurrency` (export batches, bibliography and other reads). 1–8; an older settings file derives it from
	 * `concurrency` (twice the value, at most 8: the 0.6 wave-1 behaviour).
	 */
	collectConcurrency: number;
	/**
	 * 0.6 OPT-14: seconds "Insert citation from Zotero" waits for a pick in Zotero's citation picker, apart from the request
	 * timeout (30–1800). Running out of it, or Cancel, is not a Better BibTeX failure.
	 */
	pickerWaitSeconds: number;
}

// 0.5 R10: default References headings; an empty configured list falls back to these.
export const DEFAULT_REFERENCES_HEADINGS: readonly string[] = ["References", "Bibliography", "Works Cited", "참고 문헌", "참고 자료"];

export const DEFAULT_SETTINGS: CmdsZoteroSettings = {
	bbtEndpoint: "http://127.0.0.1:23119/better-bibtex",
	zoteroIndexPath: "80. References/zotero-index.json",
	caywFormat: "pandoc",
	requestTimeoutMs: 20000,
	attachmentTimeoutMs: 60000,
	concurrency: 2,
	indexMaxAgeMinutes: 60,
	outputFolder: "References/Zotero",
	imageFolder: "References/Zotero/images",
	bibliographyStyle: "apa",
	peerVaults: [],
	citationTrigger: "bracket",
	excludedTags: ["obscite"],
	headingHighlightColor: "gray",
	referencesFollowActiveNote: true,
	referencesHeadings: [...DEFAULT_REFERENCES_HEADINGS], // 0.5 R10
	recentReadsDays: 30,
	collectConcurrency: 4, // 0.6 OPT-10: twice the default concurrency, as refreshes have run since wave 1
	pickerWaitSeconds: 600, // 0.6 OPT-14: ten minutes
};

export interface ItemIdentity {
	libraryID: number;
	libraryType: "user" | "group";
	groupID?: number;
	itemKey: string;
}

export interface Annotation {
	key: string;
	attachmentKey: string;
	type: string;
	text: string;
	comment: string;
	color: string;
	page: number;
	pageLabel: string;
	version: number;
	uri: string;
	imagePath?: string;
	tags: string[];
	dateModified: string;
	/** Zotero's `annotationSortIndex` (page|offset|top), when Better BibTeX reports it; orders blocks for reading. */
	sortIndex?: string;
}

/**
 * Additive (0.6): an annotation made in Zotero's EPUB or web-snapshot reader. Such annotations have no PDF page: their
 * position is an EPUB CFI (`FragmentSelector`) or a CSS selector (`CssSelector`), kept as Zotero reports it. They live
 * beside `annotations` so readers of the PDF contract (0.5 and the offline core) keep seeing only PDF annotations.
 */
export interface ReaderAnnotation {
	key: string;
	attachmentKey: string;
	type: string;
	text: string;
	comment: string;
	color: string;
	pageLabel: string;
	version: number;
	/** `zotero://select/<library|groups/N>/items/<attachmentKey>`: open-pdf links are used for PDF annotations only. */
	uri: string;
	tags: string[];
	dateModified: string;
	sortIndex?: string;
	imagePath?: string;
	/** Zotero's position object (`type` names the selector; `value` holds the CFI or CSS selector). */
	position: Record<string, unknown>;
}

export interface Attachment {
	key: string;
	openURI: string;
	path: string | null;
	title: string;
	annotations: Annotation[];
	/**
	 * Additive (0.4): the MIME type when Better BibTeX reports one (`contentType`, or the BBT JSON `mimeType` since 0.6);
	 * lets a null-path PDF be told apart from an EPUB or a snapshot. `attachmentFormat()` also reads the file extension.
	 */
	contentType?: string;
	filename?: string;
	/** Additive (0.6): EPUB and snapshot annotations; absent when the attachment has none. */
	readerAnnotations?: ReaderAnnotation[];
}

export interface ZoteroIndexEntry extends ItemIdentity {
	id: string;
	citekey: string;
	citekeyHistory: string[];
	title: string;
	authors: string[];
	year: string;
	doi: string;
	url: string;
	collections: string[];
	tags: string[];
	attachmentPath: string;
	zoteroSelectURI: string;
	attachments: Attachment[];
	attachmentStatus: "complete" | "unavailable";
	contentHash: string;
	metadata: Record<string, unknown>;
}

export interface Capabilities {
	zotero: string;
	betterbibtex: string;
	metadata: boolean;
	attachments: boolean;
	annotations: boolean;
	bibliography: boolean;
}

export interface Diagnostic {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	itemID?: string;
	citekey?: string;
}

/**
 * Additive (0.6): one Zotero library as a refresh saw it (`user.groups` plus its parent-item search). Readers of an older
 * index find the field absent; readers must skip elements they cannot read (see `indexLibraries()`).
 */
export interface IndexLibrary {
	libraryID: number;
	name: string;
	/** `user` (library 1), `group` (item URIs under /groups/N/), `feed` (items only without the feed filter), `unknown` (empty or unreadable). */
	kind: "user" | "group" | "feed" | "unknown";
	groupID?: number;
	/** Parent items Better BibTeX listed in this library during the refresh (feed items are not counted). */
	items: number;
	/** Entries of this library in the index, previous entries kept for skipped items included. */
	indexed: number;
}

/** Additive (0.6): one collection of an indexed library, flat; `parentKey` is null at the library root. */
export interface IndexCollection {
	libraryID: number;
	key: string;
	name: string;
	parentKey: string | null;
	/** Ids of index entries filed directly in this collection (not in subcollections); absent when membership could not be read. */
	items?: string[];
}

export interface ZoteroIndex {
	schemaVersion: 2;
	generatedAt: string;
	source: "better-bibtex";
	count: number;
	entries: ZoteroIndexEntry[];
	capabilities: Capabilities;
	diagnostics: Diagnostic[];
	complete: boolean;
	/** Additive (0.6): the libraries Better BibTeX listed; absent from older indexes and when `user.groups` was unavailable. */
	libraries?: IndexLibrary[];
	/** Additive (0.6): every collection of the listed libraries with its direct members; absent when the tree was unavailable. */
	collections?: IndexCollection[];
	/** Additive (0.6): sorted ids of entries Zotero marks as retracted; absent when the flag could not be read. */
	retracted?: string[];
}

export type Resolution =
	| { status: "resolved"; entry: ZoteroIndexEntry; matchedHistory: boolean }
	| { status: "ambiguous"; candidates: ZoteroIndexEntry[] }
	| { status: "not-found" }
	| { status: "unavailable"; message: string };

export interface IndexStorage {
	read(): Promise<string | null>;
	writeValidated(content: string): Promise<void>;
	/** Cheap change detector for the persisted index (size + mtime); undefined when unsupported. */
	fingerprint?(): Promise<string | undefined>;
}
