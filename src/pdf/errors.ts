/**
 * 0.5 R13/F08: typed failures of PDF text extraction. Pure (no `obsidian` import) so the ingest API can map a code to a
 * failure reason without depending on the live extraction module or on message text.
 */
export type PdfExtractErrorCode =
	/** The plugin was unloaded or reconfigured while the extraction was in flight; nothing was published. */
	| "cancelled"
	/** pdf.js could not be loaded from the host. */
	| "pdfjs-unavailable"
	/** pdf.js could not parse the file (the original message is appended). */
	| "unreadable"
	| "too-many-pages" | "no-pages"
	/** The extracted text does not fit the 32 MiB cache limit. */
	| "cache-too-large"
	/** Extraction produced metadata that fails the cache schema. */
	| "invalid-cache";

export class PdfExtractError extends Error {
	constructor(readonly code: PdfExtractErrorCode, message: string) {
		super(message);
		this.name = "PdfExtractError";
	}
}
