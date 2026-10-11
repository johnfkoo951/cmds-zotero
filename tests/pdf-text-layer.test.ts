import test from "node:test";
import assert from "node:assert/strict";
import { MIN_PAGE_BODY_CHARS, textLayerReport, textLayerWarning } from "../src/pdf/text-layer";

// Synthetic page text only.
const page = (n: number, text: string) => ({ page: n, pageLabel: "", text });
const body = "Synthetic body text that is long enough to count as a real text layer on this page.";
// Real pages differ in words, not only in numbers; a per-page word keeps synthetic bodies distinct after digit folding.
const tag = (n: number): string => `section ${String.fromCharCode(96 + n)}`;

test("a normal text PDF has a full text layer", () => {
	const report = textLayerReport([1, 2, 3, 4].map(n => page(n, `Running head\n${body} ${tag(n)}`)));
	assert.equal(report.textLayer, "full");
	assert.deepEqual(report.emptyPages, []);
	assert.equal(report.ocrRecommended, false);
	assert.equal(textLayerWarning(report, 4), null);
	assert(report.bodyChars > 4 * MIN_PAGE_BODY_CHARS, "a running head is dropped but the body is counted");
});

test("a scan whose only text is a watermark repeated on every page has no text layer", () => {
	const watermark = "Copyright (C) 2002 Example Media www.example.org\nExample Media Co., Ltd.";
	const report = textLayerReport(Array.from({ length: 24 }, (_, i) => page(i + 1, i === 0 ? `${watermark}\n12345` : watermark)));
	assert.equal(report.textLayer, "none");
	assert.equal(report.emptyPages.length, 24);
	assert.equal(report.ocrRecommended, true);
	assert.match(textLayerWarning(report, 24) ?? "", /^No text layer: none of the 24 pages/);
});

test("empty pages, short documents and partial scans are classified", () => {
	assert.equal(textLayerReport([page(1, ""), page(2, "  \n ")]).textLayer, "none");
	assert.equal(textLayerReport([]).textLayer, "none");
	// Two pages: a line on both pages is a stamp (a scanned two-page letter with a watermark), distinct bodies are text.
	assert.equal(textLayerReport([page(1, body), page(2, body)]).textLayer, "none");
	assert.equal(textLayerReport([page(1, `${body} ${tag(1)}`), page(2, `${body} ${tag(2)}`)]).textLayer, "full");
	assert.equal(textLayerReport([page(1, body)]).textLayer, "full", "a single page is never reduced by repetition");
	const mixed = [...[1, 2, 3, 4, 5, 6].map(n => page(n, `${body} ${tag(n)}`)), ...[7, 8, 9, 10].map(n => page(n, ""))];
	const partial = textLayerReport(mixed);
	assert.equal(partial.textLayer, "partial");
	assert.deepEqual(partial.emptyPages, [7, 8, 9, 10]);
	assert.match(textLayerWarning(partial, 10) ?? "", /^Partial text layer: 4 of 10 pages/);
	const oneBlank = textLayerReport([...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => page(n, `${body} ${tag(n)}`)), page(10, "")]);
	assert.equal(oneBlank.textLayer, "full", "one figure-only or blank page is normal");
});

test("stamps that differ only by page number or date still count as repeated, and a two-page scan is caught", () => {
	const stamped = Array.from({ length: 8 }, (_, i) => page(i + 1, `Downloaded by Example University at 10:2${i} 12 March 2016 | p. ${i + 5}`));
	const report = textLayerReport(stamped);
	assert.equal(report.textLayer, "none", "a download stamp with a changing page number is not body text");
	assert.equal(report.ocrRecommended, true);
	const twoPageScan = textLayerReport([page(1, "Copyright (C) 2002 Example Media www.example.org"), page(2, "Copyright (C) 2002 Example Media www.example.org")]);
	assert.equal(twoPageScan.textLayer, "none");
	const twoPageText = textLayerReport([page(1, `Example Journal 12(3)\n${body} one`), page(2, `Example Journal 12(3)\n${body} two`)]);
	assert.equal(twoPageText.textLayer, "full", "the shared header goes, the body stays");
});

test("figure-only pages make a text PDF partial without recommending OCR; mostly empty documents recommend it", () => {
	const figures = [...[1, 2, 3, 4, 5, 6, 7, 8].map(n => page(n, `${body} ${tag(n)}`)), ...[9, 10, 11, 12].map(n => page(n, ""))];
	const report = textLayerReport(figures);
	assert.equal(report.textLayer, "partial");
	assert.equal(report.ocrRecommended, false);
	assert.match(textLayerWarning(report, 12) ?? "", /figure-only, blank or scanned pages\); if those pages are scanned text, run OCR for them\.$/);
	const mostlyScanned = textLayerReport([...[1, 2, 3].map(n => page(n, `${body} ${tag(n)}`)), ...[4, 5, 6, 7, 8, 9].map(n => page(n, ""))]);
	assert.equal(mostlyScanned.ocrRecommended, true);
	assert.match(textLayerWarning(mostlyScanned, 9) ?? "", /; run OCR for them before relying on the text\.$/);
});
