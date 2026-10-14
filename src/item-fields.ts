/**
 * 0.6.1: metadata fields of the literature note per Zotero item type (the opt-in "Fields by item type" layout). Pure (no
 * `obsidian` import): it only names fields; note-writer renders and escapes their values.
 */

/** How a value is written: escaped text, escaped text in italics (container titles), or a DOI (verbatim when strict). */
export type FieldKind = "text" | "italic" | "doi";
export interface FieldSpec {
	label: string;
	/** The Zotero field name in the BetterBibTeX JSON export. */
	field: string;
	kind: FieldKind;
}

const text = (label: string, field: string): FieldSpec => ({ label, field, kind: "text" });
const italic = (label: string, field: string): FieldSpec => ({ label, field, kind: "italic" });
const DOI: FieldSpec = { label: "DOI", field: "DOI", kind: "doi" };
const ISBN = text("ISBN", "ISBN");
const PUBLISHER = text("Publisher", "publisher");
const PLACE = text("Location", "place");
const VOLUME = text("Volume", "volume");
const ISSUE = text("Issue", "issue");
const PAGES = text("Pages", "pages");

/** Fields after the item type, in order, for the item types that have their own set. */
export const ITEM_TYPE_FIELDS: Readonly<Record<string, readonly FieldSpec[]>> = {
	journalArticle: [italic("Journal", "publicationTitle"), VOLUME, ISSUE, PAGES, DOI, text("ISSN", "ISSN")],
	magazineArticle: [italic("Magazine", "publicationTitle"), VOLUME, ISSUE, PAGES, text("ISSN", "ISSN")],
	newspaperArticle: [italic("Newspaper", "publicationTitle"), text("Section", "section"), PLACE, PAGES],
	thesis: [text("University", "university"), text("Thesis type", "thesisType"), PLACE, text("Number of pages", "numPages")],
	report: [text("Institution", "institution"), text("Report number", "reportNumber"), text("Report type", "reportType"), text("Series", "seriesTitle"), PLACE, PAGES],
	conferencePaper: [italic("Proceedings", "proceedingsTitle"), text("Conference", "conferenceName"), PUBLISHER, PLACE, VOLUME, PAGES, DOI, ISBN],
	book: [PUBLISHER, PLACE, text("Edition", "edition"), text("Series", "series"), VOLUME, text("Number of pages", "numPages"), ISBN],
	bookSection: [italic("Book", "publicationTitle"), PUBLISHER, PLACE, text("Edition", "edition"), text("Series", "series"), VOLUME, PAGES, ISBN],
	webpage: [text("Website", "websiteTitle"), text("Website type", "websiteType")],
	blogPost: [text("Blog", "blogTitle"), text("Website type", "websiteType")],
	preprint: [text("Repository", "repository"), text("Archive ID", "archiveID"), DOI],
};
/** Item types without their own set: the container and publication fields most types share. */
export const GENERIC_FIELDS: readonly FieldSpec[] = [italic("Publication", "publicationTitle"), VOLUME, ISSUE, PUBLISHER, PLACE, PAGES];
/** Always offered after the type's own fields (DOI and ISBN only when the type's set does not list them). */
const IDENTIFIERS: readonly FieldSpec[] = [DOI, ISBN];
/** Written when present, after the identifiers. The date stays raw, so partial dates such as `2024-05` are kept. */
export const OPTIONAL_FIELDS: readonly FieldSpec[] = [text("Date", "date"), text("Short title", "shortTitle"), text("Language", "language"), text("Accessed", "accessDate")];
/** Written when present, after the Extra lines. */
export const RECORD_DATES: readonly FieldSpec[] = [text("Date added", "dateAdded"), text("Date modified", "dateModified")];

/** The type's own fields followed by the identifiers it does not already list, then the optional fields. */
export function fieldsFor(itemType: string): FieldSpec[] {
	const own = Object.prototype.hasOwnProperty.call(ITEM_TYPE_FIELDS, itemType) ? ITEM_TYPE_FIELDS[itemType] : GENERIC_FIELDS;
	return [...own, ...IDENTIFIERS.filter(spec => !own.some(other => other.field === spec.field)), ...OPTIONAL_FIELDS];
}

const EXTRA_LINE = /^([A-Za-z][A-Za-z0-9 .-]{0,39}?)\s*:\s*(?!\/\/)(\S.*)$/;
/**
 * `key: value` lines of Zotero's Extra field, in order. Other lines, the citation key (shown as Citekey) and repeated
 * keys are left out. Values are raw; the caller escapes labels and values.
 */
export function extraFields(extra: unknown): [label: string, value: string][] {
	if (typeof extra !== "string") return [];
	const seen = new Set<string>();
	const result: [string, string][] = [];
	for (const line of extra.split(/\r?\n/)) {
		const match = EXTRA_LINE.exec(line.trim());
		if (!match) continue;
		const label = match[1].trim();
		const key = label.toLowerCase();
		if (key === "citation key" || seen.has(key)) continue;
		seen.add(key);
		result.push([label, match[2].trim()]);
	}
	return result;
}
