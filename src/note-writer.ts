import { createHash } from "crypto";
import type { Annotation, CmdsZoteroSettings, ZoteroIndexEntry } from "./types";
import { colorName } from "./annotations/colors";

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");
export interface ImagePlan { source: string; path: string }
export interface RenderedNote { content: string; conflicts: string[]; images: ImagePlan[] }
export interface RenderContext {
	/** Citekeys of related Zotero items that are present in the index. */
	related?: string[];
}

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

/** Single-line text for callout titles and inline fields. */
function inline(value: unknown): string { return textFromHTML(value).replace(/\s*\n\s*/g, " "); }
/** Blockquote every line so multi-line text stays inside a callout. */
function quoted(body: string): string { return body.split("\n").map(line => `> ${line}`.trimEnd()).join("\n"); }

function block(id: string, body: string): string {
	return `<!-- cmds-zotero:${id}:${hashText(body)} -->\n${body}\n<!-- /cmds-zotero:${id} -->`;
}
function encodedPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function key(value: string): string {
	if (!/^[A-Za-z0-9]+$/.test(value)) throw new Error("Invalid Zotero item or annotation key");
	return value;
}
function fileURI(path: string): string {
	return `file://${path.split(/[\\/]/).map(segment => encodeURIComponent(segment)).join("/")}`;
}
function metadataText(entry: ZoteroIndexEntry, field: string): string {
	const value = entry.metadata[field];
	return typeof value === "string" || typeof value === "number" ? inline(String(value)) : "";
}

export interface CreatorName { role: string; name: string }
export function creatorNames(entry: ZoteroIndexEntry): CreatorName[] {
	const creators: unknown[] = Array.isArray(entry.metadata.creators) ? entry.metadata.creators : [];
	return creators.flatMap(value => {
		if (!value || typeof value !== "object") return [];
		const creator = value as Record<string, unknown>;
		const role = typeof creator.creatorType === "string" && creator.creatorType ? creator.creatorType : "author";
		const name = typeof creator.name === "string" && creator.name ? creator.name : [creator.lastName, creator.firstName].filter((v): v is string => typeof v === "string" && !!v).join(", ");
		return name ? [{ role, name }] : [];
	});
}

export function filteredTags(tags: string[], settings: CmdsZoteroSettings): string[] {
	const excluded = new Set(settings.excludedTags.map(tag => tag.toLowerCase()));
	return tags.filter(tag => tag.trim() && !excluded.has(tag.trim().toLowerCase()));
}

export function annotationURI(a: Annotation, entry: ZoteroIndexEntry): string {
	const scope = entry.libraryType === "group" ? `groups/${entry.groupID}` : "library";
	if (entry.libraryType === "group" && (!entry.groupID || !Number.isSafeInteger(entry.groupID))) throw new Error("Missing verified group ID");
	const page = Number.isSafeInteger(a.page) && a.page > 0 ? a.page : 1;
	return `zotero://open-pdf/${scope}/items/${key(a.attachmentKey)}?page=${page}&annotation=${encodeURIComponent(key(a.key))}`;
}

/** Renders one annotation as CMDS callout Markdown; reused by the import and the annotation sidebar. */
export function annotationBody(a: Annotation, image: string | undefined, entry: ZoteroIndexEntry, settings: CmdsZoteroSettings): string {
	const uri = annotationURI(a, entry);
	const page = Number.isSafeInteger(a.page) && a.page > 0 ? a.page : 1;
	// Zotero page labels can be placeholders such as "-"; fall back to the PDF page position unless the label carries a letter or digit.
	const label = inline(/[\p{L}\p{N}]/u.test(a.pageLabel) ? a.pageLabel : String(page));
	const color = colorName(a.color);
	const link = `[p. ${label}](${uri})`;
	const comment = a.comment ? `**Comment**: *${inline(a.comment)}*` : "";
	const tags = a.tags.length ? `Tags: ${a.tags.map(inline).join(", ")}` : "";
	const type = (a.type || "highlight").toLowerCase();
	if (image) {
		const title = `[!Image] ${color ? `${color} · ` : ""}p. ${label}`;
		return quoted([title, `![Annotation image](${encodedPath(image)}) ${link}`, comment, tags].filter(Boolean).join("\n"));
	}
	if (type === "note" || (!a.text && a.comment)) {
		return quoted([`[!Note] p. ${label}`, `${inline(a.comment)} ${link}`, tags].filter(Boolean).join("\n"));
	}
	if (color && settings.headingHighlightColor !== "none" && color === settings.headingHighlightColor && a.text) {
		return [`##### ${inline(a.text)} ${link}`, comment, tags].filter(Boolean).join("\n\n");
	}
	const text = inline(a.text);
	const marked = color ? `<mark class="cmds-zotero-hl-${color}">${text}</mark>` : text;
	const title = `[!Highlight] ${color ? `${color} · ` : ""}${type === "underline" ? "underline · " : ""}p. ${label}`;
	return quoted([title, `${marked} (${link})`, comment, tags].filter(Boolean).join("\n"));
}


