#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMVER } from './version-bump.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The release body is the CHANGELOG section of the tag: its dated "## <tag> — <date>" heading up to the next "## " heading.
export function changelogSection(changelog, tag) {
  if (!tag || !SEMVER.test(tag)) throw new Error('Release tag must be exact stable semver, without v prefix.');
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => line === `## ${tag}` || line.startsWith(`## ${tag} `));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${tag}" section.`);
  if (/unreleased/i.test(lines[start])) throw new Error(`CHANGELOG.md section "## ${tag}" is still marked unreleased; date it before tagging.`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines.slice(start + 1, next < 0 ? lines.length : next).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md section "## ${tag}" is empty.`);
  return body;
}
export async function releaseNotes(tag, root = ROOT) {
  return changelogSection(await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), tag);
}
async function cli() {
  try { process.stdout.write(`${await releaseNotes(process.argv[2] ?? process.env.GITHUB_REF_NAME)}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli();
