/**
 * 0.6.6 export-outside-vault: where the export kits are written. A vault folder by default. An absolute folder, or one
 * under `~/`, only after the person turned on "Allow export kits outside the vault". An absolute path that lies inside
 * the vault is used as the vault folder it is. Pure: no `obsidian` import.
 */
import { isAbsolute, join, relative, resolve, sep } from "path";

export type KitRoot = { kind: "vault"; folder: string } | { kind: "external"; path: string };

/** True for a value that names a folder by absolute path or `~/…` rather than by vault path. */
export function isExternalFolderValue(value: string): boolean {
	const text = value.trim();
	return text === "~" || text.startsWith("~/") || isAbsolute(text);
}

/** `~` and `~/…` expanded against `home`; anything else resolved as an absolute path. */
export function expandHome(value: string, home: string): string {
	const text = value.trim();
	if (text === "~") return home;
	return resolve(text.startsWith("~/") ? join(home, text.slice(2)) : text);
}

/** Why an outside-the-vault folder cannot be used, or null. Checked as the person types and again before writing. */
export function externalFolderProblem(value: string, allowOutside: boolean, home: string): string | null {
	const text = value.trim();
	if (!allowOutside) return "A folder outside the vault needs \"Allow export kits outside the vault\" turned on first.";
	if (text.includes("\0")) return "The path contains a NUL character.";
	if (text.split(/[\\/]/).some(part => part === "..")) return "Path traversal (..) is not allowed.";
	const path = expandHome(text, home);
	if (path === resolve("/") || path === resolve(home)) return "Choose a folder, not the root or home folder itself.";
	return null;
}

/**
 * The kit root for the stored `exportFolder`. Throws with a message the person can act on when the value names a folder
 * outside the vault while that is not allowed, or names the vault root itself.
 */
export function resolveKitRoot(value: string, options: { allowOutside: boolean; home: string; vaultBase: string | null }): KitRoot {
	const text = value.trim();
	if (!isExternalFolderValue(text)) return { kind: "vault", folder: text.replace(/\/+$/, "") };
	const problem = externalFolderProblem(text, options.allowOutside, options.home);
	if (problem) throw new Error(`Export kit folder "${text}": ${problem}`);
	const path = expandHome(text, options.home);
	if (options.vaultBase) {
		const base = resolve(options.vaultBase);
		if (path === base) throw new Error(`Export kit folder "${text}" is the vault itself; choose a folder inside or outside it.`);
		if (path.startsWith(`${base}${sep}`)) return { kind: "vault", folder: relative(base, path).split(sep).join("/") };
	}
	return { kind: "external", path };
}
