/**
 * Pure envelope builder for the agent surface: turns an injected host snapshot into `ConnectionInfo`, wraps any
 * action payload in the contract-2 `Envelope`, and derives the freshness gate and `info` warnings from it.
 * Live (Obsidian) and offline (fs) hosts both feed this; never import `obsidian` here.
 */
import type { BbtInfo, ConnectionInfo, Envelope, FailureReason, GitInfo, IndexInfo, PluginInfo } from "./types";
import { CACHE_DIR } from "./git-ignore";
import { formatIndexAge } from "../index-service";
import { bbtReasonLabel } from "../api/transport";

export interface HostIndexSnapshot {
	source: IndexInfo["source"];
	path: string;
	generatedAt: string | null;
	count: number | null;
	complete: boolean | null;
	schemaVersion: IndexInfo["schemaVersion"];
}

/** Everything environmental, gathered by the host before the pure builder runs. */
export interface HostSnapshot {
	mode: ConnectionInfo["mode"];
	obsidian: ConnectionInfo["obsidian"];
	obsidianError?: string;
	pluginVersion: string | null;
	/** Contract versions the plugin bundle answers; null when the plugin was not asked (offline without a manifest). */
	pluginApiVersions: number[] | null;
	/** null = unknown (no enabled-plugins listing available). */
	pluginEnabled: boolean | null;
	bbt: BbtInfo;
	index: HostIndexSnapshot;
	maxAgeMinutes: number;
	legacyPluginEnabled: boolean | null;
	git: GitInfo | null;
	now: Date;
}

export interface EnvelopeFailure { reason: FailureReason; message: string }

export const INFO_WARNINGS = ["index-in-git", "legacy-plugin-enabled", "index-stale"] as const;
export type InfoWarningCode = (typeof INFO_WARNINGS)[number];
export interface InfoWarning { code: InfoWarningCode; message: string }

/** Contract versions every 0.4 response advertises. */
export const CONTRACT_API_VERSIONS: readonly number[] = [1, 2];

/** Whole minutes since `generatedAt`; null when absent, unparsable or in the future (mirrors IndexService.ageMinutes). */
export function indexAgeMinutes(generatedAt: string | null, now: Date): number | null {
	if (generatedAt === null) return null;
	const age = now.getTime() - Date.parse(generatedAt);
	return Number.isFinite(age) && age >= 0 ? Math.floor(age / 60000) : null;
}

/** `off` beats everything; without an answered `apiVersions` list the bundle is `unknown`; contract 2 support decides `ok` vs `too-old`. */
export function pluginStatus(enabled: boolean | null, apiVersions: number[] | null): PluginInfo["status"] {
	if (enabled === false) return "off";
	if (apiVersions === null) return "unknown";
	return apiVersions.includes(2) ? "ok" : "too-old";
}

function compactBbt(bbt: BbtInfo): BbtInfo {
	return {
		reachable: bbt.reachable,
		...(bbt.zotero !== undefined ? { zotero: bbt.zotero } : {}),
		...(bbt.betterbibtex !== undefined ? { betterbibtex: bbt.betterbibtex } : {}),
		...(bbt.error !== undefined ? { error: bbt.error } : {}),
		...(bbt.reason !== undefined ? { reason: bbt.reason } : {}),
	};
}

function buildIndex(index: HostIndexSnapshot, maxAgeMinutes: number, now: Date): IndexInfo {
	const ageMinutes = indexAgeMinutes(index.generatedAt, now);
	return {
		source: index.source,
		path: index.path,
		schemaVersion: index.schemaVersion,
		generatedAt: index.generatedAt,
		ageMinutes,
		count: index.count,
		complete: index.complete,
		stale: ageMinutes === null ? null : ageMinutes > maxAgeMinutes,
		maxAgeMinutes,
	};
}

/** `ConnectionInfo` with keys in vocabulary order; `obsidianError` appears only when the host reported one. */
export function buildConnection(input: HostSnapshot): ConnectionInfo {
	return {
		mode: input.mode,
		obsidian: input.obsidian,
		...(input.obsidianError !== undefined ? { obsidianError: input.obsidianError } : {}),
		plugin: { status: pluginStatus(input.pluginEnabled, input.pluginApiVersions), version: input.pluginVersion, apiVersions: input.pluginApiVersions },
		bbt: compactBbt(input.bbt),
		index: buildIndex(input.index, input.maxAgeMinutes, input.now),
		legacyPluginEnabled: input.legacyPluginEnabled,
		git: input.git === null ? null : { ...input.git },
	};
}

