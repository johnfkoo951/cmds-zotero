import type { SectionDefinition } from "../model";
import { ANNOTATION_COLORS } from "../../annotations/colors";
import { choiceField } from "../fields";

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
	},
};
