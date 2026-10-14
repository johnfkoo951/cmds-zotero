/**
 * Field codecs of the settings tab: how one control reads a value from the draft and how its input is checked and
 * written back. Pure (no `obsidian` import) so every rule is unit-tested; `normalizeSettings` still runs on save and
 * `saveSettings` keeps the authoritative endpoint and path checks.
 */
import type { CmdsZoteroSettings, PeerVault } from "../types";
import { normalizeTagList, validateEndpoint } from "../settings-data";
import { canonicalLocale, dataDirectoryProblem, localeProblem } from "../bibliography/rules";

export type SettingsDraft = CmdsZoteroSettings;
export type SettingKey = keyof CmdsZoteroSettings;
/** The inline message for a rejected input, or null when the draft took the value. */
export type Problem = string | null;

export interface Field<V extends string | boolean> {
	/** The stored key this control edits (tests check that every stored key has a control). */
	readonly key: SettingKey;
	read(draft: SettingsDraft): V;
	/** Writes the input into the draft and returns null; a rejected input leaves the draft as it was and returns the message. */
	write(draft: SettingsDraft, input: V): Problem;
}

/** Keys whose stored type is exactly `V` (a string union such as `citationTrigger` is not a free-text key). */
type KeysOf<V> = { [K in SettingKey]: [CmdsZoteroSettings[K]] extends [V] ? ([V] extends [CmdsZoteroSettings[K]] ? K : never) : never }[SettingKey];
/** Keys whose stored type is a string or a string union (dropdowns). */
type ChoiceKeys = { [K in SettingKey]: CmdsZoteroSettings[K] extends string ? K : never }[SettingKey];

/** A free-text value, trimmed; an empty value is saved as the default (normalizeSettings). */
export function textField(key: KeysOf<string>): Field<string> {
	return { key, read: draft => draft[key], write: (draft, input) => { draft[key] = input.trim(); return null; } };
}

/** The rules of `relativePath` (vault-storage), checked as the user types; empty means the default. */
export function vaultPathProblem(value: string): Problem {
	if (!value) return null;
	if (value.includes("\\") || value.includes("\0") || /^[a-z]+:/i.test(value) || value.startsWith("/")) return "Choose a vault-relative path.";
	if (value.split("/").some(part => part === ".." || part === "." || part === "")) return "Path traversal and empty path segments are not allowed.";
	return null;
}

/** A vault-relative path (index file or folder); empty means the default. */
export function vaultPathField(key: KeysOf<string>): Field<string> {
	return {
		key, read: draft => draft[key],
		write: (draft, input) => { const value = input.trim(); const problem = vaultPathProblem(value); if (problem) return problem; draft[key] = value; return null; },
	};
}

/** The Better BibTeX endpoint: a local HTTP URL without credentials, query or fragment (`validateEndpoint`). */
export const endpointField: Field<string> = {
	key: "bbtEndpoint", read: draft => draft.bbtEndpoint,
	write: (draft, input) => {
		const value = input.trim();
		try { draft.bbtEndpoint = validateEndpoint(value); return null; }
		catch (error) { return error instanceof TypeError || !(error instanceof Error) ? "Enter a URL such as http://127.0.0.1:23119/better-bibtex." : error.message; }
	},
};

/** A whole number within `min`–`max` (the same bounds normalizeSettings enforces). */
export function integerField(key: KeysOf<number>, min: number, max: number): Field<string> {
	return {
		key, read: draft => String(draft[key]),
		write: (draft, input) => {
			const value = input.trim();
			if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) return `Enter a whole number from ${min} to ${max}.`;
			draft[key] = Number(value);
			return null;
		},
	};
}

/** Seconds shown, milliseconds stored: `min`–`max` seconds, at most millisecond precision (as the 0.5 settings tab accepted). */
export function secondsField(key: KeysOf<number>, min: number, max: number): Field<string> {
	return {
		key, read: draft => String(draft[key] / 1000),
		write: (draft, input) => {
			const value = input.trim();
			// Rounded, not tested for an exact product: 16.1 * 1000 is 16100.000000000002 in floating point.
			const ms = /^\d+(?:\.\d{1,3})?$/.test(value) ? Math.round(Number(value) * 1000) : Number.NaN;
			if (!Number.isInteger(ms) || ms < min * 1000 || ms > max * 1000) return `Enter seconds from ${min} to ${max}.`;
			draft[key] = ms;
			return null;
		},
	};
}

