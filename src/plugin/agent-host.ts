import { FileSystemAdapter, TFile, parseYaml, stringifyYaml } from "obsidian";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import type { ActionHost, AgentAction, ImportRequest, PdfTextRequest, RefreshRequest } from "../agent/actions";
import { EXPORT_TRANSLATORS } from "../agent/cites-core"; // 0.5 R10
import { buildConnection } from "../agent/connection";
import { describeBbtError, mapBounded, transportReasonOf } from "../api/transport";
import { probeGit } from "../git-probe";
import { validateIndex } from "../identity";
import { refreshRefusal, type IndexService } from "../index-service";
import { readLocalFile } from "../local-file";
import type CMDSZoteroPlugin from "../main";
import { ObsidianVaultReader } from "../obsidian-vault";
import type { PdfTextService } from "../pdf/extract";
import { hashLocalPdf } from "../pdf/file-hash";
import { applyReconcile } from "../reconcile-apply";
import { indexEntryFor, literatureNoteStatus, type RecentReport } from "../recent/recent-reads";
import type { ZoteroIndex } from "../types";
import { assertVaultBoundary, ensureCmdsIgnore, ensureDirectory, relativePath } from "../vault-storage";

/**
 * The live `ActionHost` for one agent request. `indexToken` and `pdfToken` are the services of the configuration that
 * accepted the request: writes are refused once the plugin unloads or reconfigures.
 */
