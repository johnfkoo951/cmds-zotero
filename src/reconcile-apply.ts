import { createHash } from "node:crypto";
import type { ZoteroIndex } from "./types";
import { parseNoteText } from "./frontmatter-read";
import type { YamlCodec } from "./agent/types";
import { HUB_WRITABLE_KEYS } from "./agent/types";
import { RAW_SOURCES_ROOT, reconcileNotes, type ReconcileNote, type ReconcileResult } from "./agent/reconcile-core";
import { patchFrontmatterBlock, type PatchChanges, type PatchKey } from "./agent/frontmatter-patch"; // 0.5 R8
import { isBbtTransportError } from "./api/transport";

export type { YamlCodec };
export interface WritableFile { path: string; basename: string }
export interface ReconcileWriteHost {
	read(path: string): Promise<string>;
	file(path: string): WritableFile | null;
	/**
	 * 0.5 R8: atomic read-modify-write of the whole note text (`app.vault.process`). `change` receives the current
	 * bytes and returns the bytes to write; a throw must abort without writing.
	 */
	process(file: WritableFile, change: (text: string) => string): Promise<void>;
	canWrite(): boolean;
	snapshot(): Promise<{ index: ZoteroIndex | null; indexValid: boolean; indexComplete: boolean; indexFresh: boolean; live: boolean; bbtReachable: boolean; legacyPluginEnabled: boolean | null; vault: string; pdfPaths: string[]; now: Date; expiresAt?: number }>;
	yaml: YamlCodec;
}

export interface ApplyNoteResult {
	path: string;
	status: "applied" | "unchanged" | "skipped" | "failed" | "integrity-failure";
	wrote: boolean | null;
	changedKeys: string[];
	/** 0.5 R8: which of `changedKeys` replaced an existing line and which were appended before the closing fence. */
	replacedKeys?: string[];
	appendedKeys?: string[];
	reason?: string;
	message?: string;
}
export interface ApplyResult { mode: "applied" | "partial" | "refused"; attempted: number; applied: number; unchanged: number; failed: number; integrityFailure: boolean; notes: ApplyNoteResult[]; refusedReason?: string; /** 0.5 R4: the snapshot error text behind an `index-invalid`/`bbt-unreachable` refusal. */ refusedMessage?: string; limitation: string }

type Snapshot = Awaited<ReturnType<ReconcileWriteHost["snapshot"]>>;
const LIMITATION = "The write replaces or appends only the allowed key lines and rechecks the source hash inside Obsidian's process callback, but the public API does not provide whole-file compare-and-swap against external editors; post-write verification detects but cannot atomically prevent every concurrent edit. wrote:null means verification could not establish the outcome.";
const queues = new Map<string, Promise<void>>();
const writable = (key: string): boolean => (HUB_WRITABLE_KEYS as readonly string[]).includes(key);
const material = (proposal: ReconcileNote["proposed"]): unknown => proposal ? Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== "zoteroCheckedAt")) : null;
const sourceHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** 0.5 R8: a refusal raised inside the write callback; the note is reported as skipped with `reason` when nothing was written. */
class ApplyRefusal extends Error {
	constructor(readonly reason: string, message: string) { super(message); this.name = "ApplyRefusal"; }
}

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
function refusal(reason: string, message?: string): ApplyResult { return { mode: "refused", attempted: 0, applied: 0, unchanged: 0, failed: 0, integrityFailure: false, notes: [], refusedReason: reason, ...(message ? { refusedMessage: message } : {}), limitation: LIMITATION }; }
const nonAllowed = (fm: Record<string, unknown>): unknown => Object.fromEntries(Object.entries(fm).filter(([key]) => !writable(key)));

/**
 * 0.5 R8: the patched text must parse back to the intended frontmatter before it is handed to the writer: every
 * non-allowed key and every allowed key outside the change set unchanged, every changed key at its proposed value.
 */
