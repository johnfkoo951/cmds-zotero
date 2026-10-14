import test from "node:test";
import { ZoteroVersionError } from "../src/api/transport";
import assert from "node:assert/strict";
import { annotationsAction, validateActionRequest, AGENT_ACTIONS, ACTION_API_VERSION, type FreshSubject } from "../src/agent/actions";
import { annotationColorInfo, imageCopyPrefix, normalizeHex, parseAnnotationFilters, parseColorFilter, vaultImageCopies } from "../src/agent/annotations";
import { BbtTransportError } from "../src/api/transport";
import { IngestAPI, JOB_TIMEOUT_MS } from "../src/ingest-api";
import type { RecentRead } from "../src/recent/recent-reads";
import { annotation, entry, host, JONES, NOW, run, SMITH, SMITH_GROUP } from "./agent-fixtures";

// Synthetic records only.

const keys = (payload: Record<string, any>): string[] => payload.attachments.flatMap((attachment: any) => attachment.annotations.map((row: any) => row.key));

test("annotations is a contract-2 action the live host advertises", () => {
	assert.ok(AGENT_ACTIONS.includes("annotations"));
	assert.equal(ACTION_API_VERSION.annotations, 2);
	assert.ok(JOB_TIMEOUT_MS.annotations > 0);
	assert.ok(new IngestAPI(null as never, null as never, null as never, null as never, async () => {}).actions.includes("annotations"));
});

test("a snapshot answers from the saved index: attachments in order, annotations in reading order, every field", async () => {
	const result = await run("annotations", { citekey: "smith2020" });
	assert.equal(result.ok, true);
	assert.equal(result.action, "annotations");
	assert.equal(result.apiVersion, 2);
	assert.equal(result.status, "resolved");
	assert.equal(result.source, "snapshot");
	assert.equal(result.fresh, false);
	assert.equal(result.annotationsAsOf, result.generatedAt);
	assert.equal(result.item.id, "1:ABCD2345");
	assert.equal(result.item.citekey, "smith2020");
	assert.deepEqual(result.attachments.map((attachment: any) => attachment.key), ["PDFAAAA1", "PDFBBBB2"]);
	assert.deepEqual(keys(result), ["ANNO0002", "ANNO0003", "ANNO0001", "ANNO0004"], "reading order by sort index within an attachment");
	assert.deepEqual(result.attachments.map((attachment: any) => attachment.annotationCount), [3, 1]);
	const [image, note, highlight] = result.attachments[0].annotations;
	assert.deepEqual(highlight, {
		key: "ANNO0001", attachmentKey: "PDFAAAA1", type: "highlight", color: { name: "yellow", hex: "#ffd400" }, page: 3, pageLabel: "iii", text: "Alpha text", comment: "", tags: ["method"],
		uri: "zotero://open-pdf/library/items/PDFAAAA1?page=3&annotation=ANNO0001", sortIndex: "00002|000100|00100", dateModified: "2026-10-01 10:00:00",
	});
	assert.deepEqual(note.color, { name: "red", hex: "#ff6666" });
	assert.equal(note.comment, "check this claim");
	assert.deepEqual(image.image, { cachePath: "/zotero-cache/library/ANNO0002.png", private: true, vaultCopies: [] });
	assert.equal(highlight.image, undefined);
	assert.deepEqual(result.summary, { total: 4, matched: 4, attachments: 2, byType: { image: 1, note: 1, highlight: 1, underline: 1 }, byColor: { green: 1, red: 1, yellow: 1, blue: 1 } });
	assert.deepEqual(result.filters, {});
	assert.deepEqual(result.warnings, []);
});

test("an item key with its library selects the item; the same citekey in two libraries is ambiguous, never the first match", async () => {
	const byKey = await run("annotations", { itemKey: "ABCD2345", libraryID: 1 });
	assert.equal(byKey.status, "resolved");
	assert.equal(byKey.item.id, "1:ABCD2345");
	const both = { entries: [SMITH, SMITH_GROUP, JONES] };
	const ambiguous = await run("annotations", { citekey: "smith2020" }, both);
	assert.equal(ambiguous.ok, true);
	assert.equal(ambiguous.status, "ambiguous");
	assert.equal(ambiguous.attachments, undefined);
	assert.deepEqual(ambiguous.ranked.map((item: any) => item.id).sort(), ["1:ABCD2345", "2:GRPS2345"]);
	const scoped = await run("annotations", { citekey: "smith2020", libraryID: 2 }, both);
	assert.equal(scoped.status, "resolved");
	assert.equal(scoped.item.id, "2:GRPS2345");
	assert.deepEqual(scoped.attachments, [], "an item without annotations still answers resolved");
});

