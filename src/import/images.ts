import { promises as fs } from "fs";
import { isAbsolute, resolve, relative, sep, dirname, extname } from "path";
import { createHash } from "crypto";
import { LocalFileError, readLocalFile, type MagicSpec } from "../local-file";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const PNG = ["89504e470d0a1a0a"];
const JPEG = ["ffd8ff"];
const GIF = ["474946383761", "474946383961"];
const webp = (head: Uint8Array): boolean => { const hex = Buffer.from(head).toString("hex"); return hex.startsWith("52494646") && hex.slice(16, 24) === "57454250"; };
const IMAGE_MAGIC: Record<string, MagicSpec> = { ".png": PNG, ".jpg": JPEG, ".jpeg": JPEG, ".gif": GIF, ".webp": webp };

/** Only explicit API-supplied raster paths; no URL, directory scan, or symlink traversal (guards live in local-file.ts). */
export async function readAnnotationImage(source: string): Promise<Uint8Array> {
	const magic = IMAGE_MAGIC[extname(source).toLowerCase()] ?? (() => false);
	try {
		return (await readLocalFile(source, { maxBytes: MAX_IMAGE_BYTES, magic, label: "Annotation image" })).bytes;
	} catch (error) {
		if (error instanceof LocalFileError && error.code === "bad-magic") throw new Error("Annotation image content does not match extension");
		throw error;
	}
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
