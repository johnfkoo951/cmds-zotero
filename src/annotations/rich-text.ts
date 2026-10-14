/**
 * 0.6.1 RICH-TEXT (G27): Zotero's small rich-text tag set in titles and annotation text/comments, as Markdown. Pure (no
 * `obsidian` import).
 *
 * Only well-paired lower-case tags of the whitelist are read: `<i>`/`<em>` become `*x*`, `<b>`/`<strong>` `**x**`,
 * `<sup>`/`<sub>` stay literal tags, `<span>` (Zotero's `nocase` and small-caps spans) keeps its text, `<br>` breaks the
 * line. Attributes are ignored. Every other character — unknown, unclosed or mismatched tags included — goes through the
 * caller's escape, so the result can never form a marker, a link or another tag. Without whitelisted tag pairs the result
 * is exactly `escape(text)`.
 */

export type Escape = (text: string) => string;
type Kind = "em" | "strong" | "sup" | "sub" | "plain";
const KINDS: Readonly<Record<string, Kind>> = { i: "em", em: "em", b: "strong", strong: "strong", sup: "sup", sub: "sub", span: "plain" };
/** Bounds the tag depth the parser keeps open (hostile input stays linear). */
const MAX_DEPTH = 32;

type RichNode = { kind: "text"; text: string } | { kind: "br" } | { kind: Kind; children: RichNode[] };
interface Frame { name: string; kind: Kind; raw: string; children: RichNode[] }

const TAG = /<(\/?)([a-z]+)((?:[\s/][^<>]*)?)>/g;

function parse(source: string): RichNode[] {
	const root: RichNode[] = [];
	const stack: Frame[] = [];
	const top = (): RichNode[] => stack.length ? stack[stack.length - 1].children : root;
	const literal = (text: string): void => {
		if (!text) return;
		const nodes = top();
		const last = nodes[nodes.length - 1];
		if (last?.kind === "text") last.text += text; else nodes.push({ kind: "text", text });
	};
	let at = 0;
	for (const match of source.matchAll(TAG)) {
		literal(source.slice(at, match.index));
		at = match.index + match[0].length;
		const [raw, closing, name, attributes] = match;
		const selfClosing = /\/\s*$/.test(attributes);
		if (name === "br" && !closing) { top().push({ kind: "br" }); continue; }
		const kind = Object.prototype.hasOwnProperty.call(KINDS, name) ? KINDS[name] : undefined;
		if (!kind || selfClosing) { literal(raw); continue; }
		if (!closing) {
			if (stack.length >= MAX_DEPTH) { literal(raw); continue; }
			stack.push({ name, kind, raw, children: [] });
			continue;
		}
		const open = stack[stack.length - 1];
		if (!open || open.name !== name) { literal(raw); continue; }
		stack.pop();
		top().push({ kind: open.kind, children: open.children });
	}
	literal(source.slice(at));
	// Unclosed tags are text: their opening tag is written literally, followed by what they contained.
	while (stack.length) {
		const open = stack.pop() as Frame;
		literal(open.raw);
		const nodes = top();
		for (const child of open.children) {
			const last = nodes[nodes.length - 1];
			if (child.kind === "text" && last?.kind === "text") last.text += child.text; else nodes.push(child);
		}
	}
	return root;
}

interface Context { em: boolean; strong: boolean }
/** Emphasis markers hug the text: surrounding whitespace moves outside them, and empty emphasis is dropped. */
function wrap(inner: string, marker: string): string {
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
	if (!match || !match[2]) return inner;
	return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}
function renderMarkdown(nodes: readonly RichNode[], escape: Escape, context: Context): string {
	return nodes.map(node => {
		switch (node.kind) {
			case "text": return escape(node.text);
			case "br": return "\n";
			case "em": return context.em ? renderMarkdown(node.children, escape, context) : wrap(renderMarkdown(node.children, escape, { ...context, em: true }), "*");
			case "strong": return context.strong ? renderMarkdown(node.children, escape, context) : wrap(renderMarkdown(node.children, escape, { ...context, strong: true }), "**");
			case "sup":
			case "sub": { const inner = renderMarkdown(node.children, escape, context); return inner ? `<${node.kind}>${inner}</${node.kind}>` : ""; }
			default: return renderMarkdown(node.children, escape, context);
		}
	}).join("");
}
function renderPlain(nodes: readonly RichNode[]): string {
	return nodes.map(node => node.kind === "text" ? node.text : node.kind === "br" ? "\n" : renderPlain(node.children)).join("");
}

/**
 * Rich text as Markdown; `escape` is applied to every text run. `italic` says the result is placed inside `*…*` already,
 * so `<i>` adds no second pair of markers.
 */
export function richTextMarkdown(source: string, escape: Escape, options: { italic?: boolean } = {}): string {
	return renderMarkdown(parse(source), escape, { em: options.italic === true, strong: false });
}

/** Rich text with the whitelisted tags removed (their text kept), for plain-text UI such as sidebar cards. */
export function richTextPlain(source: string): string {
	return renderPlain(parse(source));
}
