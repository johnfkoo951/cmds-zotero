/**
 * 0.6.1 R17: settings-level layout of the built-in literature note. Pure (no `obsidian` import).
 *
 * The managed section IDs and the marker grammar never change: a switched-off section keeps its managed block with an
 * empty body, so an older note never reports a missing section and switching the section back on refreshes it in place.
 * Defaults reproduce the 0.6.0 note byte for byte (annotation tags aside: excluded tags are left out since 0.6.1).
 */
import type { CmdsZoteroSettings } from "./types";

export interface CalloutNames {
	abstract: string;
	cite: string;
	metadata: string;
	links: string;
	synthesis: string;
}

export interface LayoutOptions {
	/** The abstract callout inside the `overview` block (the title heading always stays). */
	abstract: boolean;
	/** The bibliography callout (`citation` block). Off: no bibliography text is needed, even for a first import. */
	citation: boolean;
	/** The metadata fields callout (first half of the `metadata` block). */
	metadata: boolean;
	/** The links callout (second half of the `metadata` block). */
	links: boolean;
	/** The `## Zotero notes` part (`notes` block). */
	zoteroNotes: boolean;
	/** The user-owned `## Synthesis` scaffold written into new notes (never managed). */
	synthesis: boolean;
	callouts: CalloutNames;
	/** Lines of the Synthesis callout in new notes, written as given. */
	synthesisLines: readonly string[];
	/** Text of the `## …` heading new annotation blocks go under. */
	annotationsHeading: string;
	/** Metadata fields per Zotero item type (item-fields.ts) instead of the 0.6.0 fixed list; off by default. */
	itemTypeFields: boolean;
	/** Highlights continued with a leading `+` join the highlight before them (annotations/join.ts); off by default. */
	joinContinuations: boolean;
	/** Zotero rich-text tags in titles and annotations as Markdown (annotations/rich-text.ts); off by default. */
	richText: boolean;
}

export const DEFAULT_CALLOUTS: Readonly<CalloutNames> = { abstract: "Abstract", cite: "Cite", metadata: "md", links: "LINK", synthesis: "Synth" };
export const DEFAULT_SYNTHESIS_LINES: readonly string[] = ["**Contribution**::", "**Related**::"];
export const DEFAULT_ANNOTATIONS_HEADING = "Annotations";

/** Obsidian callout types: a letter, then letters, digits, `-` or `_` (at most 32 characters). */
const CALLOUT_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_LINE = 200;
const MAX_LINES = 20;
const MAX_HEADING = 100;

/** The message for a callout type the note cannot use, or null. Empty means the default. */
export function calloutTypeProblem(value: string): string | null {
	const text = value.trim();
	return !text || CALLOUT_TYPE.test(text) ? null : "Use a letter followed by letters, digits, - or _ (at most 32 characters).";
}
export function calloutType(value: unknown, fallback: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	return CALLOUT_TYPE.test(text) ? text : fallback;
}

const hasControl = (text: string): boolean => [...text].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
/** A line can never open or close an HTML comment, so it cannot spell a managed marker. */
const commentFree = (text: string): boolean => !text.includes("<!--") && !text.includes("-->");

/** The message for a Synthesis line the note cannot use, or null. */
export function synthesisLineProblem(line: string): string | null {
	if (!commentFree(line)) return "Lines cannot contain HTML comment delimiters (<!-- or -->).";
	if (line.length > MAX_LINE) return `Keep each line under ${MAX_LINE} characters.`;
	return null;
}
/** Trimmed, non-empty, comment-free lines (at most 20); an empty or unusable list keeps the default scaffold. */
export function synthesisLines(value: unknown): string[] {
	const lines = Array.isArray(value) ? value.filter((line): line is string => typeof line === "string")
		.map(line => line.trim()).filter(line => line && !hasControl(line) && synthesisLineProblem(line) === null).slice(0, MAX_LINES) : [];
	return lines.length ? lines : [...DEFAULT_SYNTHESIS_LINES];
}

/** The message for an annotations heading the note cannot use, or null. Empty means the default. */
export function annotationsHeadingProblem(value: string): string | null {
	const text = value.trim().replace(/^#+\s*/, "");
	if (!value.trim()) return null;
	if (!text || hasControl(text) || !commentFree(text)) return "Enter one line of heading text without HTML comment delimiters.";
	if (text.length > MAX_HEADING) return `Keep the heading under ${MAX_HEADING} characters.`;
	return null;
}
/** Heading text without leading `#`s; anything unusable keeps "Annotations". */
export function annotationsHeading(value: unknown): string {
	if (typeof value !== "string" || annotationsHeadingProblem(value) !== null) return DEFAULT_ANNOTATIONS_HEADING;
	return value.trim().replace(/^#+\s*/, "").replace(/\s+/g, " ") || DEFAULT_ANNOTATIONS_HEADING;
}

export type LayoutSettings = Pick<CmdsZoteroSettings,
	"noteAbstract" | "noteCitation" | "noteMetadata" | "noteLinks" | "noteZoteroNotes" | "noteSynthesis" |
	"calloutAbstract" | "calloutCite" | "calloutMetadata" | "calloutLinks" | "calloutSynthesis" | "synthesisLines" | "annotationsHeading" | "noteItemTypeFields" | "joinContinuations" | "noteRichText">;

/** The layout a note is rendered with; every value is normalised again, so a hand-built settings object is safe. */
export function layoutOf(settings: Partial<LayoutSettings>): LayoutOptions {
	const on = (value: unknown): boolean => value !== false;
	return {
		abstract: on(settings.noteAbstract), citation: on(settings.noteCitation), metadata: on(settings.noteMetadata),
		links: on(settings.noteLinks), zoteroNotes: on(settings.noteZoteroNotes), synthesis: on(settings.noteSynthesis),
		callouts: {
			abstract: calloutType(settings.calloutAbstract, DEFAULT_CALLOUTS.abstract),
			cite: calloutType(settings.calloutCite, DEFAULT_CALLOUTS.cite),
			metadata: calloutType(settings.calloutMetadata, DEFAULT_CALLOUTS.metadata),
			links: calloutType(settings.calloutLinks, DEFAULT_CALLOUTS.links),
			synthesis: calloutType(settings.calloutSynthesis, DEFAULT_CALLOUTS.synthesis),
		},
		synthesisLines: synthesisLines(settings.synthesisLines),
		annotationsHeading: annotationsHeading(settings.annotationsHeading),
		itemTypeFields: settings.noteItemTypeFields === true,
		joinContinuations: settings.joinContinuations === true,
		richText: settings.noteRichText === true,
	};
}

/**
 * Theme-aware CSS variables declared in styles.css for themes and snippets to override (documented there). The tests
 * check that each one is declared.
 */
export const THEME_VARIABLES: readonly string[] = [
	...["yellow", "red", "green", "blue", "purple", "magenta", "orange", "gray"].map(color => `--cmds-zotero-hl-${color}`),
	"--cmds-zotero-hl-strength",
	"--cmds-zotero-state-ok", "--cmds-zotero-state-warning", "--cmds-zotero-state-error", "--cmds-zotero-state-muted", "--cmds-zotero-state-accent",
	"--cmds-zotero-card-padding", "--cmds-zotero-card-gap", "--cmds-zotero-card-border",
];
