/**
 * The setup doctor (0.6.1 doctor-report, R7): environment checks from facts the host gathered, a copyable plain-text
 * report and the diagnostics they map to. Report-only: nothing here (or in its hosts) changes other plugins, Git state or
 * notes. Paths in checks are vault-relative; `redactPaths` removes absolute paths from free text before it is shown or
 * copied. Pure module: no `obsidian` import, so `tsx --test` and the offline core can load it.
 */
import type { GitInfo } from "../agent/types";
import { bbtReasonLabel, zoteroMajor } from "../api/transport";
import { DIAGNOSTIC_CODES, diagnostic, type AgentDiagnostic, type DiagnosticCode } from "../diagnostics";
import { summarizeOutcomes, type OutcomeRecord } from "./outcome-log";

export type CheckStatus = "ok" | "info" | "warning" | "error" | "unknown";

export interface DoctorCheck {
	id: "zotero" | "legacy-plugin" | "index" | "git" | "pdfjs" | "peer-vaults" | "output-folder" | "obsidian" | "citation-completion";
	status: CheckStatus;
	title: string;
	detail: string;
	/** The diagnostic code of a check that needs attention (its severity is the status). */
	code?: DiagnosticCode;
	/** Vault-relative note paths the check is about (at most `MAX_PATHS`). */
	paths?: string[];
}

/** Facts a host gathered; null means "not checked here" (the offline CLI cannot load pdf.js, for example). */
export interface DoctorFacts {
	bbt: { reachable: boolean | null; zotero?: string; betterbibtex?: string; reason?: string; status?: number };
	legacyPluginEnabled: boolean | null;
	index: { path: string; count: number | null; ageMinutes: number | null; stale: boolean | null; maxAgeMinutes: number; complete: boolean | null };
	git: GitInfo | null;
	pdfjs: boolean | null;
	/** Registered peer vaults and whether their published note map could be read. */
	peers: { name: string; readable: boolean; detail?: string }[] | null;
	/** Notes in the literature output folder that no index entry claims, and notes with Better Notes sync frontmatter. */
	outputFolder: { folder: string; notes: number; unmatched: string[]; betterNotes: string[]; /** 0.6.3 find-moved-notes: literature notes (`type: zotero` with a `zoteroID`) outside the folder. */ moved?: string[] } | null;
	/** CLI hosts only: whether the Obsidian bridge answered. */
	obsidian?: "ok" | "unavailable";
	/**
	 * 0.6.6, Obsidian host only: whether citation completion is on and which other plugins' completions, registered before
	 * it, are known to answer `[@` first (read from Obsidian's suggester list and those plugins' settings; null: unknown).
	 */
	completion?: { enabled: boolean; conflicts: CompletionConflict[] } | null;
}

export interface CompletionConflict { plugin: string; fix: string }

/**
 * 0.6.6: whether another plugin's completion, registered before the plugin's own, answers `[@` with its settings, and how
 * to stop it. Only plugins whose behaviour is known are judged; null means no known conflict.
 */
export function completionConflict(pluginId: string, settings: Record<string, unknown> | undefined): CompletionConflict | null {
	if (pluginId === "various-complements") {
		const first = typeof settings?.firstCharactersDisableSuggestions === "string" ? settings.firstCharactersDisableSuggestions : "";
		return first.includes("[") ? null : { plugin: "Various Complements", fix: "in Various Complements add [ and @ to \"First characters to disable suggestions\"" };
	}
	if (pluginId === "obsidian-pandoc-reference-list") {
		return settings?.enableCiteKeyCompletion === false ? null : { plugin: "Pandoc Reference List", fix: "in Pandoc Reference List turn off its citekey autocomplete" };
	}
	return null;
}

function completionCheck(completion: DoctorFacts["completion"]): DoctorCheck {
	const title = "Citation completion ([@)";
	if (!completion) return { id: "citation-completion", status: "unknown", title, detail: "Not checked here." };
	if (!completion.enabled) return { id: "citation-completion", status: "info", title, detail: "Citation completion is off (Settings → Citations → Citation trigger)." };
	if (!completion.conflicts.length) return { id: "citation-completion", status: "ok", title, detail: "Typing [@ opens the plugin's citation list." };
	const names = completion.conflicts.map(conflict => conflict.plugin).join(" and ");
	return { id: "citation-completion", status: "warning", title, detail: `${names} answer${completion.conflicts.length === 1 ? "s" : ""} [@ before the plugin, so its citation list may not open and a half-typed citekey can be completed from words in the note. To fix: ${completion.conflicts.map(conflict => conflict.fix).join("; ")}.` };
}

/** Paths listed per check; the count in the detail stays exact. */
export const MAX_PATHS = 20;

function flagged(id: DoctorCheck["id"], title: string, code: DiagnosticCode, detail: string, paths?: readonly string[]): DoctorCheck {
	return { id, status: DIAGNOSTIC_CODES[code], title, detail, code, ...(paths?.length ? { paths: paths.slice(0, MAX_PATHS) } : {}) };
}

