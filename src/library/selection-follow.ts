/**
 * Following Zotero's library-pane selection by polling (0.6.1 follow-zotero-selection). Opt-in: off, on window focus,
 * or every few seconds while the annotations sidebar is visible. There is no listener and no push: Better BibTeX has
 * none, so each poll reads the selection once with a short timeout. An unchanged selection is not an event; a failed
 * read pauses polling for a minute. Pure: the clock and the read are injected; no `obsidian` import.
 */
import type { SelectedItem } from "./selection";
import { selectedId } from "./selection";

export const SELECTION_FOLLOW_MODES = ["off", "focus", "interval"] as const;
export type SelectionFollowMode = typeof SELECTION_FOLLOW_MODES[number];
/** One selection read may take this long before it counts as a failure. */
export const FOLLOW_TIMEOUT_MS = 1500;
/** A failed read pauses polling this long. */
export const FOLLOW_BACKOFF_MS = 60_000;
export const FOLLOW_SECONDS_MIN = 3;
export const FOLLOW_SECONDS_MAX = 30;

export interface FollowConfig { mode: SelectionFollowMode; intervalMs: number }

/** The polling settings in effect; anything unknown is off, and the interval is clamped to 3–30 s. */
export function followConfig(settings: { followZoteroSelection?: unknown; followZoteroSelectionSeconds?: unknown }): FollowConfig {
	const mode = (SELECTION_FOLLOW_MODES as readonly unknown[]).includes(settings.followZoteroSelection) ? settings.followZoteroSelection as SelectionFollowMode : "off";
	const raw = typeof settings.followZoteroSelectionSeconds === "number" && Number.isFinite(settings.followZoteroSelectionSeconds) ? settings.followZoteroSelectionSeconds : 10;
	return { mode, intervalMs: Math.min(FOLLOW_SECONDS_MAX, Math.max(FOLLOW_SECONDS_MIN, Math.round(raw))) * 1000 };
}

/** tick: the periodic check; focus: the Obsidian window gained focus. */
export type PollTrigger = "tick" | "focus";

export type PollOutcome =
	| { kind: "skipped"; reason: "off" | "hidden" | "busy" | "paused" | "not-due" }
	| { kind: "unchanged" }
	| { kind: "changed"; items: SelectedItem[] }
	| { kind: "failed"; error: unknown; resumeAt: number };

/** The selection as a comparable value: its item identities, order ignored. */
export function selectionSignature(items: readonly Pick<SelectedItem, "libraryID" | "itemKey">[]): string {
	return items.map(selectedId).sort().join(" ");
}

export class SelectionPoller {
	private signature: string | null = null;
	private lastPollAt = Number.NEGATIVE_INFINITY;
	private resumeAt = 0;
	private busy = false;

	constructor(private readonly now: () => number) {}

	/** Why a poll would be skipped now, or null when it would run. */
	skipReason(trigger: PollTrigger, config: FollowConfig, visible: boolean): Extract<PollOutcome, { kind: "skipped" }>["reason"] | null {
		if (config.mode === "off") return "off";
		if (!visible) return "hidden";
		if (this.busy) return "busy";
		if (this.now() < this.resumeAt) return "paused";
		if (trigger === "tick" && (config.mode !== "interval" || this.now() - this.lastPollAt < config.intervalMs)) return "not-due";
		return null;
	}

	/** Reads the selection once when due; reports a change only when the selection differs from the last one seen. */
	async poll(trigger: PollTrigger, config: FollowConfig, visible: boolean, read: () => Promise<SelectedItem[]>): Promise<PollOutcome> {
		const reason = this.skipReason(trigger, config, visible);
		if (reason) return { kind: "skipped", reason };
		this.busy = true;
		this.lastPollAt = this.now();
		try {
			const items = await read();
			const signature = selectionSignature(items);
			if (signature === this.signature) return { kind: "unchanged" };
			this.signature = signature;
			return { kind: "changed", items };
		} catch (error) {
			this.resumeAt = this.now() + FOLLOW_BACKOFF_MS;
			return { kind: "failed", error, resumeAt: this.resumeAt };
		} finally {
			this.busy = false;
		}
	}

	/** Records a selection read some other way (the Read selection button), so polling does not report it again. */
	remember(items: readonly Pick<SelectedItem, "libraryID" | "itemKey">[]): void { this.signature = selectionSignature(items); }

	/** Forgets the last selection (following was switched on again), so the next poll reports what is selected. */
	reset(): void { this.signature = null; }

	/** True while polling is paused after a failure. */
	paused(): boolean { return this.now() < this.resumeAt; }
}
