import { Notice, parseYaml, TFile } from "obsidian";
import type CMDSZoteroPlugin from "../main";
import { lineDiff } from "../fragments";
import { indexDerived } from "../index-derived";
import { formatIndexAge } from "../index-service";
import { PatchPreviewModal } from "../modals/patch-preview";
import { PickerModal } from "../modals/picker";
import { ReportModal } from "../modals/report";
import { AdoptIndex, adoptCandidates, adoptRefusal, hasBetterNotesSync } from "../note-adopt";
import { noteIdentity } from "../note-aliases";
import { editFrontmatterLines, frontmatterAndBody, frontmatterRefreshChanges, legacyKeysIn, mergedItemCandidates, relinkBody, relinkEdit, verifyFrontmatterEdit, type FrontmatterEdit } from "../note-frontmatter";
import { hashText, ownerMarker } from "../note-writer";
import { parseNoteText } from "../frontmatter-read";
import type { ZoteroIndexEntry } from "../types";
import { activeNote } from "./note-batches";

/**
 * 0.6.3 single-note maintenance on the active note: update (update-current-note), rebuild (rebuild-or-repair-note), adopt
 * (adopt-existing-notes), and the per-note frontmatter line patches (frontmatter-refresh, legacy-key-cleanup,
 * merged-item-relink). Every write is previewed; line patches are verified with the YAML parser before the preview,
 * backed up, checked against the previewed text inside the write and read back afterwards. Nothing is automatic.
 */

const yaml = (text: string): unknown => parseYaml(text) as unknown;
const label = (entry: ZoteroIndexEntry): string => `${entry.title} — @${entry.citekey} · ${entry.year} · library ${entry.libraryID}`;

interface NoteState { file: TFile; text: string; frontmatter: Record<string, unknown> }

async function readActive(plugin: CMDSZoteroPlugin): Promise<NoteState> {
	const file = activeNote(plugin);
	const text = await plugin.readSaved(file);
	const parsed = parseNoteText(text, yaml);
	if (parsed.frontmatterParse === "error") throw new Error("The note's frontmatter does not parse; fix it first.");
	return { file, text, frontmatter: parsed.frontmatter ?? {} };
}

/** The index entry the active note is the literature note of (zoteroID, Zotero link, ZotLit key, citekey ladder). */
async function entryOf(plugin: CMDSZoteroPlugin, note: NoteState): Promise<ZoteroIndexEntry | null> {
	const index = await plugin.indexing.loadIndexForRead();
	const derived = indexDerived(index.entries);
	const id = noteIdentity(note.file.basename, note.frontmatter, derived.aliasIndex);
	return id ? index.entries.find(entry => entry.id === id) ?? null : null;
}

/** An owned literature note's entry, or an error saying which command fits instead. */
async function ownedEntry(plugin: CMDSZoteroPlugin, note: NoteState): Promise<ZoteroIndexEntry> {
	const entry = await entryOf(plugin, note);
	if (!entry) throw new Error("This note is not linked to an item of the index. Run Adopt current note as literature note, or Relink current note to merged Zotero item if its item was merged.");
	if (!note.text.includes(ownerMarker(entry.id))) throw new Error(`This note names @${entry.citekey} but was not created by CMDS Zotero. Run Adopt current note as literature note first.`);
	return entry;
}

/** "Update current literature note": the usual preview for the active owned note (Better Notes notes get a warning in it). */
export async function updateCurrentNote(plugin: CMDSZoteroPlugin, rebuild = false): Promise<void> {
	await plugin.run(async () => {
		const note = await readActive(plugin);
		const entry = await ownedEntry(plugin, note);
		await plugin.literature.previewImport(entry, { expectPath: note.file.path, ...(rebuild ? { rebuild: true } : {}) });
	});
}