function plural(count: number, word: string): string { return `${count} ${word}${count === 1 ? "" : "s"}`; }

function zoteroCheck(bbt: DoctorFacts["bbt"]): DoctorCheck {
	const title = "Zotero and Better BibTeX";
	if (bbt.reachable === null) return { id: "zotero", status: "unknown", title, detail: "Not checked here." };
	if (!bbt.reachable) return flagged("zotero", title, "zotero-unreachable", `Better BibTeX did not answer${bbt.reason ? ` (${bbtReasonLabel(bbt.reason, bbt.status)})` : ""}. Start Zotero with Better BibTeX; the saved index still serves reads.`);
	const versions = `Zotero ${bbt.zotero ?? "unknown"}; Better BibTeX ${bbt.betterbibtex ?? "unknown"}.`;
	const major = bbt.zotero ? zoteroMajor(bbt.zotero) : null;
	if (major !== null && major < 10) return flagged("zotero", title, "zotero-reading-history-unavailable", `${versions} Send recently read papers and Zotero's reading history need Zotero 10; everything else works.`);
	return { id: "zotero", status: "ok", title, detail: versions };
}

function indexCheck(index: DoctorFacts["index"]): DoctorCheck {
	const title = "Citekey index";
	if (index.count === null) return flagged("index", title, "index-missing", `No validated index at ${index.path}. Refresh the citekey index.`);
	const age = index.ageMinutes === null ? "age unknown" : `${index.ageMinutes} min old`;
	if (index.stale === true) return flagged("index", title, "index-stale", `${plural(index.count, "entry")}, ${age} (limit ${index.maxAgeMinutes} min). Refresh it to pick up changes in Zotero.`);
	return { id: "index", status: "ok", title, detail: `${plural(index.count, "entry")}, ${age}${index.complete === false ? ", incomplete (see Diagnose index and links)" : ""}.` };
}

function gitCheck(git: GitInfo | null, indexPath: string): DoctorCheck {
	const title = "Git";
	if (git === null) return { id: "git", status: "unknown", title, detail: "Not checked here." };
	if (!git.repo) return { id: "git", status: "ok", title, detail: "The vault is not a Git repository." };
	const exposed: string[] = [];
	if (git.indexIgnored === false || git.indexTracked === true) exposed.push(`the index file ${indexPath}`);
	if (git.cacheIgnored === false || git.cacheTracked === true) exposed.push("the .cmds-zotero cache");
	if (exposed.length) return flagged("git", title, "index-in-git", `Git tracks or does not ignore ${exposed.join(" and ")}. Ignore and untrack them yourself; the doctor changes nothing.`);
	return { id: "git", status: "ok", title, detail: "The index and the cache are ignored." };
}

function peersCheck(peers: DoctorFacts["peers"]): DoctorCheck {
	const title = "Other vaults";
	if (peers === null) return { id: "peer-vaults", status: "unknown", title, detail: "Not checked here." };
	if (!peers.length) return { id: "peer-vaults", status: "ok", title, detail: "No other vaults are registered." };
	const failed = peers.filter(peer => !peer.readable);
	if (failed.length) return flagged("peer-vaults", title, "peer-map-unreadable", `${failed.length} of ${plural(peers.length, "registered vault")} cannot be read: ${failed.map(peer => `${peer.name}${peer.detail ? ` (${peer.detail})` : ""}`).join("; ")}.`);
	return { id: "peer-vaults", status: "ok", title, detail: `${plural(peers.length, "registered vault")}, each note map readable.` };
}

function outputCheck(output: DoctorFacts["outputFolder"]): DoctorCheck {
	const title = "Literature note folder";
	if (output === null) return { id: "output-folder", status: "unknown", title, detail: "Not checked here." };
	if (output.betterNotes.length) return flagged("output-folder", title, "better-notes-in-output", `${plural(output.betterNotes.length, "note")} in ${output.folder} ${output.betterNotes.length === 1 ? "carries" : "carry"} Better Notes sync frontmatter; keep Better Notes exports in another folder so the two plugins never write the same note.`, output.betterNotes);
	if (output.unmatched.length) return flagged("output-folder", title, "foreign-notes-in-output", `${plural(output.unmatched.length, "note")} in ${output.folder} ${output.unmatched.length === 1 ? "belongs" : "belong"} to no index entry. They are never changed; move them if they are not literature notes.`, output.unmatched);
	// 0.6.3 find-moved-notes: notes moved out of the folder are fine (imports and updates find them); they are only named.
	const moved = output.moved ?? [];
	if (moved.length) return { id: "output-folder", status: "ok", title, detail: `${plural(output.notes, "note")} in ${output.folder}, each linked to an index entry; ${plural(moved.length, "literature note")} ${moved.length === 1 ? "lives" : "live"} elsewhere in the vault and ${moved.length === 1 ? "is" : "are"} updated where ${moved.length === 1 ? "it is" : "they are"}.`, paths: moved.slice(0, MAX_PATHS) };
	return { id: "output-folder", status: "ok", title, detail: `${plural(output.notes, "note")} in ${output.folder}, each linked to an index entry.` };
}

