/**
 * 0.6.6 run-pandoc-after-export and hookmark-link-export: the host side. Runs pandoc on a kit's defaults file, opens the
 * `.docx` with the system's default app and links it with the note in Hookmark. Each step is an opt-in setting.
 * Processes start with execFile (no shell), a timeout and bounded output; arguments never pass through a shell.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { hookmarkLinkArguments, pandocCandidates, pandocRunSummary, type PandocRunSummary } from "../export/run";

const execute = promisify(execFile);
/** A long manuscript with many Zotero lookups stays well under this. */
const PANDOC_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type PandocRun =
	| { kind: "ok"; pandoc: string; summary: PandocRunSummary }
	| { kind: "failed"; pandoc: string | null; message: string; summary?: PandocRunSummary };

interface ProcessError { code?: unknown; killed?: boolean; stdout?: string; stderr?: string; message?: string }

const exists = async (path: string): Promise<boolean> => { try { await fs.access(path); return true; } catch { return false; } };
const firstLine = (text: string | undefined): string => (text ?? "").split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";

/** Runs `pandoc --defaults <defaultsPath>` in the kit folder with the first pandoc found. */
export async function runPandoc(setting: string, defaultsPath: string, folder: string): Promise<PandocRun> {
	for (const candidate of pandocCandidates(setting, platform(), homedir())) {
		if (isAbsolute(candidate) && !(await exists(candidate))) continue;
		try {
			const { stdout, stderr } = await execute(candidate, ["--defaults", defaultsPath], { cwd: folder, timeout: PANDOC_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
			return { kind: "ok", pandoc: candidate, summary: pandocRunSummary(stdout, stderr) };
		} catch (caught) {
			const error = caught as ProcessError;
			if (error.code === "ENOENT") continue;
			const message = error.killed ? "pandoc ran longer than three minutes and was stopped." : firstLine(error.stderr) || error.message || "pandoc failed.";
			return { kind: "failed", pandoc: candidate, message, summary: pandocRunSummary(error.stdout ?? "", error.stderr ?? "") };
		}
	}
	return { kind: "failed", pandoc: null, message: "pandoc was not found. Install it (https://pandoc.org/installing.html, or brew install pandoc on macOS) or set Pandoc path in the settings." };
}

/** Opens a file with the system's default app; the message when it could not be opened, else null. */
export async function openWithDefaultApp(file: string): Promise<string | null> {
	const os = platform();
	const path = normalize(file);
	const [command, args] = os === "darwin" ? ["open", [path]] : os === "win32" ? ["explorer.exe", [path]] : ["xdg-open", [path]];
	try { await execute(command, args, { timeout: 20_000 }); return null; }
	// explorer.exe exits with 1 even when it opened the file.
	catch (caught) { return os === "win32" ? null : (caught as ProcessError).message ?? "The file could not be opened."; }
}

/** Links the `.docx` and the note (its Obsidian address) in Hookmark; the message when it did not work, else null. */
export async function linkInHookmark(docxPath: string, noteURI: string, docxName: string, noteName: string): Promise<string | null> {
	if (platform() !== "darwin") return "Hookmark links need macOS.";
	try { await execute("osascript", hookmarkLinkArguments(docxPath, noteURI, docxName, noteName), { timeout: 20_000 }); return null; }
	catch (caught) {
		const error = caught as ProcessError;
		const detail = firstLine(error.stderr) || error.message || "osascript failed";
		if (/-1743|not authori[sz]ed/i.test(detail)) return "macOS did not allow Obsidian to control Hookmark. Allow it in System Settings → Privacy & Security → Automation, then export again.";
		if (/-1728|-10814|-2700|Can.t get application|application isn.t running/i.test(detail)) return "Hookmark was not found. Install Hookmark, or turn off Link exports in Hookmark.";
		return `Hookmark did not link the files: ${detail}`;
	}
}
