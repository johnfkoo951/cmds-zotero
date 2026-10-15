import { promises as fs, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYamlText } from "yaml";
import { readLocalFile } from "../local-file";
import { parseNoteText } from "../frontmatter-read";
import type { NoteRecord, ScanSkip, VaultReader } from "../agent/types";
import { findNote as findListedNote, notePathCandidates } from "../agent/note-lookup";
import { LEGACY_DEFAULT_INDEX_PATH, normalizeSettings, storesIndexPath } from "../settings-data";
import type { CmdsZoteroSettings } from "../types";
import { SCAN_CONCURRENCY, scanInOrder } from "../vault-scan";

export const MAX_LISTED_NOTES = 20000;
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

/**
 * HYG-02: a configuration folder name as Obsidian accepts one: a single path segment that starts with a dot. The offline CLI
 * runs without Obsidian, so there is no `Vault#configDir` to ask. The folder is therefore always a parameter (`--config-dir`),
 * and the command line wrapper (scripts/ingest.mjs) supplies Obsidian's default when none is given: no plugin source names
 * the default folder, which `obsidianmd/hardcoded-config-path` forbids and its configuration does not let a file disable.
 */
export function configDirOf(value: string): string {
	if (typeof value !== "string" || !/^\.[^/\\]+$/.test(value) || value === ".." || value.includes("\0")) throw new Error("--config-dir must be one folder name that starts with a dot.");
	return value;
}

/** One step of the scan order: a note file, an entry the scan passes without reading, or a path it reports as skipped. */
type WalkEvent = { kind: "note"; path: string; basename: string } | { kind: "skip"; path: string; reason: "unreadable" | "symlink" } | { kind: "pass" };

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

export function parseFrontmatter(text: string): ReturnType<typeof parseNoteText> {
	return parseNoteText(text, parseYamlText);
}

/** Offline read-only vault access over the filesystem: refuses symlinks and anything outside the vault root. */
export class FsVaultReader implements VaultReader {
	private report = { skipped: [] as string[], truncated: false, skippedDetail: [] as ScanSkip[] };
	/** `limit` is the note cap of one scan (MAX_LISTED_NOTES); tests lower it. */
	constructor(private root: string, private name: string, private limit = MAX_LISTED_NOTES) {}
	scanWarnings(): { skipped: string[]; truncated: boolean; skippedDetail: ScanSkip[] } { return { skipped: [...this.report.skipped], truncated: this.report.truncated, skippedDetail: this.report.skippedDetail.map(item => ({ ...item })) }; }
	// 0.5 R8: every skipped path carries its kind so reconcile apply can veto on unreadable or symlinked entries only.
	private skip(path: string, kind: ScanSkip["kind"]): void { this.report.skipped.push(path); this.report.skippedDetail.push({ path, kind }); }

	vaultName(): string { return this.name; }

	async resolveInside(path: string): Promise<string> {
		if (path.includes("\0") || path.includes("\\") || isAbsolute(path)) throw new Error("Choose a vault-relative path.");
		const target = resolve(this.root, path);
		const rel = relative(this.root, target);
		if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Path escapes the vault.");
		const real = await fs.realpath(target);
		if (real !== target) throw new Error("Path resolves outside the vault.");
		return target;
	}

