import type { SectionDefinition } from "../model";
import { ANNOTATION_COLORS } from "../../annotations/colors";
import { choiceField, integerField } from "../fields";

const COLOR_LABELS: Record<typeof ANNOTATION_COLORS[number], string> = { yellow: "Yellow", red: "Red", green: "Green", blue: "Blue", purple: "Purple", magenta: "Magenta", orange: "Orange", gray: "Gray" };

/** Annotations: how imported highlights are laid out. */
export const annotationsSection: SectionDefinition = {
	id: "annotations",
	define(section) {
		section.setName("Annotations");
		const color = section.dropdown(choiceField("headingHighlightColor", ["none", ...ANNOTATION_COLORS])).setName("Heading highlight color")
			.setDesc("Highlights in this Zotero color become ##### headings in imported notes, for structural reading. None keeps every highlight as a callout.")
			.addOption("none", "None");
		for (const name of ANNOTATION_COLORS) color.addOption(name, COLOR_LABELS[name]);
		// 0.6.1 follow-zotero-selection: polling only, never a listener; a failed read pauses it for a minute.
		section.dropdown(choiceField("followZoteroSelection", ["off", "focus", "interval"])).setName("Follow the Zotero selection")
			.setDesc("While the annotations sidebar follows the Zotero selection, read the item selected in Zotero again when Obsidian's window gets focus, or also every few seconds while the sidebar is visible. Off reads it only when you ask. A failed read pauses following for a minute.")
			.addOption("off", "Off (read when asked)").addOption("focus", "On window focus").addOption("interval", "On focus and every few seconds");
		section.text(integerField("followZoteroSelectionSeconds", 3, 30)).setName("Selection check interval")
			.setDesc("Seconds between reads of the Zotero selection when following every few seconds (3–30).");
	},
};
