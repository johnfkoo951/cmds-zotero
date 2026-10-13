import { promises as fs } from "node:fs";

import { basename, join, relative, sep } from "node:path";
import { validateIndex } from "../identity";
import { buildConnection, buildEnvelope } from "../agent/connection";
import { ACTION_API_VERSION, AGENT_ACTIONS, runAction as dispatch, type ActionHost, type AgentAction, type PdfCacheReader } from "../agent/actions";
import type { FailureReason, IndexView, NoteRecord, VaultReader } from "../agent/types";
import { probeBbt } from "./bbt-direct";
import { configDirOf, FsVaultReader, locateVault, readPluginSettings, readEnabledPlugins, readInstalledPluginVersion } from "./fs-vault";
import { probeGit } from "../git-probe";
import { LocalFileError, readLocalFile } from "../local-file";
import { hashLocalPdf } from "../pdf/file-hash";
import type { ZoteroIndex } from "../types";

/**
 * 0.5 R13/F10: contract-2 support is decided by the installed manifest's numeric major.minor (>= 0.4 advertises [1, 2],
 * 0.0-0.3 only [1]); an absent or unparsable version stays unknown rather than being downgraded.
 */
export function pluginApiVersionsFor(version: string | null): number[] | null {
	const match = version ? /^(\d+)\.(\d+)(?:\.|$|-|\+)/.exec(version.trim()) : null;
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 0 || minor >= 4 ? [1, 2] : [1];
}


/** `configDir` (HYG-02) is the vault's configuration folder name: `--config-dir`, or the default the command line wrapper supplies. */
export interface OfflineRunInput { action: string; vault: string; vaultPath?: string | null; configDir: string; request?: unknown; obsidianError?: string | null; now?: Date }

async function readIndex(root: string, path: string): Promise<{ index: ZoteroIndex | null; failure: { reason: FailureReason; message: string } | null; present: boolean }> {
	let full: string;
	try {
		const reader = new FsVaultReader(root, basename(root));
		full = await reader.resolveInside(path);
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { index: null, present: false, failure: { reason: missing ? "index-missing" : "path-outside-vault", message: missing ? `Index file is absent: ${path}` : error instanceof Error ? error.message : "Invalid index path." } };
	}
	let text: string;
	try { text = Buffer.from((await readLocalFile(full, { maxBytes: 64 * 1024 * 1024, minBytes: 1, magic: () => true })).bytes).toString("utf8"); }
	catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		return { index: null, present: code !== "ENOENT", failure: { reason: code === "ENOENT" ? "index-missing" : "index-invalid", message: code === "ENOENT" ? `Index file is absent: ${path}` : error instanceof Error ? error.message : "Index cannot be read." } };
	}
	try {
		const value: unknown = JSON.parse(text);
		if (!validateIndex(value)) return { index: null, present: true, failure: { reason: "index-invalid", message: `Index file is present but invalid: ${path}` } };
		return { index: value, present: true, failure: null };
	} catch { return { index: null, present: true, failure: { reason: "index-invalid", message: `Index file is present but is not valid JSON: ${path}` } }; }
}

function cacheReader(reader: FsVaultReader): PdfCacheReader {
	return {
		list: path => reader.listDir(path),
		read: path => reader.readText(path, 32 * 1024 * 1024),
		statLocal: async path => {
			try { if (await fs.realpath(path) !== path) return null; const stat = await fs.lstat(path); return stat.isFile() && !stat.isSymbolicLink() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null; } catch { return null; }
		},
		fileHash: async path => {
			// 0.5 R13/F08: no size pre-check here; the shared guarded reader refuses an oversized or non-PDF file with its
			// code (pdf-too-large / pdf-invalid), while an absent or boundary-failing path stays null.
			let full: string;
			try { full = await reader.resolveInside(path); } catch { return null; }
			return hashLocalPdf(full);
		},
	};
}

async function pdfPaths(root: string): Promise<string[]> {
	const output: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		if (output.length >= 20000) return;
		let entries: import("node:fs").Dirent[];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) output.push(relative(root, full).split(sep).join("/"));
		}
	};
	await walk(root);
	return output.sort();
}

