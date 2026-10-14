/**
 * Live annotations for the Annotations sidebar (0.6.1 annotation-sidebar-live-read): what one fresh read of an item
 * (`LiteratureController.freshEntry`: one identity-pinned item.export plus item.attachments) returned, kept in memory beside
 * the saved index and never written to it. Keyed by entry id and index generation: a new generation drops every live entry,
 * and a fresh read that names another item is refused. Pure: no `obsidian` import.
 */
import type { ZoteroIndexEntry } from "../types";

type Identity = Pick<ZoteroIndexEntry, "id" | "libraryID" | "libraryType" | "itemKey"> & { groupID?: number };

export interface LiveEntry { entry: ZoteroIndexEntry; at: number }

/** Same Zotero item: id, library ID, library type, group ID and item key all agree. */
export function sameIdentity(a: Identity, b: Identity): boolean {
	return a.id === b.id && a.libraryID === b.libraryID && a.libraryType === b.libraryType && a.itemKey === b.itemKey && (a.groupID ?? null) === (b.groupID ?? null);
}

export class LiveOverlay {
	private generation: string | null = null;
	private readonly live = new Map<string, LiveEntry>();

	/** Drops everything when `generation` is not the one the stored entries belong to. */
	private enter(generation: string): void {
		if (this.generation === generation) return;
		this.generation = generation;
		this.live.clear();
	}

	/**
	 * Keeps `fresh` as the live state of `requested` for `generation` (the generation now shown; a caller whose read
	 * started under another generation drops the read instead), read at `at` (epoch ms). Returns false, and keeps nothing
	 * new, when `fresh` is another item.
	 */
	put(generation: string, requested: Identity, fresh: ZoteroIndexEntry, at: number): boolean {
		this.enter(generation);
		if (!sameIdentity(requested, fresh)) return false;
		this.live.set(requested.id, { entry: fresh, at });
		return true;
	}

	/** The live entry for `id` in `generation`, or null; asking for another generation drops every live entry. */
	get(generation: string, id: string): LiveEntry | null {
		this.enter(generation);
		return this.live.get(id) ?? null;
	}

	clear(): void { this.live.clear(); }
}

function two(value: number): string { return String(value).padStart(2, "0"); }

/** The header's source line: "Live from Zotero · HH:MM" for a live entry, else the saved snapshot's age. */
export function sourceLabel(liveAt: number | null, ageMinutes: number | null): string {
	if (liveAt !== null) { const at = new Date(liveAt); return `Live from Zotero · ${two(at.getHours())}:${two(at.getMinutes())}`; }
	if (ageMinutes === null || !Number.isFinite(ageMinutes) || ageMinutes < 0) return "Saved snapshot";
	const minutes = Math.floor(ageMinutes);
	if (minutes < 1) return "Saved snapshot · just now";
	if (minutes < 60) return `Saved snapshot · ${minutes} min old`;
	if (minutes < 60 * 24) return `Saved snapshot · ${Math.floor(minutes / 60)} h old`;
	return `Saved snapshot · ${Math.floor(minutes / (60 * 24))} d old`;
}
