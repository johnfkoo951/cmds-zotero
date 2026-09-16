import { createHash } from "node:crypto";
import type { ZoteroIndex } from "./types";
import { parseNoteText } from "./frontmatter-read";
import { HUB_WRITABLE_KEYS } from "./agent/types";
import { RAW_SOURCES_ROOT, reconcileNotes, type ReconcileNote, type ReconcileResult } from "./agent/reconcile-core";

export interface YamlCodec { parse(text: string): unknown; stringify(value: unknown): string }
export interface WritableFile { path: string; basename: string }
export interface ReconcileWriteHost {
	read(path: string): Promise<string>;
	file(path: string): WritableFile | null;
	processFrontMatter(file: WritableFile, change: (frontmatter: Record<string, unknown>) => void): Promise<void>;
	canWrite(): boolean;
	snapshot(): Promise<{ index: ZoteroIndex | null; indexValid: boolean; indexComplete: boolean; indexFresh: boolean; live: boolean; bbtReachable: boolean; legacyPluginEnabled: boolean | null; vault: string; pdfPaths: string[]; now: Date; expiresAt?: number }>;
	yaml: YamlCodec;
}

export interface ApplyNoteResult { path: string; status: "applied" | "unchanged" | "skipped" | "failed" | "integrity-failure"; wrote: boolean | null; changedKeys: string[]; reason?: string; message?: string }
export interface ApplyResult { mode: "applied" | "partial" | "refused"; attempted: number; applied: number; unchanged: number; failed: number; integrityFailure: boolean; notes: ApplyNoteResult[]; refusedReason?: string; limitation: string }

type Snapshot = Awaited<ReturnType<ReconcileWriteHost["snapshot"]>>;
const LIMITATION = "Obsidian processFrontMatter does not provide whole-file compare-and-swap; post-write verification detects but cannot atomically prevent every external body edit. wrote:null means verification could not establish the outcome.";
const queues = new Map<string, Promise<void>>();
const writable = (key: string): boolean => (HUB_WRITABLE_KEYS as readonly string[]).includes(key);
const material = (proposal: ReconcileNote["proposed"]): unknown => proposal ? Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== "zoteroCheckedAt")) : null;
const sourceHash = (text: string): string => createHash("sha256").update(text).digest("hex");

function framing(text: string): { yaml: string | null; body: string } {
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	return { yaml: match?.[1] ?? null, body: match ? source.slice(match[0].length) : source };
}
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
function gateReason(gate: Snapshot): string | null {
	if (gate.live !== true) return "requires-obsidian";
	if (!gate.index || gate.indexValid !== true) return "index-invalid";
	if (gate.indexComplete !== true) return "index-incomplete";
	if (gate.indexFresh !== true || (gate.expiresAt !== undefined && (!Number.isFinite(gate.expiresAt) || Date.now() >= gate.expiresAt))) return "stale-index";
	if (gate.bbtReachable !== true) return "bbt-unreachable";
	if (gate.legacyPluginEnabled !== false) return "legacy-plugin-enabled";
	return null;
}
function rawRoot(path: string): boolean { return path === RAW_SOURCES_ROOT || path.startsWith(`${RAW_SOURCES_ROOT}/`); }
function skip(path: string, reason: string, message?: string): ApplyNoteResult { return { path, status: "skipped", wrote: false, changedKeys: [], reason, ...(message ? { message } : {}) }; }
function refusal(reason: string): ApplyResult { return { mode: "refused", attempted: 0, applied: 0, unchanged: 0, failed: 0, integrityFailure: false, notes: [], refusedReason: reason, limitation: LIMITATION }; }

async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const prior = queues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const turn = new Promise<void>(resolve => { release = resolve; });
	const tail = prior.then(() => turn);
	queues.set(key, tail);
	await prior;
	try { return await operation(); }
	finally { release(); if (queues.get(key) === tail) queues.delete(key); }
}

