/** Shared note framing; the live and offline hosts inject their YAML parser. */
export function parseNoteText(text: string, parse: (yaml: string) => unknown): { frontmatter: Record<string, unknown> | null; frontmatterParse: "ok" | "error"; body: string } {
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	if (!match) return { frontmatter: null, frontmatterParse: /^---(?:\r?\n|$)/.test(source) ? "error" : "ok", body: source };
	const body = source.slice(match[0].length);
	try {
		const value = parse(match[1]);
		if (value === null || value === undefined) return { frontmatter: {}, frontmatterParse: "ok", body };
		if (typeof value !== "object" || Array.isArray(value)) return { frontmatter: null, frontmatterParse: "error", body };
		return { frontmatter: value as Record<string, unknown>, frontmatterParse: "ok", body };
	} catch { return { frontmatter: null, frontmatterParse: "error", body }; }
}
