import { rpc } from "../api/transport";
import { record } from "../identity";
import { validateEndpoint } from "../settings-data";
import type { BbtInfo } from "../agent/types";

/** Offline-mode probe: only `api.ready`, only against a validated local endpoint. No item RPCs run outside the plugin. */
export async function probeBbt(endpoint: string, timeoutMs = 5000): Promise<BbtInfo & { endpointError?: "endpoint-not-local" }> {
	let validated: string;
	try { validated = validateEndpoint(endpoint); } catch (error) { return { reachable: false, error: error instanceof Error ? error.message : "Invalid endpoint", endpointError: "endpoint-not-local" }; }
	try {
		const ready = await rpc(validated, "api.ready", [], timeoutMs);
		if (!record(ready) || typeof ready.zotero !== "string" || typeof ready.betterbibtex !== "string") return { reachable: false, error: "Invalid BBT readiness response" };
		return { reachable: true, zotero: ready.zotero, betterbibtex: ready.betterbibtex };
	} catch (error) {
		return { reachable: false, error: error instanceof Error ? error.message : "BBT unreachable" };
	}
}
