/**
 * The status-bar menu (0.6.1 index-status-menu): which actions it lists, which are disabled, the status item's tooltip and
 * the "Copy status JSON" payload, all derived from host state the plugin already holds. Building any of them never
 * contacts Better BibTeX. Pure module: no `obsidian` import.
 */
import { formatStatus, type StatusView } from "../agent/connection";

export type StatusMenuAction = "test-connection" | "refresh-index" | "diagnose-setup" | "diagnose-links" | "open-references" | "open-annotations" | "open-settings" | "copy-status";

export interface StatusMenuItem {
	action: StatusMenuAction;
	title: string;
	icon: string;
	disabled: boolean;
	/** True for the first item of a new group (the menu draws a separator before it). */
	separator?: boolean;
}

export interface StatusMenuState {
	/** A refresh or collection (a background warm-up included) is in flight. */
	collecting: boolean;
	legacyPluginEnabled: boolean | null;
}

/** The menu's items in display order. Refresh is disabled while a collection runs or while the legacy plugin is enabled. */
export function statusMenuItems(state: StatusMenuState): StatusMenuItem[] {
	const refreshBlocked = state.collecting || state.legacyPluginEnabled === true;
	return [
		{ action: "test-connection", title: "Test Better BibTeX connection", icon: "plug", disabled: false },
		{ action: "refresh-index", title: state.collecting ? "Refreshing citekey index…" : "Refresh citekey index", icon: "refresh-cw", disabled: refreshBlocked },
		{ action: "diagnose-setup", title: "Diagnose setup…", icon: "stethoscope", disabled: false, separator: true },
		{ action: "diagnose-links", title: "Diagnose index and links", icon: "list-checks", disabled: false },
		{ action: "open-references", title: "Open references sidebar", icon: "book-marked", disabled: false, separator: true },
		{ action: "open-annotations", title: "Open annotations sidebar", icon: "highlighter", disabled: false },
		{ action: "open-settings", title: "Open settings", icon: "settings", disabled: false, separator: true },
		{ action: "copy-status", title: "Copy status JSON", icon: "copy", disabled: false },
	];
}

/**
 * The status item's tooltip: the full status line, then what needs attention (no index, stale, legacy plugin, failed
 * Better BibTeX call), then the click hint.
 */
export function statusTooltip(view: StatusView, maxAgeMinutes: number, now = new Date()): string {
	const lines = [formatStatus(view, now)];
	if (view.count === null) lines.push("No index is loaded yet. Refresh the citekey index.");
	else if (view.stale === true) lines.push(`The index is older than ${maxAgeMinutes} minutes. Refresh it to pick up changes in Zotero.`);
	if (view.legacyPluginEnabled === true) lines.push("Disable the legacy cmds-link-zotero plugin before refreshing.");
	if (view.bbt.state === "failed") lines.push("The last Better BibTeX call failed. Test the connection.");
	lines.push("Click for actions.");
	return lines.join("\n");
}

export interface StatusJsonInput {
	view: StatusView;
	pluginVersion: string;
	/** Vault-relative index path, as configured. */
	indexPath: string;
	generatedAt: string | null;
	complete: boolean | null;
	maxAgeMinutes: number;
	collecting: boolean;
	now: Date;
}

/** "Copy status JSON": the status line's facts as stable JSON (vault-relative paths only, no note or library content). */
export function statusJson(input: StatusJsonInput): string {
	const { view } = input;
	return JSON.stringify({
		plugin: { id: "cmds-zotero", version: input.pluginVersion },
		checkedAt: input.now.toISOString(),
		index: { path: input.indexPath, count: view.count, generatedAt: input.generatedAt, ageMinutes: view.ageMinutes, stale: view.stale, maxAgeMinutes: input.maxAgeMinutes, complete: input.complete, collecting: input.collecting },
		legacyPluginEnabled: view.legacyPluginEnabled,
		bbt: view.bbt,
		status: formatStatus(view, input.now),
	}, null, 2);
}