function verifyFrontmatter(text: string, yaml: YamlCodec, before: Record<string, unknown>, proposal: Record<string, unknown>, changedKeys: readonly string[]): string | null {
	const parsed = parseNoteText(text, value => yaml.parse(value));
	if (parsed.frontmatterParse !== "ok" || !parsed.frontmatter) return "the frontmatter no longer parses";
	const after = parsed.frontmatter;
	if (stable(nonAllowed(after)) !== stable(nonAllowed(before))) return "a key outside the allowed set changed";
	for (const key of HUB_WRITABLE_KEYS) {
		if (changedKeys.includes(key)) { if (!Object.is(after[key], proposal[key])) return `${key} did not take its proposed value`; }
		else if (!Object.is(after[key], before[key])) return `${key} changed although it was not part of the proposal`;
	}
	return null;
}

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
	/** Our write callback threw before returning the patched text, so `process` wrote nothing of ours. */
	let refusedInCallback = false;
	let before: string | null = null;
	let changedKeys: PatchKey[] = [];
	let replacedKeys: PatchKey[] = [];
	let appendedKeys: PatchKey[] = [];
	try {
		if (!host.canWrite()) return skip(planned.path, "changed-since-plan", "The plugin was unloaded or reconfigured before the write.");
		const file = host.file(planned.path);
		if (!file || file.path !== planned.path) return skip(planned.path, "changed-since-plan", "The hub no longer exists at its planned path.");
		before = await host.read(planned.path);
		const expectedHash = (planned as ReconcileNote & { sourceHash?: string }).sourceHash;
		if (!expectedHash || sourceHash(before) !== expectedHash) return skip(planned.path, "changed-since-plan");
		const frame = framing(before);
		const parsedNote = parseNoteText(before, text => host.yaml.parse(text));
		if (frame.yaml === null || parsedNote.frontmatterParse !== "ok" || !parsedNote.frontmatter) return skip(planned.path, "frontmatter-parse-error");
		const beforeFm = parsedNote.frontmatter;
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
		const patch: PatchChanges = {};
		for (const key of changedKeys) {
			const value = proposal[key];
			if (typeof value !== "string" && typeof value !== "boolean") return skip(planned.path, "frontmatter-not-patchable", `${key} proposes a value that is neither a string nor a boolean.`);
			patch[key] = value;
		}
		// The snapshot probe awaited I/O; do not apply over edits that occurred during it.
		if (await host.read(planned.path) !== before || host.file(planned.path) !== file) return skip(planned.path, "changed-since-plan");
		if (!host.canWrite()) return skip(planned.path, "changed-since-plan", "The plugin was unloaded or reconfigured before the write.");
		let callbackRan = false;
		invoked = true;
		await host.process(file, text => {
			try {
				if (!host.canWrite()) throw new Error("The plugin was unloaded or reconfigured during the write.");
				if (gateReason(gate)) throw new Error("Index evidence expired before the write callback.");
				if (sourceHash(text) !== expectedHash) throw new ApplyRefusal("changed-since-plan", "The note changed between the dry-run and the write callback.");
				const patched = patchFrontmatterBlock(text, patch);
				if (!patched.ok) throw new ApplyRefusal("frontmatter-not-patchable", `${patched.refuse}${patched.key ? ` (${patched.key})` : ""}: ${patched.message}`);
				const problem = verifyFrontmatter(patched.text, host.yaml, beforeFm, proposal, changedKeys);
				if (problem) throw new ApplyRefusal("frontmatter-not-patchable", `The patched frontmatter was not written: ${problem}.`);
				replacedKeys = patched.replaced;
				appendedKeys = patched.appended;
				callbackRan = true;
				return patched.text;
			} catch (error) {
				refusedInCallback = true;
				throw error;
			}
		});
		if (!callbackRan) throw new Error("The write callback did not run.");
		const after = await host.read(planned.path);
		const problem = verifyFrontmatter(after, host.yaml, beforeFm, proposal, changedKeys);
		const preserved = framing(after).body === frame.body;
		if (problem || !preserved) return { path: planned.path, status: "integrity-failure", wrote: after !== before, changedKeys, replacedKeys, appendedKeys, reason: "post-write-mismatch", message: `Post-write verification failed (${problem ?? "the body changed"}); no rollback was attempted.` };
		return { path: planned.path, status: "applied", wrote: true, changedKeys, replacedKeys, appendedKeys };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Frontmatter write failed.";
		if (!invoked) return { path: planned.path, status: "failed", wrote: false, changedKeys: [], reason: "write-error", message };
		// A throw from our own callback happened before `process` received any text to write: nothing was written on our
		// behalf. A file that differs now was changed by another editor (the very change a changed-since-plan refusal
		// reports), so it is a refusal or a failure with wrote:false, never an integrity failure. No rollback is attempted.
		if (refusedInCallback) return error instanceof ApplyRefusal ? skip(planned.path, error.reason, message) : { path: planned.path, status: "failed", wrote: false, changedKeys: [], reason: "write-error", message };
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
	// 0.5 R4 (F16): a snapshot that throws is unusable evidence, not a BBT outage, unless the error is a typed transport fault.
	try { gate = await host.snapshot(); }
	catch (error) { return refusal(isBbtTransportError(error) ? "bbt-unreachable" : "index-invalid", error instanceof Error ? error.message : String(error)); }
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