/** One of a fixed set of values (dropdowns). */
export function choiceField<K extends ChoiceKeys>(key: K, allowed: readonly CmdsZoteroSettings[K][]): Field<string> {
	return {
		key, read: draft => draft[key],
		write: (draft, input) => { if (!(allowed as readonly string[]).includes(input)) return "Choose one of the listed values."; (draft as Record<K, string>)[key] = input; return null; },
	};
}

/** A whole number chosen from a dropdown (stored as a number). */
export function numberChoiceField(key: KeysOf<number>, min: number, max: number): Field<string> {
	const field = integerField(key, min, max);
	return { ...field, write: (draft, input) => field.write(draft, input) === null ? null : "Choose one of the listed values." };
}

/** 0.6.2: a BCP 47 locale for Better BibTeX bibliographies (`ko_kr` is written `ko-KR`); empty means the style's default. */
export const localeField: Field<string> = {
	key: "bibliographyLocale", read: draft => draft.bibliographyLocale,
	write: (draft, input) => { const value = canonicalLocale(input); const problem = localeProblem(value); if (problem) return problem; draft.bibliographyLocale = value; return null; },
};

/** 0.6.2: Zotero's data directory (absolute or `~/…`); empty means the default. */
export const dataDirectoryField: Field<string> = {
	key: "zoteroDataDirectory", read: draft => draft.zoteroDataDirectory,
	write: (draft, input) => { const value = input.trim(); const problem = dataDirectoryProblem(value); if (problem) return problem; draft.zoteroDataDirectory = value; return null; },
};

export function toggleField(key: KeysOf<boolean>): Field<boolean> {
	return { key, read: draft => draft[key], write: (draft, input) => { draft[key] = input; return null; } };
}

/** Lines of a text area: trimmed, empty lines dropped, duplicates removed (order kept). */
export function splitLines(input: string): string[] {
	return [...new Set(input.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}

/** One entry per line; an empty list is saved as the defaults (normalizeSettings). */
export function linesField(key: KeysOf<string[]>): Field<string> {
	return { key, read: draft => draft[key].join("\n"), write: (draft, input) => { draft[key] = splitLines(input); return null; } };
}

/** Zotero tags, one per line: the same normalisation as the stored setting (trimmed, lower-cased, deduplicated); empty excludes nothing. */
export function tagsField(key: KeysOf<string[]>): Field<string> {
	return { key, read: draft => draft[key].join("\n"), write: (draft, input) => { draft[key] = normalizeTagList(input.split(/\r?\n/)); return null; } };
}

/** `Vault name | absolute folder path` lines; a line without both parts is rejected with its line number. */
export function parsePeerVaults(input: string): { peers: PeerVault[] } | { problem: string } {
	const peers: PeerVault[] = [];
	const lines = input.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.trim()) continue;
		const separator = line.indexOf("|");
		const name = separator < 0 ? "" : line.slice(0, separator).trim();
		const path = separator < 0 ? line.trim() : line.slice(separator + 1).trim();
		if (!name || !path) return { problem: `Line ${index + 1} needs a vault name and an absolute folder path separated by |.` };
		peers.push({ name, path });
	}
	return { peers };
}

export const peerVaultsField: Field<string> = {
	key: "peerVaults", read: draft => draft.peerVaults.map(peer => `${peer.name} | ${peer.path}`).join("\n"),
	write: (draft, input) => { const parsed = parsePeerVaults(input); if ("problem" in parsed) return parsed.problem; draft.peerVaults = parsed.peers; return null; },
};

/** A deep copy of the stored settings that the tab edits until Save. */
export function draftOf(settings: CmdsZoteroSettings): SettingsDraft {
	return { ...settings, peerVaults: settings.peerVaults.map(peer => ({ ...peer })), excludedTags: [...settings.excludedTags], referencesHeadings: [...settings.referencesHeadings], synthesisLines: [...settings.synthesisLines] };
}
