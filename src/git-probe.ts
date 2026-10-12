import { execFile } from "node:child_process";
import { promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CACHE_DIR, gitCoverage } from "./agent/git-ignore";
import type { GitInfo } from "./agent/types";
import { readLocalFile } from "./local-file";

const execute = promisify(execFile);
const MAX_IGNORE_BYTES = 256 * 1024;

async function ignoreText(root: string, name: string): Promise<string | null> {
	try {
		return Buffer.from((await readLocalFile(join(root, name), { maxBytes: MAX_IGNORE_BYTES, minBytes: 0, magic: () => true })).bytes).toString("utf8");
	} catch { return null; }
}

/** Local read-only Git probes. Missing Git yields unknown tracked state, never a clean bill of health. */
export async function probeGit(root: string, indexPath: string): Promise<GitInfo> {
	try { await fs.lstat(join(root, ".git")); }
	catch { return { repo: false, indexIgnored: null, cacheIgnored: null, indexTracked: null, cacheTracked: null }; }
	const result = gitCoverage(await ignoreText(root, ".gitignore"), indexPath, CACHE_DIR, await ignoreText(root, `${CACHE_DIR}/.gitignore`));
	result.indexTracked = null;
	result.cacheTracked = null;
	try {
		const { stdout } = await execute("git", ["-C", root, "ls-files", "-z", "--", indexPath, `${CACHE_DIR}/`], { timeout: 5000, maxBuffer: 512 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
		const names = stdout.split("\0").filter(Boolean);
		result.indexTracked = names.includes(indexPath);
		result.cacheTracked = names.some(name => name.startsWith(`${CACHE_DIR}/`));
	} catch { /* Tracked state is explicitly unknown if the bounded probe fails. */ }
	try {
		await execute("git", ["-C", root, "check-ignore", "--no-index", "--quiet", "--", indexPath], { timeout: 5000, maxBuffer: 8192, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
		result.indexIgnored = true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === 1) result.indexIgnored = false;
	}
	return result;
}

export type GitProbe = (root: string, indexPath: string) => Promise<GitInfo>;

/** PERF-09: how long a cached answer may stand even when no watched file changed (bounds what the watch list cannot see). */
export const GIT_PROBE_MAX_AGE_MS = 60_000;

/**
 * Files whose content decides `probeGit` for one vault: the Git index (`ls-files`), every ignore file `check-ignore`
 * and the pure coverage check consult for the index path and the private cache folder, the repository and user
 * configuration (which can move or redefine the excludes file), and the default user excludes file.
 */
export function gitProbeInputs(root: string, indexPath: string, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
	const nested: string[] = [];
	let folder = root;
	for (const part of indexPath.split("/").slice(0, -1)) { folder = join(folder, part); nested.push(join(folder, ".gitignore")); }
	const config = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(home, ".config");
	return [
		join(root, ".git", "index"), join(root, ".gitignore"), ...nested, join(root, CACHE_DIR, ".gitignore"),
		join(root, ".git", "info", "exclude"), join(root, ".git", "config"),
		join(home, ".gitconfig"), join(config, "git", "config"), join(config, "git", "ignore"),
	];
}

/** Identity, size and times of every input, or null when `.git` is not a directory (absent, or a linked worktree's pointer file). */
async function inputSignature(root: string, inputs: string[]): Promise<string | null> {
	let git: Stats;
	try { git = await fs.lstat(join(root, ".git")); } catch { return null; }
	if (!git.isDirectory()) return null;
	const parts = await Promise.all(inputs.map(path => fs.lstat(path).then(
		stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
		(error: unknown) => typeof error === "object" && error !== null && "code" in error ? String(error.code) : "error",
	)));
	return `${git.dev}:${git.ino}|${parts.join("|")}`;
}

interface CachedProbe { signature: string; at: number; answer: Promise<GitInfo> }

/**
 * PERF-09: `probeGit` for one plugin session. An answer is reused while every file in `gitProbeInputs` keeps its lstat
 * signature, for at most `maxAgeMs`; concurrent callers share one probe. A vault whose `.git` is not a directory keeps
 * the uncached probe (absent: the probe spawns nothing; a worktree pointer: its index lives elsewhere). Callers get a
 * copy, never the cached object.
 */
export function cachedGitProbe(options: { probe?: GitProbe; maxAgeMs?: number; now?: () => number; home?: string; env?: NodeJS.ProcessEnv } = {}): GitProbe {
	const probe = options.probe ?? probeGit;
	const maxAgeMs = options.maxAgeMs ?? GIT_PROBE_MAX_AGE_MS;
	const now = options.now ?? Date.now;
	const cache = new Map<string, CachedProbe>();
	return async (root, indexPath) => {
		const key = `${root}\0${indexPath}`;
		const signature = await inputSignature(root, gitProbeInputs(root, indexPath, options.home, options.env));
		if (signature === null) { cache.delete(key); return probe(root, indexPath); }
		const hit = cache.get(key);
		if (hit && hit.signature === signature && now() - hit.at < maxAgeMs) return { ...(await hit.answer) };
		const entry: CachedProbe = { signature, at: now(), answer: probe(root, indexPath) };
		cache.set(key, entry);
		try { return { ...(await entry.answer) }; }
		catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
	};
}