test("a former citekey resolves and says so; an unknown key is not-found and a stale index withholds that verdict", async () => {
	const former = await run("annotations", { citekey: "smithOld2020" });
	assert.equal(former.status, "resolved");
	assert.equal(former.matchedHistory, true);
	const missing = await run("annotations", { citekey: "nobody1999" });
	assert.equal(missing.ok, true);
	assert.equal(missing.status, "not-found");
	const stale = await run("annotations", { citekey: "nobody1999" }, { ageMinutes: 600 });
	assert.equal(stale.ok, false);
	assert.equal(stale.reason, "stale-index");
	assert.equal(stale.status, "unavailable");
	assert.equal(stale.indexAnswer, "not-found");
	const allowed = await run("annotations", { citekey: "nobody1999", allowStale: true }, { ageMinutes: 600 });
	assert.equal(allowed.ok, true);
	assert.equal(allowed.status, "not-found");
	const positive = await run("annotations", { citekey: "smith2020" }, { ageMinutes: 600 });
	assert.equal(positive.ok, true, "a positive match from a stale index is still a match");
	assert.match(positive.warnings[0], /600 minutes old; annotations made since then are missing/);
});

test("a missing or unusable index is a structured failure, not an empty answer", async () => {
	const unavailable = await run("annotations", { citekey: "smith2020" }, { extra: { indexView: null, indexFailure: { reason: "index-invalid", message: "Index file is present but invalid" } } });
	assert.equal(unavailable.ok, false);
	assert.equal(unavailable.reason, "index-invalid");
});

test("filters: color by name or hex, type, tag (case-insensitive), attachment, and they combine", async () => {
	const yellow = await run("annotations", { citekey: "smith2020", color: "yellow" });
	assert.deepEqual(keys(yellow), ["ANNO0001"]);
	assert.deepEqual(yellow.filters, { color: "yellow" });
	assert.deepEqual(keys(await run("annotations", { citekey: "smith2020", color: "#5FB236" })), ["ANNO0002"]);
	assert.deepEqual(keys(await run("annotations", { citekey: "smith2020", color: "ff6666" })), ["ANNO0003"]);
	assert.deepEqual(keys(await run("annotations", { citekey: "smith2020", type: "Underline" })), ["ANNO0004"]);
	assert.deepEqual(keys(await run("annotations", { citekey: "smith2020", tag: "todo" })), ["ANNO0003"]);
	assert.deepEqual(keys(await run("annotations", { citekey: "smith2020", tag: "method" })), ["ANNO0003", "ANNO0001"]);
	const supplement = await run("annotations", { citekey: "smith2020", attachment: "PDFBBBB2" });
	assert.deepEqual(keys(supplement), ["ANNO0004"]);
	assert.deepEqual(supplement.summary, { total: 4, matched: 1, attachments: 1, byType: { underline: 1 }, byColor: { blue: 1 } });
	assert.deepEqual(keys(await run("annotations", { citekey: "smith2020", tag: "method", type: "highlight", attachment: "PDFAAAA1" })), ["ANNO0001"]);
	const none = await run("annotations", { citekey: "smith2020", color: "purple" });
	assert.equal(none.ok, true);
	assert.deepEqual(none.attachments, []);
	assert.equal(none.summary.matched, 0);
});

test("a filter that names no such value is rejected with the allowed values; an unknown attachment key is invalid-request with the item's attachments", async () => {
	// runAction validates first; the live host and the offline core turn the throw into an invalid-request envelope.
	await assert.rejects(run("annotations", { citekey: "smith2020", color: "teal" }), /color must be one of yellow, red, green/);
	await assert.rejects(run("annotations", { citekey: "smith2020", type: "scribble" }), /highlight, underline, note, text, image, ink/);
	const attachment = await run("annotations", { citekey: "smith2020", attachment: "ZZZZZZZZ" });
	assert.equal(attachment.ok, false);
	assert.equal(attachment.reason, "invalid-request");
	assert.match(attachment.message, /not an attachment of @smith2020/);
	assert.deepEqual(attachment.attachments.map((item: any) => item.key), ["PDFAAAA1", "PDFBBBB2"], "the item's attachments are offered");
	// The action also guards itself for direct callers that skip validateActionRequest.
	const direct = await annotationsAction(host(), { citekey: "smith2020", color: "teal" });
	assert.equal(direct.reason, "invalid-request");
});

