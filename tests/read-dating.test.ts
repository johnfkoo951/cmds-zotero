import test from "node:test";
import assert from "node:assert/strict";
import { afterTerms, dateByBisection } from "../src/recent/read-dating";
import { addDays, daysBetween } from "../src/recent/recent-reads";

// 0.6 OPT-19: pure bisection over a reading window with an injected "read strictly after day D" search.
function history(readOn: Record<string, string>) {
	const searches: string[] = [];
	const readAfter = async (day: string): Promise<ReadonlySet<string>> => {
		searches.push(day);
		return new Set(Object.entries(readOn).filter(([, read]) => read > day).map(([key]) => key));
	};
	return { searches, readAfter };
}

test("dateByBisection finds each key's latest reading day anywhere in the window, edges included", async () => {
	const readOn = { first: "2026-01-01", last: "2026-12-31", middle: "2026-07-02", twin: "2026-07-02", next: "2026-07-03" };
	const { searches, readAfter } = history(readOn);
	const dated = await dateByBisection(Object.keys(readOn), "2026-01-01", "2026-12-31", readAfter);
	assert.deepEqual(Object.fromEntries(dated), readOn);
	// Five keys on four distinct days in a 365-day window: far below 365 exact-day probes.
	assert.ok(searches.length <= 4 * Math.ceil(Math.log2(365)), `${searches.length} searches`);
});

test("dateByBisection: no keys means no search; a one-day window needs none; keys are de-duplicated", async () => {
	const none = history({});
	assert.deepEqual([...await dateByBisection([], "2026-10-01", "2026-10-30", none.readAfter)], []);
	assert.equal(none.searches.length, 0);
	const oneDay = history({ a: "2026-10-12" });
	assert.deepEqual([...await dateByBisection(["a", "a"], "2026-10-12", "2026-10-12", oneDay.readAfter)], [["a", "2026-10-12"]]);
	assert.equal(oneDay.searches.length, 0);
});

test("dateByBisection places keys the search never returns at the first day and keys it always returns at the last", async () => {
	const dated = await dateByBisection(["never", "always"], "2026-10-01", "2026-10-30", async () => new Set(["always"]));
	assert.equal(dated.get("never"), "2026-10-01");
	assert.equal(dated.get("always"), "2026-10-30");
	await assert.rejects(dateByBisection(["a"], "2026-10-30", "2026-10-01", async () => new Set()), /ends before it starts/);
});

test("dateByBisection splits every open interval once per round, at most `concurrency` searches at a time", async () => {
	let inFlight = 0;
	let peak = 0;
	const readOn: Record<string, string> = {};
	for (let index = 0; index < 12; index++) readOn[`k${index}`] = addDays("2026-01-01", index * 30);
	const dated = await dateByBisection(Object.keys(readOn), "2026-01-01", "2026-12-31", async day => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise(resolve => setImmediate(resolve));
		inFlight--;
		return new Set(Object.entries(readOn).filter(([, read]) => read > day).map(([key]) => key));
	}, 3);
	assert.deepEqual(Object.fromEntries(dated), readOn);
	assert.ok(peak <= 3, `peak ${peak}`);
	assert.ok(daysBetween("2026-12-31", "2026-01-01") === 364);
});

test("afterTerms is the Zotero 10 item-level lastRead isAfter search and refuses a day that is not YYYY-MM-DD", () => {
	assert.deepEqual(afterTerms("2026-10-12"), [["resultLevel", "item"], ["lastRead", "isAfter", "2026-10-12"]]);
	assert.throws(() => afterTerms("12 October 2026"), /Invalid calendar day/);
});
