import { createHash } from "crypto";
import type { Annotation, CmdsZoteroSettings, ZoteroIndexEntry } from "./types";

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");
export interface ImagePlan { source: string; path: string }
export interface RenderedNote { content: string; conflicts: string[]; images: ImagePlan[] }

export function safeVaultPath(path: string): string {
	if (!path || path.startsWith("/") || /[\\:]/.test(path) || [...path].some(c => c.charCodeAt(0) < 32) || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Unsafe vault path");
	return path;
}

export function textFromHTML(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<\s*(?:br\s*\/?|\/p|\/div|\/li|\/h[1-6])\s*>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => {
			const code = n[0]?.toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
		})
		.replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[name.toLowerCase()] ?? ""))
		.split("").filter(c => c.charCodeAt(0) >= 32 || c === "\n" || c === "\t" || c === "\r").join("")
		.replace(/[\\`*_{}[\]()#!|<>~]/g, "\\$&").replace(/\n{3,}/g, "\n\n").trim();
}

function block(id: string, body: string): string {
	return `<!-- cmds-zotero:${id}:${hashText(body)} -->\n${body}\n<!-- /cmds-zotero:${id} -->`;
}
function encodedPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function key(value: string): string {
	if (!/^[A-Za-z0-9]+$/.test(value)) throw new Error("Invalid Zotero item or annotation key");
	return value;
}
function annotationBody(a: Annotation, image: string | undefined, entry: ZoteroIndexEntry): string {
	const scope = entry.libraryType === "group" ? `groups/${entry.groupID}` : "library";
	if (entry.libraryType === "group" && (!entry.groupID || !Number.isSafeInteger(entry.groupID))) throw new Error("Missing verified group ID");
	const page = Number.isSafeInteger(a.page) && a.page > 0 ? a.page : 1;
	const uri = `zotero://open-pdf/${scope}/items/${key(a.attachmentKey)}?page=${page}&annotation=${encodeURIComponent(key(a.key))}`;
	return [`### ${textFromHTML(a.type || "Annotation")} · ${textFromHTML(a.pageLabel || String(page))}`,
		`[Open annotation](${uri})`, a.text ? `> ${textFromHTML(a.text).replace(/\n/g, "\n> ")}` : "",
		image ? `![Annotation image](${encodedPath(image)})` : "", textFromHTML(a.comment),
		a.tags.length ? `Tags: ${a.tags.map(textFromHTML).join(", ")}` : ""].filter(Boolean).join("\n\n");
}

/** Frontmatter is initialized once; existing YAML remains entirely user-owned. */
export function renderLiterature(entry: ZoteroIndexEntry, bibliography: string, settings: CmdsZoteroSettings, previous: string | null, imageHashes: ReadonlyMap<string, string> = new Map()): RenderedNote {
	const owner = `<!-- cmds-zotero-owner:${hashText(entry.id)} -->`;
	const conflicts: string[] = [];
	const images: ImagePlan[] = [];
	if (previous !== null && !previous.includes(owner)) return { content: previous, conflicts: ["Existing note is not owned by this Zotero item"], images };
	const creators: unknown[] = Array.isArray(entry.metadata.creators) ? entry.metadata.creators : [];
	const creatorNames = creators.flatMap(value => {
		if (!value || typeof value !== "object") return [];
		const creator = value as Record<string, unknown>;
		const name = typeof creator.name === "string" ? creator.name : [creator.firstName, creator.lastName].filter(v => typeof v === "string").join(" ");
		return name ? [name] : [];
	});
	const authors = creatorNames.length ? creatorNames : entry.authors;
	const sections = new Map<string, string>();
	sections.set("overview", `## Overview\n\n# ${textFromHTML(entry.title)}\n\n${textFromHTML(entry.metadata.abstractNote)}`.trim());
	sections.set("citation", `## Cite (APA)\n\n${textFromHTML(bibliography) || "Bibliography unavailable."}`);
	sections.set("metadata", `## Metadata\n\n${[
		["Authors", authors.join("; ")], ["Year", entry.year], ["DOI", entry.doi], ["URL", entry.url],
		["Collections", entry.collections.join("; ")], ["Tags", entry.tags.join("; ")],
	].map(([label, value]) => `- ${label}: ${textFromHTML(value)}`).join("\n")}`);
	const notes: unknown[] = Array.isArray(entry.metadata.notes) ? entry.metadata.notes : [];
	sections.set("notes", `## Zotero notes\n\n${notes.map(n => textFromHTML(typeof n === "string" ? n : n && typeof n === "object" && "note" in n ? (n as Record<string, unknown>).note : "")).filter(Boolean).join("\n\n---\n\n")}`.trim());
	const seen = new Set<string>();
	for (const attachment of entry.attachments) for (const a of attachment.annotations) {
		const id = `annotation-${key(attachment.key)}-${key(a.key)}`;
		if (a.attachmentKey !== attachment.key) throw new Error("Annotation attachment identity mismatch");
		if (seen.has(id)) continue;
		seen.add(id);
		let image: string | undefined;
		if (a.imagePath) {
			const extension = /\.(png|jpe?g|gif|webp)$/i.exec(a.imagePath)?.[1]?.toLowerCase();
			if (!extension) throw new Error("Unsupported annotation image extension");
			const digest = imageHashes.get(a.imagePath);
			if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Validated image content hash required before rendering");
			const library = entry.libraryType === "group" ? entry.groupID : entry.libraryID;
			if (library === undefined || !Number.isSafeInteger(library) || library < 0) throw new Error("Verified image library identity required");
			image = safeVaultPath(`${settings.imageFolder}/${entry.libraryType}-${library}-${key(attachment.key)}-${key(a.key)}-${digest}.${extension}`);
			images.push({ source: a.imagePath, path: image });
		}
		sections.set(id, annotationBody(a, image, entry));
	}
	if (previous === null) {
		const yaml: Record<string, unknown> = { citekey: entry.citekey, title: entry.title, authors, year: entry.year, doi: entry.doi, tags: entry.tags, "zotero-id": entry.id, "zotero-key": entry.itemKey, "zotero-library-id": entry.libraryID, zoteroID: entry.id, zoteroItemKey: entry.itemKey, zoteroLibraryID: entry.libraryID, zoteroLibraryType: entry.libraryType, ...(entry.groupID === undefined ? {} : { zoteroGroupID: entry.groupID }) };
		const frontmatter = Object.entries(yaml).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
		const intro = ["overview", "citation"].map(id => block(id, sections.get(id) ?? "")).join("\n\n");
		const details = ["metadata", "notes"].map(id => block(id, sections.get(id) ?? "")).join("\n\n");
		const annotations = [...sections].filter(([id]) => id.startsWith("annotation-")).map(([id, body]) => block(id, body)).join("\n\n");
		return { content: `---\n${frontmatter}\n---\n\n${owner}\n\n${intro}\n\n## Synthesis\n\n### Contribution\n\n### Related\n\n${details}\n\n## Notes\n\n## Annotations\n\n${annotations}\n`, conflicts, images };
	}
	const matched = new Set<string>();
	const expression = /<!-- cmds-zotero:([a-zA-Z0-9-]+):([a-f0-9]{64}) -->\n([\s\S]*?)\n<!-- \/cmds-zotero:\1 -->/g;
	let content = previous.replace(expression, (whole: string, id: string, hash: string, body: string) => {
		if (matched.has(id)) { conflicts.push(`Duplicate managed section: ${id}`); return whole; }
		matched.add(id);
		if (hashText(body) !== hash) { conflicts.push(`Edited generated section preserved: ${id}`); return whole; }
		const fresh = sections.get(id);
		return fresh === undefined ? whole : block(id, fresh);
	});
	// Missing or damaged markers must never result in duplicated generated sections.
	const openingCount = (previous.match(/<!-- cmds-zotero:/g) ?? []).length;
	const closingCount = (previous.match(/<!-- \/cmds-zotero:/g) ?? []).length;
	if (openingCount !== matched.size || closingCount !== matched.size) conflicts.push("Malformed or duplicate managed markers");
	for (const [id, body] of sections) if (!matched.has(id)) {
		if (id.startsWith("annotation-") && !previous.includes(`cmds-zotero:${id}:`)) content += `\n${block(id, body)}\n`;
		else conflicts.push(`Missing managed section: ${id}`);
	}
	return { content, conflicts, images };
}