/** Frontmatter is initialized once; existing YAML remains entirely user-owned. */
export function renderLiterature(entry: ZoteroIndexEntry, bibliography: string, settings: CmdsZoteroSettings, previous: string | null, imageHashes: ReadonlyMap<string, string> = new Map(), context: RenderContext = {}): RenderedNote {
	const owner = `<!-- cmds-zotero-owner:${hashText(entry.id)} -->`;
	const conflicts: string[] = [];
	const images: ImagePlan[] = [];
	if (previous !== null && !previous.includes(owner)) return { content: previous, conflicts: ["Existing note is not owned by this Zotero item"], images };
	const creators = creatorNames(entry);
	const authors = creators.filter(c => c.role === "author").map(c => c.name);
	const authorList = authors.length ? authors : creators.length ? creators.map(c => c.name) : entry.authors;
	const tags = filteredTags(entry.tags, settings);
	const itemType = metadataText(entry, "itemType");
	const journal = itemType === "journalArticle" ? metadataText(entry, "publicationTitle") : itemType === "preprint" ? metadataText(entry, "repository") : "";
	const related = (context.related ?? []).filter(citekey => /^[A-Za-z0-9_:.+/-]+$/.test(citekey));
	const sections = new Map<string, string>();

	const abstract = textFromHTML(entry.metadata.abstractNote);
	sections.set("overview", [`# ${inline(entry.title)}`, abstract ? quoted(`[!Abstract]\nabstract:: ${abstract}`) : ""].filter(Boolean).join("\n\n"));
	sections.set("citation", quoted(`[!Cite]\n${textFromHTML(bibliography) || "Bibliography unavailable."}`));

	const fields: [string, string][] = [];
	for (const creator of creators) fields.push([creator.role.charAt(0).toUpperCase() + creator.role.slice(1), inline(creator.name)]);
	if (!creators.length) for (const name of entry.authors) fields.push(["Author", inline(name)]);
	fields.push(["Title", inline(entry.title)], ["Year", inline(entry.year)], ["Citekey", `@${inline(entry.citekey)}`]);
	if (tags.length) fields.push(["Tags", tags.map(inline).join(", ")]);
	if (itemType) fields.push(["itemType", itemType]);
	if (journal) fields.push(["Journal", `*${journal}*`]);
	for (const [label, field] of [["Volume", "volume"], ["Issue", "issue"], ["Publisher", "publisher"], ["Location", "place"], ["Pages", "pages"], ["DOI", "DOI"], ["ISBN", "ISBN"]] as const) {
		const value = metadataText(entry, field);
		if (value) fields.push([label, value]);
	}
	if (itemType === "bookSection" && metadataText(entry, "publicationTitle")) fields.push(["Book", metadataText(entry, "publicationTitle")]);
	if (entry.url) fields.push(["URL", inline(entry.url)]);
	if (entry.collections.length) fields.push(["Collections", entry.collections.map(inline).join("; ")]);
	if (related.length) fields.push(["Related", related.map(citekey => `[[@${citekey}]]`).join(", ")]);
	const links = [`[Open in Zotero](${entry.zoteroSelectURI})`, ...entry.attachments.filter(a => a.path).map(a => `[${inline(a.title) || "Attachment"}](${fileURI(a.path ?? "")})`)];
	sections.set("metadata", `${quoted(`[!md]\n${fields.map(([label, value]) => `**${label}**:: ${value}`).join("\n")}`)}\n\n${quoted(`[!LINK]\n${links.join(" · ")}`)}`);

	const notes: unknown[] = Array.isArray(entry.metadata.notes) ? entry.metadata.notes : [];
	const noteText = notes.map(n => textFromHTML(typeof n === "string" ? n : n && typeof n === "object" && "note" in n ? (n as Record<string, unknown>).note : "")).filter(Boolean).join("\n\n---\n\n");
	sections.set("notes", `## Zotero notes\n\n${noteText || "*No Zotero notes.*"}`);

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
		sections.set(id, annotationBody(a, image, entry, settings));
	}

	if (previous === null) {
		const yaml: Record<string, unknown> = {
			type: "zotero", citekey: entry.citekey, title: entry.title, authors: authorList, year: entry.year, doi: entry.doi, tags: [...new Set(["zotero", ...tags])],
			zotero_title: entry.title, zotero_author: authorList, zotero_year: entry.year, zotero_journal: journal, zotero_doi: entry.doi, zotero_url: entry.url, zotero_tags: tags,
			"zotero-id": entry.id, "zotero-key": entry.itemKey, "zotero-library-id": entry.libraryID,
			zoteroID: entry.id, zoteroItemKey: entry.itemKey, zoteroLibraryID: entry.libraryID, zoteroLibraryType: entry.libraryType,
			...(entry.groupID === undefined ? {} : { zoteroGroupID: entry.groupID }),
		};
		// JSON scalars and flow sequences are valid YAML and keep quoting unambiguous.
		const frontmatter = Object.entries(yaml).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
		const intro = ["overview", "citation"].map(id => block(id, sections.get(id) ?? "")).join("\n\n");
		const synthesis = "## Synthesis\n\n> [!Synth]\n> **Contribution**::\n> **Related**::";
		const details = ["metadata", "notes"].map(id => block(id, sections.get(id) ?? "")).join("\n\n");
		const annotations = [...sections].filter(([id]) => id.startsWith("annotation-")).map(([id, body]) => block(id, body)).join("\n\n");
		return { content: `---\n${frontmatter}\n---\n\n${owner}\n\n${intro}\n\n${synthesis}\n\n${details}\n\n## Notes\n\n## Annotations\n\n${annotations}\n`, conflicts, images };
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
