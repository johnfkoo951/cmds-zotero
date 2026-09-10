import { DEFAULT_SETTINGS, type CmdsZoteroSettings } from "./types";

function integer(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function text(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value.trim() : fallback; }

export function normalizeSettings(raw: unknown): CmdsZoteroSettings {
	const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	return {
		bbtEndpoint: text(data.bbtEndpoint, DEFAULT_SETTINGS.bbtEndpoint),
		zoteroIndexPath: text(data.zoteroIndexPath, DEFAULT_SETTINGS.zoteroIndexPath),
		caywFormat: text(data.caywFormat, DEFAULT_SETTINGS.caywFormat),
		requestTimeoutMs: integer(data.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 1000, 180000),
		attachmentTimeoutMs: integer(data.attachmentTimeoutMs, DEFAULT_SETTINGS.attachmentTimeoutMs, 1000, 180000),
		concurrency: integer(data.concurrency, DEFAULT_SETTINGS.concurrency, 1, 8),
		indexMaxAgeMinutes: integer(data.indexMaxAgeMinutes, DEFAULT_SETTINGS.indexMaxAgeMinutes, 1, 10080),
		outputFolder: text(data.outputFolder, DEFAULT_SETTINGS.outputFolder),
		imageFolder: text(data.imageFolder, DEFAULT_SETTINGS.imageFolder),
		bibliographyStyle: text(data.bibliographyStyle, DEFAULT_SETTINGS.bibliographyStyle),
		peerVaults: Array.isArray(data.peerVaults) ? data.peerVaults.filter((v: unknown): v is {name:string;path:string} => {
			if (!v || typeof v !== "object") return false;
			const peer = v as Record<string, unknown>;
			return typeof peer.name === "string" && !!peer.name.trim() && typeof peer.path === "string" && !!peer.path.trim();
		}).map(peer => ({ name: peer.name.trim(), path: peer.path.trim() })) : [],
	};
}

export function validateEndpoint(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.hash || url.search) {
		throw new Error("Use a local HTTP endpoint without credentials, query parameters or fragments.");
	}
	return url.toString().replace(/\/$/, "");
}
