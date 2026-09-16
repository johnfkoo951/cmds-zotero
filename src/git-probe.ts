import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
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
