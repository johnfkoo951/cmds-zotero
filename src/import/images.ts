import { constants, promises as fs } from "fs";
import { isAbsolute, resolve, relative, sep, dirname, extname } from "path";
import { createHash } from "crypto";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Only explicit API-supplied raster paths; no URL, directory scan, or symlink traversal. */
export async function readAnnotationImage(source: string): Promise<Uint8Array> {
	if (!isAbsolute(source) || source.includes("\0")) throw new Error("Annotation image must have an absolute local path");
	const absolute = resolve(source);
	if (await fs.realpath(absolute) !== absolute) throw new Error("Symlinked annotation image path refused");
	const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		const pathStat = await fs.lstat(absolute);
		if (await fs.realpath(absolute) !== absolute || pathStat.ino !== stat.ino || pathStat.dev !== stat.dev || pathStat.isSymbolicLink()) throw new Error("Annotation image path changed during open");
		if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || stat.size < 8) throw new Error("Invalid annotation image size or type");
		const bytes = new Uint8Array(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!read.bytesRead) throw new Error("Annotation image changed during read");
			offset += read.bytesRead;
		}
		const after = await handle.stat();
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Annotation image changed during read");
		const hex = Buffer.from(bytes.slice(0, 12)).toString("hex");
		const ext = extname(absolute).toLowerCase();
		const valid = ext === ".png" ? hex.startsWith("89504e470d0a1a0a") : [".jpg", ".jpeg"].includes(ext) ? hex.startsWith("ffd8ff") : ext === ".gif" ? hex.startsWith("474946383761") || hex.startsWith("474946383961") : ext === ".webp" && hex.startsWith("52494646") && hex.slice(16, 24) === "57454250";
		if (!valid) throw new Error("Annotation image content does not match extension");
		return bytes;
	} finally { await handle.close(); }
}

export async function checkVaultDestination(root: string, vaultPath: string): Promise<void> {
	const canonicalRoot = await fs.realpath(root);
	const target = resolve(canonicalRoot, vaultPath);
	const rel = relative(canonicalRoot, target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Destination escapes vault");
	let cursor = target;
	while (cursor !== canonicalRoot) {
		try {
			const stat = await fs.lstat(cursor);
			if (stat.isSymbolicLink()) throw new Error("Symlinked vault destination refused");
			if (cursor !== target && !stat.isDirectory()) throw new Error("Destination parent is not a folder");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		cursor = dirname(cursor);
	}
}
