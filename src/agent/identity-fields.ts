/**
 * Pure builders for the `identity` action: hub frontmatter, its YAML fragment, the S01 block, the status callout and PDF
 * attachment selection. Never imports `obsidian`; vocabulary §1 (identity keys), §2 (`pdfStatus`) and the identity spec.
 */
import type { Attachment, ZoteroIndexEntry } from "../types";
import { pdfURI } from "../uris";
import { emitDoi } from "./search";
import { HUB_IDENTITY_KEYS } from "./types";
import type { HubIdentityFrontmatter, NoteRef, PdfStatus, ResolutionStatus, ResolveOutcome } from "./types";

const FULL_CITATION_PLACEHOLDER = "{APA 등 완전한 서지 — 원문 표기 그대로}";
const RAW_SOURCE_PLACEHOLDER = "[[{YYYY-MM-DD-Paper-Title}]]";

export { emitDoi } from "./search";

export interface IdentityFrontmatterInput {
	/** `--citekey` (or the folder key); null when the agent passed none. */
	requestedCitekey: string | null;
	outcome: ResolveOutcome;
	/** Index older than `indexMaxAgeMinutes`: a not-found verdict is withheld and reported as `unavailable`. */
	stale: boolean;
	now: Date;
	/** DOI already passed through `emitDoi` (or the raw `--doi` value; it is normalized again, idempotently). */
	emittedDoi: string;
}

/**
 * The five identity keys plus optional requested `citekey` and emitted `doi`. `citekey` is never inferred from the
 * index: omitting the requested key omits it from YAML and keeps the identity provisional even when an item resolves.
 */
export function identityFrontmatter(input: IdentityFrontmatterInput): HubIdentityFrontmatter {
	const { outcome } = input;
	const entry = outcome.status === "resolved" ? outcome.entry : null;
	const zoteroStatus: ResolutionStatus = input.stale && outcome.status === "not-found" ? "unavailable" : outcome.status;
	const citekey = input.requestedCitekey?.trim() || undefined;
	const doi = emitDoi(input.emittedDoi) || (entry ? emitDoi(entry.doi) : "");
	const citekeyProvisional = !(zoteroStatus === "resolved" && entry !== null && citekey !== undefined && entry.citekey === citekey);
	const requested = citekey === undefined ? {} : { citekey };
	const tail = { zoteroStatus, zoteroCheckedAt: input.now.toISOString() };
	return entry
		? { ...requested, citekeyProvisional, doi, zoteroID: entry.id, zoteroSelectURI: entry.zoteroSelectURI, ...tail }
		: { ...requested, citekeyProvisional, doi, ...tail };
}

/** One key per line in `HUB_IDENTITY_KEYS` order; strings JSON-quoted, booleans bare, absent keys omitted. */
export function yamlFragment(fm: HubIdentityFrontmatter): string {
	const lines: string[] = [];
	for (const key of HUB_IDENTITY_KEYS) {
		const value = fm[key];
		if (value === undefined || (key === "citekey" && value === "")) continue;
		lines.push(`${key}: ${typeof value === "boolean" ? String(value) : JSON.stringify(value)}`);
	}
	return lines.join("\n");
}

export interface PdfCandidate { key: string; title: string; path: string | null }

export interface PdfPick {
	pdfStatus: PdfStatus;
	/** Attachment key (never the parent item key); null unless exactly one attachment was selected. */
	attachmentKey: string | null;
	/** The attachment's bare `zotero://open-pdf/.../items/<ATTACHMENTKEY>` URI without page parameters. */
	openURI: string | null;
	path: string | null;
	/** `ambiguous`: the PDF attachments to choose from; `unknown-type`: the attachments lacking evidence. */
	candidates?: PdfCandidate[];
}

/** `contentType`/`filename` are additive BBT fields (spec: bbt.ts optional); the index shape may lack them. */
export type AttachmentEvidence = Attachment & { contentType?: string; filename?: string };

type AttachmentKind = "pdf" | "other" | "unknown";

function isPdfName(name: string | null | undefined): boolean {
	return typeof name === "string" && /\.pdf$/i.test(name.trim());
}

function attachmentKind(attachment: AttachmentEvidence): AttachmentKind {
	const type = attachment.contentType?.trim().toLowerCase() ?? "";
	if (isPdfName(attachment.path) || type === "application/pdf" || isPdfName(attachment.filename) || isPdfName(attachment.title)) return "pdf";
	if ((typeof attachment.path === "string" && attachment.path.trim() !== "") || type !== "") return "other";
	return "unknown";
}

