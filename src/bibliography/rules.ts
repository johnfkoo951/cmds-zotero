/**
 * 0.6.2: validation rules of the bibliography settings, shared by the settings tab, `normalizeSettings` and the offline
 * core. Pure and dependency-free apart from `path`.
 */
import { isAbsolute } from "path";

const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

/** Why a locale cannot be sent to Better BibTeX, else null; empty means the style's default locale. */
export function localeProblem(value: string): string | null {
	const text = value.trim();
	if (!text) return null;
	return LOCALE.test(text) ? null : "Enter a locale such as en-US, de-DE or ko-KR, or leave it empty for the style's default.";
}

/** A locale written loosely (`ko_kr`, `EN-us`) in canonical case, or the input when it is not a locale at all. */
export function canonicalLocale(value: string): string {
	const parts = value.trim().replace(/_/g, "-").split("-");
	if (!parts[0]) return "";
	return parts.map((part, index) => index === 0 ? part.toLowerCase() : part.length === 4 ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part.toUpperCase()).join("-");
}

/** Why a data-directory setting cannot be used (absolute path, or `~/…`; no NUL, no `..` segments), else null. */
export function dataDirectoryProblem(value: string): string | null {
	const text = value.trim();
	if (!text) return null;
	if (text.includes("\0")) return "The path contains a NUL character.";
	if (!(text === "~" || text.startsWith("~/") || isAbsolute(text))) return "Enter an absolute folder path or one starting with ~/.";
	if (text.split(/[\\/]/).some(part => part === "..")) return "Path traversal (..) is not allowed.";
	return null;
}
