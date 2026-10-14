/**
 * 0.6.2 opening a PDF at a citation's locator. A locator such as `p. 33` is a printed page label; Zotero's open-pdf link
 * takes a 1-based page position. The index knows a label's position only where an annotation sits on that page, so for
 * each PDF attachment the page comes from, in order: an annotation on a page with exactly that label, the offset between
 * numeric labels and positions when all annotated pages agree on one, or the number itself read as a page position.
 * Pure: never imports `obsidian`.
 */
import type { Attachment } from "../types";
import { isPageLocator, type Locator } from "./cluster";

export type PageSource = "label" | "offset" | "number";

export interface LocatorPage { attachmentKey: string; page: number; source: PageSource }

/** The first page of a locator value (`33–35, 38` → `33`, `xii` → `xii`). */
export function firstPageLabel(value: string): string {
	return value.trim().split(/\s*[-–—,]\s*/)[0] ?? "";
}

/** The page of `locator` in one attachment, or null when it cannot be told (not a page locator, or a non-numeric label without an annotation on it). */
export function locatorPageIn(attachment: Pick<Attachment, "key" | "annotations">, locator: Locator): LocatorPage | null {
	if (!isPageLocator(locator)) return null;
	const label = firstPageLabel(locator.value);
	if (!label) return null;
	const exact = attachment.annotations.find(annotation => annotation.pageLabel === label && annotation.page > 0);
	if (exact) return { attachmentKey: attachment.key, page: exact.page, source: "label" };
	if (!/^\d+$/.test(label)) return null;
	const number = Number(label);
	const offsets = new Set(attachment.annotations.filter(annotation => /^\d+$/.test(annotation.pageLabel) && annotation.page > 0).map(annotation => annotation.page - Number(annotation.pageLabel)));
	if (offsets.size === 1) {
		const offset = [...offsets][0];
		if (number + offset > 0) return { attachmentKey: attachment.key, page: number + offset, source: offset === 0 ? "label" : "offset" };
	}
	return number > 0 ? { attachmentKey: attachment.key, page: number, source: "number" } : null;
}

/** What the Notice says about how the page was found. */
export function pageSourceText(page: LocatorPage, label: string): string {
	if (page.source === "label") return `Opened at the page labelled ${label} (page ${page.page} of the PDF).`;
	if (page.source === "offset") return `Opened at page ${page.page} of the PDF: the annotated pages put printed page ${label} there.`;
	return `No annotation tells where printed page ${label} is, so ${label} was read as the PDF's page ${page.page}, counting from 1; the printed page may differ.`;
}