function candidate(attachment: AttachmentEvidence): PdfCandidate {
	return { key: attachment.key, title: attachment.title, path: attachment.path };
}

function pickOne(attachment: AttachmentEvidence): PdfPick {
	const path = typeof attachment.path === "string" && attachment.path.trim() !== "" ? attachment.path : null;
	return { pdfStatus: path ? "present" : "missing-file", attachmentKey: attachment.key, openURI: attachment.openURI, path };
}

function pickExplicit(entry: ZoteroIndexEntry, attachments: AttachmentEvidence[], attachmentKey: string): PdfPick {
	if (attachmentKey === entry.itemKey) throw new Error("A parent item key cannot select a PDF attachment");
	const attachment = attachments.find(item => item.key === attachmentKey);
	if (!attachment) throw new Error(`Attachment ${attachmentKey} is not attached to item ${entry.id}`);
	const kind = attachmentKind(attachment);
	if (kind === "other") throw new Error(`Attachment ${attachmentKey} is not a PDF`);
	if (kind === "unknown") return { pdfStatus: "unknown-type", attachmentKey: attachment.key, openURI: attachment.openURI, path: null };
	return pickOne(attachment);
}

/**
 * `pdfStatus` rules (§2): `unavailable` whenever `attachmentStatus` is unavailable (retained attachments ignored);
 * a `.pdf` path → `present`; a known PDF (contentType, filename or title ending `.pdf`) without a path → `missing-file`;
 * null path and no evidence → `unknown-type` (candidates listed); several PDFs → `ambiguous` unless `attachmentKey`
 * names one; nothing PDF-like → `none`. Throws when `attachmentKey` is the parent key, unknown, or a known non-PDF.
 */
export function pickPdf(entry: ZoteroIndexEntry, attachmentKey?: string): PdfPick {
	const none: PdfPick = { pdfStatus: "none", attachmentKey: null, openURI: null, path: null };
	if (entry.attachmentStatus === "unavailable") return { ...none, pdfStatus: "unavailable" };
	const attachments = entry.attachments as AttachmentEvidence[];
	if (attachmentKey !== undefined) return pickExplicit(entry, attachments, attachmentKey);
	const pdfs = attachments.filter(attachment => attachmentKind(attachment) === "pdf");
	if (pdfs.length === 1) return pickOne(pdfs[0]);
	if (pdfs.length > 1) return { ...none, pdfStatus: "ambiguous", candidates: pdfs.map(candidate) };
	const unknown = attachments.filter(attachment => attachmentKind(attachment) === "unknown");
	if (unknown.length) return { ...none, pdfStatus: "unknown-type", candidates: unknown.map(candidate) };
	return none;
}

export interface S01Input {
	frontmatter: HubIdentityFrontmatter;
	/** Index citekey when resolved (payload `citekeyCurrent`); null otherwise. */
	citekeyCurrent: string | null;
	/** Rendered bibliography text; null when BBT is unreachable, offline, disabled or the style failed. */
	bibliography: string | null;
	pdf: PdfPick;
	/** `--raw-source` value, with or without `[[ ]]`; null when not given. */
	rawSource: string | null;
	/** `vaultNotes.raw`: used only when exactly one raw source exists and `rawSource` is null. */
	rawNotes: NoteRef[];
	/** `ranked.length` / `candidates.length` when ambiguous. */
	candidateCount?: number;
	/** Failure reason for the unavailable line, e.g. `stale-index` or `bbt-unreachable`. */
	unavailableReason?: string;
}

export interface S01Block { fullCitation: string | null; lines: string[]; markdown: string }

