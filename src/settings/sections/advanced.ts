import type { SectionDefinition } from "../model";
import { integerField, secondsField } from "../fields";

/** Requests: timeouts and attachment concurrency (shown under Advanced). */
export const advancedSection: SectionDefinition = {
	id: "advanced",
	advanced: true,
	define(section) {
		section.setName("Requests");
		section.text(secondsField("requestTimeoutMs", 1, 180)).setName("Request timeout").setDesc("Seconds for metadata requests (1–180).");
		section.text(secondsField("attachmentTimeoutMs", 1, 180)).setName("Attachment timeout").setDesc("Seconds for PDF and annotation requests (1–180); uncached images may take longer.");
		section.text(integerField("concurrency", 1, 8)).setName("Parallel requests").setDesc("Bounded attachment request concurrency (1–8).");
	},
};