/** Every check, in report order. */
export function doctorChecks(facts: DoctorFacts): DoctorCheck[] {
	const checks: DoctorCheck[] = [zoteroCheck(facts.bbt)];
	checks.push(facts.legacyPluginEnabled === null ? { id: "legacy-plugin", status: "unknown", title: "Legacy plugin", detail: "Not checked here." }
		: facts.legacyPluginEnabled ? flagged("legacy-plugin", "Legacy plugin", "legacy-plugin-enabled", "The legacy cmds-link-zotero plugin is enabled and shares the index path. Disable it yourself before refreshing.")
			: { id: "legacy-plugin", status: "ok", title: "Legacy plugin", detail: "The legacy cmds-link-zotero plugin is not enabled." });
	checks.push(indexCheck(facts.index), gitCheck(facts.git, facts.index.path));
	checks.push(facts.pdfjs === null ? { id: "pdfjs", status: "unknown", title: "PDF text (pdf.js)", detail: "Not checked here; PDF text extraction runs in Obsidian." }
		: facts.pdfjs ? { id: "pdfjs", status: "ok", title: "PDF text (pdf.js)", detail: "Obsidian's PDF library loads." }
			: flagged("pdfjs", "PDF text (pdf.js)", "pdfjs-unavailable", "Obsidian's PDF library did not load; PDF text extraction and quote location will fail."));
	checks.push(peersCheck(facts.peers), outputCheck(facts.outputFolder));
	if (facts.completion !== undefined) checks.push(completionCheck(facts.completion));
	if (facts.obsidian !== undefined) checks.push(facts.obsidian === "ok" ? { id: "obsidian", status: "ok", title: "Obsidian bridge", detail: "The Obsidian CLI reached the plugin." }
		: flagged("obsidian", "Obsidian bridge", "obsidian-unavailable", "The Obsidian CLI did not reach the plugin, so answers come from the saved index file. Live actions need Obsidian running with its CLI enabled."));
	return checks;
}

/** The checks that need attention, as diagnostics (codes registered in `DIAGNOSTIC_CODES`). */
export function doctorDiagnostics(checks: readonly DoctorCheck[]): AgentDiagnostic[] {
	return checks.flatMap(check => check.code ? [diagnostic(check.code, check.detail)] : []);
}

/**
 * Removes absolute paths from free text: the vault root becomes vault-relative, the home folder `~`, and any other
 * `/Users/<name>`, `/home/<name>` or `C:\Users\<name>` prefix `~` as well.
 */
export function redactPaths(text: string, roots: { vaultRoot?: string | null; home?: string | null } = {}): string {
	let result = text;
	for (const [root, replacement] of [[roots.vaultRoot, "<vault>"], [roots.home, "~"]] as const) {
		if (!root || root.length < 2) continue;
		const trimmed = root.replace(/[\\/]+$/, "");
		result = result.split(`${trimmed}/`).join(replacement === "<vault>" ? "" : "~/").split(`${trimmed}\\`).join(replacement === "<vault>" ? "" : "~\\").split(trimmed).join(replacement);
	}
	return result.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~").replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "~");
}

const MARK: Readonly<Record<CheckStatus, string>> = { ok: "ok", info: "info", warning: "warning", error: "error", unknown: "not checked" };

export interface ReportInput {
	checks: readonly DoctorCheck[];
	pluginVersion: string;
	generatedAt: Date;
	statusLine: string;
	outcomes: readonly OutcomeRecord[];
	vaultRoot?: string | null;
	home?: string | null;
}

/** The copyable plain-text report: checks, then the recent Better BibTeX outcomes (local log only); paths redacted. */
export function doctorReport(input: ReportInput): string {
	const lines = ["CMDS Zotero setup report", `Plugin ${input.pluginVersion} · ${input.generatedAt.toISOString()}`, input.statusLine, ""];
	for (const check of input.checks) {
		lines.push(`[${MARK[check.status]}] ${check.title}: ${check.detail}${check.code ? ` (${check.code})` : ""}`);
		for (const path of check.paths ?? []) lines.push(`    - ${path}`);
	}
	const summary = summarizeOutcomes(input.outcomes);
	lines.push("", `Recent Better BibTeX calls (this session, last ${summary.total}): ${summary.ok} ok, ${summary.failed} failed${summary.failed ? ` (${Object.entries(summary.reasons).map(([reason, count]) => `${bbtReasonLabel(reason)} ${count}`).join(", ")})` : ""}.`);
	for (const record of input.outcomes.filter(outcome => !outcome.ok).slice(-5)) lines.push(`    - ${record.at} ${record.reason ? bbtReasonLabel(record.reason, record.status) : "failed"}${record.message ? `: ${record.message}` : ""}`);
	return redactPaths(lines.join("\n"), { vaultRoot: input.vaultRoot ?? null, home: input.home ?? null });
}