	/**
	 * The scan order: depth first, each folder sorted by name, one event per folder visit and per entry (every event is
	 * where the note cap is checked). An unreadable folder and a symbolic link are skipped; dot-folders are not entered.
	 */
	private async *walk(dir: string): AsyncGenerator<WalkEvent> {
		yield { kind: "pass" };
		let entries: Dirent[];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { yield { kind: "skip", path: relative(this.root, dir).split(sep).join("/"), reason: "unreadable" }; return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) { yield { kind: "skip", path: relative(this.root, full).split(sep).join("/"), reason: "symlink" }; continue; }
			if (entry.isDirectory()) { yield { kind: "pass" }; if (!entry.name.startsWith(".")) yield* this.walk(full); continue; }
			if (!entry.isFile() || !entry.name.endsWith(".md")) { yield { kind: "pass" }; continue; }
			yield { kind: "note", path: relative(this.root, full).split(sep).join("/"), basename: entry.name.replace(/\.md$/, "") };
		}
	}

	async listNotes(): Promise<NoteRecord[]> {
		const notes: NoteRecord[] = [];
		this.report = { skipped: [], truncated: false, skippedDetail: [] };
		// PERF-07: up to SCAN_CONCURRENCY notes are read ahead while the walk is visited in order, so notes, skipped and
		// truncated equal the sequential walk's (a note read past the cap is discarded).
		await scanInOrder(this.walk(this.root), SCAN_CONCURRENCY, event => event.kind === "note" ? this.readNote(event.path).then(parseFrontmatter) : null, (event, outcome) => {
			if (notes.length >= this.limit) { this.report.truncated = true; return false; }
			if (event.kind === "skip") { this.skip(event.path, event.reason); return true; }
			if (event.kind === "pass") return true;
			if (!outcome?.ok) { this.skip(event.path, "unreadable"); return true; }
			if (outcome.value.frontmatterParse === "error") this.skip(event.path, "parse-error");
			notes.push({ path: event.path, basename: event.basename, frontmatter: outcome.value.frontmatter, frontmatterParse: outcome.value.frontmatterParse });
			return true;
		});
		return notes;
	}

	/**
	 * PERF-07: the answer of `findNote(await this.listNotes(), path)` without reading every note. A candidate that is not a
	 * regular file cannot be listed; otherwise the walk runs only up to it (no reads) and reads just that file. Notes the
	 * walk passes are counted, so a candidate that a capped scan could miss is answered by the scan itself (the only case
	 * that updates the scan report).
	 */
	async findNote(path: string): Promise<NoteRecord | null> {
		const candidates = notePathCandidates(path);
		const present = await Promise.all(candidates.map(candidate => fs.lstat(join(this.root, candidate)).then(stat => stat.isFile(), () => false)));
		if (!present.some(Boolean)) return null;
		const wanted = new Set<string>(candidates);
		let passed = 0;
		for await (const event of this.walk(this.root)) {
			if (event.kind !== "note") continue;
			if (wanted.has(event.path)) {
				if (passed >= this.limit) return findListedNote(await this.listNotes(), path);
				try {
					const parsed = parseFrontmatter(await this.readNote(event.path));
					return { path: event.path, basename: event.basename, frontmatter: parsed.frontmatter, frontmatterParse: parsed.frontmatterParse };
				} catch { /* Unreadable: a scan skips it, so a later candidate decides. */ }
			}
			passed++;
		}
		return null;
	}

	async readNote(path: string): Promise<string> {
		const full = await this.resolveInside(path);
		const stat = await fs.stat(full);
		if (!stat.isFile()) throw new Error(`Note not found: ${path}`);
		if (stat.size > MAX_NOTE_BYTES) throw new Error(`Note exceeds ${MAX_NOTE_BYTES / 1024 / 1024} MiB: ${path}`);
		return Buffer.from((await readLocalFile(full, { maxBytes: MAX_NOTE_BYTES, minBytes: 0, magic: () => true })).bytes).toString("utf8");
	}

	async exists(path: string): Promise<boolean> {
		try { const full = await this.resolveInside(path); return (await fs.stat(full)).isFile(); } catch { return false; }
	}

	async readText(path: string, maxBytes: number): Promise<string | null> {
		try {
			const full = await this.resolveInside(path);
			const stat = await fs.stat(full);
			if (!stat.isFile() || stat.size > maxBytes) return null;
			return Buffer.from((await readLocalFile(full, { maxBytes, minBytes: 0, magic: () => true })).bytes).toString("utf8");
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

/** Plugin settings as persisted by Obsidian in the vault's configuration folder, normalized exactly like the plugin does; defaults when absent. */
export async function readPluginSettings(root: string, configDir: string): Promise<{ settings: CmdsZoteroSettings; present: boolean }> {
	// 0.6.5: the same Index path fallback as the plugin (an index already at the pre-0.6.5 default is kept).
	const legacyIndex = async (raw: unknown): Promise<boolean> => !storesIndexPath(raw) && await fs.lstat(join(root, LEGACY_DEFAULT_INDEX_PATH)).then(() => true, () => false);
	let raw: unknown;
	try { raw = JSON.parse(await fs.readFile(join(root, configDir, "plugins", "cmds-zotero", "data.json"), "utf8")); }
	catch { return { settings: normalizeSettings({}, { legacyIndex: await legacyIndex({}) }), present: false }; }
	return { settings: normalizeSettings(raw, { legacyIndex: await legacyIndex(raw) }), present: true };
}

export async function readEnabledPlugins(root: string, configDir: string): Promise<string[] | null> {
	try {
		const raw: unknown = JSON.parse(await fs.readFile(join(root, configDir, "community-plugins.json"), "utf8"));
		return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : null;
	} catch { return null; }
}

export async function readInstalledPluginVersion(root: string, configDir: string): Promise<string | null> {
	try {
		const raw: unknown = JSON.parse(await fs.readFile(join(root, configDir, "plugins", "cmds-zotero", "manifest.json"), "utf8"));
		const version = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
		return typeof version === "string" ? version : null;
	} catch { return null; }
}
