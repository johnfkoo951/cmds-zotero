import { Notice } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import type { Annotation, ZoteroIndexEntry } from "../types";
import { annotationInsertText, type InsertMode } from "../annotations/search";

/**
 * The text inserting an annotation writes (0.6.1). A callout of an image annotation first copies the image to the path
 * the import uses (new file only); when that copy fails the callout links the PDF location instead and a Notice says why.
 */
export async function annotationText(plugin: CMDSZoteroPlugin, entry: ZoteroIndexEntry, annotation: Annotation, mode: InsertMode): Promise<string> {
	let image: string | undefined;
	if (mode === "callout" && annotation.imagePath) {
		try { image = await plugin.importer.copyAnnotationImage(entry, annotation); }
		catch (error) { new Notice(`The annotation image was not copied, so a link was inserted instead: ${error instanceof Error ? error.message : String(error)}`); }
	}
	return annotationInsertText(mode, annotation, entry, plugin.settings, image);
}
