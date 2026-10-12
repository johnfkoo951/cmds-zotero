/**
 * PERF-07: the mechanics shared by one vault scan in the live and offline readers. Pure Node: never imports `obsidian`,
 * so `tsx --test` and the offline CLI core load it.
 */
import { promises as fs, type Stats } from "node:fs";
import { join } from "node:path";

/** Note reads one scan keeps in flight. */
export const SCAN_CONCURRENCY = 8;

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function* each<T>(items: Iterable<T>): AsyncGenerator<T> { yield* items; }

function startSettled<T, R>(start: (item: T) => Promise<R> | null, item: T): Promise<Settled<R>> | null {
	let work: Promise<R> | null;
	try { work = start(item); } catch (error) { return Promise.resolve({ ok: false, error }); }
	return work ? work.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })) : null;
}

/**
 * Starts `start` for up to `concurrency` items ahead of the one being visited and hands every outcome to `visit` strictly
 * in source order, so `visit` sees exactly what a sequential loop would. `start` returns null for an item that needs no
 * work (its outcome is null). When `visit` returns false nothing new is started, the source is closed, and work already
 * in flight is awaited with its outcome discarded, so no read outlives the scan. A throw from `visit` or from the source
 * ends the scan the same way and propagates.
 */
export async function scanInOrder<T, R>(source: Iterable<T> | AsyncIterable<T>, concurrency: number, start: (item: T) => Promise<R> | null, visit: (item: T, outcome: Settled<R> | null) => boolean): Promise<void> {
	if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer");
	const iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : each(source);
	const queue: { item: T; outcome: Promise<Settled<R>> | null }[] = [];
	let inFlight = 0;
	let exhausted = false;
	try {
		for (;;) {
			while (!exhausted && inFlight < concurrency) {
				const next = await iterator.next();
				if (next.done) { exhausted = true; break; }
				const outcome = startSettled(start, next.value);
				if (outcome) inFlight++;
				queue.push({ item: next.value, outcome });
			}
			const head = queue.shift();
			if (!head) return;
			let outcome: Settled<R> | null = null;
			if (head.outcome) { outcome = await head.outcome; inFlight--; }
			if (!visit(head.item, outcome)) return;
		}
	} finally {
		await Promise.all(queue.flatMap(entry => entry.outcome ? [entry.outcome] : []));
		if (!exhausted) await iterator.return?.();
	}
}

export type Lstat = (path: string) => Promise<Stats>;

const lstatPath: Lstat = path => fs.lstat(path);

/** One scan's directory answers: each path is asked once and every later caller sees the same stats or the same error. */
export function memoizedLstat(lstat: Lstat = lstatPath): Lstat {
	const answers = new Map<string, Promise<Stats>>();
	return path => {
		let answer = answers.get(path);
		if (!answer) { answer = lstat(path); answers.set(path, answer); }
		return answer;
	};
}

export const SYMLINK_REFUSAL = "Symbolic-link output paths are not allowed.";

/**
 * The vault-boundary walk of every host: no segment of `rel` below `root` may be a symbolic link, and an absent segment
 * ends the walk (nothing below it exists yet). `lstatDir` answers the parent folders (a scan passes a memoized one);
 * `lstatLeaf` answers the final segment and is never shared, so every file keeps its own symlink refusal.
 */
export async function assertSegmentsInside(root: string, rel: string, lstatDir: Lstat = lstatPath, lstatLeaf: Lstat = lstatPath): Promise<void> {
	const segments = rel.split("/");
	let current = root;
	for (let index = 0; index < segments.length; index++) {
		current = join(current, segments[index]);
		const lstat = index < segments.length - 1 ? lstatDir : lstatLeaf;
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error(SYMLINK_REFUSAL);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}
