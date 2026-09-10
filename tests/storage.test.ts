import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
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
}
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
			stdin: { contents: 'export { VaultIndexStorage } from "./src/vault-storage"; export { FileSystemAdapter } from "obsidian";', resolveDir: process.cwd() },
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
			assert.equal(adapter.removed.length, 1);
			assert.ok(adapter.removed.every(path => path.startsWith(`${indexPath}.`) && path.endsWith(".tmp")));
			assert.equal(adapter.renameCalls, 0);
		});

		await t.test("canWrite=false preserves the existing index and cleans staging", async () => {
			const { root, adapter, storage } = await fixture("unloaded", () => false);
			await assert.rejects(storage.writeValidated(updated), /plugin was unloaded/);
			assert.equal(await fs.readFile(join(root, indexPath), "utf8"), original);
			assert.equal((await fileTree(root)).some(path => path.endsWith(".tmp")), false);
			assert.equal(adapter.removed.includes(indexPath), false);
			assert.equal(adapter.renameCalls, 0);
		});
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