/** "Adopt current note as literature note": one matching item goes to the preview; several to a chooser; never a first match. */
export async function adoptCurrentNote(plugin: CMDSZoteroPlugin): Promise<void> {
	await plugin.run(async () => {
		const note = await readActive(plugin);
		const refusal = adoptRefusal({ path: note.file.path, basename: note.file.basename, frontmatter: note.frontmatter }, note.text);
		if (refusal) throw new Error(`Not adopted: ${refusal}.`);
		const index = await plugin.indexing.loadIndexForRead();
		const match = adoptCandidates({ path: note.file.path, basename: note.file.basename, frontmatter: note.frontmatter }, new AdoptIndex(index.entries));
		const preview = (entry: ZoteroIndexEntry): void => { void plugin.literature.previewImport(entry, { adoptPath: note.file.path }); };
		if (match.candidates.length === 1) { preview(match.candidates[0]); return; }
		const pick = (entries: ZoteroIndexEntry[], hint: string): void => { new PickerModal(plugin.app, entries, label, preview, hint).open(); };
		if (match.candidates.length > 1) { pick(match.candidates, `${match.candidates.length} items match (${match.evidence.join(", ")}); choose one…`); return; }
		new Notice("No item matches this note by its Zotero link, item key, citekey or digital object identifier; choose the item.");
		await plugin.navigation.pick(preview);
	});
}

/** Shows the line diff of a patch and, on confirmation, writes it with backup, source check and read-back. */
function previewPatch(plugin: CMDSZoteroPlugin, note: NoteState, heading: string, summary: string, after: string, applyLabel: string): void {
	new PatchPreviewModal(plugin.app, heading, summary, lineDiff(note.text, after), async () => {
		const current = await plugin.app.vault.read(note.file);
		if (hashText(current) !== hashText(note.text)) throw new Error("The note changed after the preview; run the command again.");
		const backup = await plugin.importer.backupNote(note.file.path, note.text);
		await plugin.app.vault.process(note.file, text => {
			if (hashText(text) !== hashText(note.text)) throw new Error("The note changed after the preview; nothing was written.");
			return after;
		});
		plugin.indexing.noteChanged(note.file.path);
		const written = await plugin.app.vault.read(note.file);
		new Notice(written === after ? `Note updated. Backup: ${backup}.` : `The note does not read back as written (another edit at the same moment?). Check it; the previous text is in ${backup}.`);
	}, applyLabel).open();
}

/** The patched text of a frontmatter edit, verified with the YAML parser; throws with the reason otherwise. */
function patched(note: NoteState, edit: FrontmatterEdit): string {
	const out = editFrontmatterLines(note.text, edit);
	if (!out.ok) throw new Error(`The frontmatter cannot be patched line by line: ${out.message}`);
	const problem = verifyFrontmatterEdit(note.text, out.text, edit, yaml);
	if (problem) throw new Error(`The patch was not verified: ${problem}`);
	return out.text;
}

/** "Refresh frontmatter of current note from Zotero": the plugin's metadata keys present in the note, read fresh from Zotero. */
export async function refreshFrontmatter(plugin: CMDSZoteroPlugin): Promise<void> {
	await plugin.run(async () => {
		const note = await readActive(plugin);
		const indexed = await entryOf(plugin, note);
		if (!indexed || typeof note.frontmatter.zoteroID !== "string") throw new Error("This note has no zoteroID of an indexed item. Adopt or relink it first.");
		const { entry, fresh } = await plugin.literature.freshEntry(indexed);
		const set = frontmatterRefreshChanges(note.frontmatter, entry, plugin.settings);
		const keys = Object.keys(set);
		if (!keys.length) { new Notice(`The frontmatter already matches ${fresh ? "Zotero" : "the saved index"}.`); return; }
		const warning = hasBetterNotesSync(note.frontmatter) ? " Better Notes syncs this note and may overwrite the change." : "";
		previewPatch(plugin, note, "Refresh frontmatter from Zotero", `${keys.length} key${keys.length === 1 ? "" : "s"} from ${fresh ? "Zotero" : "the saved index (Zotero is not answering)"}: ${keys.join(", ")}. Other keys, tags and the note's text stay as they are.${warning}`, patched(note, { set }), "Refresh frontmatter");
	});
}

/** "Remove legacy keys from current note": keys 0.3/0.4 and cmds-link-zotero wrote, derivable from `zoteroID`. */
export async function removeLegacyKeys(plugin: CMDSZoteroPlugin): Promise<void> {
	await plugin.run(async () => {
		const note = await readActive(plugin);
		const remove = legacyKeysIn(note.frontmatter);
		if (!remove.length) { new Notice("This note has no legacy Zotero keys."); return; }
		if (typeof note.frontmatter.zoteroID !== "string") throw new Error("This note has no zoteroID, so the legacy keys are its only identity. Adopt it first.");
		previewPatch(plugin, note, "Remove legacy keys", `Removes ${remove.join(", ")}; zoteroID keeps the note's identity. Other keys and the note's text stay as they are.`, patched(note, { remove }), "Remove keys");
	});
}

