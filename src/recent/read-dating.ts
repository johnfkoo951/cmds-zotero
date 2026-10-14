/**
 * Dating recent reads by bisection (0.6 recent-reads-efficiency, OPT-19). Zotero compares `lastRead` per local calendar
 * day (`DATE(lastRead, 'unixepoch', 'localtime')`); a date-form `isAfter` value matches items with an attachment read
 * strictly after that day, and datetime values never match. "Read after day D" is monotone in D, so one search per
 * interval midpoint halves the interval of every item in it: one item in a 365-day window needs 9 searches instead of up
 * to 365 exact-day probes. Pure module: the search is injected and there is no `obsidian` import.
 */
import { mapBounded } from "../api/transport";
import { addDays, daysBetween } from "./recent-reads";

/** Parents whose attachment was last read strictly after `day` (a local `YYYY-MM-DD`; Zotero 10). */
export function afterTerms(day: string): unknown[] {
	addDays(day, 0);
	return [["resultLevel", "item"], ["lastRead", "isAfter", day]];
}

interface Interval { first: string; last: string; keys: string[] }

/** The day an interval is split at: items read after it go to the later half. */
function midpoint(interval: Interval): string { return addDays(interval.first, Math.floor(daysBetween(interval.last, interval.first) / 2)); }

/**
 * The latest local day within [`first`, `last`] on which each key's item was read, by bisection. `readAfter(day)` returns
 * the keys of items read strictly after `day`; keys it never returns end at `first`, keys it always returns at `last`.
 * Each round splits every open interval once (its searches run `concurrency` at a time), so a window of W days takes
 * ceil(log2 W) rounds and at most one search per open interval and round. Keys are de-duplicated; no key means no search.
 */
export async function dateByBisection(keys: readonly string[], first: string, last: string, readAfter: (day: string) => Promise<ReadonlySet<string>>, concurrency = 2): Promise<Map<string, string>> {
	if (daysBetween(last, first) < 0) throw new Error("The dating window ends before it starts");
	const dated = new Map<string, string>();
	let open: Interval[] = keys.length ? [{ first, last, keys: [...new Set(keys)] }] : [];
	while (open.length) {
		const splitting = open.filter(interval => {
			if (interval.first !== interval.last) return true;
			for (const key of interval.keys) dated.set(key, interval.last);
			return false;
		});
		const found = await mapBounded(splitting, concurrency, interval => readAfter(midpoint(interval)));
		open = splitting.flatMap((interval, index) => {
			const day = midpoint(interval);
			const later = interval.keys.filter(key => found[index].has(key));
			const earlier = interval.keys.filter(key => !found[index].has(key));
			return [
				...(later.length ? [{ first: addDays(day, 1), last: interval.last, keys: later }] : []),
				...(earlier.length ? [{ first: interval.first, last: day, keys: earlier }] : []),
			];
		});
	}
	return dated;
}
