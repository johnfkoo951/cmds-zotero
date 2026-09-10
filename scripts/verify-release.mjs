#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMVER } from './version-bump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function verifyRelease(tag, root = ROOT) {
  if (!tag || !SEMVER.test(tag)) throw new Error('Release tag must be exact stable semver, without v prefix.');
  const [manifest, pkg, lock, versions] = await Promise.all(['manifest.json', 'package.json', 'package-lock.json', 'versions.json'].map(async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))));
  if (manifest.id !== 'cmds-zotero' || pkg.name !== 'cmds-zotero' || manifest.isDesktopOnly !== true) throw new Error('Plugin identity mismatch.');
  if ([manifest.version, pkg.version, lock.version, lock.packages?.['']?.version].some(version => version !== tag)) throw new Error('Tag/manifest/package/lock versions differ.');
  if (!SEMVER.test(manifest.minAppVersion) || versions[tag] !== manifest.minAppVersion) throw new Error('versions.json compatibility entry differs.');
  if (/obsidian/i.test(manifest.description)) throw new Error('Manifest description must not contain the application name.');
  return tag;
}
async function cli() {
  try { console.log(`Verified release ${await verifyRelease(process.argv[2] ?? process.env.GITHUB_REF_NAME)}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli();
