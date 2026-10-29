import { DEFAULT_SETTINGS, type AnnotationTagStyle, type CitationFormatSetting, type CitationTrigger, type CmdsZoteroSettings } from "./types";
import { isAnnotationColor } from "./annotations/colors";
import { annotationsHeading, calloutType, synthesisLines } from "./layout";
import { canonicalLocale, dataDirectoryProblem, localeProblem } from "./bibliography/rules";

/** 0.6.2: the stored names of the fixed citation formats (the same list as citations/formats.ts, kept here so the offline core stays small). */
export const CITATION_FORMAT_SETTINGS: readonly CitationFormatSetting[] = ["pandoc", "narrative", "wikilink", "author-date", "zotero-link", "note-link"];
import { notePatternProblem } from "./note-path";

function integer(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function flag(value: unknown, fallback: boolean): boolean { return typeof value === "boolean" ? value : fallback; }

/** 0.6.5: the default Index path before 0.6.5; an install that never stored an Index path keeps an index already there. */
export const LEGACY_DEFAULT_INDEX_PATH = "80. References/zotero-index.json";

/** 0.6.5: true when stored settings name an Index path of their own, by the same rule `normalizeSettings` applies. */
export function storesIndexPath(raw: unknown): boolean {
	return !!raw && typeof raw === "object" && text((raw as Record<string, unknown>).zoteroIndexPath, "") !== "";
}

/** 0.6.5: the stored settings with the pre-0.6.5 Index path written in (saved once, so the index never moves later). */
export function withLegacyIndexPath(raw: unknown): Record<string, unknown> {
	const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	return { ...data, zoteroIndexPath: LEGACY_DEFAULT_INDEX_PATH };
}
/** 0.6.6: a pandoc path is empty (look in the usual places), absolute, or under `~/`. */
export function pandocPathProblem(value: string): string | null {
	const text = value.trim();
	if (!text) return null;
	if (text.includes("\0")) return "The path contains a NUL character.";
	if (!(text.startsWith("/") || text.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(text))) return "Enter the full path to pandoc, for example /opt/homebrew/bin/pandoc, or leave it empty.";
	return null;
}

function text(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value.trim() : fallback; }

/**
 * 0.6 OPT-10: the refresh concurrency a settings file without `collectConcurrency` gets: `concurrency` itself, the value
 * 0.5 bounded attachment reads with, so a user who lowered Parallel requests for a slow Zotero keeps that bound. Fresh
 * installs get DEFAULT_SETTINGS.collectConcurrency.
 */
export function defaultCollectConcurrency(concurrency: number): number { return concurrency; }

/**
 * `legacyIndex` (0.6.5): the vault already has an index at `LEGACY_DEFAULT_INDEX_PATH`; settings that store no Index path then
 * keep that path instead of the new default, so an install that never pressed Save does not build a second index.
 */
export function normalizeSettings(raw: unknown, options: { legacyIndex?: boolean } = {}): CmdsZoteroSettings {
	const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	const concurrency = integer(data.concurrency, DEFAULT_SETTINGS.concurrency, 1, 8);
	return {
		bbtEndpoint: text(data.bbtEndpoint, DEFAULT_SETTINGS.bbtEndpoint),
		zoteroIndexPath: text(data.zoteroIndexPath, options.legacyIndex ? LEGACY_DEFAULT_INDEX_PATH : DEFAULT_SETTINGS.zoteroIndexPath),
		caywFormat: text(data.caywFormat, DEFAULT_SETTINGS.caywFormat),
		requestTimeoutMs: integer(data.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 1000, 180000),
		attachmentTimeoutMs: integer(data.attachmentTimeoutMs, DEFAULT_SETTINGS.attachmentTimeoutMs, 1000, 180000),
		concurrency,
		indexMaxAgeMinutes: integer(data.indexMaxAgeMinutes, DEFAULT_SETTINGS.indexMaxAgeMinutes, 1, 10080),
		outputFolder: text(data.outputFolder, DEFAULT_SETTINGS.outputFolder),
		imageFolder: text(data.imageFolder, DEFAULT_SETTINGS.imageFolder),
		bibliographyStyle: text(data.bibliographyStyle, DEFAULT_SETTINGS.bibliographyStyle),
		peerVaults: Array.isArray(data.peerVaults) ? data.peerVaults.filter((v: unknown): v is {name:string;path:string} => {
			if (!v || typeof v !== "object") return false;
			const peer = v as Record<string, unknown>;
			return typeof peer.name === "string" && !!peer.name.trim() && typeof peer.path === "string" && !!peer.path.trim();
		}).map(peer => ({ name: peer.name.trim(), path: peer.path.trim() })) : [],
		citationTrigger: (["bracket", "at", "off"] as const).includes(data.citationTrigger as CitationTrigger) ? data.citationTrigger as CitationTrigger : DEFAULT_SETTINGS.citationTrigger,
		excludedTags: Array.isArray(data.excludedTags) ? normalizeTagList(data.excludedTags) : [...DEFAULT_SETTINGS.excludedTags],
		headingHighlightColor: typeof data.headingHighlightColor === "string" && (data.headingHighlightColor === "none" || isAnnotationColor(data.headingHighlightColor)) ? data.headingHighlightColor : DEFAULT_SETTINGS.headingHighlightColor,
		referencesFollowActiveNote: typeof data.referencesFollowActiveNote === "boolean" ? data.referencesFollowActiveNote : DEFAULT_SETTINGS.referencesFollowActiveNote,
		referencesHeadings: referencesHeadings(data.referencesHeadings), // 0.5 R10
		recentReadsDays: integer(data.recentReadsDays, DEFAULT_SETTINGS.recentReadsDays, 1, 365),
		collectConcurrency: integer(data.collectConcurrency, data.concurrency === undefined ? DEFAULT_SETTINGS.collectConcurrency : defaultCollectConcurrency(concurrency), 1, 8), // 0.6 OPT-10
		pickerWaitSeconds: integer(data.pickerWaitSeconds, DEFAULT_SETTINGS.pickerWaitSeconds, 30, 1800), // 0.6 OPT-14
		// 0.6.1 R17: note layout.
		noteAbstract: flag(data.noteAbstract, DEFAULT_SETTINGS.noteAbstract),
		noteCitation: flag(data.noteCitation, DEFAULT_SETTINGS.noteCitation),
		noteMetadata: flag(data.noteMetadata, DEFAULT_SETTINGS.noteMetadata),
		noteLinks: flag(data.noteLinks, DEFAULT_SETTINGS.noteLinks),
		noteZoteroNotes: flag(data.noteZoteroNotes, DEFAULT_SETTINGS.noteZoteroNotes),
		noteSynthesis: flag(data.noteSynthesis, DEFAULT_SETTINGS.noteSynthesis),
		calloutAbstract: calloutType(data.calloutAbstract, DEFAULT_SETTINGS.calloutAbstract),
		calloutCite: calloutType(data.calloutCite, DEFAULT_SETTINGS.calloutCite),
		calloutMetadata: calloutType(data.calloutMetadata, DEFAULT_SETTINGS.calloutMetadata),
		calloutLinks: calloutType(data.calloutLinks, DEFAULT_SETTINGS.calloutLinks),
		calloutSynthesis: calloutType(data.calloutSynthesis, DEFAULT_SETTINGS.calloutSynthesis),
		synthesisLines: synthesisLines(data.synthesisLines),
		annotationsHeading: annotationsHeading(data.annotationsHeading),
		noteItemTypeFields: flag(data.noteItemTypeFields, DEFAULT_SETTINGS.noteItemTypeFields),
		joinContinuations: flag(data.joinContinuations, DEFAULT_SETTINGS.joinContinuations),
		noteRichText: flag(data.noteRichText, DEFAULT_SETTINGS.noteRichText),
		annotationTagStyle: (["plain", "hashtag"] as const).includes(data.annotationTagStyle as AnnotationTagStyle) ? data.annotationTagStyle as AnnotationTagStyle : DEFAULT_SETTINGS.annotationTagStyle,
		followZoteroSelection: (["off", "focus", "interval"] as const).find(mode => mode === data.followZoteroSelection) ?? DEFAULT_SETTINGS.followZoteroSelection, // 0.6.1
		followZoteroSelectionSeconds: integer(data.followZoteroSelectionSeconds, DEFAULT_SETTINGS.followZoteroSelectionSeconds, 3, 30),
		// 0.6.2 WP5: citations editor.
		citationFormat: CITATION_FORMAT_SETTINGS.find(format => format === data.citationFormat) ?? DEFAULT_SETTINGS.citationFormat,
		citekeyProblemMarks: flag(data.citekeyProblemMarks, DEFAULT_SETTINGS.citekeyProblemMarks),
		citationHover: flag(data.citationHover, DEFAULT_SETTINGS.citationHover),
		authorDateRendering: flag(data.authorDateRendering, DEFAULT_SETTINGS.authorDateRendering),
		citationClickAction: (["nothing", "note", "pdf"] as const).find(mode => mode === data.citationClickAction) ?? DEFAULT_SETTINGS.citationClickAction,
		pasteZoteroLinks: flag(data.pasteZoteroLinks, DEFAULT_SETTINGS.pasteZoteroLinks),
		// 0.6.2 WP6
		bibliographyLocale: bibliographyLocale(data.bibliographyLocale),
		bibliographyOrder: (["style", "citation", "alphabetical"] as const).find(order => order === data.bibliographyOrder) ?? DEFAULT_SETTINGS.bibliographyOrder,
		zoteroDataDirectory: typeof data.zoteroDataDirectory === "string" && data.zoteroDataDirectory.trim() && !dataDirectoryProblem(data.zoteroDataDirectory) ? data.zoteroDataDirectory.trim() : DEFAULT_SETTINGS.zoteroDataDirectory,
		exportFolder: text(data.exportFolder, DEFAULT_SETTINGS.exportFolder),
		// 0.6.6: an outside-the-vault exportFolder is kept as stored; the export refuses it while exportOutsideVault is off.
		exportOutsideVault: flag(data.exportOutsideVault, DEFAULT_SETTINGS.exportOutsideVault),
		pandocAfterExport: flag(data.pandocAfterExport, DEFAULT_SETTINGS.pandocAfterExport),
		pandocPath: typeof data.pandocPath === "string" && !pandocPathProblem(data.pandocPath) ? data.pandocPath.trim() : DEFAULT_SETTINGS.pandocPath,
		hookmarkLinkExports: flag(data.hookmarkLinkExports, DEFAULT_SETTINGS.hookmarkLinkExports),
		// 0.6.3 filename-folder-pattern: an unusable stored pattern keeps the 0.6.1 naming.
		noteFilenamePattern: typeof data.noteFilenamePattern === "string" && !notePatternProblem(data.noteFilenamePattern) ? data.noteFilenamePattern.trim() : DEFAULT_SETTINGS.noteFilenamePattern,
		noteFolderPattern: typeof data.noteFolderPattern === "string" && !notePatternProblem(data.noteFolderPattern, true) ? data.noteFolderPattern.trim() : DEFAULT_SETTINGS.noteFolderPattern,
	};
}

// 0.6.2: a malformed locale keeps the style's default rather than reaching Better BibTeX.
function bibliographyLocale(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_SETTINGS.bibliographyLocale;
	const locale = canonicalLocale(value);
	return localeProblem(locale) ? DEFAULT_SETTINGS.bibliographyLocale : locale;
}

/** Excluded Zotero tags as stored: strings only, trimmed, lower-cased, empty entries dropped, deduplicated (order kept). */
export function normalizeTagList(value: readonly unknown[]): string[] {
	return [...new Set(value.filter((tag): tag is string => typeof tag === "string").map(tag => tag.trim().toLowerCase()).filter(Boolean))];
}

// 0.5 R10: plain strings, trimmed and deduplicated; an empty or malformed list keeps the defaults so detection never goes blind.
function referencesHeadings(value: unknown): string[] {
	const list = Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))] : [];
	return list.length ? list : [...DEFAULT_SETTINGS.referencesHeadings];
}

export function validateEndpoint(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.hash || url.search) {
		throw new Error("Use a local HTTP endpoint without credentials, query parameters or fragments.");
	}
	return url.toString().replace(/\/$/, "");
}