/** The envelope every action returns; `reason`/`message` are present only on failure. */
export function buildEnvelope(action: string, vault: string, apiVersion: Envelope["apiVersion"], connection: ConnectionInfo, now: Date, failure?: EnvelopeFailure): Envelope {
	return {
		apiVersion,
		contract: 2,
		apiVersions: [...CONTRACT_API_VERSIONS],
		action,
		vault,
		ok: failure === undefined,
		...(failure !== undefined ? { reason: failure.reason, message: failure.message } : {}),
		checkedAt: now.toISOString(),
		connection,
	};
}

/** True when negative verdicts (not-found, dangling, unregistered) must be withheld: the index is stale and the caller did not opt in. */
export function staleGate(connection: ConnectionInfo, allowStale: boolean): boolean {
	return connection.index.complete !== true || connection.index.stale === null || (!allowStale && connection.index.stale === true);
}

function gitWarning(connection: ConnectionInfo): InfoWarning | null {
	const git = connection.git;
	if (git === null || !git.repo) return null;
	const exposed: string[] = [];
	if (git.indexIgnored === false || git.indexTracked === true) exposed.push(`index file "${connection.index.path}"`);
	if (git.cacheIgnored === false || git.cacheTracked === true) exposed.push(`cache directory "${CACHE_DIR}/"`);
	if (exposed.length === 0) return null;
	return { code: "index-in-git", message: `The vault is a git repository and tracking or ignore rules expose the ${exposed.join(" or the ")}; ignore and untrack sensitive files before committing (existing history is unchanged).` };
}

/** `info`/`diagnostics` warnings derived from the connection, in INFO_WARNINGS order. */
export function infoWarnings(connection: ConnectionInfo): InfoWarning[] {
	const warnings: InfoWarning[] = [];
	const git = gitWarning(connection);
	if (git !== null) warnings.push(git);
	if (connection.legacyPluginEnabled === true) {
		warnings.push({ code: "legacy-plugin-enabled", message: "The legacy plugin cmds-link-zotero is enabled; disable it before refreshing or applying changes with cmds-zotero." });
	}
	if (connection.index.stale === true) {
		warnings.push({ code: "index-stale", message: `The index is ${connection.index.ageMinutes ?? 0} minutes old (limit ${connection.index.maxAgeMinutes}); run refresh or pass --allow-stale.` });
	}
	return warnings;
}

// 0.5 R4: the one status line humans and agents share (status bar, sidebar headers, diagnostics report).
export interface StatusView {
	/** Entry count of the loaded index; null when no validated index is loaded. */
	count: number | null;
	ageMinutes: number | null;
	stale: boolean | null;
	legacyPluginEnabled: boolean | null;
	/** The last real BBT observation: `at` is an ISO timestamp, `reason` a transport reason for a failure. */
	bbt: { state: "ok" | "failed" | "untested"; at?: string; reason?: string; status?: number };
}

function clockLabel(iso: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return "unknown time";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function agoLabel(iso: string, now: Date): string {
	const minutes = indexAgeMinutes(iso, now);
	if (minutes === null) return `at ${clockLabel(iso)}`;
	return minutes < 1 ? "just now" : `${formatIndexAge(minutes)} ago`;
}

/**
 * `Zotero index: 450 · 27 h old · stale · legacy plugin on · BBT ok 3 min ago`; a failure names the clock time and
 * the short reason (`BBT failed 14:05 (connection refused)`); `BBT untested` before any real call.
 */
export function formatStatus(view: StatusView, now = new Date()): string {
	const parts: string[] = [`Zotero index: ${view.count === null ? "none" : view.count}`];
	if (view.count !== null) parts.push(`${formatIndexAge(view.ageMinutes)} old`);
	if (view.stale === true) parts.push("stale");
	if (view.legacyPluginEnabled === true) parts.push("legacy plugin on");
	const bbt = view.bbt;
	if (bbt.state === "ok") parts.push(`BBT ok${bbt.at ? ` ${agoLabel(bbt.at, now)}` : ""}`);
	else if (bbt.state === "failed") parts.push(`BBT failed${bbt.at ? ` ${clockLabel(bbt.at)}` : ""}${bbt.reason ? ` (${bbtReasonLabel(bbt.reason, bbt.status)})` : ""}`);
	else parts.push("BBT untested");
	return parts.join(" · ");
}
