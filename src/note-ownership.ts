/**
 * Ownership partition for "Update all owned literature notes" (0.5 R14). Pure: never imports `obsidian`; the host supplies
 * the note listing (path, basename, cached frontmatter) and a reader. A note is owned when it resolves to an index entry,
 * lies inside the output folder and carries that entry's owner marker; every other resolved note is linked but not owned,
 * counted once and never sent through the BBT-backed preview path. Only notes inside the output folder are read.
 */
import type { ZoteroIndex, ZoteroIndexEntry } from "./types";
import { buildAliasIndex, noteIdentity } from "./note-aliases";
import { ownerMarker } from "./note-writer";

export interface OwnershipNote { path: string; basename: string; frontmatter: Record<string, unknown> | undefined }
export interface OwnedPartition {
	/** Entries with at least one owned note, in index order. */
	owned: ZoteroIndexEntry[];
	/** Entry id → owned note paths (sorted). */
	ownedPaths: Map<string, string[]>;
	/** Resolved notes without an owner marker or outside the output folder (sorted). */
	linkedNotOwned: string[];
}

function normalizeFolder(folder: string): string {
	return folder.trim().replace(/^\/+|\/+$/g, "");
}

export async function partitionOwnedNotes(index: ZoteroIndex, notes: OwnershipNote[], outputFolder: string, read: (path: string) => Promise<string>): Promise<OwnedPartition> {
	const lookup = buildAliasIndex(index.entries);
	const folder = normalizeFolder(outputFolder);
	const ownedPaths = new Map<string, string[]>();
	const linkedNotOwned: string[] = [];
	for (const note of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
		const id = noteIdentity(note.basename, note.frontmatter, lookup);
		if (!id) continue;
		let owned = false;
		if (folder && note.path.startsWith(`${folder}/`)) {
			try { owned = (await read(note.path)).includes(ownerMarker(id)); } catch { owned = false; }
		}
		if (!owned) { linkedNotOwned.push(note.path); continue; }
		const paths = ownedPaths.get(id) ?? [];
		paths.push(note.path);
		ownedPaths.set(id, paths);
	}
	return { owned: index.entries.filter(entry => ownedPaths.has(entry.id)), ownedPaths, linkedNotOwned };
}

/** One-line summary for the batch report. */
export function ownershipSummary(partition: OwnedPartition): string {
	return `Owned: ${partition.owned.length} · Linked but not owned: ${partition.linkedNotOwned.length} (not updated)`;
}
