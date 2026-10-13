/**
 * 0.6 OPT-03/OPT-23: the warm-up bookkeeping of the index controller, free of Obsidian so it is unit-testable: which flight
 * a warm-up joins, the retry backoff after a failed background refresh, the index generation whose failure was already
 * announced, and the startup deferral of a stale snapshot's collection. The clock is injected. Pure: never imports
 * `obsidian`.
 */

/** After a failed background refresh, UI warm-ups return immediately for this long instead of re-hitting BBT. */
export const WARM_BACKOFF_MS = 60_000;

/** After startup a stale snapshot keeps serving reads; its collection waits this long (a missing snapshot never waits). */
export const STARTUP_COLLECT_DELAY_MS = 30_000;

/** True when `outcome` is a BBT failure observed less than `windowMs` ago (the warm-up backoff window by default). */
export function failedRecently(outcome: { ok: boolean; at: Date } | null | undefined, now: number, windowMs = WARM_BACKOFF_MS): boolean {
	if (!outcome || outcome.ok) return false;
	const age = now - outcome.at.getTime();
	return age >= 0 && age < windowMs;
}

/**
 * Transport faults meaning Zotero is not answering at all: what a readiness probe would find again. An RPC error or an
 * unexpected answer for one item says nothing about the next request, so it never counts.
 */
const UNREACHABLE_REASONS: ReadonlySet<string> = new Set(["connection-refused", "timeout", "http-404"]);

/**
 * 0.6 OPT-13: true when `outcome` is a "Zotero is not answering" failure (connection refused, timed out, endpoint missing)
 * observed less than `windowMs` ago, so a sidebar can serve cached or fallback text without probing BBT again.
 */
export function unreachableRecently(outcome: { ok: boolean; at: Date; reason?: string } | null | undefined, now: number, windowMs = WARM_BACKOFF_MS): boolean {
	return failedRecently(outcome, now, windowMs) && outcome?.reason !== undefined && UNREACHABLE_REASONS.has(outcome.reason);
}

export class WarmState {
	private flight: { promise: Promise<void>; force: boolean } | null = null;
	private failedUntil = 0;
	/** Index generation (generatedAt, or "none") whose failure or staleness was already announced. */
	private announced: string | null = null;
	private deferredUntil = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/** True while an explicit (forced) warm-up is in flight. */
	forcedActive(): boolean { return this.flight?.force === true; }

	/** True while background warm-ups back off after a failed refresh. */
	backoffActive(): boolean { return this.now() < this.failedUntil; }

	/**
	 * Joins or starts a warm-up: a caller joins a flight that is at least as strict (any flight for a background warm-up, a
	 * forced flight for a forced one); a forced warm-up arriving during a background one runs after it. During the backoff a
	 * background warm-up resolves at once without starting anything.
	 */
	run(force: boolean, warm: (force: boolean) => Promise<void>): Promise<void> {
		const current = this.flight;
		if (current && (current.force || !force)) return current.promise;
		if (!force && this.backoffActive()) return Promise.resolve();
		const flight = { force, promise: Promise.resolve() };
		flight.promise = (current ? current.promise.catch(() => undefined) : Promise.resolve())
			.then(() => warm(force))
			.finally(() => { if (this.flight === flight) this.flight = null; });
		this.flight = flight;
		return flight.promise;
	}

	/** A background or forced refresh failed: background warm-ups back off for `WARM_BACKOFF_MS`. */
	failed(): void { this.failedUntil = this.now() + WARM_BACKOFF_MS; }

	/** True when a Notice about `generation` should be shown: once per generation, always for a forced warm-up. */
	announce(generation: string, force = false): boolean {
		if (!force && this.announced === generation) return false;
		this.announced = generation;
		return true;
	}

	/** Startup: a stale snapshot's collection waits `ms` (or until a forced refresh or `endDeferral()`). */
	deferCollection(ms = STARTUP_COLLECT_DELAY_MS): void { this.deferredUntil = this.now() + ms; }

	endDeferral(): void { this.deferredUntil = 0; }

	collectionDeferred(): boolean { return this.now() < this.deferredUntil; }

	/** A new configuration: no backoff, nothing announced, no joined flight, no deferral. */
	reset(): void {
		this.flight = null;
		this.failedUntil = 0;
		this.announced = null;
		this.deferredUntil = 0;
	}
}