async function offlineHost(input: OfflineRunInput, action: AgentAction): Promise<ActionHost | { failure: Record<string, unknown> }> {
	const now = input.now ?? new Date();
	const configDir = configDirOf(input.configDir);
	const located = await locateVault(input.vault, input.vaultPath ?? null);
	if (!located.location) {
		const reason: FailureReason = located.ambiguous ? "ambiguous-vault-path" : "path-outside-vault";
		const message = located.ambiguous ? `Several registered vaults are named ${input.vault}. Pass --vault-path.` : `Vault ${input.vault} was not found. Pass --vault-path.`;
		const connection = buildConnection({ mode: "offline", obsidian: "unavailable", ...(input.obsidianError ? { obsidianError: input.obsidianError } : {}), pluginVersion: null, pluginApiVersions: null, pluginEnabled: null, bbt: { reachable: null }, index: { source: "none", path: "", generatedAt: null, count: null, complete: null, schemaVersion: null }, maxAgeMinutes: 60, legacyPluginEnabled: null, git: null, now });
		return { failure: { apiVersion: ACTION_API_VERSION[action], contract: 2, apiVersions: [1, 2], action, vault: input.vault, ok: false, reason, message, checkedAt: now.toISOString(), connection, ...(located.candidates.length ? { candidates: located.candidates } : {}) } };
	}
	const root = located.location.path;
	const reader = new FsVaultReader(root, input.vault);
	const [{ settings, present: settingsPresent }, enabled, version] = await Promise.all([readPluginSettings(root, configDir), readEnabledPlugins(root, configDir), readInstalledPluginVersion(root, configDir)]);
	const loaded = await readIndex(root, settings.zoteroIndexPath);
	const bbt = action === "connection" ? await probeBbt(settings.bbtEndpoint) : { reachable: null };
	const connection = buildConnection({
		mode: "offline", obsidian: "unavailable", ...(input.obsidianError ? { obsidianError: input.obsidianError } : {}), pluginVersion: version,
		pluginApiVersions: pluginApiVersionsFor(version), pluginEnabled: enabled === null ? (settingsPresent ? null : false) : enabled.includes("cmds-zotero"), bbt,
		index: { source: loaded.index ? "offline-file" : "none", path: settings.zoteroIndexPath, generatedAt: loaded.index?.generatedAt ?? null, count: loaded.index?.count ?? null, complete: loaded.index?.complete ?? null, schemaVersion: loaded.index?.schemaVersion ?? null },
		maxAgeMinutes: settings.indexMaxAgeMinutes, legacyPluginEnabled: enabled === null ? null : enabled.includes("cmds-link-zotero"), git: await probeGit(root, settings.zoteroIndexPath), now,
	});
	const indexView: IndexView | null = loaded.index ? { index: loaded.index, ageMinutes: connection.index.ageMinutes ?? Number.POSITIVE_INFINITY, stale: connection.index.stale !== false } : null;
	return {
		vault: input.vault, now, connection, settings, indexView, indexFailure: loaded.failure, reader,
		bibliography: null, bibliographyReason: "offline", vaultLinks: async () => ({ links: [], warnings: ["Cross-vault maps are unavailable in offline mode."] }),
		pdfCache: cacheReader(reader), vaultPdfPaths: () => pdfPaths(root),
	};
}

/** Maps a thrown error of an offline action to its structured failure envelope. */
function offlineFailure(host: ActionHost, action: AgentAction, error: unknown): Record<string, unknown> {
	const message = error instanceof Error ? error.message : "Offline action failed.";
	// 0.5 R13/F08: typed local-file refusals map by code before any message pattern.
	const reason: FailureReason = error instanceof LocalFileError ? (error.code === "too-large" ? "pdf-too-large" : "pdf-invalid") : /outside|escapes|not found/i.test(message) ? "path-outside-vault" : "invalid-request";
	return { ...buildEnvelope(action, host.vault, ACTION_API_VERSION[action], host.connection, host.now, { reason, message }), ...(ACTION_API_VERSION[action] === 1 ? { status: "unavailable" } : {}) };
}

export async function runAction(input: OfflineRunInput): Promise<Record<string, unknown>> {
	if (!AGENT_ACTIONS.includes(input.action as AgentAction)) throw new Error(`Unsupported action: ${input.action}`);
	const action = input.action as AgentAction;
	const host = await offlineHost(input, action);
	if ("failure" in host) return host.failure;
	try { return await dispatch(host, action, input.request ?? {}); }
	catch (error) { return offlineFailure(host, action, error); }
}

/** A reader whose vault listing is taken once; reads of single notes pass through. For a batch of read-only requests of one action. */
function sharedListing(reader: VaultReader): VaultReader {
	let listing: Promise<NoteRecord[]> | null = null;
	const scanWarnings = reader.scanWarnings?.bind(reader);
	const findNote = reader.findNote?.bind(reader);
	return {
		vaultName: () => reader.vaultName(),
		listNotes: () => (listing ??= reader.listNotes()).then(notes => [...notes]),
		readNote: path => reader.readNote(path),
		exists: path => reader.exists(path),
		...(scanWarnings ? { scanWarnings } : {}),
		...(findNote ? { findNote } : {}),
	};
}

/**
 * `runAction` for many requests of one action (`resolve --stdin`): the host (vault location, settings, index, git probe) is
 * built once and the vault is listed once, so a batch costs little more than a single request. Each request is answered on its
 * own, in order; a failing request becomes its own failure envelope and never stops the others.
 */
export async function runActions(input: Omit<OfflineRunInput, "request"> & { requests: readonly unknown[] }): Promise<Record<string, unknown>[]> {
	if (!AGENT_ACTIONS.includes(input.action as AgentAction)) throw new Error(`Unsupported action: ${input.action}`);
	const action = input.action as AgentAction;
	const host = await offlineHost(input, action);
	if ("failure" in host) return input.requests.map(() => host.failure);
	const shared: ActionHost = { ...host, reader: sharedListing(host.reader) };
	const results: Record<string, unknown>[] = [];
	for (const request of input.requests) {
		try { results.push(await dispatch(shared, action, request ?? {})); }
		catch (error) { results.push(offlineFailure(shared, action, error)); }
	}
	return results;
}
