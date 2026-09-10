import type { ZoteroIndexEntry } from "./types";

export function buildAliasIndex(entries: ZoteroIndexEntry[]) {
	const ids = new Set(entries.map(entry => entry.id));
	const aliases = new Map<string, string | null>();
	for (const entry of entries) {
		for (const alias of new Set([entry.citekey, ...entry.citekeyHistory])) {
			if (!aliases.has(alias)) aliases.set(alias, entry.id);
			else if (aliases.get(alias) !== entry.id) aliases.set(alias, null);
		}
	}
	return { ids, aliases };
}

export function noteIdentity(basename: string, frontmatter: Record<string, unknown> | undefined, lookup: ReturnType<typeof buildAliasIndex>): string | null {
	if (typeof frontmatter?.zoteroID === "string") return lookup.ids.has(frontmatter.zoteroID) ? frontmatter.zoteroID : null;
	const candidates = [basename.startsWith("@") ? basename.slice(1) : undefined, frontmatter?.citekey, frontmatter?.zotero_citekey];
	const matches = new Set<string>();
	for (const alias of candidates) {
		if (typeof alias !== "string" || !lookup.aliases.has(alias)) continue;
		const id = lookup.aliases.get(alias);
		if (id === null) return null;
		if (id) matches.add(id);
	}
	return matches.size === 1 ? [...matches][0] : null;
}