test("image annotations list their private cache path and the copies the import made in the vault", async () => {
	const folder = "References/Zotero/images";
	const files = { [folder]: [
		"user-1-PDFAAAA1-ANNO0002-" + "a".repeat(64) + ".png",
		"user-1-PDFAAAA1-ANNO0002-" + "b".repeat(64) + ".png",
		"user-1-PDFAAAA1-ANNO0099-" + "c".repeat(64) + ".png",
		"user-1-PDFAAAA1-ANNO0002-notahash.png",
		"user-1-PDFAAAA1-ANNO0002-" + "d".repeat(64) + ".txt",
	] };
	const result = await run("annotations", { citekey: "smith2020", type: "image" }, { files });
	assert.deepEqual(result.attachments[0].annotations[0].image, {
		cachePath: "/zotero-cache/library/ANNO0002.png", private: true,
		vaultCopies: [`${folder}/user-1-PDFAAAA1-ANNO0002-${"a".repeat(64)}.png`, `${folder}/user-1-PDFAAAA1-ANNO0002-${"b".repeat(64)}.png`],
	});
	const listing = await run("annotations", { citekey: "smith2020", type: "image" }, { files, settings: { imageFolder: "Assets/figs/" }, extra: { pdfCache: { list: async dir => { assert.equal(dir, "Assets/figs/"); throw new Error("Symbolic-link output paths are not allowed."); }, read: async () => null, statLocal: async () => null, fileHash: async () => null } } });
	assert.equal(listing.ok, true);
	assert.deepEqual(listing.attachments[0].annotations[0].image.vaultCopies, []);
	assert.match(listing.warnings[0], /image folder could not be listed \(Symbolic-link output paths are not allowed\.\)/);
	let listed = 0;
	await run("annotations", { citekey: "smith2020", type: "highlight" }, { extra: { pdfCache: { list: async () => { listed++; return []; }, read: async () => null, statLocal: async () => null, fileHash: async () => null } } });
	assert.equal(listed, 0, "the image folder is read only when an image annotation is listed");
});

test("fresh needs the live host; offline answers requires-obsidian and never the snapshot", async () => {
	const result = await run("annotations", { citekey: "smith2020", fresh: true }, { live: false });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "requires-obsidian");
	assert.equal(result.attachments, undefined);
	const today = await run("annotations", { today: true }, { live: false });
	assert.equal(today.reason, "requires-obsidian");
});

test("fresh reads the item from Zotero now: new annotations appear, the source says so, the saved index is not used", async () => {
	const updated = { ...SMITH, attachments: [{ ...SMITH.attachments[0], annotations: [...SMITH.attachments[0].annotations, annotation("ANNO0005", "PDFAAAA1", { page: 9, text: "Made a minute ago", sortIndex: "00008|000100|00100" })] }, SMITH.attachments[1]] };
	const seen: FreshSubject[] = [];
	const result = await run("annotations", { citekey: "smith2020", fresh: true, attachment: "PDFAAAA1" }, { extra: { freshEntry: async subject => { seen.push(subject); return { entry: updated, fresh: true }; } } });
	assert.equal(result.ok, true);
	assert.equal(result.source, "fresh");
	assert.equal(result.fresh, true);
	assert.equal(result.annotationsAsOf, NOW.toISOString());
	assert.deepEqual(keys(result), ["ANNO0002", "ANNO0003", "ANNO0001", "ANNO0005"]);
	assert.deepEqual(seen, [{ entry: SMITH }], "the saved entry is the identity the fresh read must reproduce");
	const snapshot = await run("annotations", { citekey: "smith2020" }, { extra: { freshEntry: async () => { throw new Error("must not be asked"); } } });
	assert.equal(snapshot.source, "snapshot", "without fresh the live hook is not used");
});

test("fresh with Zotero unreachable is refused with the typed fault; allowStale answers from the saved index and warns", async () => {
	const fault = new BbtTransportError("connection-refused", "http://127.0.0.1:23119/better-bibtex", "connect ECONNREFUSED");
	const extra = { freshEntry: async () => ({ entry: SMITH, fresh: false, error: fault }) };
	const refused = await run("annotations", { citekey: "smith2020", fresh: true }, { extra });
	assert.equal(refused.ok, false);
	assert.equal(refused.reason, "bbt-unreachable");
	assert.equal(refused.bbtError.reason, "connection-refused");
	assert.match(refused.message, /pass --allow-stale/);
	assert.equal(refused.attachments, undefined);
	const allowed = await run("annotations", { citekey: "smith2020", fresh: true, allowStale: true }, { extra });
	assert.equal(allowed.ok, true);
	assert.equal(allowed.source, "snapshot");
	assert.equal(allowed.fresh, false);
	assert.match(allowed.warnings[0], /Answered from the saved index .* annotations made since then are missing/);
	const plain = await run("annotations", { citekey: "smith2020", fresh: true }, { extra: { freshEntry: async () => ({ entry: SMITH, fresh: false, error: new Error("Better BibTeX did not export exactly one item") }) } });
	assert.equal(plain.reason, "invalid-request", "an untyped fault is not a BBT outage");
});

