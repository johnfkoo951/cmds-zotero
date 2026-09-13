import { App, loadPdfJs } from "obsidian";
import { constants, promises as fs } from "fs";
import { isAbsolute, resolve } from "path";
import { createHash } from "crypto";
import { joinTextItems, type PageText, type TextItem } from "./locate";
import { assertVaultBoundary, ensureDirectory } from "../vault-storage";

export const MAX_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_PAGES = 2000;
export const PDF_TEXT_CACHE_DIR = ".cmds-zotero/pdf-text";

export interface ExtractedPdf {
	version: 1;
	sha256: string;
	bytes: number;
	pageCount: number;
	extractedAt: string;
	pages: PageText[];
}

/** Read-only, symlink-refusing read of a local PDF path supplied by the index; never a URL or a directory scan. */
export async function readLocalPdf(source: string): Promise<Uint8Array> {
	if (!isAbsolute(source) || source.includes("\0")) throw new Error("PDF attachment must have an absolute local path");
	const absolute = resolve(source);
	if (await fs.realpath(absolute) !== absolute) throw new Error("Symlinked PDF path refused");
	const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("PDF path is not a regular file");
		if (stat.size < 8) throw new Error("PDF file is empty");
		if (stat.size > MAX_PDF_BYTES) throw new Error(`PDF exceeds the ${MAX_PDF_BYTES / 1024 / 1024} MiB extraction limit`);
		const bytes = new Uint8Array(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!read.bytesRead) throw new Error("PDF changed during read");
			offset += read.bytesRead;
		}
		if (Buffer.from(bytes.slice(0, 5)).toString("latin1") !== "%PDF-") throw new Error("File is not a PDF");
		return bytes;
	} finally { await handle.close(); }
}

export class PdfTextService {
	private flights = new Map<string, Promise<ExtractedPdf>>();
	constructor(private app: App) {}

	private cachePath(scope: string, attachmentKey: string, sha256: string): string {
		return `${PDF_TEXT_CACHE_DIR}/${scope}-${attachmentKey}-${sha256.slice(0, 16)}.json`;
	}

	/** Per-page text for one attachment; cached by content hash so a re-downloaded or annotated PDF re-extracts. */
	extract(path: string, scope: string, attachmentKey: string): Promise<ExtractedPdf> {
		const key = `${scope}:${attachmentKey}:${path}`;
		const flight = this.flights.get(key);
		if (flight) return flight;
		const request = this.extractNow(path, scope, attachmentKey).finally(() => { this.flights.delete(key); });
		this.flights.set(key, request);
		return request;
	}

	private async extractNow(path: string, scope: string, attachmentKey: string): Promise<ExtractedPdf> {
		if (!/^[A-Z0-9]{8}$/.test(attachmentKey) || !/^[a-z]+-\d+$/.test(scope)) throw new Error("Invalid attachment identity for PDF text cache");
		const bytes = await readLocalPdf(path);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const cache = this.cachePath(scope, attachmentKey, sha256);
		await assertVaultBoundary(this.app, cache);
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(cache)) {
			try {
				const parsed: unknown = JSON.parse(await adapter.read(cache));
				if (parsed && typeof parsed === "object" && (parsed as ExtractedPdf).version === 1 && (parsed as ExtractedPdf).sha256 === sha256 && Array.isArray((parsed as ExtractedPdf).pages)) return parsed as ExtractedPdf;
			} catch { /* rebuild a damaged cache */ }
		}
		const pdfjs = await loadPdfJs() as { getDocument: (options: Record<string, unknown>) => { promise: Promise<PdfDocument> } };
		const doc = await pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, useSystemFonts: false, stopAtErrors: false }).promise;
		try {
			if (doc.numPages > MAX_PDF_PAGES) throw new Error(`PDF has ${doc.numPages} pages; the extraction limit is ${MAX_PDF_PAGES}`);
			let labels: (string | null)[] | null = null;
			try { labels = await doc.getPageLabels(); } catch { labels = null; }
			const pages: PageText[] = [];
			for (let n = 1; n <= doc.numPages; n++) {
				const page = await doc.getPage(n);
				const content = await page.getTextContent();
				const label = labels?.[n - 1];
				pages.push({ page: n, pageLabel: typeof label === "string" && label !== String(n) ? label : "", text: joinTextItems(content.items as TextItem[]) });
				page.cleanup?.();
			}
			const extracted: ExtractedPdf = { version: 1, sha256, bytes: bytes.length, pageCount: doc.numPages, extractedAt: new Date().toISOString(), pages };
			await ensureDirectory(this.app, cache);
			await adapter.write(cache, JSON.stringify(extracted));
			return extracted;
		} finally { await doc.destroy(); }
	}
}

interface PdfDocument {
	numPages: number;
	getPageLabels(): Promise<(string | null)[] | null>;
	getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup?: () => void }>;
	destroy(): Promise<void>;
}
