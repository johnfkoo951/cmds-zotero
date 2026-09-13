import type { ZoteroIndex, ZoteroIndexEntry } from "./types";
import { parseItemURI } from "./api/normalize";

/** Citekeys of items related through Zotero `dc:relation` links that exist in the same library scope of the index. */
export function relatedCitekeys(entry: ZoteroIndexEntry, index: ZoteroIndex): string[] {
	const relations = entry.metadata.relations;
	if (!relations || typeof relations !== "object") return [];
	const raw = (relations as Record<string, unknown>)["dc:relation"];
	const uris = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	const found = new Set<string>();
	for (const uri of uris) {
		if (typeof uri !== "string") continue;
		let identity: ReturnType<typeof parseItemURI>;
		try { identity = parseItemURI(uri); } catch { continue; }
		const matches = index.entries.filter(candidate => candidate.itemKey === identity.itemKey && candidate.libraryType === identity.libraryType && candidate.groupID === identity.groupID && candidate.id !== entry.id);
		// Ambiguous item keys across libraries are skipped rather than guessed.
		if (matches.length === 1) found.add(matches[0].citekey);
	}
	return [...found].sort();
}