function singleLine(text: string): string {
	return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function wikilink(target: string): string {
	return `[[${target.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").trim()}]]`;
}

function citekeyLine(fm: HubIdentityFrontmatter, citekeyCurrent: string | null): string {
	const requested = fm.citekey?.trim() || null;
	const display = requested ?? citekeyCurrent;
	if (display === null) return "- **citekey**: unassigned";
	if (fm.zoteroStatus !== "resolved") return `- **citekey**: \`${display}\` (provisional)`;
	const suffix = requested !== null && citekeyCurrent !== null && citekeyCurrent !== requested
		? ` (Zotero key: ${citekeyCurrent} — pin pending)`
		: "";
	return `- **citekey**: \`${display}\`${suffix}`;
}

function zoteroLine(fm: HubIdentityFrontmatter, input: S01Input): string {
	switch (fm.zoteroStatus) {
		case "resolved": return fm.zoteroSelectURI ?? `resolved (${fm.zoteroID ?? "select URI missing"})`;
		case "not-found": return `not registered (checked ${fm.zoteroCheckedAt})`;
		case "unavailable": return `unavailable at ingest (checked ${fm.zoteroCheckedAt}${input.unavailableReason ? `; ${input.unavailableReason}` : ""})`;
		case "ambiguous": return `ambiguous (${input.candidateCount ?? "several"} candidates; see identity ranked[])`;
	}
}

function pdfLine(pdf: PdfPick): string | null {
	if (pdf.openURI === null || (pdf.pdfStatus !== "present" && pdf.pdfStatus !== "missing-file")) return null;
	return `- **PDF**: ${pdfURI(pdf.openURI, 1)}${pdf.pdfStatus === "missing-file" ? " (file not downloaded)" : ""}`;
}

function rawSourceLine(input: S01Input): string {
	if (input.rawSource !== null && input.rawSource.trim() !== "") return `- **Raw Source**: ${wikilink(input.rawSource)}`;
	if (input.rawNotes.length === 1) return `- **Raw Source**: ${wikilink(input.rawNotes[0].basename)}`;
	return `- **Raw Source**: ${RAW_SOURCE_PLACEHOLDER}`;
}

/**
 * The hub `## S01 Citation` bullets in fixed order: Full citation, citekey, DOI, Zotero, PDF (only present/missing-file,
 * always the attachment key), Raw Source (`--raw-source`, else exactly one raw note, else the template placeholder).
 */
export function s01Lines(input: S01Input): S01Block {
	const fm = input.frontmatter;
	const fullCitation = input.bibliography && input.bibliography.trim() ? singleLine(input.bibliography) : null;
	const lines = [
		`- **Full citation**: ${fullCitation ?? FULL_CITATION_PLACEHOLDER}`,
		citekeyLine(fm, input.citekeyCurrent),
		`- **DOI**: ${fm.doi || "none"}`,
		`- **Zotero**: ${zoteroLine(fm, input)}`,
	];
	const pdf = pdfLine(input.pdf);
	if (pdf !== null) lines.push(pdf);
	lines.push(rawSourceLine(input));
	return { fullCitation, lines, markdown: lines.join("\n") };
}

export interface CalloutExtra {
	/** Index citekey of the resolved item; named in the pin-pending callout. */
	citekeyCurrent?: string | null;
	candidateCount?: number;
	unavailableReason?: string;
}

/**
 * Hub status callout: the paper-ingest `Provisional citekey` warning (byte-exact) for not-found, a `Zotero unavailable`
 * warning, a `Zotero ambiguous` warning, `Citekey pin pending` info for resolved-unpinned, null for resolved-pinned.
 */
export function callout(status: ResolutionStatus, citekey: string, checkedAt: string, pinInstruction: string | null, extra: CalloutExtra = {}): string | null {
	switch (status) {
		case "not-found":
			return [
				"> [!warning] Provisional citekey",
				`> \`${citekey}\` 는 로컬 생성 — Zotero 미등록. 등록 시 BBT 키를 이 값으로 **PIN**(고정), 노트/폴더 재명명 금지.`,
			].join("\n");
		case "unavailable":
			return [
				"> [!warning] Zotero unavailable",
				`> \`${citekey}\` 는 로컬 생성 — Zotero 확인 불가 (checked ${checkedAt}${extra.unavailableReason ? `; ${extra.unavailableReason}` : ""}). 연결 복구 후 \`identity\` 로 재확인. 등록 시 BBT 키를 이 값으로 **PIN**(고정), 노트/폴더 재명명 금지.`,
			].join("\n");
		case "ambiguous":
			return [
				"> [!warning] Zotero ambiguous",
				`> \`${citekey}\` — Zotero 후보 ${extra.candidateCount ?? "여러 "}건 (checked ${checkedAt}). \`identity\` ranked[] 에서 항목을 확인한 뒤 \`--item-key ITEMKEY --library ID\` 로 재조회. 확정 전 zoteroID 기록 금지, 노트/폴더 재명명 금지.`,
			].join("\n");
		case "resolved":
			if (pinInstruction === null) return null;
			return [
				"> [!info] Citekey pin pending",
				`> Zotero 등록됨 — BBT 키 \`${extra.citekeyCurrent ?? "unknown"}\` ≠ 볼트 citekey \`${citekey}\`. Zotero에서 **PIN**(고정), 노트/폴더 재명명 금지.`,
				`> ${pinInstruction}`,
			].join("\n");
	}
}
