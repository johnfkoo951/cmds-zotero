export interface PeerVault {
	name: string;
	path: string;
}

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
}

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
}

export interface Attachment {
	key: string;
	openURI: string;
	path: string | null;
	title: string;
	annotations: Annotation[];
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

export interface ZoteroIndex {
	schemaVersion: 2;
	generatedAt: string;
	source: "better-bibtex";
	count: number;
	entries: ZoteroIndexEntry[];
	capabilities: Capabilities;
	diagnostics: Diagnostic[];
	complete: boolean;
}

export type Resolution =
	| { status: "resolved"; entry: ZoteroIndexEntry; matchedHistory: boolean }
	| { status: "ambiguous"; candidates: ZoteroIndexEntry[] }
	| { status: "not-found" }
	| { status: "unavailable"; message: string };

export interface IndexStorage {
	read(): Promise<string | null>;
	writeValidated(content: string): Promise<void>;
}
