import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkVaultDestination, readAnnotationImage, MAX_IMAGE_BYTES } from "../src/import/images";

test("image reader validates extension/signature/size and refuses symlinks", async () => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-image-test-")));
	try {
		const source = join(directory, "example.png");
		const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
		await fs.writeFile(source, bytes);
		assert.deepEqual(Buffer.from(await readAnnotationImage(source)), bytes);
		const link = join(directory, "linked.png");
		await fs.symlink(source, link);
		await assert.rejects(readAnnotationImage(link), /Symlinked/);
		await fs.writeFile(join(directory, "wrong.jpg"), bytes);
		await assert.rejects(readAnnotationImage(join(directory, "wrong.jpg")), /extension/);
		const large = await fs.open(join(directory, "large.png"), "w");
		await large.truncate(MAX_IMAGE_BYTES + 1);
		await large.close();
		await assert.rejects(readAnnotationImage(join(directory, "large.png")), /size/);
		await assert.rejects(readAnnotationImage("relative.png"), /absolute/);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("vault destination validation rejects traversal and parent symlinks", async () => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-path-test-")));
	try {
		await checkVaultDestination(directory, "References/images/example.png");
		await assert.rejects(checkVaultDestination(directory, "../outside.png"), /escapes/);
		await fs.mkdir(join(directory, "real"));
		await fs.symlink(join(directory, "real"), join(directory, "linked"));
		await assert.rejects(checkVaultDestination(directory, "linked/image.png"), /Symlinked/);
		await fs.writeFile(join(directory, "occupied"), "file");
		await assert.rejects(checkVaultDestination(directory, "occupied/image.png"));
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
