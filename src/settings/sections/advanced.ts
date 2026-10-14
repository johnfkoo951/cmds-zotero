import type { SectionDefinition } from "../model";
import { integerField, secondsField } from "../fields";

/** Requests: timeouts and how many requests go to Zotero at once (shown under Advanced). */
export const advancedSection: SectionDefinition = {
	id: "advanced",
	advanced: true,
	define(section) {
		section.setName("Requests");
		section.text(secondsField("requestTimeoutMs", 1, 180)).setName("Request timeout").setDesc("Seconds for metadata requests (1–180).");
		section.text(secondsField("attachmentTimeoutMs", 1, 180)).setName("Attachment timeout").setDesc("Seconds for PDF and annotation requests (1–180); uncached images may take longer.");
		section.text(integerField("concurrency", 1, 8)).setName("Parallel requests").setDesc("Requests sent to Zotero at once for item exports, bibliographies and reading history (1–8).");
		section.text(integerField("collectConcurrency", 1, 8)).setName("Refresh requests").setDesc("Requests sent to Zotero at once while the index is refreshed, such as attachment and annotation reads (1–8). Lower it if Zotero slows down during a refresh.");
	},
};
