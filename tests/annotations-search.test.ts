// 0.6.1 annotation-search-insert: the search model over every indexed annotation and the insert formats. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { annotationInsertText, annotationSearchRow, annotationSearchRows, linkOnly, preparedSearchRows, searchAnnotations, searchEmptyText } from "../src/annotations/search";
import { annotationBody } from "../src/note-writer";
import { DEFAULT_SETTINGS, type Annotation, type Attachment, type ZoteroIndexEntry } from "../src/types";

// Synthetic records only (AGENTS.md).
const note = (o: Partial<Annotation> = {}): Annotation => ({
	key: "ANNO2345", attachmentKey: "ATTA2345", type: "highlight", text: "Synthetic", comment: "", color: "#ffd400", page: 12, pageLabel: "12", version: 3, uri: "", tags: [], dateModified: "2026-01-01T00:00:00Z", ...o,
});
const attachment = (annotations: Annotation[], key = "ATTA2345"): Attachment => ({ key, title: "Synthetic.pdf", path: "/synthetic/a.pdf", openURI: `zotero://open-pdf/library/items/${key}`, annotations } as unknown as Attachment);
const entry = (o: Partial<ZoteroIndexEntry>, annotations: Annotation[]): ZoteroIndexEntry => ({
	id: "1:ITEM2345", libraryID: 1, libraryType: "user", itemKey: "ITEM2345", citekey: "synthetic2026memory", citekeyHistory: [], title: "Synthetic memory", attachments: [attachment(annotations)], ...o,
} as unknown as ZoteroIndexEntry);

const korean = "기억의 재구성은 맥락에 따라 달라진다";
const entries = [
	entry({}, [
		note({ key: "ANNA2345", text: "Working memory has a limited capacity", comment: "core claim", tags: ["method"], page: 3, pageLabel: "3" }),
		note({ key: "ANNB2345", text: korean, comment: "", color: "#ff6666", page: 5, pageLabel: "v" }),
		note({ key: "ANNC2345", type: "image", text: "", imagePath: "/synthetic/cache/ANNC2345.png", page: 7, pageLabel: "7" }),
	]),
	entry({ id: "1:ITEM6789", itemKey: "ITEM6789", citekey: "other2025sleep", title: "Sleep and memory consolidation" }, [
		note({ key: "ANND2345", text: "Sleep stabilises traces", comment: "기억 공고화", page: 9, pageLabel: "9" }),
		note({ key: "ANNE2345", type: "ink", text: "", comment: "", page: 2, pageLabel: "2" }),
	]),
];

test("search: every word must match text, comment or tags; own text ranks before citekey or title", () => {
	const rows = annotationSearchRows(entries);
	assert.equal(rows.length, 5);
	assert.deepEqual(searchAnnotations(rows, "limited capacity").map(row => row.annotation.key), ["ANNA2345"]);
	assert.deepEqual(searchAnnotations(rows, "CORE claim").map(row => row.annotation.key), ["ANNA2345"], "comment, case-insensitive");
	assert.deepEqual(searchAnnotations(rows, "method").map(row => row.annotation.key), ["ANNA2345"], "tag");
	assert.deepEqual(searchAnnotations(rows, "limited sleep").map(row => row.annotation.key), [], "all words, not any");
	// "memory" is in ANNA's text (own) and in both titles (other): the own match comes first.
	assert.deepEqual(searchAnnotations(rows, "memory").map(row => row.annotation.key), ["ANNA2345", "ANNB2345", "ANNC2345", "ANND2345", "ANNE2345"]);
	assert.deepEqual(searchAnnotations(rows, "@other2025sleep").map(row => row.annotation.key), ["ANND2345", "ANNE2345"], "citekey");
	assert.deepEqual(searchAnnotations(rows, "red").map(row => row.annotation.key), ["ANNB2345"], "colour name");
	assert.equal(searchAnnotations(rows, "").length, 5, "empty query lists rows in reading order");
	assert.equal(searchAnnotations(rows, "", 2).length, 2, "limit");
});

