import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const facade = `
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
export class App {}
export const normalizePath = value => value;
export class FileSystemAdapter {
 constructor(root) { this.root = root; this.removed = []; this.renameCalls = 0; }
 getBasePath() { return this.root; }
 async exists(path) { try { await fs.stat(join(this.root,path)); return true; } catch(error) { if(error.code === 'ENOENT') return false; throw error; } }
 async mkdir(path) { await fs.mkdir(join(this.root,path)); }
 async read(path) { return fs.readFile(join(this.root,path),'utf8'); }
 async write(path,content) { await fs.writeFile(join(this.root,path),content); if(this.afterWrite) await this.afterWrite(path,content); }
 async remove(path) { this.removed.push(path); await fs.unlink(join(this.root,path)); }
 async rename(from,to) { this.renameCalls++; if(await this.exists(to)) throw Error('Destination file already exists'); await fs.rename(join(this.root,from),join(this.root,to)); }
 async list(path) { const entries = await fs.readdir(join(this.root,path),{withFileTypes:true}); return { files: entries.filter(e=>e.isFile()).map(e=>path+'/'+e.name), folders: entries.filter(e=>e.isDirectory()).map(e=>path+'/'+e.name) }; }
}
`;

interface Adapter {
	getBasePath(): string;
	removed: string[];
	renameCalls: number;
	afterWrite?: (path: string, content: string) => Promise<void>;
}
interface Storage {
	read(): Promise<string | null>;
	writeValidated(content: string): Promise<void>;
}
interface StorageModule {
	FileSystemAdapter: new (root: string) => Adapter;
	VaultIndexStorage: new (app: { vault: { adapter: Adapter; configDir: string } }, path: string, canWrite?: () => boolean) => Storage;
	staleBackups: (names: string[], keep?: number, protect?: string) => string[];
	BACKUPS_KEPT: number;
}
const backupName = (epoch: number, suffix = "0") => `index-${epoch}-0000000${suffix}-0000-4000-8000-000000000000.json`;
const indexPath = "References/zotero-index.json";
const original = JSON.stringify({ schemaVersion: 2, entries: [{ id: "user:1:SYNTH001" }] });
const updated = JSON.stringify({ schemaVersion: 2, entries: [{ id: "user:1:SYNTH002" }] });
const external = JSON.stringify({ schemaVersion: 2, entries: [{ id: "user:1:EXTERNAL" }] });

async function fileTree(root: string, relative = ""): Promise<string[]> {
	const entries = await fs.readdir(join(root, relative), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...await fileTree(root, path));
		else files.push(path);
	}
	return files.sort();
}

