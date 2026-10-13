// Synthetic fixtures shared by the agent action tests: a small index with annotations, and an ActionHost over it.
import { runAction, type ActionHost } from "../src/agent/actions";
import { buildConnection } from "../src/agent/connection";
import { DEFAULT_SETTINGS, type Annotation, type CmdsZoteroSettings, type ZoteroIndex, type ZoteroIndexEntry } from "../src/types";
import type { NoteRecord } from "../src/agent/types";

export const NOW = new Date(2026, 9, 13, 10, 0, 0);

export function annotation(key: string, attachmentKey: string, over: Partial<Annotation> = {}): Annotation {
	const page = over.page ?? 1;
	return {
		key, attachmentKey, type: "highlight", text: "", comment: "", color: "#ffd400", page, pageLabel: String(page), version: 1,
		uri: `zotero://open-pdf/library/items/${attachmentKey}?page=${page}&annotation=${key}`, tags: [], dateModified: "2026-10-01 10:00:00", ...over,
	};
}

export function entry(over: Partial<ZoteroIndexEntry> & { itemKey: string; citekey: string }): ZoteroIndexEntry {
	const libraryID = over.libraryID ?? 1;
	const libraryType = over.libraryType ?? "user";
	return {
		id: `${libraryID}:${over.itemKey}`, libraryID, libraryType, citekeyHistory: [], title: `Title of ${over.citekey}`, authors: ["Smith, Alex"], year: "2020", doi: "", url: "", collections: [], tags: [],
		attachmentPath: "", zoteroSelectURI: `zotero://select/library/items/${over.itemKey}`, attachments: [], attachmentStatus: "complete", contentHash: "", metadata: {}, ...over,
	};
}

/** smith2020 carries two attachments: the main PDF (4 annotations in reading order 02, 00, 01 in the list) and a supplement. */
export const SMITH = entry({
	itemKey: "ABCD2345", citekey: "smith2020", citekeyHistory: ["smithOld2020"], title: "A synthetic paper",
	attachments: [
		{
			key: "PDFAAAA1", openURI: "zotero://open-pdf/library/items/PDFAAAA1", path: "/synthetic/main.pdf", title: "Full text", contentType: "application/pdf",
			annotations: [
				annotation("ANNO0001", "PDFAAAA1", { page: 3, pageLabel: "iii", text: "Alpha text", tags: ["method"], sortIndex: "00002|000100|00100" }),
				annotation("ANNO0002", "PDFAAAA1", { type: "image", page: 1, color: "#5fb236", imagePath: "/zotero-cache/library/ANNO0002.png", sortIndex: "00000|000100|00100" }),
				annotation("ANNO0003", "PDFAAAA1", { type: "note", page: 2, color: "#ff6666", comment: "check this claim", tags: ["TODO", "method"], sortIndex: "00001|000100|00100" }),
			],
		},
		{
			key: "PDFBBBB2", openURI: "zotero://open-pdf/library/items/PDFBBBB2", path: null, title: "Supplement", contentType: "application/pdf",
			annotations: [annotation("ANNO0004", "PDFBBBB2", { type: "underline", page: 5, color: "#2ea8e5", text: "Underlined supplement text", sortIndex: "00004|000100|00100" })],
		},
	],
});
export const JONES = entry({ itemKey: "JONE2345", citekey: "jones2019", title: "A second paper", year: "2019" });
/** The same citekey in a group library: `--citekey smith2020` is ambiguous across libraries. */
export const SMITH_GROUP = entry({ itemKey: "GRPS2345", citekey: "smith2020", libraryID: 2, libraryType: "group", groupID: 77, title: "Same key, other library" });
/** A later item that reuses smith2020's former key. */
export const REUSED = entry({ itemKey: "REUS2345", citekey: "smithOld2020", libraryID: 1, title: "Reuses a former key" });

export function indexOf(entries: ZoteroIndexEntry[], generatedAt = NOW.toISOString(), complete = true): ZoteroIndex {
	return { schemaVersion: 2, generatedAt, source: "better-bibtex", count: entries.length, entries, capabilities: { zotero: "10", betterbibtex: "9", metadata: true, attachments: true, annotations: true, bibliography: true }, diagnostics: [], complete };
}

export interface HostOptions {
	entries?: ZoteroIndexEntry[];
	/** Minutes the index is older than NOW. */
	ageMinutes?: number;
	complete?: boolean;
	notes?: Record<string, string>;
	extra?: Partial<ActionHost>;
	settings?: Partial<CmdsZoteroSettings>;
	scan?: { skipped?: string[]; truncated?: boolean };
	live?: boolean;
	files?: Record<string, string[]>;
}

/** An ActionHost over a synthetic index and synthetic notes (`notes`: path to text; frontmatter is parsed from a leading --- block). */
export function host(options: HostOptions = {}): ActionHost {
	const entries = options.entries ?? [SMITH, JONES];
	const generatedAt = new Date(NOW.getTime() - (options.ageMinutes ?? 0) * 60000).toISOString();
	const index = indexOf(entries, generatedAt, options.complete ?? true);
	const connection = buildConnection({
		mode: options.live === false ? "offline" : "live", obsidian: options.live === false ? "unavailable" : "ok", pluginVersion: "0.6.0", pluginApiVersions: [1, 2], pluginEnabled: true, bbt: { reachable: null },
		index: { source: "plugin", path: "80. References/zotero-index.json", generatedAt, count: entries.length, complete: index.complete, schemaVersion: 2 }, maxAgeMinutes: 60, legacyPluginEnabled: false, git: null, now: NOW,
	});
	const notes = options.notes ?? {};
	const records: NoteRecord[] = Object.keys(notes).map(path => ({ path, basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path, ...frontmatterOf(notes[path]) }));
	return {
		vault: "Research", now: NOW, connection, settings: { ...DEFAULT_SETTINGS, ...options.settings }, indexView: { index, stale: connection.index.stale !== false, ageMinutes: options.ageMinutes ?? 0 }, indexFailure: null,
		reader: {
			vaultName: () => "Research",
			scanWarnings: () => ({ skipped: [...(options.scan?.skipped ?? [])], truncated: options.scan?.truncated ?? false }),
			listNotes: async () => records,
			readNote: async path => { if (!(path in notes)) throw new Error(`Note not found: ${path}`); return notes[path]; },
			exists: async path => path in notes,
		},
		bibliography: null, bibliographyReason: null, vaultLinks: async () => ({ links: [], warnings: [] }),
		pdfCache: { list: async dir => options.files?.[dir] ?? [], read: async () => null, statLocal: async () => null, fileHash: async () => null }, vaultPdfPaths: async () => [],
		...options.extra,
	};
}

/** Frontmatter of a synthetic note: a flat `key: value` / `key: [a, b]` reader for the few keys the tests use. */
function frontmatterOf(text: string): Pick<NoteRecord, "frontmatter" | "frontmatterParse"> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) return { frontmatter: {}, frontmatterParse: "ok" };
	const frontmatter: Record<string, unknown> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		const value = pair[2].trim();
		frontmatter[pair[1]] = value.startsWith("[") ? value.slice(1, -1).split(",").map(item => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : value.replace(/^["']|["']$/g, "");
	}
	return { frontmatter, frontmatterParse: "ok" };
}

export async function run(action: Parameters<typeof runAction>[1], request: unknown, options: HostOptions = {}): Promise<Record<string, any>> {
	return await runAction(host(options), action, request) as Record<string, any>;
}