async function applyNote(host: ReconcileWriteHost, planned: ReconcileNote, vault: string): Promise<ApplyNoteResult> {
	let invoked = false;
	let before: string | null = null;
	let changedKeys: (typeof HUB_WRITABLE_KEYS)[number][] = [];
	try {
		if (!host.canWrite()) return skip(planned.path, "changed-since-plan", "The plugin was unloaded or reconfigured before the write.");
		const file = host.file(planned.path);
		if (!file || file.path !== planned.path) return skip(planned.path, "changed-since-plan", "The hub no longer exists at its planned path.");
		before = await host.read(planned.path);
		const expectedHash = (planned as ReconcileNote & { sourceHash?: string }).sourceHash;
		if (!expectedHash || sourceHash(before) !== expectedHash) return skip(planned.path, "changed-since-plan");
		const frame = framing(before);
		if (frame.yaml === null) return skip(planned.path, "yaml-roundtrip-unsafe");
		const parsedNote = parseNoteText(before, text => host.yaml.parse(text));
		if (parsedNote.frontmatterParse !== "ok" || !parsedNote.frontmatter) return skip(planned.path, "frontmatter-parse-error");
		const beforeFm = parsedNote.frontmatter;
		// Remove only the serializer's final line terminator, not meaningful trailing whitespace.
		if (host.yaml.stringify(beforeFm).replace(/\n$/, "") !== frame.yaml) return skip(planned.path, "yaml-roundtrip-unsafe");
		if (beforeFm.type !== "paper-hub" || rawRoot(planned.path)) return skip(planned.path, "not-paper-hub");

		// Refresh the evidence after acquiring the queue and reading the current source, for EVERY file.
		const gate = await host.snapshot();
		const reason = gateReason(gate);
		if (reason || gate.vault !== vault) return skip(planned.path, reason ?? "changed-since-plan");
		const current = reconcileNotes([{ path: planned.path, basename: file.basename, frontmatter: beforeFm, frontmatterParse: "ok", body: before }], gate.index, { name: vault, pdfPaths: gate.pdfPaths }, { now: gate.now, stale: false, allowStale: false }).notes[0];
		if (!current?.proposalEligible || !current.proposed || stable(material(current.proposed)) !== stable(material(planned.proposed))) return skip(planned.path, "changed-since-plan");
		const proposal = current.proposed;
		changedKeys = HUB_WRITABLE_KEYS.filter(key => key in proposal && !Object.is(beforeFm[key], proposal[key]));
		if (!changedKeys.some(key => key !== "zoteroCheckedAt")) return { path: planned.path, status: "unchanged", wrote: false, changedKeys: [] };
		// The snapshot probe awaited I/O; do not apply over edits that occurred during it.
		if (await host.read(planned.path) !== before || host.file(planned.path) !== file) return skip(planned.path, "changed-since-plan");
		if (!host.canWrite()) return skip(planned.path, "changed-since-plan", "The plugin was unloaded or reconfigured before the write.");
		let callbackRan = false;
		invoked = true;
		await host.processFrontMatter(file, currentFm => {
			if (!host.canWrite()) throw new Error("The plugin was unloaded or reconfigured during the write.");
			if (gateReason(gate)) throw new Error("Index evidence expired before the frontmatter callback.");
			if (stable(currentFm) !== stable(beforeFm)) throw new Error("Frontmatter changed before apply.");
			for (const key of changedKeys) currentFm[key] = proposal[key];
			callbackRan = true;
		});
		if (!callbackRan) throw new Error("Frontmatter callback did not run.");
		const after = await host.read(planned.path);
		const parsedAfter = parseNoteText(after, text => host.yaml.parse(text));
		const fmAfter = parsedAfter.frontmatter ?? {};
		const nonAllowed = (fm: Record<string, unknown>): unknown => Object.fromEntries(Object.entries(fm).filter(([key]) => !writable(key)));
		const intended = changedKeys.every(key => Object.is(fmAfter[key], proposal[key]));
		const preserved = parsedAfter.frontmatterParse === "ok" && stable(nonAllowed(fmAfter)) === stable(nonAllowed(beforeFm)) && framing(after).body === frame.body;
		if (!intended || !preserved) return { path: planned.path, status: "integrity-failure", wrote: after !== before, changedKeys, reason: "post-write-mismatch", message: "Post-write verification failed; no rollback was attempted." };
		return { path: planned.path, status: "applied", wrote: true, changedKeys };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Frontmatter write failed.";
		if (!invoked) return { path: planned.path, status: "failed", wrote: false, changedKeys: [], reason: "write-error", message };
		try {
			const afterError = await host.read(planned.path);
			const changed = afterError !== before;
			return { path: planned.path, status: changed ? "integrity-failure" : "failed", wrote: changed ? null : false, changedKeys: changed ? changedKeys : [], reason: changed ? "post-write-mismatch" : "write-error", message };
		} catch {
			return { path: planned.path, status: "integrity-failure", wrote: null, changedKeys, reason: "verification-unavailable", message: `${message} The write outcome is unknown; do not resubmit automatically.` };
		}
	}
}

export async function applyReconcile(host: ReconcileWriteHost, plan: ReconcileResult): Promise<ApplyResult> {
	let gate: Snapshot;
	try { gate = await host.snapshot(); } catch { return refusal("bbt-unreachable"); }
	const reason = gateReason(gate);
	if (reason) return refusal(reason);
	const candidates = plan.notes.filter(note => note.type === "paper-hub" && note.proposalEligible && note.proposed && !rawRoot(note.path));
	const results: ApplyNoteResult[] = [];
	let stop = false;
	for (const planned of candidates) {
		if (stop) { results.push(skip(planned.path, "prior-integrity-failure")); continue; }
		const result = await serialized(`${gate.vault}:${planned.path}`, () => applyNote(host, planned, gate.vault));
		results.push(result);
		if (result.status === "integrity-failure") stop = true;
	}
	const applied = results.filter(item => item.status === "applied").length;
	const unchanged = results.filter(item => item.status === "unchanged").length;
	const failed = results.filter(item => item.status === "failed" || item.status === "integrity-failure").length;
	return { mode: failed || results.some(item => item.status === "skipped") ? "partial" : "applied", attempted: candidates.length, applied, unchanged, failed, integrityFailure: stop, notes: results, limitation: LIMITATION };
}
