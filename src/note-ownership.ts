/**
 * Ownership partition for "Update all owned literature notes" (0.5 R14). Pure: never imports `obsidian`; the host supplies
 * the note listing (path, basename, cached frontmatter) and a reader. A note is owned when it resolves to an index entry,
 * lies inside the output folder and carries that entry's owner marker; every other resolved note is linked but not owned,
 * counted once and never sent through the BBT-backed preview path. Only notes inside the output folder are read.
 */
import type { ZoteroIndex, ZoteroIndexEntry } from "./types";
import { noteIdentity } from "./note-aliases";
import { ownerMarker } from "./note-writer";
import { indexDerived } from "./index-derived";
import { SCAN_CONCURRENCY, scanInOrder } from "./vault-scan";

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

/**
 * 0.6: the alias index is the index generation's shared one (`indexDerived`), and the output folder's candidates are read
 * with up to `concurrency` reads in flight, taken in path order, so the partition equals the sequential one.
 */
export async function partitionOwnedNotes(index: ZoteroIndex, notes: OwnershipNote[], outputFolder: string, read: (path: string) => Promise<string>, concurrency = SCAN_CONCURRENCY): Promise<OwnedPartition> {
	const lookup = indexDerived(index.entries).aliasIndex;
	const folder = normalizeFolder(outputFolder);
	const ownedPaths = new Map<string, string[]>();
	const linkedNotOwned: string[] = [];
	const resolved = [...notes].sort((a, b) => a.path.localeCompare(b.path)).flatMap(note => {
		const id = noteIdentity(note.basename, note.frontmatter, lookup);
		return id ? [{ note, id }] : [];
	});
	const inFolder = (path: string): boolean => !!folder && path.startsWith(`${folder}/`);
	await scanInOrder(resolved, concurrency, ({ note }) => inFolder(note.path) ? read(note.path) : null, ({ note, id }, outcome) => {
		if (!outcome?.ok || !outcome.value.includes(ownerMarker(id))) { linkedNotOwned.push(note.path); return true; }
		const paths = ownedPaths.get(id);
		if (paths) paths.push(note.path); else ownedPaths.set(id, [note.path]);
		return true;
	});
	return { owned: index.entries.filter(entry => ownedPaths.has(entry.id)), ownedPaths, linkedNotOwned };
}

/** One-line summary for the batch report. */
export function ownershipSummary(partition: OwnedPartition): string {
	return `Owned: ${partition.owned.length} · Linked but not owned: ${partition.linkedNotOwned.length} (not updated)`;
}
