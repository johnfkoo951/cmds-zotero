/**
 * The settings tab's areas, in display order. A control is added by editing its area's file under `sections/`; a new
 * area is one more entry here. Sections marked `advanced` render under the one collapsed "Advanced" heading. Pure.
 */
import type { SectionDefinition } from "./model";
import { connectionSection } from "./sections/connection";
import { librarySection } from "./sections/library";
import { citationsSection } from "./sections/citations";
import { notesSection } from "./sections/notes";
import { layoutSection } from "./sections/layout";
import { annotationsSection } from "./sections/annotations";
import { bibliographySection } from "./sections/bibliography";
import { recentSection } from "./sections/recent";
import { vaultsSection } from "./sections/vaults";
import { agentsSection } from "./sections/agents";
import { advancedSection } from "./sections/advanced";

export const SETTINGS_SECTIONS: readonly SectionDefinition[] = [
	connectionSection, librarySection, citationsSection, notesSection, layoutSection, annotationsSection, bibliographySection, recentSection, vaultsSection,
	agentsSection, advancedSection,
];