test("search: Korean matches in composed and decomposed forms, in text and comments", () => {
	const rows = annotationSearchRows(entries);
	assert.deepEqual(searchAnnotations(rows, "재구성").map(row => row.annotation.key), ["ANNB2345"]);
	assert.deepEqual(searchAnnotations(rows, "재구성".normalize("NFD")).map(row => row.annotation.key), ["ANNB2345"], "decomposed query");
	const decomposed = annotationSearchRows([entry({}, [note({ text: korean.normalize("NFD") })])]);
	assert.equal(searchAnnotations(decomposed, "맥락에").length, 1, "decomposed stored text");
	assert.deepEqual(searchAnnotations(rows, "공고화").map(row => row.annotation.key), ["ANND2345"]);
	assert.deepEqual(searchAnnotations(rows, "기억").map(row => row.annotation.key), ["ANNB2345", "ANND2345"]);
});

test("rows read 'p. label · @citekey · colour'; images and drawings have a snippet", () => {
	const rows = annotationSearchRows(entries);
	assert.equal(rows[0].label, "p. 3 · @synthetic2026memory · yellow");
	assert.equal(rows[1].label, "p. v · @synthetic2026memory · red");
	assert.equal(rows[2].snippet, "Image annotation");
	assert.equal(rows[4].snippet, "Ink annotation");
});

test("prepared rows are built once per index generation (entries array)", () => {
	const first = preparedSearchRows(entries);
	assert.equal(preparedSearchRows(entries), first);
	assert.notEqual(preparedSearchRows([...entries]), first, "a new generation rebuilds");
});

test("insert: callout is the import's callout, quote ends in a linked citation, link is the open-pdf link", () => {
	const item = entries[0];
	const highlight = item.attachments[0].annotations[0];
	assert.equal(annotationInsertText("callout", highlight, item, DEFAULT_SETTINGS), annotationBody(highlight, undefined, item, DEFAULT_SETTINGS));
	const link = "[Synthetic memory — p. 3](<zotero://open-pdf/library/items/ATTA2345?page=3&annotation=ANNA2345>)";
	assert.equal(annotationInsertText("link", highlight, item, DEFAULT_SETTINGS), link);
	assert.equal(annotationInsertText("quote", highlight, item, DEFAULT_SETTINGS),
		"> Working memory has a limited capacity\n> — [@synthetic2026memory, p. 3] [Zotero](<zotero://open-pdf/library/items/ATTA2345?page=3&annotation=ANNA2345>)");
	const multi = note({ text: "First line\r\n\nsecond line", pageLabel: "가" });
	assert.equal(annotationInsertText("quote", multi, item, DEFAULT_SETTINGS),
		"> First line\n> second line\n> — [@synthetic2026memory, p. 가] [Zotero](<zotero://open-pdf/library/items/ATTA2345?page=12&annotation=ANNO2345>)");
});

test("insert: image and ink annotations insert links only; a copied image becomes the import's image callout", () => {
	const image = entries[0].attachments[0].annotations[2];
	const ink = entries[1].attachments[0].annotations[1];
	assert.ok(linkOnly(image) && linkOnly(ink) && !linkOnly(entries[0].attachments[0].annotations[0]));
	assert.equal(annotationInsertText("quote", image, entries[0], DEFAULT_SETTINGS), "[Synthetic memory — p. 7](<zotero://open-pdf/library/items/ATTA2345?page=7&annotation=ANNC2345>)");
	assert.equal(annotationInsertText("quote", ink, entries[1], DEFAULT_SETTINGS), "[Sleep and memory consolidation — p. 2](<zotero://open-pdf/library/items/ATTA2345?page=2&annotation=ANNE2345>)");
	assert.equal(annotationInsertText("callout", image, entries[0], DEFAULT_SETTINGS), "[Image annotation, p. 7](<zotero://open-pdf/library/items/ATTA2345?page=7&annotation=ANNC2345>)", "not copied: link only");
	const copied = "References/Zotero/images/user-1-ATTA2345-ANNC2345-abc.png";
	assert.equal(annotationInsertText("callout", image, entries[0], DEFAULT_SETTINGS, copied), annotationBody(image, copied, entries[0], DEFAULT_SETTINGS));
	assert.match(annotationInsertText("callout", image, entries[0], DEFAULT_SETTINGS, copied), /^> \[!Image\]/);
});

