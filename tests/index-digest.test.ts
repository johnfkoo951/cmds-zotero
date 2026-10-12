import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestFile, digestIfText, readWithDigest, sameDigest } from "../src/index-digest";

const digestOf = (bytes: Uint8Array) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength });
const mib = 1 << 20;
// Sizes around the 1 MiB chunk; multi-byte characters and surrogate pairs straddle chunk and slice boundaries, and a
// lone surrogate is written as U+FFFD the way a text write encodes it.
const texts = [
	"", "{}", "a".repeat(mib), "a".repeat(mib + 1), `${"a".repeat(mib - 1)}참고 문헌 🙂 ${"b".repeat(mib)}`, `${"a".repeat(mib - 1)}🙂${"c".repeat(10)}`,
	"🙂".repeat(mib), `${"x".repeat(3 * mib + 17)}\ud800 lone`, "참고 문헌 ".repeat(400000),
];

async function inTempDir(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(join(tmpdir(), "cmds-zotero-digest-test-"));
	try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("file digests and reads agree with the bytes a text write produces, across chunk boundaries", async () => {
	await inTempDir(async directory => {
		for (const [index, text] of texts.entries()) {
			const file = join(directory, `index-${index}.json`);
			await fs.writeFile(file, text);
			const bytes = await fs.readFile(file);
			const expected = digestOf(bytes);
			assert.deepEqual(await digestFile(file), expected, `digestFile ${index}`);
			const read = await readWithDigest(file);
			assert.ok(read && read.bytes.equals(bytes), `readWithDigest bytes ${index}`);
			assert.deepEqual(read.digest, expected, `readWithDigest digest ${index}`);
			assert.equal(read.bytes.toString("utf8"), bytes.toString("utf8"));
			assert.deepEqual(await digestIfText(file, text), expected, `digestIfText ${index}`);
		}
		const absent = join(directory, "absent.json");
		assert.equal(await digestFile(absent), null);
		assert.equal(await readWithDigest(absent), null);
		assert.equal(await digestIfText(absent, ""), null);
		await assert.rejects(digestFile(directory), "a directory is not an index file");
	});
});

test("a staged file that differs from the text in any byte, or in length, has no digest", async () => {
	await inTempDir(async directory => {
		const text = `${"a".repeat(mib - 2)}🙂${"b".repeat(mib)}참고`;
		const file = join(directory, "staged.json");
		const variants: [string, string | Buffer][] = [
			["first byte", `z${text.slice(1)}`],
			["inside a pair at the chunk boundary", text.replace("🙂", "😀")],
			["last byte", `${text.slice(0, -1)}X`],
			["one byte short", Buffer.from(text).subarray(0, Buffer.byteLength(text) - 1)],
			["one byte long", `${text} `],
			["empty", ""],
		];
		for (const [label, content] of variants) {
			await fs.writeFile(file, content);
			assert.equal(await digestIfText(file, text), null, label);
		}
		await fs.writeFile(file, text);
		assert.deepEqual(await digestIfText(file, text), digestOf(Buffer.from(text)));
		assert.equal(await digestIfText(file, `${text}x`), null, "a longer text than the file");
	});
});

test("digests are equal only for the same bytes; null stands for an absent file", () => {
	const a = digestOf(Buffer.from("{\"id\":\"SYNTH001\"}"));
	assert.ok(sameDigest(a, digestOf(Buffer.from("{\"id\":\"SYNTH001\"}"))));
	assert.ok(!sameDigest(a, digestOf(Buffer.from("{\"id\":\"SYNTH002\"}"))), "same size, different bytes");
	assert.ok(!sameDigest(a, { ...a, size: a.size + 1 }));
	assert.ok(sameDigest(null, null));
	assert.ok(!sameDigest(a, null) && !sameDigest(null, a));
});