export async function agentHost(plugin: CMDSZoteroPlugin, action: AgentAction, request: unknown, now: Date, onIndex: (index: ZoteroIndex) => Promise<void>, indexToken: IndexService, pdfToken: PdfTextService): Promise<ActionHost> {
	const reader = new ObsidianVaultReader(plugin.app);
	const index = await indexToken.peek();
	const adapter = plugin.app.vault.adapter;
	const indexExists = await adapter.exists(plugin.settings.zoteroIndexPath);
	// 0.5 R13/F11: the guarded local reader requires realpath === path, so a vault opened through a symlink must join
	// vault-relative paths onto the resolved base, not the path Obsidian was given.
	const root = adapter instanceof FileSystemAdapter ? await fs.realpath(adapter.getBasePath()).catch(() => adapter.getBasePath()) : null;
	const bbtInfo = action === "connection" ? await plugin.bbt.capabilities().then(value => ({ reachable: true, zotero: value.zotero, betterbibtex: value.betterbibtex }), (error: unknown) => { const reason = transportReasonOf(error); return { reachable: false, error: error instanceof Error ? error.message : "BBT unreachable", ...(reason ? { reason } : {}) }; }) : { reachable: null };
	const connection = buildConnection({
		mode: "live", obsidian: "ok", pluginVersion: plugin.manifest.version, pluginApiVersions: [1, 2], pluginEnabled: true, bbt: bbtInfo,
		index: { source: index ? "plugin" : "none", path: plugin.settings.zoteroIndexPath, generatedAt: index?.generatedAt ?? null, count: index?.count ?? null, complete: index?.complete ?? null, schemaVersion: index?.schemaVersion ?? null },
		maxAgeMinutes: plugin.settings.indexMaxAgeMinutes, legacyPluginEnabled: plugin.legacyPluginEnabled(),
		git: root ? await probeGit(root, plugin.settings.zoteroIndexPath) : null, now,
	});
	const host: ActionHost = {
		vault: plugin.app.vault.getName(), now, connection, settings: plugin.settings,
		indexView: index ? { index, ageMinutes: connection.index.ageMinutes ?? Number.POSITIVE_INFINITY, stale: connection.index.stale !== false } : null,
		indexFailure: index ? null : indexExists ? { reason: "index-invalid", message: "The index file exists but failed validation; run refresh explicitly." } : { reason: "index-missing", message: "No validated Zotero index is available; run refresh explicitly." }, reader,
		bibliography: (entry, style) => plugin.bibliography.bibliographyForStyle(entry, style), bibliographyReason: null,
		vaultLinks: (entry, current) => plugin.links.find(entry, current),
		pdfCache: {
			list: async dir => { await assertVaultBoundary(plugin.app, dir); return (await adapter.exists(dir)) ? (await adapter.list(dir)).files.map(path => path.split("/").pop() ?? path) : []; },
			read: async path => {
				if (!root) return null;
				try {
					await assertVaultBoundary(plugin.app, path);
					const bytes = (await readLocalFile(nodePath.join(root, relativePath(path)), { maxBytes: 32 * 1024 * 1024, minBytes: 0, magic: () => true })).bytes;
					return Buffer.from(bytes).toString("utf8");
				} catch { return null; }
			},
			statLocal: async path => { try { if (await fs.realpath(path) !== path) return null; const stat = await fs.lstat(path); return stat.isFile() && !stat.isSymbolicLink() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null; } catch { return null; } },
			fileHash: async path => {
				if (!root) return null;
				// 0.5 R13/F08: the shared guarded reader surfaces an oversized or non-PDF file by code; boundary failures stay null.
				try { await assertVaultBoundary(plugin.app, path); } catch { return null; }
				return hashLocalPdf(nodePath.join(root, relativePath(path)));
			},
		},
		vaultPdfPaths: async () => plugin.app.vault.getFiles().filter(file => file.extension.toLowerCase() === "pdf").map(file => file.path).sort(),
		// 0.5 R10: structured bibliography export and the sidecar store (vault-bounded; the private ignore file is ensured before every write).
		exportBibliography: (citekeys, format, libraryID) => plugin.bbt.export(citekeys, EXPORT_TRANSLATORS[format], libraryID),
		sidecar: {
			read: async path => {
				await assertVaultBoundary(plugin.app, path);
				const stat = await adapter.stat(path);
				if (!stat) return null;
				if (stat.type !== "file") throw new Error(`Sidecar path is a folder: ${path}`);
				if (stat.size > 32 * 1024 * 1024) throw new Error(`Existing file is too large to inspect: ${path}`);
				return adapter.read(path);
			},
			write: async (path, content) => {
				await assertVaultBoundary(plugin.app, path);
				if (!plugin.active || plugin.index !== indexToken) throw new Error("The plugin was reloaded; the sidecar was not written.");
				await ensureCmdsIgnore(plugin.app);
				await ensureDirectory(plugin.app, path);
				await adapter.write(path, content);
				return Buffer.byteLength(content);
			},
		},
	};
	host.refresh = async (refresh: RefreshRequest) => {
		const outcome = await indexToken.refresh({ force: refresh.ifOlderThanMinutes === undefined, ...(refresh.ifOlderThanMinutes ? { ifOlderThanMs: refresh.ifOlderThanMinutes * 60000 } : {}) });
		const { reason } = outcome;
		// The agent refresh action is an explicit publication: a snapshot that could not be revalidated is a failure, not a result.
		if (reason === "stale-fallback") throw refreshRefusal(outcome); // 0.5 R4: carries the typed cause
		await onIndex(outcome.index);
		return { host: await agentHost(plugin, "info", {}, new Date(), onIndex, indexToken, pdfToken), refreshed: outcome.refreshed, reason, ageMinutesBefore: outcome.ageMinutesBefore };
	};
	host.recentReads = async (days: number): Promise<RecentReport[]> => {
		const reads = await plugin.literature.recentReads(days);
		const notes = plugin.literature.literatureNoteFiles();
		return mapBounded(reads, 2, async read => {
			const found = await plugin.literature.entryForRecent(read, index);
			const files = found.entry ? notes.get(found.entry.id) ?? [] : [];
			const note = found.entry ? literatureNoteStatus(found.entry, await Promise.all(files.map(async file => ({ path: file.path, text: await plugin.app.vault.cachedRead(file) })))) : null;
			return { read, id: found.entry?.id ?? null, inIndex: !!(index && indexEntryFor(read, index.entries)), fresh: found.fresh, note, ...(found.entry ? {} : { problem: `${describeBbtError(found.error)} Not in the saved index and not readable from Zotero.` }) };
		});
	};
	host.importNote = (importRequest: ImportRequest) => plugin.literature.importForAgent(importRequest, index);
	// 0.6 annotations: a fresh read of one item, and the day's reading history. Neither touches the saved index, the recent-reads cache or any vault file.
	host.freshEntry = async subject => "entry" in subject ? plugin.literature.freshEntry(subject.entry) : plugin.literature.entryForRecent(subject.read, index);
	host.readOnDay = async day => (await plugin.bbt.recentlyRead(1, { now })).filter(read => read.readOn === day);
	host.extractPdf = async (target, pdfRequest: PdfTextRequest) => {
		if (!target.localPath) throw new Error("The PDF file is unavailable.");
		if (target.item && target.attachment.key) {
			const entry = index?.entries.find(candidate => candidate.id === target.item?.id);
			if (!entry) throw new Error("The PDF parent item is no longer in the index.");
			return pdfToken.extract({ kind: "attachment", libraryType: entry.libraryType, libraryID: entry.libraryID, attachmentKey: target.attachment.key, id: entry.id, path: target.localPath }, { force: pdfRequest.force });
		}
		return pdfToken.extract({ kind: "file", path: target.attachment.path ?? "", absolutePath: target.localPath }, { force: pdfRequest.force });
	};
	host.applyReconcile = async result => applyReconcile({
		read: async path => { await assertVaultBoundary(plugin.app, path); const file = plugin.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error(`Hub not found: ${path}`); return plugin.app.vault.read(file); },
		file: path => { const file = plugin.app.vault.getAbstractFileByPath(path); return file instanceof TFile ? file : null; },
		// 0.5 R8: whole-text read-modify-write; the writer re-checks the source hash and patches only the allowed key lines.
		process: async (file, change) => {
			await assertVaultBoundary(plugin.app, file.path);
			const current = plugin.app.vault.getAbstractFileByPath(file.path);
			if (!(current instanceof TFile)) return Promise.reject(new Error(`Hub not found: ${file.path}`));
			await plugin.app.vault.process(current, text => {
				if (plugin.legacyPluginEnabled() !== false) throw new Error("Legacy plugin state changed before apply.");
				return change(text);
			});
		},
		canWrite: () => plugin.active && plugin.index === indexToken && plugin.pdfText === pdfToken,
		snapshot: async () => {
			const current = await indexToken.peek();
			const bbtReachable = await plugin.bbt.isReachable();
			const pdfPaths = await host.vaultPdfPaths();
			const checked = new Date();
			return { index: current, indexValid: current !== null && validateIndex(current), indexComplete: current?.complete === true, indexFresh: indexToken.isStale(current, checked.getTime()) === false, live: plugin.active && plugin.index === indexToken && plugin.pdfText === pdfToken, bbtReachable, legacyPluginEnabled: plugin.legacyPluginEnabled(), vault: plugin.app.vault.getName(), pdfPaths, now: checked, expiresAt: current ? Date.parse(current.generatedAt) + (plugin.settings.indexMaxAgeMinutes + 1) * 60000 : 0 };
		},
		yaml: { parse: parseYaml, stringify: stringifyYaml },
	}, result);
	host.yaml = { parse: parseYaml, stringify: stringifyYaml }; // 0.5 R8: informational yamlNormalisable on reconcile rows
	return host;
}