test("empty search: index not loaded, nothing indexed, no match", () => {
	assert.match(searchEmptyText(false, 0), /not loaded/);
	assert.match(searchEmptyText(true, 0), /No annotations are indexed/);
	assert.equal(searchEmptyText(true, 4), "No annotations match.");
});

test("AnnotationSearchModal: strips rich-text HTML from comment, omits empty comment line, and guards IME composition", async () => {
	const mockObsidian = `
	export class SuggestModal {
		constructor(app) {
			this.app = app;
			this.registered = [];
			this.selected = 0;
			this.inputCalls = 0;
			this.scope = { register: (mods, key, cb) => { this.registered.push({ mods, key, cb }); } };
			this.inputEl = { listeners: {}, addEventListener(type, cb) { (this.listeners[type] ??= []).push(cb); } };
		}
		setPlaceholder() {}
		setInstructions() {}
		selectActiveSuggestion() { this.selected++; }
		onInput() { this.inputCalls++; }
	}
	export const Keymap = { isModifier: () => false };
	`;
	const bundled = await build({
		stdin: { contents: 'export { AnnotationSearchModal } from "./src/modals/annotation-search";', resolveDir: process.cwd(), loader: "ts" },
		bundle: true, platform: "node", format: "esm", write: false,
		plugins: [{
			name: "mock-obsidian",
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
				b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: mockObsidian, loader: "js" }));
			},
		}],
	});
	const { AnnotationSearchModal } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`) as {
		AnnotationSearchModal: new (app: unknown, rows: unknown[], empty: string, source: string, choose: () => void) => {
			registered: { cb: (e: unknown) => boolean }[];
			selected: number;
			inputCalls: number;
			inputEl: { listeners: Record<string, (() => void)[]> };
			renderSuggestion(row: unknown, el: unknown): void;
		};
	};
	const modal = new AnnotationSearchModal({}, [], "empty", "snapshot", () => {});
	assert.equal(modal.registered.length, 3);
	assert.equal(modal.registered[0].cb({ isComposing: true }), true);
	assert.equal(modal.registered[0].cb({ keyCode: 229 }), true);
	assert.equal(modal.selected, 0);
	assert.equal(modal.registered[0].cb({ isComposing: false }), false);
	assert.equal(modal.selected, 1);
	for (const cb of modal.inputEl.listeners.compositionend ?? []) cb();
	assert.equal(modal.inputCalls, 1);

	const makeEl = () => {
		const children: { tag: string; cls?: string; text?: string }[] = [];
		return {
			children,
			createDiv(opts: { text?: string }) { children.push({ tag: "div", text: opts.text }); },
			createEl(tag: string, opts: { cls?: string; text?: string }) { children.push({ tag, cls: opts.cls, text: opts.text }); },
		};
	};
	const richRow = annotationSearchRow(entries[0], entries[0].attachments[0], note({ text: "Highlighted text", comment: "<b>Important</b> <i>note</i>" }));
	const el1 = makeEl();
	modal.renderSuggestion(richRow, el1);
	assert.equal(el1.children.length, 3);
	assert.equal(el1.children[1].text, "Important note");

	const emptyHtmlCommentRow = annotationSearchRow(entries[0], entries[0].attachments[0], note({ text: "Highlighted text", comment: "<span>   </span>" }));
	const el2 = makeEl();
	modal.renderSuggestion(emptyHtmlCommentRow, el2);
	assert.equal(el2.children.length, 2, "whitespace-only HTML comment does not render a <small> comment line");
});

