import { TFile } from "obsidian";
import { batchProgressText, runBatch } from "../batch/batch-run";
import { reviewRow, scopeEntries, type ReviewRow } from "../batch/plan";
import type CMDSZoteroPlugin from "../main";
import { BatchReviewModal } from "../modals/batch-review";
import { ScopeQueryModal } from "../modals/patch-preview";
import { ReportModal } from "../modals/report";
import { AdoptIndex, adoptCandidates, adoptRefusal } from "../note-adopt";
import { newNotePath } from "../note-path";
import { queryContext } from "../search/query";
import type { ZoteroIndex, ZoteroIndexEntry } from "../types";
import { describeBbtError } from "../api/transport";

/**
 * 0.6.3 batch-import-by-scope and the adopt batch (adopt-existing-notes): plan → review list (batch-dry-run-review) →
 * one note at a time with the progress Notice and Cancel of update-all. Zotero is read only for the ticked rows.
 */

const message = (error: unknown): string => error instanceof Error ? error.message : "failed";

/** "Import literature notes by search": new notes only, for the items a fielded search names. */
export async function importByScope(plugin: CMDSZoteroPlugin): Promise<void> {
	await plugin.run(async () => {
		const index = await plugin.indexing.loadIndexForRead();
		let notes: Map<string, unknown[]> | null = null;
		const context = queryContext(index, entry => (notes ??= plugin.links.localFilesByEntry(index)).has(entry.id));
		new ScopeQueryModal(plugin.app, query => scopeEntries(index.entries, query, context).length, query => {
			void plugin.run(async () => {
				const entries = scopeEntries(index.entries, query, context);
				if (!entries.length) throw new Error(`No items match ${query}.`);
				const identities = await plugin.importer.identityMap();
				const rows: ReviewRow<ZoteroIndexEntry>[] = [];
				const planned = new Set<string>();
				for (const entry of entries) {
					const label = `@${entry.citekey} · ${entry.title}`;
					const existing = await identities.pathsFor(entry.id);
					if (existing.length) { rows.push(reviewRow(entry.id, label, existing.join(", "), "skip", "already has a literature note", entry)); continue; }
					let path: string;
					try { path = newNotePath(entry, plugin.settings); } catch (error) { rows.push(reviewRow(entry.id, label, "", "skip", message(error), entry)); continue; }
					// Two items whose pattern gives one file name: the second is skipped, never written over the first.
					if (planned.has(path) || plugin.app.vault.getAbstractFileByPath(path)) { rows.push(reviewRow(entry.id, label, path, "skip", "another note already uses this file name", entry)); continue; }
					planned.add(path);
					rows.push(reviewRow(entry.id, label, path, "create", "", entry));
				}
				new BatchReviewModal(plugin.app, `Import ${entries.length} matching item${entries.length === 1 ? "" : "s"}`, rows, chosen => {
					void plugin.run(() => runImport(plugin, index, chosen.map(row => row.item)));
				}, { applyLabel: "Create notes" }).open();
			});
		}).open();
	});
}

