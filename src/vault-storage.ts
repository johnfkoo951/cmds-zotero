import { App, FileSystemAdapter, normalizePath } from "obsidian";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { privateIgnoreCoversAll } from "./agent/git-ignore";
import { digestFile, digestIfText, readWithDigest, sameDigest, type IndexDigest } from "./index-digest";
import type { IndexStorage } from "./types";
import { BIBLIOGRAPHY_SIDECAR, type BibliographyStorage } from "./bibliography-store"; // 0.5 R12

export function relativePath(value: string): string {
	if (!value || value.includes("\\") || value.includes("\0") || /^[a-z]+:/i.test(value) || value.startsWith("/")) {
		throw new Error("Choose a vault-relative path.");
	}
	if (value.split("/").some(part => part === ".." || part === "." || part === "")) {
		throw new Error("Path traversal and empty path segments are not allowed.");
	}
	return normalizePath(value);
}

export async function assertVaultBoundary(app: App, value: string): Promise<void> {
	const rel = relativePath(value);
	if (!(app.vault.adapter instanceof FileSystemAdapter)) throw new Error("A desktop file-system vault is required.");
	const root = await fs.realpath(app.vault.adapter.getBasePath());
	let current = root;
	for (const segment of rel.split("/")) {
		current = path.join(current, segment);
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symbolic-link output paths are not allowed.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

export async function ensureDirectory(app: App, filePath: string): Promise<void> {
	const parts = relativePath(filePath).split("/");
	parts.pop();
	let dir = "";
	for (const part of parts) {
		dir = dir ? `${dir}/${part}` : part;
		if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
	}
}

export const CMDS_DIR = ".cmds-zotero";
export const BACKUP_DIR = `${CMDS_DIR}/backups`;
/** Backups written by this plugin: `index-<epoch ms>-<uuid>.json`. Anything else in the directory is never touched. */
export const BACKUP_NAME = /^index-(\d{1,16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
export const BACKUPS_KEPT = 3;

/** Names of the plugin's own backups that fall outside the newest `keep`; `protect` is always kept. Pure, deterministic. */
export function staleBackups(names: string[], keep = BACKUPS_KEPT, protect?: string): string[] {
	const own = names.filter(name => BACKUP_NAME.test(name) && name !== protect)
		.sort((left, right) => Number(BACKUP_NAME.exec(right)![1]) - Number(BACKUP_NAME.exec(left)![1]) || right.localeCompare(left));
	const slots = protect && names.includes(protect) ? keep - 1 : keep;
	return own.slice(Math.max(slots, 0));
}

/** The plugin's private directory holds sensitive caches; it is always gitignored by the plugin itself (idempotent). */
export async function ensureCmdsIgnore(app: App): Promise<void> {
	const ignore = `${CMDS_DIR}/.gitignore`;
	await assertVaultBoundary(app, ignore);
	await ensureDirectory(app, ignore);
	const old = await app.vault.adapter.exists(ignore) ? await app.vault.adapter.read(ignore) : "";
	if (!privateIgnoreCoversAll(old)) await app.vault.adapter.write(ignore, old + (old && !old.endsWith("\n") ? "\n" : "") + "*\n");
}

export class VaultIndexStorage implements IndexStorage {
	/**
	 * Digest of the index bytes last read or written (null: the file was absent; undefined: not read yet). Only the digest
	 * is kept: the text belongs to the caller, so the plugin never holds a second copy of the index for its lifetime.
	 */
	private snapshot: IndexDigest | null | undefined;
	constructor(private app: App, private indexPath: string, private canWrite: () => boolean = () => true) {
		relativePath(indexPath);
		if (indexPath.startsWith(`${app.vault.configDir}/`)) throw new Error("Keep the index outside the configuration directory.");
	}

	async read(): Promise<string | null> {
		await assertVaultBoundary(this.app, this.indexPath);
		const file = await readWithDigest(this.fullPath(this.indexPath));
		this.snapshot = file?.digest ?? null;
		return file ? file.bytes.toString("utf8") : null;
	}

	async fingerprint(): Promise<string | undefined> {
		const stat = await this.app.vault.adapter.stat(this.indexPath);
		return stat ? `${stat.size}:${stat.mtime}` : "absent";
	}

	/** Absolute path of a vault-relative path; the guarded replacement needs a desktop file-system vault. */
	private fullPath(relative: string): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("A desktop file-system vault is required.");
		return path.join(adapter.getBasePath(), relative);
	}

	/** Digest of the index file as it is now (null when absent), hashed in bounded chunks. */
	private currentDigest(): Promise<IndexDigest | null> {
		return digestFile(this.fullPath(this.indexPath));
	}

	async writeValidated(content: string): Promise<void> {
		await assertVaultBoundary(this.app, this.indexPath);
		await ensureDirectory(this.app, this.indexPath);
		const current = await this.currentDigest();
		if (this.snapshot !== undefined && !sameDigest(current, this.snapshot)) {
			throw new Error("Index changed during refresh. Reload the plugin before retrying; the external changes were preserved.");
		}
		const token = randomUUID();
		const temp = `${this.indexPath}.${token}.tmp`;
		const adapter = this.app.vault.adapter;
		let backupName: string | undefined;
		try {
			await adapter.write(temp, content);
			const written = await digestIfText(this.fullPath(temp), content);
			if (written === null) throw new Error("Index staging verification failed.");
			if (current !== null) {
				await ensureCmdsIgnore(this.app);
				backupName = `index-${Date.now()}-${token}.json`;
				const backup = `${BACKUP_DIR}/${backupName}`;
				await assertVaultBoundary(this.app, backup);
				await ensureDirectory(this.app, backup);
				await this.copyIndex(backup);
			}
			if (!sameDigest(await this.currentDigest(), current)) throw new Error("Index changed during staging; refresh was cancelled.");
			if (!this.canWrite()) throw new Error("The plugin was unloaded; index replacement was cancelled.");
			// DataAdapter.rename refuses an existing destination. A same-directory
			// filesystem rename atomically replaces it without deleting the old file first.
			if (!(adapter instanceof FileSystemAdapter)) throw new Error("A desktop file-system vault is required.");
			await assertVaultBoundary(this.app, this.indexPath);
			await fs.rename(path.join(adapter.getBasePath(), temp), path.join(adapter.getBasePath(), this.indexPath));
			this.snapshot = written;
		} finally {
			if (await adapter.exists(temp)) await adapter.remove(temp);
		}
		if (backupName !== undefined) await this.pruneBackups(backupName);
	}

	/**
	 * Backs up the index with one file-system copy (a copy-on-write clone where the volume supports it) instead of writing
	 * a copy from memory. An index that vanished since it was checked gets the same verdict as the post-staging comparison.
	 */
	private async copyIndex(backup: string): Promise<void> {
		try { await fs.copyFile(this.fullPath(this.indexPath), this.fullPath(backup), fsConstants.COPYFILE_FICLONE); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(await this.app.vault.adapter.exists(this.indexPath))) throw new Error("Index changed during staging; refresh was cancelled.");
			throw error;
		}
	}

	/** Keeps the newest `BACKUPS_KEPT` plugin-owned backups after a successful replacement; foreign files are never deleted. */
	private async pruneBackups(protect: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			await assertVaultBoundary(this.app, BACKUP_DIR);
			if (!(await adapter.exists(BACKUP_DIR))) return;
			const names = (await adapter.list(BACKUP_DIR)).files.map(file => file.split("/").pop() ?? file);
			for (const name of staleBackups(names, BACKUPS_KEPT, protect)) {
				const target = `${BACKUP_DIR}/${name}`;
				await assertVaultBoundary(this.app, target);
				await adapter.remove(target);
			}
		} catch (error) {
			// Pruning is best effort: a leftover backup is harmless, a failed refresh is not.
			console.debug("CMDS Zotero: could not prune index backups", error);
		}
	}
}

// 0.5 R12: the bibliography sidecar lives in the plugin's private directory; reads never write, writes keep the private ignore.
/** Text storage for `.cmds-zotero/bibliography.json`; `canWrite` guards a late write after the host was reconfigured. */
export function bibliographySidecarStorage(app: App, canWrite: () => boolean = () => true): BibliographyStorage {
	const adapter = app.vault.adapter;
	return {
		read: async () => {
			await assertVaultBoundary(app, BIBLIOGRAPHY_SIDECAR);
			return (await adapter.exists(BIBLIOGRAPHY_SIDECAR)) ? adapter.read(BIBLIOGRAPHY_SIDECAR) : null;
		},
		write: async text => {
			if (!canWrite()) return;
			await assertVaultBoundary(app, BIBLIOGRAPHY_SIDECAR);
			await ensureCmdsIgnore(app);
			if (!canWrite()) return;
			await adapter.write(BIBLIOGRAPHY_SIDECAR, text);
		},
	};
}
