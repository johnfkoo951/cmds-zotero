#!/usr/bin/env node
// Installs the bundled Claude Code skill (skills/cmds-zotero) into ~/.claude/skills/cmds-zotero.
// Files are copied, never symlinked, and every `${CMDS_ZOTERO_ROOT}` placeholder is rewritten to this
// repository's absolute path so the public skill never carries a personal path.
//
//   node scripts/install-skill.mjs            install (refuses to overwrite a differing install)
//   node scripts/install-skill.mjs --force    overwrite a differing install
//   node scripts/install-skill.mjs --check    exit 0 when the install matches, 1 otherwise
//   node scripts/install-skill.mjs --target DIR
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = '${CMDS_ZOTERO_ROOT}';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'skills', 'cmds-zotero');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	process.stdout.write('Usage: node scripts/install-skill.mjs [--target DIR] [--check] [--force]\n');
	process.exit(0);
}
let target = join(homedir(), '.claude', 'skills', 'cmds-zotero');
let check = false;
let force = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--check') check = true;
	else if (args[i] === '--force') force = true;
	else if (args[i] === '--target' && args[i + 1]) target = resolve(args[++i]);
	else { process.stderr.write(`Unknown argument: ${args[i]}\n`); process.exit(2); }
}

async function walk(dir) {
	const out = [];
	for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isSymbolicLink()) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...await walk(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

const files = await walk(source).catch(() => null);
if (!files || !files.length) { process.stderr.write(`Skill source missing: ${source}\n`); process.exit(1); }

const rendered = new Map();
for (const file of files) {
	const rel = relative(source, file).split(sep).join('/');
	rendered.set(rel, (await fs.readFile(file, 'utf8')).split(PLACEHOLDER).join(repoRoot));
}

const differing = [];
const missing = [];
for (const [rel, content] of rendered) {
	try {
		if (await fs.readFile(join(target, rel), 'utf8') !== content) differing.push(rel);
	} catch { missing.push(rel); }
}

if (check) {
	const ok = !differing.length && !missing.length;
	process.stdout.write(JSON.stringify({ target, files: rendered.size, missing, differing, ok }) + '\n');
	process.exit(ok ? 0 : 1);
}
if (differing.length && !force) {
	process.stderr.write(`Installed skill differs in ${differing.length} file(s): ${differing.join(', ')}. Re-run with --force to overwrite.\n`);
	process.exit(1);
}
for (const [rel, content] of rendered) {
	const destination = join(target, rel);
	await fs.mkdir(dirname(destination), { recursive: true });
	await fs.writeFile(destination, content, 'utf8');
}
process.stdout.write(JSON.stringify({ target, files: rendered.size, written: [...rendered.keys()], overwritten: differing.length }) + '\n');
