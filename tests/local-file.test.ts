import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFileError, matchesMagic, readLocalFile } from "../src/local-file";

const PDF_MAGIC = ["255044462d"];
const pdfBytes = Buffer.from("%PDF-1.7\n%synthetic body\n%%EOF\n", "latin1");

async function withTemp(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-local-file-")));
	try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function code(promise: Promise<unknown>): Promise<string> {
	try { await promise; } catch (error) { return error instanceof LocalFileError ? error.code : `other:${String(error)}`; }
	return "resolved";
}

test("a regular file within limits is read whole with its mtime", async () => {
	await withTemp(async directory => {
		const source = join(directory, "paper.pdf");
		await fs.writeFile(source, pdfBytes);
		const stat = await fs.stat(source);
		const result = await readLocalFile(source, { maxBytes: 1024, magic: PDF_MAGIC, label: "PDF" });
		assert.deepEqual(Buffer.from(result.bytes), pdfBytes);
		assert.equal(result.mtimeMs, stat.mtimeMs);
		const byPredicate = await readLocalFile(source, { maxBytes: 1024, magic: head => head[0] === 0x25 && head[1] === 0x50 });
		assert.equal(byPredicate.bytes.length, pdfBytes.length);
	});
});

test("symlinked paths are refused even when the target is valid", async () => {
	await withTemp(async directory => {
		const source = join(directory, "paper.pdf");
		await fs.writeFile(source, pdfBytes);
		const link = join(directory, "linked.pdf");
		await fs.symlink(source, link);
		assert.equal(await code(readLocalFile(link, { maxBytes: 1024, magic: PDF_MAGIC })), "symlink");
		await assert.rejects(readLocalFile(link, { maxBytes: 1024, magic: PDF_MAGIC, label: "Annotation image" }), /Symlinked annotation image/);
		await fs.mkdir(join(directory, "real"));
		await fs.writeFile(join(directory, "real", "paper.pdf"), pdfBytes);
		await fs.symlink(join(directory, "real"), join(directory, "linkeddir"));
		assert.equal(await code(readLocalFile(join(directory, "linkeddir", "paper.pdf"), { maxBytes: 1024, magic: PDF_MAGIC })), "symlink");
	});
});

test("size bounds are enforced before the content is read", async () => {
	await withTemp(async directory => {
		const large = join(directory, "large.pdf");
		const handle = await fs.open(large, "w");
		await handle.write(pdfBytes);
		await handle.truncate(4096 + 1);
		await handle.close();
		assert.equal(await code(readLocalFile(large, { maxBytes: 4096, magic: PDF_MAGIC })), "too-large");
		await assert.rejects(readLocalFile(large, { maxBytes: 4096, magic: PDF_MAGIC, label: "PDF" }), /size 4097 exceeds the 4096 byte limit/);
		const tiny = join(directory, "tiny.pdf");
		await fs.writeFile(tiny, Buffer.from("%PDF"));
		assert.equal(await code(readLocalFile(tiny, { maxBytes: 4096, magic: PDF_MAGIC })), "too-small");
		assert.equal((await readLocalFile(tiny, { maxBytes: 4096, magic: ["25504446"], minBytes: 4 })).bytes.length, 4);
	});
});

test("magic bytes must match by hex prefix list or predicate", async () => {
	await withTemp(async directory => {
		const png = join(directory, "image.png");
		await fs.writeFile(png, Buffer.from("89504e470d0a1a0a00000000", "hex"));
		assert.equal(await code(readLocalFile(png, { maxBytes: 1024, magic: PDF_MAGIC })), "bad-magic");
		assert.equal(await code(readLocalFile(png, { maxBytes: 1024, magic: ["ffd8ff", "89504e470d0a1a0a"] })), "resolved");
		assert.equal(await code(readLocalFile(png, { maxBytes: 1024, magic: () => false })), "bad-magic");
		assert.equal(await code(readLocalFile(png, { maxBytes: 1024, magic: [] })), "bad-magic");
		await assert.rejects(readLocalFile(png, { maxBytes: 1024, magic: PDF_MAGIC, label: "PDF" }), /PDF content does not match/);
	});
	assert.equal(matchesMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), PDF_MAGIC), true);
	assert.equal(matchesMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), ["25504446-"]), false);
	assert.equal(matchesMagic(new Uint8Array([0x25, 0x50]), ["255044462D"]), false);
	assert.equal(matchesMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), ["255044462D"]), true);
});

test("path shape and file kind guards run before any read", async () => {
	await withTemp(async directory => {
		assert.equal(await code(readLocalFile("relative.pdf", { maxBytes: 1024, magic: PDF_MAGIC })), "not-absolute");
		await assert.rejects(readLocalFile("relative.pdf", { maxBytes: 1024, magic: PDF_MAGIC, label: "PDF" }), /PDF must have an absolute local path/);
		assert.equal(await code(readLocalFile(`${join(directory, "paper.pdf")}\0`, { maxBytes: 1024, magic: PDF_MAGIC })), "not-absolute");
		assert.equal(await code(readLocalFile(directory, { maxBytes: 1024, magic: PDF_MAGIC })), "not-regular-file");
		assert.equal(await code(readLocalFile(join(directory, "missing.pdf"), { maxBytes: 1024, magic: PDF_MAGIC })), `other:Error: ENOENT: no such file or directory, realpath '${join(directory, "missing.pdf")}'`);
	});
});