const read = (citekey: string, itemKey: string, readOn: string | null = "2026-10-13"): RecentRead => ({ itemKey, libraryType: "user", library: "My Library", citekey, title: `Title of ${citekey}`, year: "2020", authors: ["Smith, Alex"], readOn });

test("today on a Zotero older than 10 is zotero-too-old, as for recent", async () => {
	const result = await run("annotations", { today: true }, { extra: { readOnDay: async () => { throw new ZoteroVersionError("Zotero's reading history", 10, "7.0.11"); } } });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "zotero-too-old");
	assert.match(String(result.message), /needs Zotero 10 or later/);
});

test("today resolves only when exactly one paper was opened today: none is not-found, several are candidates", async () => {
	const days: string[] = [];
	const todayHost = (reads: RecentRead[]) => ({ extra: { readOnDay: async (day: string) => { days.push(day); return reads; } } });
	const none = await run("annotations", { today: true }, todayHost([]));
	assert.equal(none.ok, true);
	assert.equal(none.status, "not-found");
	assert.deepEqual(none.today, { day: "2026-10-13", reads: 0 });
	assert.deepEqual(days, ["2026-10-13"]);
	const several = await run("annotations", { today: true }, todayHost([read("smith2020", "ABCD2345"), read("jones2019", "JONE2345")]));
	assert.equal(several.ok, true);
	assert.equal(several.status, "ambiguous");
	assert.equal(several.attachments, undefined, "no annotations are returned for a guess");
	assert.deepEqual(several.candidates.map((item: any) => [item.citekey, item.id, item.inIndex]), [["smith2020", "1:ABCD2345", true], ["jones2019", "1:JONE2345", true]]);
	assert.match(several.message, /2 papers were opened today; pass --citekey/);
	const yesterday = await run("annotations", { today: true }, todayHost([read("smith2020", "ABCD2345", "2026-10-12"), read("jones2019", "JONE2345", null)]));
	assert.equal(yesterday.status, "not-found", "only papers dated today count");
	const one = await run("annotations", { today: true, color: "yellow" }, todayHost([read("smith2020", "ABCD2345")]));
	assert.equal(one.ok, true);
	assert.equal(one.status, "resolved");
	assert.deepEqual(one.today, { day: "2026-10-13", reads: 1 });
	assert.equal(one.item.citekey, "smith2020");
	assert.deepEqual(keys(one), ["ANNO0001"]);
});

test("today with a paper the saved index lacks needs fresh; with fresh it is read from Zotero by its reading-history row", async () => {
	const unknown = read("brandnew2026", "NEWW2345");
	const extra = (seen: FreshSubject[]) => ({ readOnDay: async () => [unknown], freshEntry: async (subject: FreshSubject) => { seen.push(subject); return { entry: entry({ itemKey: "NEWW2345", citekey: "brandnew2026", attachments: [{ key: "PDFNEWW1", openURI: "zotero://open-pdf/library/items/PDFNEWW1", path: null, title: "PDF", annotations: [annotation("ANNONEW1", "PDFNEWW1", { text: "Fresh from Zotero" })] }] }), fresh: true }; } });
	const stale = await run("annotations", { today: true }, { extra: extra([]) });
	assert.equal(stale.ok, false);
	assert.equal(stale.reason, "stale-index");
	assert.match(stale.message, /not in the saved index; pass --fresh/);
	assert.equal(stale.candidates[0].inIndex, false);
	const seen: FreshSubject[] = [];
	const fresh = await run("annotations", { today: true, fresh: true }, { extra: extra(seen) });
	assert.equal(fresh.ok, true);
	assert.equal(fresh.source, "fresh");
	assert.equal(fresh.item.citekey, "brandnew2026");
	assert.deepEqual(seen, [{ read: unknown }]);
	assert.equal(fresh.attachments[0].annotations[0].text, "Fresh from Zotero");
	const closed = await run("annotations", { today: true }, { extra: { readOnDay: async () => { throw new BbtTransportError("connection-refused", "http://127.0.0.1:23119/better-bibtex", "connect ECONNREFUSED"); } } });
	assert.equal(closed.reason, "bbt-unreachable");
	assert.equal(closed.bbtError.reason, "connection-refused");
});

