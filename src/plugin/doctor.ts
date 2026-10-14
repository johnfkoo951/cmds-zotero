import { FileSystemAdapter, loadPdfJs, Notice } from "obsidian";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { transportReasonOf } from "../api/transport";
import { doctorChecks, doctorReport, type DoctorFacts } from "../doctor/checks";
import type CMDSZoteroPlugin from "../main";
import type { ZoteroIndex } from "../types";
import { DoctorModal } from "../modals/doctor";

/** Frontmatter keys Better Notes writes into the Markdown files it syncs; a note carrying them belongs to Better Notes. */
const BETTER_NOTES_KEYS: readonly string[] = ["$libraryID", "$itemKey"];

/**
 * 0.6.1 doctor: the facts only Obsidian can check. Read-only: pdf.js is loaded (as PDF text extraction does), peer note
 * maps are read, and the output folder is listed from the metadata cache; nothing is written or changed. `index` is the
 * snapshot the caller already holds (the agent host's peek, or the Diagnose setup view's): this function never loads or
 * publishes one, so `diagnostics --env` cannot publish the note map and reads the same generation as the rest of its payload.
 */
export async function environmentFacts(plugin: CMDSZoteroPlugin, index: ZoteroIndex | null): Promise<Pick<DoctorFacts, "pdfjs" | "peers" | "outputFolder">> {
	let pdfjs: boolean;
	try { pdfjs = Boolean(await loadPdfJs()); } catch { pdfjs = false; }
	const folder = plugin.settings.outputFolder.trim().replace(/^\/+|\/+$/g, "");
	const claimed = new Set<string>();
	if (index) for (const files of plugin.links.localFilesByEntry(index).values()) for (const file of files) claimed.add(file.path);
	const inFolder = folder ? plugin.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${folder}/`)).sort((a, b) => a.path.localeCompare(b.path)) : [];
	const betterNotes = inFolder.filter(file => { const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter; return !!frontmatter && BETTER_NOTES_KEYS.some(key => key in frontmatter); }).map(file => file.path);
	// Without an index no note can be claimed, so "unmatched" would list every note: it is left empty then.
	const unmatched = index ? inFolder.filter(file => !claimed.has(file.path) && !betterNotes.includes(file.path)).map(file => file.path) : [];
	return { pdfjs, peers: await plugin.links.peerMapStatus(), outputFolder: folder ? { folder, notes: inFolder.length, unmatched, betterNotes } : null };
}

/** The vault's real folder on disk, or null on a non-desktop adapter. */
async function vaultRoot(plugin: CMDSZoteroPlugin): Promise<string | null> {
	const adapter = plugin.app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return null;
	return fs.realpath(adapter.getBasePath()).catch(() => adapter.getBasePath());
}

/** Every doctor fact for the Diagnose setup view: one Better BibTeX readiness probe (the person asked), then local checks. */
export async function gatherFacts(plugin: CMDSZoteroPlugin): Promise<DoctorFacts> {
	const bbt: DoctorFacts["bbt"] = await plugin.bbt.capabilities().then(
		value => ({ reachable: true, zotero: value.zotero, betterbibtex: value.betterbibtex }),
		(error: unknown) => { const reason = transportReasonOf(error); return { reachable: false, ...(reason ? { reason } : {}) }; },
	);
	const now = Date.now();
	const index = plugin.lastIndex ?? await plugin.savedIndex();
	const root = await vaultRoot(plugin);
	return {
		bbt,
		legacyPluginEnabled: plugin.legacyPluginEnabled(),
		index: { path: plugin.settings.zoteroIndexPath, count: index?.count ?? null, ageMinutes: plugin.index.ageMinutes(index, now), stale: plugin.index.isStale(index, now), maxAgeMinutes: plugin.settings.indexMaxAgeMinutes, complete: index?.complete ?? null },
		git: root ? await plugin.gitProbe(root, plugin.settings.zoteroIndexPath).catch(() => null) : null,
		...await environmentFacts(plugin, index),
	};
}

/** "Diagnose setup": runs the checks and opens the report view (rows open the notes they name; Copy report copies the text). */
export async function showDoctor(plugin: CMDSZoteroPlugin): Promise<void> {
	await plugin.run(async () => {
		const notice = new Notice("Checking the setup…", 0);
		let facts: DoctorFacts;
		try { facts = await gatherFacts(plugin); } finally { notice.hide(); }
		const checks = doctorChecks(facts);
		const report = doctorReport({ checks, pluginVersion: plugin.manifest.version, generatedAt: new Date(), statusLine: plugin.statusLine(), outcomes: plugin.outcomes.entries(), vaultRoot: await vaultRoot(plugin), home: homedir() });
		new DoctorModal(plugin.app, checks, report).open();
	});
}
