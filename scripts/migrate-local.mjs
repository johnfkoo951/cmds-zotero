#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = 'cmds-link-zotero';
const NEW = 'cmds-zotero';
const ASSETS = ['main.js', 'manifest.json', 'styles.css'];
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

async function read(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function digest(file) { const bytes = await read(file); return bytes === null ? null : hash(bytes); }

// Reject symlinks in every existing ancestor, including not-yet-created destinations.
async function safePath(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink refused: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}
async function tree(folder) {
  const result = {};
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink refused: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) result[path.relative(folder, file)] = await digest(file);
      else throw new Error(`Special file refused: ${file}`);
    }
  }
  await visit(folder);
  return result;
}
async function context(options) {
  if (!options.vault || !options.backup || !path.isAbsolute(options.vault) || !path.isAbsolute(options.backup)) {
    throw new Error('Provide --vault ABSOLUTE_PATH and --backup ABSOLUTE_PATH.');
  }
  const vault = await safePath(options.vault);
  const backup = await safePath(options.backup);
  const source = await safePath(options.source ?? ROOT);
  if (inside(vault, backup) || inside(ROOT, backup) || inside(source, backup) || inside(backup, vault) || inside(backup, source)) {
    throw new Error('Backup must be outside the vault and source/repository, with no overlapping ancestry.');
  }
  const config = path.join(vault, '.obsidian');
  if (!(await fs.stat(config)).isDirectory()) throw new Error('Vault must contain a .obsidian directory.');
  await safePath(config);
  const plugins = await safePath(path.join(config, 'plugins'));
  await safePath(path.join(plugins, OLD));
  await safePath(path.join(plugins, NEW));
  return { vault, backup, source, plugins, config };
}
async function inspect(ctx) {
  const manifest = JSON.parse((await read(path.join(ctx.source, 'manifest.json'))) ?? 'null');
  if (manifest?.id !== NEW || manifest.isDesktopOnly !== true) throw new Error('Source manifest identity/desktop flag mismatch.');
  const assets = {};
  for (const name of ASSETS) {
    const bytes = await read(path.join(ctx.source, name));
    if (!bytes?.length) throw new Error(`Missing or empty build asset: ${name}`);
    assets[name] = bytes;
  }
  const before = {
    old: await tree(path.join(ctx.plugins, OLD)),
    current: await tree(path.join(ctx.plugins, NEW)),
    registry: await digest(path.join(ctx.config, 'community-plugins.json')),
    hotkeys: await digest(path.join(ctx.config, 'hotkeys.json')),
    source: Object.fromEntries(ASSETS.map(name => [name, hash(assets[name])])),
  };
  const registryFile = path.join(ctx.config, 'community-plugins.json');
  const hotkeysFile = path.join(ctx.config, 'hotkeys.json');
  const registry = JSON.parse((await read(registryFile)) ?? '[]');
  const hotkeys = JSON.parse((await read(hotkeysFile)) ?? '{}');
  if (!Array.isArray(registry) || registry.some(id => typeof id !== 'string') || new Set(registry).size !== registry.length) throw new Error('Malformed or duplicate enabled-plugin registry.');
  if (!hotkeys || typeof hotkeys !== 'object' || Array.isArray(hotkeys)) throw new Error('Malformed hotkey registry.');
  const changes = ASSETS.map(name => ({ file: path.join(ctx.plugins, NEW, name), bytes: assets[name] }));
  const oldManifest = await read(path.join(ctx.plugins, OLD, 'manifest.json'));
  if (Object.keys(before.old).length && (!oldManifest || JSON.parse(oldManifest).id !== OLD)) throw new Error('Old installation has unexpected identity.');
  const newManifest = await read(path.join(ctx.plugins, NEW, 'manifest.json'));
  if (Object.keys(before.current).length && (!newManifest || JSON.parse(newManifest).id !== NEW)) throw new Error('New installation collision: unexpected identity.');
  const oldData = await read(path.join(ctx.plugins, OLD, 'data.json'));
  const newData = await read(path.join(ctx.plugins, NEW, 'data.json'));
  if (oldData && newData && !oldData.equals(newData)) throw new Error('Both installations have different data.json; choose settings manually before migration.');
  if (oldData && !newData) changes.push({ file: path.join(ctx.plugins, NEW, 'data.json'), bytes: oldData });
  if (registry.includes(OLD)) {
    if (registry.includes(NEW)) throw new Error('Both plugin IDs enabled. Disable one before migration.');
    changes.push({ file: registryFile, bytes: json(registry.map(id => id === OLD ? NEW : id)) });
  }
  let migrated = false;
  for (const id of Object.keys(hotkeys)) {
    if (!id.startsWith(OLD + ':')) continue;
    const target = NEW + id.slice(OLD.length);
    if (Object.hasOwn(hotkeys, target) && JSON.stringify(hotkeys[target]) !== JSON.stringify(hotkeys[id])) throw new Error(`Hotkey collision: ${target}`);
    hotkeys[target] = hotkeys[id];
    delete hotkeys[id];
    migrated = true;
  }
  if (migrated) changes.push({ file: hotkeysFile, bytes: json(hotkeys) });
  const fingerprint = hash(json({ vault: ctx.vault, source: ctx.source, before }));
  return { before, fingerprint, changes };
}
async function replaceChecked(file, bytes, expected) {
  await safePath(file);
  if (await digest(file) !== expected) throw new Error(`Concurrent change: ${file}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (bytes === null) { await fs.unlink(file); return; }
  const temporary = file + '.cmds-migrate-' + process.pid;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    if (await digest(file) !== expected) throw new Error(`Concurrent change: ${file}`);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function saveJournal(ctx, journal) {
  const file = path.join(ctx.backup, 'migration.json');
  const temporary = path.join(ctx.backup, `.journal-${process.pid}.tmp`);
  await safePath(file);
  try {
    await fs.writeFile(temporary, json(journal), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function restore(ctx, journal) {
  if (journal.vault !== ctx.vault || journal.schemaVersion !== 1) throw new Error('Backup manifest does not match vault/schema.');
  if (!Array.isArray(journal.changes)) throw new Error('Malformed backup manifest.');
  const allowed = [path.join(ctx.config, 'community-plugins.json'), path.join(ctx.config, 'hotkeys.json'), ...[...ASSETS, 'data.json'].map(name => path.join(ctx.plugins, NEW, name))];
  if (journal.pending) {
    if (!allowed.includes(journal.pending.file)) throw new Error('Backup contains an unexpected pending target.');
    await safePath(journal.pending.file);
    const pendingHash = await digest(journal.pending.file);
    if (pendingHash === journal.pending.after) journal.changes.push(journal.pending);
    else if (pendingHash !== journal.pending.before) throw new Error('Interrupted write has unexpected contents; manual recovery required.');
    delete journal.pending;
  }
  // Validate the entire rollback first: never partially roll back known modified files.
  for (const change of journal.changes) {
    if (!allowed.includes(change.file)) throw new Error('Backup contains an unexpected write target.');
    await safePath(change.file);
    if (await digest(change.file) !== change.after) throw new Error(`Rollback refused: deployed file changed: ${change.file}`);
    if (change.before !== null) {
      if (!/^\d+\.bin$/.test(change.backup)) throw new Error('Invalid backup filename.');
      const bytes = await read(path.join(ctx.backup, change.backup));
      if (!bytes || hash(bytes) !== change.before) throw new Error('Backup integrity check failed.');
    }
  }
  for (const change of [...journal.changes].reverse()) {
    const bytes = change.before === null ? null : await read(path.join(ctx.backup, change.backup));
    await replaceChecked(change.file, bytes, change.after);
    journal.changes.pop();
    await saveJournal(ctx, journal);
  }
  journal.status = 'rolled-back';
  await saveJournal(ctx, journal);
}
export async function migrate(options) {
  const mode = options.mode ?? 'dry-run';
  if (!['dry-run', 'check', 'apply', 'rollback'].includes(mode)) throw new Error('Mode must be dry-run, check, apply, or rollback.');
  const ctx = await context(options);
  if (mode === 'rollback') {
    const journal = JSON.parse((await read(path.join(ctx.backup, 'migration.json'))) ?? 'null');
    if (!journal || !['applied', 'applying', 'failed'].includes(journal.status)) throw new Error('No pending deployment to roll back.');
    await restore(ctx, journal);
    return { status: 'rolled-back' };
  }
  const plan = await inspect(ctx);
  const summary = { mode, fingerprint: plan.fingerprint, changes: plan.changes.map(change => path.relative(ctx.vault, change.file)), oldInstallationRetained: true };
  if (mode !== 'apply') return summary;
  if (options.expect !== plan.fingerprint) throw new Error('Run check and pass its fingerprint as --expect before applying.');
  // The target must be a new directory: never overwrite an earlier recovery point.
  await fs.mkdir(ctx.backup, { recursive: false, mode: 0o700 });
  const journal = { schemaVersion: 1, vault: ctx.vault, source: ctx.source, status: 'applying', before: plan.before, changes: [] };
  await saveJournal(ctx, journal);
  for (const [name, directory] of [['old-installation', OLD], ['new-installation', NEW]]) {
    if (Object.keys(directory === OLD ? plan.before.old : plan.before.current).length) await fs.cp(path.join(ctx.plugins, directory), path.join(ctx.backup, name), { recursive: true, errorOnExist: true, force: false });
  }
  // Snapshot registries even when no ID mapping is needed.
  for (const name of ['community-plugins.json', 'hotkeys.json']) {
    const bytes = await read(path.join(ctx.config, name));
    if (bytes !== null) await fs.writeFile(path.join(ctx.backup, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  if ((await inspect(ctx)).fingerprint !== plan.fingerprint) throw new Error('Concurrent change while creating backup; nothing deployed.');
  try {
    for (const [index, change] of plan.changes.entries()) {
      const previous = await read(change.file);
      const before = previous === null ? null : hash(previous);
      const expected = change.file.startsWith(ctx.plugins + path.sep)
        ? (plan.before.current[path.relative(path.join(ctx.plugins, NEW), change.file)] ?? null)
        : change.file.endsWith('community-plugins.json') ? plan.before.registry : plan.before.hotkeys;
      if (before !== expected) throw new Error(`Concurrent change: ${change.file}`);
      const backup = `${index}.bin`;
      if (previous !== null) await fs.writeFile(path.join(ctx.backup, backup), previous, { flag: 'wx', mode: 0o600 });
      const record = { file: change.file, before, after: hash(change.bytes), backup };
      // Persist intent before mutation; recover an interrupted write using hashes.
      journal.pending = record;
      await saveJournal(ctx, journal);
      await replaceChecked(change.file, change.bytes, before);
      journal.changes.push(record);
      delete journal.pending;
      await saveJournal(ctx, journal);
    }
    journal.status = 'applied';
    await saveJournal(ctx, journal);
  } catch (error) {
    if (journal.pending && await digest(journal.pending.file) === journal.pending.after) journal.changes.push(journal.pending);
    delete journal.pending;
    journal.status = 'failed';
    await saveJournal(ctx, journal);
    try { await restore(ctx, journal); }
    catch (rollbackError) { throw new Error(`${error.message}; rollback stopped: ${rollbackError.message}. Retain backup for manual recovery.`); }
    throw error;
  }
  return { ...summary, status: 'applied', backup: ctx.backup, runtimeAction: 'Enable/reload manually only after verifying the installation; this script never launches applications.' };
}

async function cli() {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      if (!['--vault', '--backup', '--source', '--mode', '--expect'].includes(args[index]) || !args[index + 1]) throw new Error('Usage: node scripts/migrate-local.mjs --vault ABS --backup ABS [--source ABS] [--mode dry-run|check|apply|rollback] [--expect FINGERPRINT]');
      options[args[index].slice(2)] = args[index + 1];
    }
    console.log(JSON.stringify(await migrate(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli();
