/**
 * Guarded read of one local file outside the vault (PDF attachments, annotation images).
 * Pure Node: never imports `obsidian`. Vocabulary §6: absolute path, no NUL, realpath === path,
 * O_NOFOLLOW, regular file, lstat inode/dev re-check, size bounds, magic bytes, post-read size + mtime re-check.
 */
import { constants, promises as fs } from "fs";
import { isAbsolute, resolve } from "path";

export type LocalFileErrorCode =
	| "not-absolute" | "symlink" | "changed-during-open" | "not-regular-file"
	| "too-small" | "too-large" | "bad-magic" | "changed-during-read";

export class LocalFileError extends Error {
	constructor(readonly code: LocalFileErrorCode, message: string) {
		super(message);
		this.name = "LocalFileError";
	}
}

/** Either lower-case hex prefixes (any one must match the head) or a predicate over the first 16 bytes. */
export type MagicSpec = string[] | ((head: Uint8Array) => boolean);

export interface LocalFileOptions {
	maxBytes: number;
	magic: MagicSpec;
	/** Defaults to 8 bytes (vocabulary §6). */
	minBytes?: number;
	/** Noun used in error messages, e.g. "PDF" or "Annotation image". Defaults to "File". */
	label?: string;
}

export interface LocalFile {
	bytes: Uint8Array;
	/** Modification time as observed before and after the read (both agree). */
	mtimeMs: number;
}

export const MAGIC_HEAD_BYTES = 16;
export const DEFAULT_MIN_BYTES = 8;

/** Compares the file head against the magic specification. */
export function matchesMagic(head: Uint8Array, magic: MagicSpec): boolean {
	if (typeof magic === "function") return magic(head);
	const hex = Buffer.from(head).toString("hex");
	return magic.some(prefix => prefix.length > 0 && hex.startsWith(prefix.toLowerCase()));
}

export async function readLocalFile(path: string, opts: LocalFileOptions): Promise<LocalFile> {
	const label = opts.label ?? "File";
	const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
	if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new LocalFileError("not-absolute", `${label} must have an absolute local path`);
	const absolute = resolve(path);
	if (await fs.realpath(absolute) !== absolute) throw new LocalFileError("symlink", `Symlinked ${label.toLowerCase()} path refused`);
	const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		const pathStat = await fs.lstat(absolute);
		if (await fs.realpath(absolute) !== absolute || pathStat.ino !== stat.ino || pathStat.dev !== stat.dev || pathStat.isSymbolicLink()) throw new LocalFileError("changed-during-open", `${label} path changed during open`);
		if (!stat.isFile()) throw new LocalFileError("not-regular-file", `${label} path is not a regular file`);
		if (stat.size < minBytes) throw new LocalFileError("too-small", `${label} size ${stat.size} is below the ${minBytes} byte minimum`);
		if (stat.size > opts.maxBytes) throw new LocalFileError("too-large", `${label} size ${stat.size} exceeds the ${opts.maxBytes} byte limit`);
		const bytes = new Uint8Array(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!read.bytesRead) throw new LocalFileError("changed-during-read", `${label} changed during read`);
			offset += read.bytesRead;
		}
		if (!matchesMagic(bytes.subarray(0, Math.min(MAGIC_HEAD_BYTES, bytes.length)), opts.magic)) throw new LocalFileError("bad-magic", `${label} content does not match the expected format`);
		const after = await handle.stat();
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new LocalFileError("changed-during-read", `${label} changed during read`);
		return { bytes, mtimeMs: stat.mtimeMs };
	} finally { await handle.close(); }
}
