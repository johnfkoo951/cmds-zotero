/**
 * 0.6.8 export-result-tones: what the end of an export shows. A clean pandoc run that opened the `.docx` is a Notice
 * only; a kit handed over without running pandoc, a run that left something to check and a run that could not happen
 * open the report with a tone, the outcome first and the kit's details folded away. Pure: no `obsidian` import.
 */
import type { PandocRunSummary } from "./run";

export type ExportTone = "success" | "info" | "warning" | "error";

/** What an export command wrote, before pandoc runs. */
export interface KitResult {
	title: string;
	/** What the kit holds and how the copy was cleaned: the report's details. */
	lines: string[];
	/** What to check however pandoc ends: no CSL file, a missing `zotero.lua`, a note's unusable `csl` or `lang`. */
	warnings: string[];
	/**
	 * Citations the kit could not resolve from the index. Once pandoc ran, its own output says which citations stayed
	 * text, so these are shown only when it did not run.
	 */
	unresolved: string[];
	/** The `.docx` file name pandoc writes. */
	docx: string;
	/** The Word kit (live Zotero citations). */
	word: boolean;
}

/** How the end of an export went. */
export type ExportStep =
	/** Run pandoc after export is off (or the kit has no folder on disk): the command is the result. */
	| { kind: "handed-over" }
	/** The Word kit while Zotero does not answer: pandoc was not run. */
	| { kind: "zotero-offline" }
	/** `pandoc` is null when no pandoc was found. */
	| { kind: "failed"; pandoc: string | null; message: string; summary?: PandocRunSummary }
	/** `hookmark` is null while Link exports in Hookmark is off; `problem` is null when the link was made. */
	| { kind: "ran"; pandoc: string; summary: PandocRunSummary; docxPath: string; openProblem: string | null; hookmark: { problem: string | null } | null };

export interface ExportReport {
	tone: ExportTone;
	title: string;
	/** The outcome first, then what needs attention and what to do about it. */
	summary: string[];
	/** The kit's files and the cleaning report (folded), ending with the command unless it is shown open. */
	details: string[];
	command: string;
	/** The command is shown open: pandoc was not asked to run, so the command is the result. */
	showCommand: boolean;
	/** The Notice of a clean run; null for every other tone, which opens the report. */
	notice: string | null;
	/** The `.docx` pandoc wrote, which the report can open again. */
	docxPath: string | null;
	/** pandoc could not run or failed: the report offers Try again. */
	retry: boolean;
}

const REFRESH = "In Word, press Refresh in the Zotero tab once; the citations and the bibliography are then Zotero's.";
const LINKED = "Linked the .docx and the note in Hookmark.";

const citekeys = (keys: readonly string[]): string => keys.map(key => `@${key}`).join(", ");

/** What pandoc and `zotero.lua` printed that the person should act on, one line each. */
export function runIssues(summary: PandocRunSummary | undefined): string[] {
	if (!summary) return [];
	return [
		...(summary.missing.length ? [`Not found in Zotero, left as text in the .docx: ${citekeys(summary.missing)}.`] : []),
		...(summary.ambiguous.length ? [`Found more than once in Zotero, left as text: ${citekeys(summary.ambiguous)}.`] : []),
		...summary.other.map(line => `pandoc: ${line}`),
	];
}

/** The tone, the Notice or report text and the actions for the end of an export. `copied`: the command is on the clipboard. */
export function exportReport(kit: KitResult, step: ExportStep, command: string, copied: boolean): ExportReport {
	const commandLines = ["", "The pandoc command (pandoc 2.17 or later):", command];
	const base = { title: kit.title, details: [...kit.lines, ...commandLines], command, showCommand: false, notice: null, docxPath: null, retry: false };
	switch (step.kind) {
		case "handed-over":
			return {
				...base, tone: kit.warnings.length || kit.unresolved.length ? "warning" : "info", details: kit.lines, showCommand: true,
				summary: [
					copied ? "Kit written. The pandoc command is on the clipboard (pandoc 2.17 or later)." : "Kit written. Run the command below (pandoc 2.17 or later).",
					...(kit.word ? [`Run it while Zotero is open. ${REFRESH}`] : []),
					...kit.unresolved,
					...kit.warnings,
				],
			};
		case "zotero-offline":
			return {
				...base, tone: "error", retry: true,
				summary: ["Zotero is not answering, so pandoc was not run: the Word kit asks Zotero for the cited items.", ...kit.unresolved, ...kit.warnings, "Start Zotero, then press Try again."],
			};
		case "failed":
			return {
				...base, tone: "error", retry: true,
				summary: [step.pandoc === null ? step.message : `pandoc did not finish: ${step.message}`, ...runIssues(step.summary), ...kit.unresolved, ...kit.warnings, "Fix the cause above, then press Try again."],
			};
		case "ran": {
			const opened = step.openProblem === null;
			const linked = step.hookmark !== null && step.hookmark.problem === null;
			const problems = [
				...runIssues(step.summary),
				...(opened ? [] : [`The .docx could not be opened: ${step.openProblem}`]),
				...(step.hookmark?.problem ? [step.hookmark.problem] : []),
				...kit.warnings,
			];
			// pandoc's own output replaced the kit's guesses about unresolved citations; they stay in the details.
			const ran = { ...base, details: [`pandoc (${step.pandoc}) wrote ${step.docxPath}.`, ...kit.lines, ...kit.unresolved, ...commandLines], docxPath: step.docxPath };
			if (!problems.length) {
				return {
					...ran, tone: "success",
					notice: `Opened ${kit.docx}.${kit.word ? " In Word, press Refresh in the Zotero tab once." : ""}${linked ? " Linked with the note in Hookmark." : ""}`,
					summary: [`Opened ${kit.docx}.`, ...(kit.word ? [REFRESH] : []), ...(linked ? [LINKED] : [])],
				};
			}
			const leftAsText = step.summary.missing.length + step.summary.ambiguous.length > 0;
			const headline = leftAsText ? `${kit.docx} was written, but some citations were left as text.`
				: opened ? `${kit.docx} was written and opened; check the notes below.`
				: `${kit.docx} was written, but it could not be opened.`;
			return {
				...ran, tone: "warning",
				summary: [
					headline,
					...problems,
					...(step.summary.missing.length ? ["Check those citekeys in Zotero, or fix them in the note, then export again."] : []),
					...(step.summary.ambiguous.length ? ["Give each of those items its own citekey in Better BibTeX, then export again."] : []),
					...(opened && kit.word ? [REFRESH] : []),
					...(linked ? [LINKED] : []),
				],
			};
		}
	}
}