async function runImport(plugin: CMDSZoteroPlugin, index: ZoteroIndex, entries: ZoteroIndexEntry[]): Promise<void> {
	const created: string[] = [];
	const skipped: string[] = [];
	const label = "Importing literature notes";
	const progress = (done: number): string => batchProgressText(label, done, entries.length, [["created", created.length], ["skipped", skipped.length]]);
	const batch = await plugin.literature.openNoteBatch(progress(0));
	let notRun: ZoteroIndexEntry[] = [];
	let cancelled = false;
	try {
		const run = await runBatch(entries, {
			concurrency: plugin.settings.concurrency,
			prepare: async entry => {
				const current = await plugin.literature.freshEntry(entry);
				if (current.fresh) await plugin.bibliography.bibliographyDetail(current.entry).catch(() => undefined);
				return current;
			},
			cancelled: () => batch.cancelled,
			onItem: (entry, position) => { batch.update(progress(position), `@${entry.citekey}`); },
			apply: async (entry, prepared) => {
				try {
					const current = prepared.ok ? prepared.value : { entry, fresh: false, error: prepared.error };
					const preview = await plugin.importer.preview(current.entry, index, { identities: batch.identities, ...(current.fresh ? {} : { offline: true }) });
					if (preview.exists) { skipped.push(`@${entry.citekey}: a literature note appeared meanwhile (${preview.path})`); return; }
					if (preview.conflicts.length) { skipped.push(`@${entry.citekey}: ${preview.conflicts.join("; ")}`); return; }
					const result = await plugin.importer.apply(preview);
					if (result.conflicts.length) { skipped.push(`@${entry.citekey}: ${result.conflicts.join("; ")}`); return; }
					plugin.indexing.noteChanged(result.path);
					created.push(result.path);
				} catch (error) { skipped.push(`@${entry.citekey}: ${message(error)}`); }
			},
		});
		notRun = run.notRun;
		cancelled = run.cancelled;
	} finally { batch.close(); }
	new ReportModal(plugin.app, "Import literature notes by search", [
		...(cancelled ? [`Cancelled after ${entries.length - notRun.length} of ${entries.length} items; the rest were not run.`] : []),
		`Created: ${created.length}`, `Skipped: ${skipped.length}`, ...(notRun.length ? [`Not run: ${notRun.length}`] : []),
		"", ...created.map(path => `created  ${path}`), ...skipped.map(line => `skipped  ${line}`), ...notRun.map(entry => `not run  @${entry.citekey}`),
	].join("\n")).open();
}

interface AdoptRow { path: string; entry: ZoteroIndexEntry }

/**
 * "Adopt existing literature notes": lists the vault's notes that match exactly one index item by a Zotero link or key,
 * a citekey in the frontmatter or the file name (DOI-only matches are listed unticked), with notes matching several
 * items and notes that cannot be adopted as skips. Nothing is written before the review.
 */
export async function adoptExistingNotes(plugin: CMDSZoteroPlugin): Promise<void> {
	await plugin.run(async () => {
		const index = await plugin.indexing.loadIndexForRead();
		const adoptIndex = new AdoptIndex(index.entries);
		const linked = new Set([...plugin.links.localFilesByEntry(index).values()].flat().map(file => file.path));
		const identities = await plugin.importer.identityMap();
		const rows: ReviewRow<AdoptRow | null>[] = [];
		const claimed = new Map<string, string>();
		const pending: { file: TFile; match: ReturnType<typeof adoptCandidates> }[] = [];
		for (const file of plugin.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
			const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
			const note = { path: file.path, basename: file.basename, frontmatter };
			const match = adoptCandidates(note, adoptIndex);
			if (!match.candidates.length) continue;
			const why = adoptRefusal(note);
			if (why) continue; // hubs, Raw Sources, Bookends and Better Notes notes are not literature notes to adopt
			const text = await plugin.app.vault.cachedRead(file);
			const refusal = adoptRefusal(note, text);
			if (refusal) { if (!linked.has(file.path)) rows.push(reviewRow(file.path, file.path, match.candidates.map(entry => `@${entry.citekey}`).join(", "), "skip", refusal, null)); continue; }
			if (match.candidates.length > 1) { rows.push(reviewRow(file.path, file.path, match.candidates.map(entry => `@${entry.citekey}`).join(", "), "skip", "several items match: use Adopt current note as literature note to choose", null)); continue; }
			const entry = match.candidates[0];
			const existing = (await identities.pathsFor(entry.id)).filter(path => path !== file.path);
			if (existing.length) { rows.push(reviewRow(file.path, file.path, `@${entry.citekey}`, "skip", `the item already has a literature note: ${existing.join(", ")}`, null)); continue; }
			pending.push({ file, match });
		}
		for (const { file, match } of pending) {
			if (match.strength === "strong" && !claimed.has(match.candidates[0].id)) claimed.set(match.candidates[0].id, file.path);
		}
		for (const { file, match } of pending) {
			const entry = match.candidates[0];
			const first = claimed.get(entry.id);
			if (first && first !== file.path) { rows.push(reviewRow(file.path, file.path, `@${entry.citekey}`, "skip", `${first} matches the same item`, null)); continue; }
			claimed.set(entry.id, file.path);
			rows.push(reviewRow(file.path, file.path, `@${entry.citekey} · ${entry.title}`, "adopt", `${match.evidence.join(", ")}${match.strength === "doi" ? " (DOI only: check it)" : ""}`, { path: file.path, entry }, match.strength === "strong"));
		}
		rows.sort((a, b) => a.key.localeCompare(b.key));
		if (!rows.length) throw new Error("No notes outside CMDS Zotero match an item of the index by Zotero link, key, citekey or DOI.");
		new BatchReviewModal(plugin.app, "Adopt existing literature notes", rows, chosen => {
			void plugin.run(() => runAdopt(plugin, index, chosen.flatMap(row => row.item ? [row.item] : [])));
		}, { applyLabel: "Adopt notes" }).open();
	});
}

