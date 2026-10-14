/**
 * "Find notes citing a source" (0.6 OPT-15): which notes cite one of an item's citekeys. Pure: never imports `obsidian`;
 * the host injects the note reader.
 */
import { mapBounded } from "../api/transport";
import { scanCitations } from "./scan";

/** Note reads in flight at once. */
export const CITING_READ_CONCURRENCY = 8;

/** One note citing the source: the line of its first citation and how many citations it has. */
export interface CitingNote<F> { file: F; line: number; count: number }

/**
 * The notes among `files` that cite one of `citekeys` ([@key], @key or [[@key]]), read `concurrency` at a time. A note is
 * scanned only when its text contains `@<key>` for one of the keys. Most citations first, then by path; the order does not
 * depend on which read finished first. A read that fails ends the search with its error.
 */
export async function findCitingNotes<F extends { path: string }>(files: readonly F[], citekeys: Iterable<string>, read: (file: F) => Promise<string>, concurrency = CITING_READ_CONCURRENCY): Promise<CitingNote<F>[]> {
	const keys = new Set(citekeys);
	const needles = [...keys].map(key => `@${key}`);
	const found = await mapBounded([...files], concurrency, async (file): Promise<CitingNote<F> | null> => {
		const text = await read(file);
		if (!needles.some(needle => text.includes(needle))) return null;
		const occurrences = scanCitations(text).filter(item => keys.has(item.citekey));
		return occurrences.length ? { file, line: occurrences[0].line, count: occurrences.length } : null;
	});
	const hits = found.filter((hit): hit is CitingNote<F> => hit !== null);
	return hits.sort((a, b) => b.count - a.count || a.file.path.localeCompare(b.file.path));
}
