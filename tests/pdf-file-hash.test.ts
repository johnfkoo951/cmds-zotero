// 0.5 R13/F08 + F11: the shared guarded PDF hash used by the live host and the offline CLI, driven through the real reader.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { hashLocalPdf, MAX_LOCAL_PDF_BYTES } from "../src/pdf/file-hash";
import { LocalFileError } from "../src/local-file";

const roots: string[] = [];
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });
async function sandbox(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-hash-")));
	roots.push(root);
	return root;
}
const codeOf = (error: unknown): string => error instanceof LocalFileError ? error.code : String(error);

test("a vault PDF hashes to its SHA-256 and reports the absolute path it was read from", async () => {
	const root = await sandbox();
	const bytes = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
	await fs.writeFile(join(root, "paper.pdf"), bytes);
	const hashed = await hashLocalPdf(join(root, "paper.pdf"));
	assert.deepEqual(hashed, { sha256: createHash("sha256").update(bytes).digest("hex"), absolutePath: join(root, "paper.pdf") });
});

test("an oversized PDF throws too-large and a non-PDF throws bad-magic; both keep their LocalFileError code", async () => {
	const root = await sandbox();
	await fs.writeFile(join(root, "big.pdf"), "%PDF-1.4\n" + "x".repeat(64));
	await assert.rejects(hashLocalPdf(join(root, "big.pdf"), 32), error => codeOf(error) === "too-large");
	await fs.writeFile(join(root, "notes.pdf"), "Just text that pretends to be a PDF.\n");
	await assert.rejects(hashLocalPdf(join(root, "notes.pdf")), error => codeOf(error) === "bad-magic");
	// The real limit applies to a sparse file without materializing 64 MiB: the size check runs before any allocation.
	await fs.writeFile(join(root, "sparse.pdf"), "%PDF-1.7\n");
	await fs.truncate(join(root, "sparse.pdf"), MAX_LOCAL_PDF_BYTES + 1);
	await assert.rejects(hashLocalPdf(join(root, "sparse.pdf")), error => codeOf(error) === "too-large");
});

test("a missing file, a directory, a symlink and a too-small file all read as null (not inside the vault), never as a refusal", async () => {
	const root = await sandbox();
	assert.equal(await hashLocalPdf(join(root, "absent.pdf")), null);
	await fs.mkdir(join(root, "dir.pdf"));
	assert.equal(await hashLocalPdf(join(root, "dir.pdf")), null);
	await fs.writeFile(join(root, "real.pdf"), "%PDF-1.4\nbody\n");
	await fs.symlink(join(root, "real.pdf"), join(root, "link.pdf"));
	assert.equal(await hashLocalPdf(join(root, "link.pdf")), null, "a symlinked path is refused by the guarded reader");
	// The same file through a symlinked *directory* is null too, which is why the hosts realpath the vault base first (F11).
	await fs.mkdir(join(root, "vault"));
	await fs.writeFile(join(root, "vault", "p.pdf"), "%PDF-1.4\nbody\n");
	await fs.symlink(join(root, "vault"), join(root, "vault-link"));
	assert.equal(await hashLocalPdf(join(root, "vault-link", "p.pdf")), null);
	assert.ok(await hashLocalPdf(join(await fs.realpath(join(root, "vault-link")), "p.pdf")));
	await fs.writeFile(join(root, "tiny.pdf"), "%PDF");
	assert.equal(await hashLocalPdf(join(root, "tiny.pdf")), null);
});
