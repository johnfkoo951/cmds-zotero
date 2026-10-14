/**
 * A local ring buffer of the most recent Better BibTeX call outcomes (0.6.1 doctor-report), kept in memory for the
 * setup report. Nothing is persisted or sent anywhere. Pure module: no `obsidian` import.
 */

export interface OutcomeRecord { ok: boolean; at: string; reason?: string; status?: number; message?: string }

/** How many outcomes the log keeps. */
export const OUTCOME_LOG_SIZE = 50;

export class OutcomeLog {
	private readonly records: OutcomeRecord[] = [];
	constructor(private readonly capacity = OUTCOME_LOG_SIZE) {}

	push(outcome: { ok: boolean; at: Date; reason?: string; status?: number; message?: string }): void {
		this.records.push({ ok: outcome.ok, at: outcome.at.toISOString(), ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.status !== undefined ? { status: outcome.status } : {}), ...(!outcome.ok && outcome.message ? { message: outcome.message } : {}) });
		if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
	}

	/** Oldest first. */
	entries(): OutcomeRecord[] { return this.records.map(record => ({ ...record })); }
}

export interface OutcomeSummary { total: number; ok: number; failed: number; reasons: Record<string, number> }

export function summarizeOutcomes(records: readonly OutcomeRecord[]): OutcomeSummary {
	const reasons: Record<string, number> = {};
	let ok = 0;
	for (const record of records) {
		if (record.ok) { ok++; continue; }
		const reason = record.reason ?? "unknown";
		reasons[reason] = (reasons[reason] ?? 0) + 1;
	}
	return { total: records.length, ok, failed: records.length - ok, reasons };
}
