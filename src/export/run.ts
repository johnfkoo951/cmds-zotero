/**
 * 0.6.6 run-pandoc-after-export and hookmark-link-export: the pure parts of running a kit. Which pandoc to run, what its
 * output says, and the AppleScript that links the `.docx` and the note in Hookmark. The host adapter
 * (`plugin/export-runner.ts`) runs the processes; both are opt-in settings. Pure: no `obsidian` import.
 */
import { join, win32 } from "path";
import { pathToFileURL } from "url";

/** Where pandoc is looked for when the setting is empty: the GUI app does not inherit the shell's PATH. */
export function pandocCandidates(setting: string, platform: string, home: string): string[] {
	const configured = setting.trim();
	if (configured) return [configured.startsWith("~/") ? (platform === "win32" ? win32.join(home, configured.slice(2)) : join(home, configured.slice(2))) : configured];
	// The Windows installer puts pandoc under the user's AppData (per-user) or Program Files (all users).
	if (platform === "win32") return [win32.join(home, "AppData", "Local", "Pandoc", "pandoc.exe"), "C:\\Program Files\\Pandoc\\pandoc.exe", "pandoc"];
	const local = join(home, ".local", "bin", "pandoc");
	if (platform === "darwin") return ["/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc", "/opt/local/bin/pandoc", local, "pandoc"];
	return ["/usr/local/bin/pandoc", "/usr/bin/pandoc", local, "pandoc"];
}

export interface PandocRunSummary {
	/** Citekeys `zotero.lua` did not find in Zotero (left as text in the `.docx`). */
	missing: string[];
	/** Citekeys `zotero.lua` found more than once. */
	ambiguous: string[];
	/** Other output lines (pandoc warnings), without `zotero.lua`'s own version lines. */
	other: string[];
}

/** What pandoc and `zotero.lua` printed, sorted into what the person should act on. */
export function pandocRunSummary(stdout: string, stderr: string): PandocRunSummary {
	const summary: PandocRunSummary = { missing: [], ambiguous: [], other: [] };
	for (const raw of `${stdout}\n${stderr}`.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || /^zotero-live-citations\b/.test(line) || /^new version ".*" available at/.test(line)) continue;
		const missing = /^@(\S+?):? (?:not found|not in Zotero)$/.exec(line);
		if (missing) { if (!summary.missing.includes(missing[1])) summary.missing.push(missing[1]); continue; }
		const ambiguous = /^@(\S+): duplicates found$/.exec(line);
		if (ambiguous) { if (!summary.ambiguous.includes(ambiguous[1])) summary.ambiguous.push(ambiguous[1]); continue; }
		summary.other.push(line);
	}
	return summary;
}

/**
 * Links two addresses in Hookmark (`hook … and …`), naming each bookmark. The addresses arrive as arguments, so no part
 * of a path or a note name is ever read as AppleScript.
 */
export const HOOKMARK_LINK_SCRIPT = `on run argv
	tell application "Hookmark"
		set docBookmark to make new bookmark with data (item 1 of argv)
		set noteBookmark to make new bookmark with data (item 2 of argv)
		set name of docBookmark to (item 3 of argv)
		set name of noteBookmark to (item 4 of argv)
		hook docBookmark and noteBookmark
	end tell
	return "linked"
end run`;

/** The `osascript` arguments that link the `.docx` at `docxPath` with the note at `noteURI` (its Obsidian address). */
export function hookmarkLinkArguments(docxPath: string, noteURI: string, docxName: string, noteName: string): string[] {
	return ["-e", HOOKMARK_LINK_SCRIPT, pathToFileURL(docxPath).href, noteURI, docxName, noteName];
}
