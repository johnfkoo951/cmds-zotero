/**
 * Pure `.gitignore` evaluation for the `index-in-git` check: parses the root ignore file and answers whether a
 * vault-relative path is covered, without touching the git binary. Never import `obsidian` here.
 * Semantics follow gitignore(5): comments, blank lines, trailing-space stripping, `!` negation, anchoring by
 * inner/leading `/`, directory-only trailing `/`, `*`, `?`, `[...]` and the three `**` forms.
 */
import type { GitInfo } from "./types";

/** Plugin-owned cache directory (note map, PDF text cache, backups); must never reach a public remote. */
export const CACHE_DIR = ".cmds-zotero";

export interface GitignoreRule {
	pattern: string;
	negated: boolean;
	dirOnly: boolean;
	anchored: boolean;
	regex: RegExp;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Trailing spaces are ignored unless quoted with a backslash. */
function stripTrailingSpaces(line: string): string {
	let end = line.length;
	while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") end--;
	return line.slice(0, end);
}

function classEnd(segment: string, open: number): number {
	let i = open + 1;
	if (segment[i] === "!" || segment[i] === "^") i++;
	if (segment[i] === "]") i++;
	const close = segment.indexOf("]", i);
	return close;
}

function classToRegex(body: string): string {
	const negated = body.startsWith("!") || body.startsWith("^");
	const inner = (negated ? body.slice(1) : body).replace(/[\\\]^[]/g, "\\$&");
	return `[${negated ? "^" : ""}${inner}]`;
}

/** One path segment (no `/`) to a regex fragment; `*` and `?` never cross a separator. */
function segmentToRegex(segment: string): string {
	let out = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\" && i + 1 < segment.length) { out += escapeRegex(segment[++i]); continue; }
		if (ch === "*") { while (segment[i + 1] === "*") i++; out += "[^/]*"; continue; }
		if (ch === "?") { out += "[^/]"; continue; }
		if (ch === "[") {
			const close = classEnd(segment, i);
			if (close === -1) { out += "\\["; continue; }
			out += classToRegex(segment.slice(i + 1, close));
			i = close;
			continue;
		}
		out += escapeRegex(ch);
	}
	return out;
}

function patternToRegex(pattern: string, anchored: boolean): RegExp {
	const segments = pattern.split("/");
	let body = "";
	let afterDoubleStar = false;
	segments.forEach((segment, i) => {
		const joiner = i > 0 && !afterDoubleStar ? "/" : "";
		if (segment === "**") {
			if (i === segments.length - 1) { body += `${joiner}.*`; afterDoubleStar = true; return; }
			body += `${joiner}(?:.*/)?`;
			afterDoubleStar = true;
			return;
		}
		body += joiner + segmentToRegex(segment);
		afterDoubleStar = false;
	});
	return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}$`);
}

/** Rules in file order; comments, blank and empty-after-stripping lines are dropped. */
export function parseGitignore(text: string): GitignoreRule[] {
	const rules: GitignoreRule[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripTrailingSpaces(rawLine);
		if (line === "" || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		let pattern = negated ? line.slice(1) : line;
		const dirOnly = pattern.endsWith("/");
		pattern = pattern.replace(/\/+$/, "");
		const anchored = pattern.includes("/");
		pattern = pattern.replace(/^\/+/, "");
		if (pattern === "") continue;
		rules.push({ pattern, negated, dirOnly, anchored, regex: patternToRegex(pattern, anchored) });
	}
	return rules;
}

function normalizePath(relativePath: string): { path: string; isDir: boolean } {
	const cleaned = relativePath.replace(/\/{2,}/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
	const isDir = cleaned.endsWith("/");
	return { path: cleaned.replace(/\/+$/, ""), isDir };
}

/** Last matching rule wins; null when no rule matches. Directory-only rules never match files. */
function verdict(rules: GitignoreRule[], candidate: string, isDir: boolean): boolean | null {
	let result: boolean | null = null;
	for (const rule of rules) {
		if (rule.dirOnly && !isDir) continue;
		if (rule.regex.test(candidate)) result = !rule.negated;
	}
	return result;
}

function ignoredByRules(rules: GitignoreRule[], path: string, isDir: boolean): boolean {
	const segments = path.split("/");
	for (let depth = 1; depth < segments.length; depth++) {
		if (verdict(rules, segments.slice(0, depth).join("/"), true) === true) return true;
	}
	return verdict(rules, path, isDir) === true;
}

/**
 * Whether `relativePath` (vault-relative, `/`-separated; a trailing `/` marks a directory) is ignored.
 * An excluded parent directory ignores everything below it; a later `!` rule cannot re-include those files.
 */
export function isIgnored(gitignoreText: string, relativePath: string): boolean {
	const { path, isDir } = normalizePath(relativePath);
	if (path === "") return false;
	return ignoredByRules(parseGitignore(gitignoreText), path, isDir);
}

/**
 * Whether nothing inside `dir` can be committed: the directory itself is ignored, or a trailing `dir/**` /
 * `dir/*` rule swallows every child (git leaves the directory unmatched in that form, so `isIgnored` alone says no).
 */
export function isDirectoryCovered(gitignoreText: string, dir: string): boolean {
	const { path } = normalizePath(dir);
	if (path === "") return false;
	const rules = parseGitignore(gitignoreText);
	if (ignoredByRules(rules, path, true)) return true;
	const probe = `${path}/`;
	let covered = false;
	for (const rule of rules) {
		if (rule.negated) { covered = false; continue; }
		if (!rule.dirOnly && rule.regex.test(probe)) covered = true;
	}
	return covered;
}

/**
 * Git coverage of the two sensitive locations. `gitignoreText: null` means the repository has no root ignore file,
 * so neither path is covered; the caller decides whether `.git` exists at all.
 */
export function gitCoverage(gitignoreText: string | null, indexPath: string, cacheDir: string, privateIgnore: string | null = null): GitInfo {
	gitignoreText ??= "";
	return {
		repo: true,
		indexIgnored: isIgnored(gitignoreText, indexPath),
		cacheIgnored: isDirectoryCovered(gitignoreText, cacheDir) || privateIgnoreCoversAll(privateIgnore),
	};
}

/** A final catch-all in the private directory overrides earlier local exceptions. */
export function privateIgnoreCoversAll(text: string | null): boolean {
	const last = parseGitignore(text ?? "").at(-1);
	return last !== undefined && !last.negated && !last.dirOnly && !last.anchored && last.pattern === "*";
}
