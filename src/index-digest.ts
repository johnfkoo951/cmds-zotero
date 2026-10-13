import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

/**
 * What index storage remembers of the last index text it read or wrote: the SHA-256 and byte size of its bytes on disk,
 * never the text itself. Equal digests stand for equal bytes; a size difference alone already proves a change.
 */
export interface IndexDigest { sha256: string; size: number }

/** Files are read and hashed in chunks of this size: bounded memory and no long synchronous block for any index size. */
const CHUNK_BYTES = 1 << 20;
const encoder = new TextEncoder();

async function openExisting(file: string): Promise<FileHandle | null> {
	try { return await open(file, "r"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Reads up to `length` bytes into the start of `buffer`; fewer only at the end of the file. */
async function readUpTo(handle: FileHandle, buffer: Uint8Array, length: number): Promise<number> {
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, null);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return filled;
}

/** Digest of a file, read in bounded chunks; null when the file does not exist. */
export async function digestFile(file: string): Promise<IndexDigest | null> {
	const handle = await openExisting(file);
	if (!handle) return null;
	try {
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		let size = 0;
		for (let read = await readUpTo(handle, chunk, CHUNK_BYTES); read > 0; read = await readUpTo(handle, chunk, CHUNK_BYTES)) {
			hash.update(chunk.subarray(0, read));
			size += read;
		}
		return { sha256: hash.digest("hex"), size };
	} finally { await handle.close(); }
}

/** A file's bytes and their digest, hashed chunk by chunk as they are read; null when the file does not exist. */
export async function readWithDigest(file: string): Promise<{ bytes: Buffer; digest: IndexDigest } | null> {
	const handle = await openExisting(file);
	if (!handle) return null;
	try {
		const hash = createHash("sha256");
		// One byte of headroom lets the final read report the end of a file that did not change since `stat`.
		let bytes = Buffer.allocUnsafe((await handle.stat()).size + 1);
		let size = 0;
		for (;;) {
			if (size === bytes.length) {
				const grown = Buffer.allocUnsafe(bytes.length * 2);
				bytes.copy(grown, 0, 0, size);
				bytes = grown;
			}
			const { bytesRead } = await handle.read(bytes, size, Math.min(CHUNK_BYTES, bytes.length - size), null);
			if (bytesRead === 0) break;
			hash.update(bytes.subarray(size, size + bytesRead));
			size += bytesRead;
		}
		return { bytes: bytes.subarray(0, size), digest: { sha256: hash.digest("hex"), size } };
	} finally { await handle.close(); }
}

/**
 * Digest of a file whose bytes must be exactly `text` in UTF-8, as a write of `text` produces them. The file is compared
 * with the encoded text and hashed chunk by chunk in one pass; null when it differs or does not exist.
 */
export async function digestIfText(file: string, text: string): Promise<IndexDigest | null> {
	const handle = await openExisting(file);
	if (!handle) return null;
	try {
		const hash = createHash("sha256");
		const expected = new Uint8Array(CHUNK_BYTES);
		const actual = Buffer.allocUnsafe(CHUNK_BYTES);
		let offset = 0;
		let size = 0;
		while (offset < text.length) {
			let end = Math.min(text.length, offset + CHUNK_BYTES);
			// A slice never ends between the halves of a surrogate pair: encoded alone, a half would become U+FFFD.
			const last = text.charCodeAt(end - 1);
			if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
			const { read, written } = encoder.encodeInto(text.slice(offset, end), expected);
			if (await readUpTo(handle, actual, written) !== written || !actual.subarray(0, written).equals(expected.subarray(0, written))) return null;
			hash.update(actual.subarray(0, written));
			size += written;
			offset += read;
		}
		if (await readUpTo(handle, actual, 1) !== 0) return null;
		return { sha256: hash.digest("hex"), size };
	} finally { await handle.close(); }
}

/** True when both digests describe the same bytes, or both stand for an absent file. */
export function sameDigest(left: IndexDigest | null, right: IndexDigest | null): boolean {
	if (left === null || right === null) return left === right;
	return left.size === right.size && left.sha256 === right.sha256;
}