/** "Report notes with legacy frontmatter keys": vault-wide, read-only (metadata cache); nothing is changed. */
export function reportLegacyKeys(plugin: CMDSZoteroPlugin): void {
	const rows = plugin.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path)).flatMap(file => {
		const keys = legacyKeysIn(plugin.app.metadataCache.getFileCache(file)?.frontmatter);
		return keys.length ? [`${file.path}: ${keys.join(", ")}`] : [];
	});
	new ReportModal(plugin.app, "Notes with legacy Zotero keys", rows.length
		? [`${rows.length} note${rows.length === 1 ? "" : "s"} carry keys that zoteroID makes redundant. Nothing was changed; open a note and run Remove legacy keys from current note to clean it up after a preview.`, "", ...rows].join("\n")
		: "No note carries legacy Zotero keys.").open();
}

/**
 * "Relink current note to merged Zotero item": the note's item is gone from a complete index, and its citekey (current or
 * former) or DOI is now on another item. One survivor is previewed; several go to a chooser. Never automatic.
 */
export async function relinkMergedItem(plugin: CMDSZoteroPlugin): Promise<void> {
	await plugin.run(async () => {
		const note = await readActive(plugin);
		const index = await plugin.indexing.loadIndexForRead();
		const found = mergedItemCandidates({ basename: note.file.basename, frontmatter: note.frontmatter }, index);
		if (found.status === "no-identity") throw new Error("This note has no zoteroID to relink.");
		if (found.status === "linked") { new Notice(`This note's item is in the index (@${found.entry.citekey}); nothing to relink.`); return; }
		if (found.status === "incomplete") throw new Error("The saved index is incomplete, so it cannot show that the item is gone. Refresh the citekey index and retry.");
		if (!found.candidates.length) throw new Error(`Item ${found.oldId} is not in the index and no item carries this note's citekey or DOI.`);
		const relink = (survivor: ZoteroIndexEntry): void => {
			void plugin.run(async () => {
				if ((await (await plugin.importer.identityMap()).pathsFor(survivor.id)).some(path => path !== note.file.path)) throw new Error(`@${survivor.citekey} already has a literature note; merge the two notes by hand.`);
				const edit = relinkEdit(note.frontmatter, survivor);
				const out = editFrontmatterLines(note.text, edit);
				if (!out.ok) throw new Error(`The frontmatter cannot be patched line by line: ${out.message}`);
				const after = relinkBody(out.text, found.oldId, survivor.id);
				const expected = frontmatterAndBody(note.text).body.split(ownerMarker(found.oldId)).join(ownerMarker(survivor.id));
				const problem = verifyFrontmatterEdit(note.text, after, edit, yaml, expected);
				if (problem) throw new Error(`The relink was not verified: ${problem}`);
				const age = formatIndexAge(plugin.index.ageMinutes(index));
				previewPatch(plugin, note, "Relink to merged Zotero item", `Item ${found.oldId} is not in the saved index (${age} old); @${survivor.citekey} (${survivor.id}) carries ${found.evidence.find(line => line.startsWith(survivor.id))?.slice(survivor.id.length + 2) ?? "its citekey or DOI"}. The identity keys${edit.remove?.length ? `, the legacy keys ${edit.remove.join(", ")}` : ""} and the ownership marker change; nothing else.`, after, "Relink note");
			});
		};
		if (found.candidates.length === 1) { relink(found.candidates[0]); return; }
		new PickerModal(plugin.app, found.candidates, label, relink, `${found.candidates.length} items carry this note's citekey or DOI; choose the surviving item…`).open();
	});
}

/** True when the active file is a Markdown note (command availability). */
export function hasActiveNote(plugin: CMDSZoteroPlugin): boolean {
	const file = plugin.app.workspace.getActiveFile();
	return file instanceof TFile && file.extension === "md";
}
