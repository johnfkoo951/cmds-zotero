/**
 * 0.5 R13/F08: the one guarded read-and-hash of a vault PDF shared by the live host (main.ts) and the offline CLI
 * (cli/core.ts), so both classify a present-but-refused file identically. Pure Node: never imports `obsidian`.
 */
import { createHash } from "node:crypto";
import { LocalFileError, readLocalFile } from "../local-file";

export const MAX_LOCAL_PDF_BYTES = 64 * 1024 * 1024;
export const PDF_MAGIC = ["255044462d"];

export interface LocalPdfHash {
	sha256: string;
	absolutePath: string;
}

/**
 * SHA-256 of a PDF at an absolute, already boundary-checked path. Returns null when the file is absent, not a regular
 * file, or reached through a symlink (the caller reports "not inside the vault"); throws the `LocalFileError` for a
 * file that is present but oversized (`too-large`) or not a PDF (`bad-magic`) so the failure reason can name it.
 */
export async function hashLocalPdf(absolutePath: string, maxBytes: number = MAX_LOCAL_PDF_BYTES): Promise<LocalPdfHash | null> {
	try {
		const bytes = (await readLocalFile(absolutePath, { maxBytes, minBytes: 5, magic: PDF_MAGIC, label: "PDF" })).bytes;
		return { sha256: createHash("sha256").update(bytes).digest("hex"), absolutePath };
	} catch (error) {
		if (error instanceof LocalFileError && (error.code === "too-large" || error.code === "bad-magic")) throw error;
		return null;
	}
}