test("VaultIndexStorage uses guarded filesystem replacement with a real temporary vault", async t => {
	const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cmds-zotero-storage-test-")));
	try {
		const output = join(directory, "storage.cjs");
		await build({
			stdin: { contents: 'export { VaultIndexStorage, staleBackups, BACKUPS_KEPT } from "./src/vault-storage"; export { FileSystemAdapter } from "obsidian";', resolveDir: process.cwd() },
			bundle: true, platform: "node", format: "cjs", outfile: output,
			plugins: [{ name: "synthetic-obsidian", setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" }));
				b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: facade, loader: "js" }));
			} }],
		});
		const module = createRequire(output)(output) as StorageModule;
		async function fixture(name: string, canWrite?: () => boolean) {
			const root = join(directory, name);
			await fs.mkdir(join(root, "References"), { recursive: true });
			await fs.writeFile(join(root, indexPath), original);
			const adapter = new module.FileSystemAdapter(root);
			const storage = new module.VaultIndexStorage({ vault: { adapter, configDir: ".obsidian" } }, indexPath, canWrite);
			assert.equal(await storage.read(), original);
			return { root, adapter, storage };
		}

		await t.test("existing destination is replaced without adapter rename/delete and has an exact backup", async () => {
			const { root, adapter, storage } = await fixture("replace");
			await storage.writeValidated(updated);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), updated);
			assert.equal(await storage.read(), updated);
			assert.equal(adapter.renameCalls, 0, "Obsidian rename rejects an existing destination");
			assert.equal(adapter.removed.includes(indexPath), false, "The existing index must not be removed before replacement");
			const files = await fileTree(root);
			assert.equal(files.some(path => path.endsWith(".tmp")), false);
			const backups = files.filter(path => path.startsWith(".cmds-zotero/backups/"));
			assert.equal(backups.length, 1);
			assert.equal(await fs.readFile(join(root, backups[0]!), "utf8"), original);
			// A second successful write proves the last successful snapshot was advanced.
			await storage.writeValidated(original);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), original);
		});

		await t.test("external edits since the last read survive without staging or replacement", async () => {
			const { root, adapter, storage } = await fixture("snapshot-conflict");
			await fs.writeFile(join(root, indexPath), external);
			await assert.rejects(storage.writeValidated(updated), /Index changed during refresh/);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), external);
			assert.deepEqual(await fileTree(root), [indexPath]);
			assert.deepEqual(adapter.removed, []);
			assert.equal(adapter.renameCalls, 0);
		});

		await t.test("an edit during staging is preserved and only the staged temporary file is cleaned", async () => {
			const { root, adapter, storage } = await fixture("staging-conflict");
			adapter.afterWrite = async path => {
				if (path.endsWith(".tmp")) await fs.writeFile(join(root, indexPath), external);
			};
			await assert.rejects(storage.writeValidated(updated), /Index changed during staging/);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), external);
			assert.equal((await fileTree(root)).some(path => path.endsWith(".tmp")), false);
			assert.deepEqual((await fileTree(root)).filter(path => path.startsWith(".cmds-zotero/backups/")), [], "a backup of the edited bytes is not kept: it would not be the index it claims to back up");
			assert.equal(adapter.removed.length, 1);
			assert.ok(adapter.removed.every(path => path.startsWith(`${indexPath}.`) && path.endsWith(".tmp")));
			assert.equal(adapter.renameCalls, 0);
		});

		await t.test("an index swapped for a symbolic link during staging is never copied into a backup", async () => {
			const { root, adapter, storage } = await fixture("symlink-swap");
			const outside = join(directory, "outside-secret.json");
			await fs.writeFile(outside, JSON.stringify({ secret: "OUTSIDE-THE-VAULT" }));
			adapter.afterWrite = async path => {
				if (!path.endsWith(".tmp")) return;
				await fs.unlink(join(root, indexPath));
				await fs.symlink(outside, join(root, indexPath));
			};
			await assert.rejects(storage.writeValidated(updated), /Symbolic-link|Index changed during staging/);
			for (const path of (await fileTree(root)).filter(file => file.startsWith(".cmds-zotero/backups/"))) {
				assert.doesNotMatch(await fs.readFile(join(root, path), "utf8"), /OUTSIDE-THE-VAULT/, path);
			}
			assert.equal((await fs.lstat(join(root, indexPath))).isSymbolicLink(), true, "the swapped path is left as found");
			assert.equal(await fs.readFile(outside, "utf8"), JSON.stringify({ secret: "OUTSIDE-THE-VAULT" }), "the outside file is untouched");
		});

		await t.test("the backup is checked against the replaced bytes: an index rewritten in place during staging cancels the refresh", async () => {
			const { root, adapter, storage } = await fixture("rewritten-in-place");
			adapter.afterWrite = async path => {
				if (path.endsWith(".tmp")) await fs.writeFile(join(root, indexPath), original.slice(0, 20));
			};
			await assert.rejects(storage.writeValidated(updated), /Index changed during staging/);
			assert.deepEqual((await fileTree(root)).filter(path => path.startsWith(".cmds-zotero/backups/")), []);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), original.slice(0, 20), "the external bytes are left as found");
		});

		await t.test("backups are pruned to the newest three plugin-owned files; foreign files are never deleted", async () => {
			assert.equal(module.BACKUPS_KEPT, 3);
			const { root, adapter, storage } = await fixture("prune");
			const backups = ".cmds-zotero/backups";
			await fs.mkdir(join(root, backups), { recursive: true });
			const own = [backupName(1000), backupName(2000), backupName(3000)];
			const foreign = ["notes.txt", "index-manual.json", "index-4000-not-a-uuid.json", "zotero-index.json"];
			for (const name of [...own, ...foreign]) await fs.writeFile(join(root, backups, name), name);
			await storage.writeValidated(updated);
			let names = (await fs.readdir(join(root, backups))).sort();
			const fresh = names.filter(name => !own.includes(name) && !foreign.includes(name));
			assert.equal(fresh.length, 1, "the new backup exists");
			assert.deepEqual(names, [...foreign, own[1], own[2], ...fresh].sort(), "only the oldest plugin-owned backup was pruned");
			assert.deepEqual(adapter.removed.filter(path => path.startsWith(backups)), [`${backups}/${own[0]}`]);
			assert.equal(await fs.readFile(join(root, backups, fresh[0]!), "utf8"), original);
			await storage.writeValidated(original);
			names = (await fs.readdir(join(root, backups))).sort();
			assert.equal(names.filter(name => !foreign.includes(name)).length, 3, "three plugin-owned backups remain after the second write");
			assert.ok(!names.includes(own[1]) && names.includes(own[2]) && names.includes(fresh[0]!), "the next oldest was pruned, newer ones kept");
			for (const name of foreign) assert.equal(await fs.readFile(join(root, backups, name), "utf8"), name, `${name} untouched`);
			assert.deepEqual(module.staleBackups([backupName(5), backupName(9), "x.json", backupName(7), backupName(1)], 3, backupName(1)), [backupName(5)], "protect keeps the current backup even when older");
			assert.deepEqual(module.staleBackups(["a.json", "b.json"]), []);
		});

		await t.test("canWrite=false preserves the existing index and cleans staging", async () => {
			const { root, adapter, storage } = await fixture("unloaded", () => false);
			await assert.rejects(storage.writeValidated(updated), /plugin was unloaded/);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), original);
			assert.equal((await fileTree(root)).some(path => path.endsWith(".tmp")), false);
			assert.deepEqual((await fileTree(root)).filter(path => path.startsWith(".cmds-zotero/backups/")), [], "unreferenced backup is removed when replacement does not complete");
			assert.equal(adapter.removed.includes(indexPath), false);
			assert.equal(adapter.renameCalls, 0);
		});

		await t.test("changes are compared by content digest: a same-size edit is caught, a same-bytes rewrite is not a change", async () => {
			assert.equal(Buffer.byteLength(external), Buffer.byteLength(original), "the external edit keeps the file size");
			const sized = await fixture("same-size");
			await fs.writeFile(join(sized.root, indexPath), external);
			await assert.rejects(sized.storage.writeValidated(updated), /Index changed during refresh/);
			assert.equal(await fs.readFile(join(sized.root, indexPath), "utf8"), external);
			assert.deepEqual(await fileTree(sized.root), [indexPath]);

			const touched = await fixture("same-bytes");
			await fs.writeFile(join(touched.root, indexPath), original);
			const later = new Date(Date.now() + 5000);
			await fs.utimes(join(touched.root, indexPath), later, later);
			await touched.storage.writeValidated(updated);
			assert.equal(await fs.readFile(join(touched.root, indexPath), "utf8"), updated, "an unchanged index with a new mtime is replaced");
		});

		await t.test("an index deleted during staging cancels the refresh and nothing is recreated", async () => {
			const { root, adapter, storage } = await fixture("deleted-during-staging");
			adapter.afterWrite = async path => {
				if (path.endsWith(".tmp")) await fs.unlink(join(root, indexPath));
			};
			await assert.rejects(storage.writeValidated(updated), /Index changed during staging/);
			assert.equal((await fileTree(root)).some(path => path === indexPath || path.endsWith(".tmp")), false);
			assert.equal(adapter.renameCalls, 0);
		});

		await t.test("a staged file that does not read back as written is refused before any backup", async () => {
			const { root, adapter, storage } = await fixture("staging-corrupt");
			adapter.afterWrite = async (path, content) => {
				if (path.endsWith(".tmp")) await fs.writeFile(join(root, path), content.replace("SYNTH002", "SYNTH00X"));
			};
			await assert.rejects(storage.writeValidated(updated), /Index staging verification failed/);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), original);
			assert.deepEqual(await fileTree(root), [indexPath], "no temporary file and no backup remain");
		});

		await t.test("the storage keeps a digest of the last text it read or wrote, never the text", async () => {
			const { storage } = await fixture("digest-only");
			const ownText = () => Object.entries(storage).filter(([, value]) => typeof value !== "function" && !(value && typeof value === "object" && "vault" in value)).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(" ");
			const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
			assert.doesNotMatch(ownText(), /SYNTH001/);
			assert.match(ownText(), new RegExp(sha256(original)));
			await storage.writeValidated(updated);
			assert.doesNotMatch(ownText(), /SYNTH00[12]/);
			assert.match(ownText(), new RegExp(`${sha256(updated)}.*"size":${Buffer.byteLength(updated)}`));
		});

		await t.test("a first index is written without a backup and the next write backs it up", async () => {
			const root = join(directory, "first-write");
			await fs.mkdir(join(root, "References"), { recursive: true });
			const adapter = new module.FileSystemAdapter(root);
			const storage = new module.VaultIndexStorage({ vault: { adapter, configDir: ".obsidian" } }, indexPath);
			assert.equal(await storage.read(), null);
			await storage.writeValidated(original);
			assert.deepEqual(await fileTree(root), [indexPath]);
			await fs.writeFile(join(root, indexPath), external);
			await assert.rejects(storage.writeValidated(updated), /Index changed during refresh/, "the digest of the first write is the new snapshot");
			await fs.writeFile(join(root, indexPath), original);
			await storage.writeValidated(updated);
			const backups = (await fileTree(root)).filter(path => path.startsWith(".cmds-zotero/backups/"));
			assert.equal(backups.length, 1);
			assert.equal(await fs.readFile(join(root, backups[0]!), "utf8"), original);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), updated);
		});
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
