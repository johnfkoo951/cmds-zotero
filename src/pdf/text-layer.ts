/**
 * Does an extracted PDF carry readable text? A scanned PDF (page images only) extracts as empty pages, or as nothing but a
 * publisher watermark repeated on every page; reading it needs OCR, which this plugin does not run.
 * Pure module: no `obsidian` import.
 */
import type { PageText } from "./locate";

/** A page with fewer body characters than this (whitespace excluded) counts as having no text. */
export const MIN_PAGE_BODY_CHARS = 20;

export interface TextLayerReport {
	/** `full`: (nearly) every page has text; `partial`: many pages have none; `none`: no page has body text. */
	textLayer: "full" | "partial" | "none";
	status?: "full" | "partial" | "none";
	/** One-based positions of pages without body text. */
	emptyPages: number[];
	pageCount?: number;
	/** Body characters across the document (whitespace and repeated watermark lines excluded). */
	bodyChars: number;
	/** True when the text layer is missing on the whole document or a large part of it. */
	ocrRecommended: boolean;
}

function lines(text: string): string[] {
	return text.split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}
/** Lines that differ only by page numbers, dates or punctuation (running heads, download stamps) count as one line. */
function repeatKey(line: string): string { return line.replace(/\d+/g, "#").replace(/[^\p{L}#]+/gu, " ").trim().toLowerCase(); }
function visibleLength(line: string): number { return line.replace(/\s/g, "").length; }

/**
 * Classifies the text layer. Lines that repeat across pages (watermarks, running heads, download stamps; compared with
 * digits and punctuation ignored) are not body text: on three or more pages a line repeats when it occurs on at least
 * half of them, on a two-page document when it occurs on both. OCR is recommended when no page, or at least half of the
 * pages, has body text missing; fewer empty pages (figures, blank pages) only make the layer `partial`.
 */
export function textLayerReport(pages: readonly PageText[]): TextLayerReport {
	const pageLines = pages.map(page => lines(page.text));
	const occurrences = new Map<string, number>();
	for (const keys of pageLines.map(list => new Set(list.map(repeatKey)))) for (const key of keys) occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
	const repeatedAt = pages.length >= 3 ? Math.max(3, Math.ceil(pages.length / 2)) : pages.length === 2 ? 2 : Infinity;
	const bodies = pageLines.map(list => list.filter(line => (occurrences.get(repeatKey(line)) ?? 0) < repeatedAt).reduce((sum, line) => sum + visibleLength(line), 0));
	const emptyPages = pages.filter((_, position) => bodies[position] < MIN_PAGE_BODY_CHARS).map(page => page.page);
	const bodyChars = bodies.reduce((sum, chars) => sum + chars, 0);
	const textLayer = !pages.length || emptyPages.length === pages.length ? "none" : emptyPages.length * 2 >= pages.length || emptyPages.length > Math.max(2, pages.length * 0.2) ? "partial" : "full";
	return { textLayer, emptyPages, bodyChars, ocrRecommended: textLayer === "none" || (textLayer === "partial" && emptyPages.length * 2 >= pages.length) };
}

export interface TextLayerSummary {
	textLayer?: "full" | "partial" | "none";
	status?: "full" | "partial" | "none";
	emptyPages: readonly number[];
	pageCount?: number;
	bodyChars?: number;
	ocrRecommended: boolean;
}

/** The warning an agent sees when the text layer is missing; null for a normal text PDF. */
export function textLayerWarning(report: TextLayerReport | TextLayerSummary, pageCount?: number): string | null {
	const kind = ("status" in report && report.status ? report.status : report.textLayer) ?? "full";
	const total = pageCount ?? ("pageCount" in report && typeof report.pageCount === "number" ? report.pageCount : report.emptyPages.length);
	if (kind === "full") return null;
	if (kind === "none") return `No text layer: none of the ${total} pages has extractable body text (a scanned PDF). Run OCR before reading or quoting it; locate cannot verify quotes in it.`;
	return `Partial text layer: ${report.emptyPages.length} of ${total} pages have no extractable body text (figure-only, blank or scanned pages)${report.ocrRecommended ? "; run OCR for them before relying on the text" : "; if those pages are scanned text, run OCR for them"}.`;
}
