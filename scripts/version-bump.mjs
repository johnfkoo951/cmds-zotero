#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Also supports npm's version lifecycle, where npm has already changed package.json.
export async function bumpVersion(root = ROOT, requested) {
  const names = ['package.json', 'package-lock.json', 'manifest.json', 'versions.json'];
  const original = await Promise.all(names.map(name => fs.readFile(path.join(root, name), 'utf8')));
  const [pkg, lock, manifest, versions] = original.map(text => JSON.parse(text));
  const version = requested ?? process.env.npm_package_version ?? pkg.version;
  if (!SEMVER.test(version)) throw new Error('Expected an exact stable semver, without v prefix.');
  if (pkg.name !== 'cmds-zotero' || manifest.id !== 'cmds-zotero') throw new Error('Project identity mismatch.');
  if (!SEMVER.test(manifest.minAppVersion)) throw new Error('Invalid minimum application version.');
  pkg.version = version;
  manifest.version = version;
  lock.version = version;
  if (!lock.packages?.['']) throw new Error('Expected a package-lock with a root packages entry.');
  lock.packages[''].version = version;
  versions[version] = manifest.minAppVersion;
  const updated = [pkg, lock, manifest, versions].map(value => JSON.stringify(value, null, 2) + '\n');
  // No git, tags, network, dependency resolution, or release side effects.
  const written = [];
  try {
    for (let index = 0; index < names.length; index++) {
      const file = path.join(root, names[index]);
      if (await fs.readFile(file, 'utf8') !== original[index]) throw new Error(`Concurrent change: ${names[index]}`);
      await fs.writeFile(file, updated[index]);
      written.push(index);
    }
  } catch (error) {
    for (const index of written.reverse()) {
      const file = path.join(root, names[index]);
      if (await fs.readFile(file, 'utf8') === updated[index]) await fs.writeFile(file, original[index]);
    }
    throw error;
  }
  return version;
}
async function cli() {
  try { console.log(`Version synchronized: ${await bumpVersion(ROOT, process.argv[2])}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli();
