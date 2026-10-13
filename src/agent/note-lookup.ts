import type { NoteRecord } from "./types";

/** The two listed paths a note request can name: the slash-trimmed path itself, and that path with `.md` appended. */
export function notePathCandidates(path: string): [string, string] {
	const clean = path.replace(/^\/+|\/+$/g, "");
	return [clean, `${clean}.md`];
}

/** 0.5 R13/F14: one note by vault-relative path, with or without its `.md` extension; shared by cites and locate. */
export function findNote(notes: NoteRecord[], path: string): NoteRecord | null {
	const [clean, withExtension] = notePathCandidates(path);
	return notes.find(note => note.path === clean || note.path === withExtension) ?? null;
}