async function runAdopt(plugin: CMDSZoteroPlugin, index: ZoteroIndex, rows: AdoptRow[]): Promise<void> {
	const adopted: string[] = [];
	const skipped: string[] = [];
	const offline = await plugin.bbt.capabilities().then(() => null, (error: unknown) => error);
	const progress = (done: number): string => batchProgressText("Adopting notes", done, rows.length, [["adopted", adopted.length], ["skipped", skipped.length]]);
	const batch = await plugin.literature.openNoteBatch(progress(0));
	let notRun: AdoptRow[] = [];
	let cancelled = false;
	try {
		const run = await runBatch(rows, {
			concurrency: plugin.settings.concurrency,
			prepare: async row => {
				if (offline) return { entry: row.entry, fresh: false };
				const current = await plugin.literature.freshEntry(row.entry);
				if (current.fresh) await plugin.bibliography.bibliographyDetail(current.entry).catch(() => undefined);
				return current;
			},
			cancelled: () => batch.cancelled,
			onItem: (row, position) => { batch.update(progress(position), row.path); },
			apply: async (row, prepared) => {
				try {
					const current = prepared.ok ? prepared.value : { entry: row.entry, fresh: false };
					const preview = await plugin.importer.adoptPreview(current.entry, row.path, index, { identities: batch.identities, offline: !current.fresh });
					if (preview.conflicts.length) { skipped.push(`${row.path}: ${preview.conflicts.join("; ")}`); return; }
					const result = await plugin.importer.apply(preview);
					if (result.conflicts.length) { skipped.push(`${row.path}: ${result.conflicts.join("; ")}`); return; }
					plugin.indexing.noteChanged(result.path);
					adopted.push(`${result.path}${result.backup ? ` (backup ${result.backup})` : ""}${result.unverified ? ` — ${result.unverified}` : ""}`);
				} catch (error) { skipped.push(`${row.path}: ${message(error)}`); }
			},
		});
		notRun = run.notRun;
		cancelled = run.cancelled;
	} finally { batch.close(); }
	new ReportModal(plugin.app, "Adopt existing literature notes", [
		...(cancelled ? [`Cancelled after ${rows.length - notRun.length} of ${rows.length} notes; the rest were not run.`] : []),
		`Adopted: ${adopted.length}`, `Skipped: ${skipped.length}`, ...(notRun.length ? [`Not run: ${notRun.length}`] : []),
		...(offline ? [`Zotero offline: ${describeBbtError(offline)} Notes were adopted from the saved index where cached bibliography text existed.`] : []),
		"", ...adopted.map(line => `adopted  ${line}`), ...skipped.map(line => `skipped  ${line}`), ...notRun.map(row => `not run  ${row.path}`),
	].join("\n")).open();
}

/** The active Markdown note, or an error naming what is needed. */
export function activeNote(plugin: CMDSZoteroPlugin): TFile {
	const file = plugin.app.workspace.getActiveFile();
	if (!(file instanceof TFile) || file.extension !== "md") throw new Error("Open a Markdown note first.");
	return file;
}
