import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYamlText } from "yaml";
import type { NoteRecord, VaultReader } from "../agent/types";
import { normalizeSettings } from "../settings-data";
import type { CmdsZoteroSettings } from "../types";

export const MAX_LISTED_NOTES = 20000;
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

export interface VaultLocation { name: string; path: string }

/** Finds a vault by name in Obsidian's registry; two matches are an error the caller must surface. */
export async function locateVault(name: string, explicitPath: string | null, home = homedir()): Promise<{ location: VaultLocation | null; ambiguous: boolean; candidates: string[] }> {
	if (explicitPath) {
		if (!isAbsolute(explicitPath)) throw new Error("--vault-path must be absolute");
		const real = await fs.realpath(explicitPath);
		return { location: { name, path: real }, ambiguous: false, candidates: [real] };
	}
	const registry = join(home, "Library", "Application Support", "obsidian", "obsidian.json");
	let raw: unknown;
	try { raw = JSON.parse(await fs.readFile(registry, "utf8")); } catch { return { location: null, ambiguous: false, candidates: [] }; }
	const vaults = raw && typeof raw === "object" && (raw as { vaults?: unknown }).vaults;
	const candidates: string[] = [];
	if (vaults && typeof vaults === "object") {
		for (const value of Object.values(vaults as Record<string, unknown>)) {
			const path = value && typeof value === "object" ? (value as { path?: unknown }).path : undefined;
			if (typeof path === "string" && basename(path) === name) candidates.push(path);
		}
	}
	if (candidates.length !== 1) return { location: null, ambiguous: candidates.length > 1, candidates };
	return { location: { name, path: await fs.realpath(candidates[0]) }, ambiguous: false, candidates };
}

export function parseFrontmatter(text: string): { frontmatter: Record<string, unknown> | null; frontmatterParse: "ok" | "error"; body: string } {
	const withoutBOM = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(withoutBOM);
	if (!match) return { frontmatter: null, frontmatterParse: "ok", body: withoutBOM };
	const body = withoutBOM.slice(match[0].length);
	try {
		const parsed: unknown = parseYamlText(match[1]);
		return { frontmatter: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null, frontmatterParse: "ok", body };
	} catch { return { frontmatter: null, frontmatterParse: "error", body }; }
}

/** Offline read-only vault access over the filesystem: refuses symlinks and anything outside the vault root. */
export class FsVaultReader implements VaultReader {
	constructor(private root: string, private name: string) {}

	vaultName(): string { return this.name; }

	async resolveInside(path: string): Promise<string> {
		if (path.includes("\0") || path.includes("\\") || isAbsolute(path)) throw new Error("Choose a vault-relative path.");
		const target = resolve(this.root, path);
		const rel = relative(this.root, target);
		if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Path escapes the vault.");
		const real = await fs.realpath(target);
		if (real !== target && !real.startsWith(this.root + sep)) throw new Error("Path resolves outside the vault.");
		return target;
	}

	async listNotes(): Promise<NoteRecord[]> {
		const notes: NoteRecord[] = [];
		const walk = async (dir: string): Promise<void> => {
			if (notes.length >= MAX_LISTED_NOTES) return;
			let entries: import("node:fs").Dirent[];
			try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (notes.length >= MAX_LISTED_NOTES) return;
				if (entry.isSymbolicLink()) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) { if (!entry.name.startsWith(".")) await walk(full); continue; }
				if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
				const relPath = relative(this.root, full).split(sep).join("/");
				let text: string;
				try {
					const stat = await fs.stat(full);
					if (stat.size > MAX_NOTE_BYTES) continue;
					text = await fs.readFile(full, "utf8");
				} catch { continue; }
				const head = text.startsWith("---") ? text : "";
				const parsed = parseFrontmatter(head);
				notes.push({ path: relPath, basename: entry.name.replace(/\.md$/, ""), frontmatter: parsed.frontmatter, frontmatterParse: parsed.frontmatterParse });
			}
		};
		await walk(this.root);
		return notes;
	}

	async readNote(path: string): Promise<string> {
		const full = await this.resolveInside(path);
		const stat = await fs.stat(full);
		if (!stat.isFile()) throw new Error(`Note not found: ${path}`);
		if (stat.size > MAX_NOTE_BYTES) throw new Error(`Note exceeds ${MAX_NOTE_BYTES / 1024 / 1024} MiB: ${path}`);
		return fs.readFile(full, "utf8");
	}

	async exists(path: string): Promise<boolean> {
		try { const full = await this.resolveInside(path); return (await fs.stat(full)).isFile(); } catch { return false; }
	}

	async readText(path: string, maxBytes: number): Promise<string | null> {
		try {
			const full = await this.resolveInside(path);
			const stat = await fs.stat(full);
			if (!stat.isFile() || stat.size > maxBytes) return null;
			return await fs.readFile(full, "utf8");
		} catch { return null; }
	}

	async statFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
		try { const full = await this.resolveInside(path); const stat = await fs.stat(full); return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null; } catch { return null; }
	}

	async listDir(path: string): Promise<string[]> {
		try { const full = await this.resolveInside(path); return (await fs.readdir(full)).sort(); } catch { return []; }
	}

	async isDirectory(path: string): Promise<boolean> {
		try { const full = await this.resolveInside(path); return (await fs.stat(full)).isDirectory(); } catch { return false; }
	}
}

/** Plugin settings as persisted by Obsidian, normalized exactly like the plugin does; defaults when absent. */
export async function readPluginSettings(root: string): Promise<{ settings: CmdsZoteroSettings; present: boolean }> {
	try {
		const raw: unknown = JSON.parse(await fs.readFile(join(root, ".obsidian", "plugins", "cmds-zotero", "data.json"), "utf8"));
		return { settings: normalizeSettings(raw), present: true };
	} catch { return { settings: normalizeSettings({}), present: false }; }
}

export async function readEnabledPlugins(root: string): Promise<string[] | null> {
	try {
		const raw: unknown = JSON.parse(await fs.readFile(join(root, ".obsidian", "community-plugins.json"), "utf8"));
		return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : null;
	} catch { return null; }
}

export async function readInstalledPluginVersion(root: string): Promise<string | null> {
	try {
		const raw: unknown = JSON.parse(await fs.readFile(join(root, ".obsidian", "plugins", "cmds-zotero", "manifest.json"), "utf8"));
		const version = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
		return typeof version === "string" ? version : null;
	} catch { return null; }
}

export async function readGitignore(root: string): Promise<{ repo: boolean; text: string | null }> {
	let repo = false;
	// `.git` is a directory for a checkout and a file for a worktree; either means the vault is version-controlled.
	try { await fs.stat(join(root, ".git")); repo = true; } catch { repo = false; }
	if (!repo) return { repo: false, text: null };
	try { return { repo: true, text: await fs.readFile(join(root, ".gitignore"), "utf8") }; } catch { return { repo: true, text: null }; }
}