test("request validation: one selector, bounded filter values, no unknown fields", () => {
	validateActionRequest("annotations", { citekey: "smith2020" });
	validateActionRequest("annotations", { itemKey: "ABCD2345", libraryID: 1, fresh: true, allowStale: true, color: "yellow", type: "image", tag: "x", attachment: "PDFAAAA1" });
	validateActionRequest("annotations", { today: true, fresh: true });
	assert.throws(() => validateActionRequest("annotations", {}), /exactly one selector/);
	assert.throws(() => validateActionRequest("annotations", { citekey: "a", itemKey: "ABCD2345", libraryID: 1 }), /exactly one selector/);
	assert.throws(() => validateActionRequest("annotations", { citekey: "a", today: true }), /exactly one selector/);
	assert.throws(() => validateActionRequest("annotations", { today: false }), /exactly one selector/);
	assert.throws(() => validateActionRequest("annotations", { itemKey: "ABCD2345" }), /libraryID/);
	assert.throws(() => validateActionRequest("annotations", { citekey: "a", fresh: "yes" }), /boolean/);
	assert.throws(() => validateActionRequest("annotations", { citekey: "a", color: "teal" }), /color must be one of/);
	assert.throws(() => validateActionRequest("annotations", { citekey: "a", type: "scribble" }), /type must be one of/);
	assert.throws(() => validateActionRequest("annotations", { citekey: "a", attachment: "short" }), /eight-character/);
	assert.throws(() => validateActionRequest("annotations", { citekey: "a", doi: "10.1/x" }), /Unsupported annotations request field: doi/);
	assert.throws(() => validateActionRequest("annotations", { citekey: "a", apply: true }), /Unsupported annotations request field: apply/);
});

test("filter parsing: colors by name or hex, a word is never a short hex", () => {
	assert.deepEqual(parseColorFilter("Yellow"), { kind: "name", name: "yellow" });
	assert.deepEqual(parseColorFilter("#FFD400"), { kind: "hex", hex: "#ffd400" });
	assert.deepEqual(parseColorFilter("ffd400"), { kind: "hex", hex: "#ffd400" });
	assert.deepEqual(parseColorFilter("#fd0"), { kind: "hex", hex: "#ffdd00" });
	assert.equal(parseColorFilter("fed"), null, "a bare three-digit word is not a color");
	assert.equal(parseColorFilter("teal"), null);
	assert.equal(normalizeHex("not a color"), null);
	assert.deepEqual(annotationColorInfo(""), { name: null, hex: null });
	assert.deepEqual(annotationColorInfo("#aaaaaa"), { name: "gray", hex: "#aaaaaa" });
	assert.deepEqual(parseAnnotationFilters({ tag: "  " }), { error: "tag must not be empty." });
	assert.deepEqual(parseAnnotationFilters({ type: " HIGHLIGHT ", tag: " x ", attachment: " PDFAAAA1 " }), { filters: { type: "highlight", tag: "x", attachment: "PDFAAAA1" } });
});

test("vault copy names follow the import's naming and library scope", () => {
	assert.equal(imageCopyPrefix({ libraryType: "user", libraryID: 1 }, "PDFAAAA1", "ANNO0002"), "user-1-PDFAAAA1-ANNO0002-");
	assert.equal(imageCopyPrefix({ libraryType: "group", libraryID: 2, groupID: 77 }, "PDFAAAA1", "ANNO0002"), "group-77-PDFAAAA1-ANNO0002-", "a group library is addressed by its group ID");
	assert.equal(imageCopyPrefix({ libraryType: "group", libraryID: 2 }, "PDFAAAA1", "ANNO0002"), null);
	const digest = "e".repeat(64);
	assert.deepEqual(vaultImageCopies({ libraryType: "group", libraryID: 2, groupID: 77 }, { key: "ANNO0002", attachmentKey: "PDFAAAA1" }, "Img/", [`group-77-PDFAAAA1-ANNO0002-${digest}.jpeg`, `user-77-PDFAAAA1-ANNO0002-${digest}.png`]), [`Img/group-77-PDFAAAA1-ANNO0002-${digest}.jpeg`]);
});
