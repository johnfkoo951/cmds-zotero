/**
 * 0.6 batch-performance-progress: how a literature-note batch runs. Read-only work for upcoming notes (a fresh Zotero read,
 * a bibliography rendering) is kept running ahead while the writes happen strictly one at a time, and a cancel takes
 * effect before the next write, never during one. Pure: never imports `obsidian`.
 */
import type { Settled } from "../vault-scan";

export interface BatchOptions<T, P, R> {
	/** How many preparations may be in flight at once (1-8), the current item's included. */
	concurrency: number;
	/** Read-only work for one item; a throw reaches `apply` as a failed outcome. */
	prepare(item: T, index: number): Promise<P>;
	/** The write for one item: run one at a time in item order, and always to completion once started. */
	apply(item: T, prepared: Settled<P>, index: number): Promise<R>;
	/** Asked before each write (and again after waiting for that item's preparation): true stops the batch there. */
	cancelled(): boolean;
	/** The item became current; its preparation may still be running. */
	onItem?(item: T, index: number): void;
}

export interface BatchRun<T, R> {
	/** One result per written item, in item order. */
	results: R[];
	/** Items the batch did not reach because it was cancelled, in item order. */
	notRun: T[];
	cancelled: boolean;
}

function settle<P>(run: () => Promise<P>): Promise<Settled<P>> {
	try {
		return run().then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
	} catch (error) { return Promise.resolve({ ok: false, error }); }
}

/**
 * Runs `items` in order. Item i's preparation is started together with up to `concurrency - 1` of the following ones; its
 * write starts only after the previous write finished. A throwing `apply` ends the batch with that error (callers catch
 * per-item failures inside `apply`). Preparations still in flight when the batch ends are awaited and dropped, so no
 * read outlives the batch.
 */
export async function runBatch<T, P, R>(items: readonly T[], options: BatchOptions<T, P, R>): Promise<BatchRun<T, R>> {
	const { concurrency } = options;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Concurrency must be between 1 and 8");
	const prepared: Promise<Settled<P>>[] = [];
	const results: R[] = [];
	let next = 0;
	let cancelled = false;
	try {
		for (; next < items.length; next++) {
			if (options.cancelled()) { cancelled = true; break; }
			while (prepared.length < Math.min(items.length, next + concurrency)) {
				const at = prepared.length;
				prepared.push(settle(() => options.prepare(items[at], at)));
			}
			options.onItem?.(items[next], next);
			const outcome = await prepared[next];
			if (options.cancelled()) { cancelled = true; break; }
			results.push(await options.apply(items[next], outcome, next));
		}
	} finally {
		await Promise.all(prepared.slice(next));
	}
	return { results, notRun: items.slice(next), cancelled };
}

/** "Updating literature notes: 12 of 340 · 10 updated · 1 skipped"; counts of zero are left out. */
export function batchProgressText(label: string, done: number, total: number, counts: readonly (readonly [string, number])[] = []): string {
	return [`${label}: ${done} of ${total}`, ...counts.filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`)].join(" · ");
}
