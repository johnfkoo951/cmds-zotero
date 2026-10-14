/**
 * 0.6 OPT-02: which notes of the literature folder carry each `zoteroID`. A batch builds the map once from the notes' own
 * text (never the metadata cache, which Obsidian updates asynchronously), so N imports read the folder once instead of N
 * times. The host reports what changes afterwards — the batch's own writes with their text, vault events by path — and
 * the map reads exactly those notes again before its next answer. Pure: never imports `obsidian`; the host injects the
 * note listing, a guarded reader and the YAML parser.
 */
import { parseNoteText } from "../frontmatter-read";
import { safeVaultPath } from "../note-writer";
import { SCAN_CONCURRENCY, scanInOrder } from "../vault-scan";

/** Reads one vault note; null when no note exists at the path (any more). */
export type IdentityNoteReader = (path: string) => Promise<string | null>;

export interface IdentitySource {
	/** Vault-relative paths of every Markdown note, in vault order; only those below the folder are read. */
	list: () => readonly string[];
	/** A reader for one round of reads (the build, or the re-reads before an answer); it checks the vault boundary first. */
	reader: () => IdentityNoteReader;
	parseYaml: (yaml: string) => unknown;
}

/** The `zoteroID` string a note's frontmatter declares; null without frontmatter, for invalid YAML or any other value. */
export function noteZoteroID(text: string, parseYaml: (yaml: string) => unknown): string | null {
	const id = parseNoteText(text, parseYaml).frontmatter?.zoteroID;
	return typeof id === "string" ? id : null;
}

export class IdentityMap {
	private readonly idOf = new Map<string, string>();
	private readonly pathsOf = new Map<string, Set<string>>();
	/** Paths reported changed since the last answer. */
	private readonly changed = new Set<string>();
	/** A folder moved or disappeared: the listing itself is read again. */
	private relist = false;
	/**
	 * The first unreadable note of the last round. While it is set, every answer reads the whole folder again first and
	 * fails only if a note is still unreadable: the per-preview folder scan of 0.5 did the same, so a note that was
	 * briefly unreadable (removed by sync while still listed) fails one answer, not the rest of the batch.
	 */
	private failure: { error: unknown } | null = null;
	private round: Promise<void> | null = null;
	private readonly prefix: string;

	private constructor(readonly folder: string, private readonly source: IdentitySource, private readonly concurrency: number) {
		this.prefix = `${safeVaultPath(folder)}/`;
	}

	/**
	 * Reads every note below `folder` once, `concurrency` reads in flight, outcomes taken in listing order. The first note
	 * that cannot be read stops the build; later answers read the folder again and fail while a note stays unreadable.
	 */
	static async build(folder: string, source: IdentitySource, concurrency = SCAN_CONCURRENCY): Promise<IdentityMap> {
		const map = new IdentityMap(folder, source, concurrency);
		await map.scan(map.listed());
		return map;
	}

	/** True for paths below the folder: the only notes the map tracks. */
	covers(path: string): boolean { return path.startsWith(this.prefix); }

	/** Sorted paths of the folder's notes whose `zoteroID` is `identity`; notes reported changed are read again first. */
	async pathsFor(identity: string): Promise<string[]> {
		await this.catchUp();
		if (this.failure) throw this.failure.error;
		return [...(this.pathsOf.get(identity) ?? [])].sort();
	}

	/**
	 * The batch wrote `text` to `path` (an import apply): the note's identity comes from that text, without a read. A change
	 * reported for the path before or after the write still re-reads it.
	 */
	noteWritten(path: string, text: string): void {
		if (this.covers(path)) this.set(path, noteZoteroID(text, this.source.parseYaml));
	}

	/** A note changed, appeared or disappeared (a vault event): it is read again before the next answer. */
	noteChanged(path: string): void {
		if (this.covers(path)) this.changed.add(path);
	}

	/** A folder was renamed or deleted: the listing and every note below the folder are read again before the next answer. */
	foldersChanged(): void { this.relist = true; }

	private listed(): string[] { return this.source.list().filter(path => this.covers(path)); }

	/** Applies reported changes, one round at a time; a round that starts while another runs waits for it. */
	private async catchUp(): Promise<void> {
		while (this.round) await this.round;
		if (!this.failure && !this.relist && !this.changed.size) return;
		const round = this.relist || this.failure ? this.rebuild() : this.reread();
		this.round = round;
		try { await round; } finally { if (this.round === round) this.round = null; }
	}

	private async rebuild(): Promise<void> {
		this.relist = false;
		this.failure = null;
		this.changed.clear();
		this.idOf.clear();
		this.pathsOf.clear();
		await this.scan(this.listed());
	}

	private async reread(): Promise<void> {
		const paths = [...this.changed].sort();
		this.changed.clear();
		await this.scan(paths);
	}

	private async scan(paths: readonly string[]): Promise<void> {
		const read = this.source.reader();
		await scanInOrder(paths, this.concurrency, path => read(path), (path, outcome) => {
			if (!outcome) return true;
			if (!outcome.ok) { this.failure = { error: outcome.error }; return false; }
			this.set(path, outcome.value === null ? null : noteZoteroID(outcome.value, this.source.parseYaml));
			return true;
		});
	}

	private set(path: string, id: string | null): void {
		const before = this.idOf.get(path) ?? null;
		if (before === id) return;
		if (before !== null) {
			const paths = this.pathsOf.get(before);
			paths?.delete(path);
			if (paths && !paths.size) this.pathsOf.delete(before);
			this.idOf.delete(path);
		}
		if (id === null) return;
		this.idOf.set(path, id);
		const paths = this.pathsOf.get(id);
		if (paths) paths.add(path); else this.pathsOf.set(id, new Set([path]));
	}
}
