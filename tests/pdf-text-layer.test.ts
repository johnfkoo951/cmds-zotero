import test from "node:test";
import assert from "node:assert/strict";
import { MIN_PAGE_BODY_CHARS, textLayerReport, textLayerWarning } from "../src/pdf/text-layer";

// Synthetic page text only.
const page = (n: number, text: string) => ({ page: n, pageLabel: "", text });
const body = "Synthetic body text that is long enough to count as a real text layer on this page.";

test("a normal text PDF has a full text layer", () => {
	const report = textLayerReport([1, 2, 3, 4].map(n => page(n, `Running head\n${body} ${n}`)));
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
	// Two pages: no repeated-line removal, so identical short pages still count as text when long enough.
	assert.equal(textLayerReport([page(1, body), page(2, body)]).textLayer, "full");
	const mixed = [...[1, 2, 3, 4, 5, 6].map(n => page(n, `${body} ${n}`)), ...[7, 8, 9, 10].map(n => page(n, ""))];
	const partial = textLayerReport(mixed);
	assert.equal(partial.textLayer, "partial");
	assert.deepEqual(partial.emptyPages, [7, 8, 9, 10]);
	assert.match(textLayerWarning(partial, 10) ?? "", /^Partial text layer: 4 of 10 pages/);
	const oneBlank = textLayerReport([...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => page(n, `${body} ${n}`)), page(10, "")]);
	assert.equal(oneBlank.textLayer, "full", "one figure-only or blank page is normal");
});
