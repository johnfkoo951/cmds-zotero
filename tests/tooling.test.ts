import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrate } from '../scripts/migrate-local.mjs';
import { bumpVersion } from '../scripts/version-bump.mjs';
import { verifyRelease } from '../scripts/verify-release.mjs';
import { scanText, sanitize } from '../scripts/sanitize.mjs';

const OLD = 'cmds-link-zotero';
const NEW = 'cmds-zotero';
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'cmds-tooling-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const source = path.join(root, 'build');
  const config = path.join(vault, '.obsidian');
  const old = path.join(config, 'plugins', OLD);
  const current = path.join(config, 'plugins', NEW);
  const backup = path.join(root, 'backup');
  await fs.mkdir(old, { recursive: true });
  await fs.mkdir(source);
  const manifest = { id: NEW, name: 'CMDS Zotero', version: '0.2.0', minAppVersion: '1.7.2', isDesktopOnly: true, description: 'Local sources' };
  await fs.writeFile(path.join(source, 'manifest.json'), encode(manifest));
  await fs.writeFile(path.join(source, 'main.js'), 'new bundle');
  await fs.writeFile(path.join(source, 'styles.css'), '.test {}');
  await fs.writeFile(path.join(old, 'manifest.json'), encode({ ...manifest, id: OLD }));
  await fs.writeFile(path.join(old, 'main.js'), 'old bundle');
  await fs.writeFile(path.join(old, 'data.json'), encode({ sample: 'settings' }));
  await fs.writeFile(path.join(config, 'community-plugins.json'), encode(['unrelated', OLD]));
  await fs.writeFile(path.join(config, 'hotkeys.json'), encode({ [`${OLD}:insert-citation`]: [{ key: 'Q' }], 'unrelated:keep': [] }));
  return { root, vault, source, config, old, current, backup, options: { vault, source, backup } };
}

test('migration check is read-only; apply retains old/settings; rollback restores registries', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.config, 'community-plugins.json'), 'utf8');
  const check = await migrate({ ...f.options, mode: 'check' });
  await assert.rejects(fs.access(f.backup));
  await assert.rejects(fs.access(f.current));
  await migrate({ ...f.options, mode: 'apply', expect: check.fingerprint });
  assert.equal(await fs.readFile(path.join(f.old, 'main.js'), 'utf8'), 'old bundle');
  assert.equal(await fs.readFile(path.join(f.current, 'main.js'), 'utf8'), 'new bundle');
  assert.equal(await fs.readFile(path.join(f.current, 'data.json'), 'utf8'), await fs.readFile(path.join(f.old, 'data.json'), 'utf8'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.config, 'community-plugins.json'), 'utf8')), ['unrelated', NEW]);
  const keys = JSON.parse(await fs.readFile(path.join(f.config, 'hotkeys.json'), 'utf8'));
  assert.ok(keys[`${NEW}:insert-citation`]);
  assert.ok(!keys[`${OLD}:insert-citation`]);
  assert.ok(keys['unrelated:keep']);
  await migrate({ ...f.options, mode: 'rollback' });
  assert.equal(await fs.readFile(path.join(f.config, 'community-plugins.json'), 'utf8'), before);
  await assert.rejects(fs.access(path.join(f.current, 'main.js')));
  await assert.rejects(fs.access(path.join(f.current, 'data.json')));
});

test('apply requires check fingerprint and rejects concurrent registry/source changes', async t => {
  const f = await fixture(t);
  const check = await migrate(f.options);
  await assert.rejects(migrate({ ...f.options, mode: 'apply' }), /fingerprint/);
  await fs.writeFile(path.join(f.config, 'community-plugins.json'), encode(['unrelated']));
  await assert.rejects(migrate({ ...f.options, mode: 'apply', expect: check.fingerprint }), /fingerprint/);
  const fresh = await migrate(f.options);
  await fs.writeFile(path.join(f.source, 'main.js'), 'changed bundle');
  await assert.rejects(migrate({ ...f.options, mode: 'apply', expect: fresh.fingerprint }), /fingerprint/);
  await assert.rejects(fs.access(f.backup));
});

test('backup path must be absolute, outside active vault and repository, with no symlinks', async t => {
  const f = await fixture(t);
  await assert.rejects(migrate({ ...f.options, vault: 'relative' }), /ABSOLUTE/);
  await assert.rejects(migrate({ ...f.options, backup: path.join(f.config, 'backup') }), /outside/);
  await assert.rejects(migrate({ ...f.options, backup: path.join(f.source, 'backup') }), /outside/);
  await fs.symlink(f.source, path.join(f.root, 'linked'));
  await assert.rejects(migrate({ ...f.options, backup: path.join(f.root, 'linked', 'backup') }), /Symlink/);
});

test('new installation collisions and differing settings/hotkeys are rejected', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.current);
  await fs.writeFile(path.join(f.current, 'main.js'), 'unknown');
  await assert.rejects(migrate(f.options), /collision/);
  await fs.copyFile(path.join(f.source, 'manifest.json'), path.join(f.current, 'manifest.json'));
  await fs.writeFile(path.join(f.current, 'data.json'), encode({ sample: 'other' }));
  await assert.rejects(migrate(f.options), /different data/);
  await fs.unlink(path.join(f.current, 'data.json'));
  await fs.writeFile(path.join(f.config, 'hotkeys.json'), encode({ [`${OLD}:insert`]: [], [`${NEW}:insert`]: [{ key: 'Q' }] }));
  await assert.rejects(migrate(f.options), /Hotkey collision/);
});

test('disabled old ID stays disabled; an existing settings file is not rewritten', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.config, 'community-plugins.json'), encode(['unrelated']));
  await fs.mkdir(f.current);
  await fs.copyFile(path.join(f.source, 'manifest.json'), path.join(f.current, 'manifest.json'));
  await fs.copyFile(path.join(f.old, 'data.json'), path.join(f.current, 'data.json'));
  const before = await fs.stat(path.join(f.current, 'data.json'));
  const check = await migrate(f.options);
  await migrate({ ...f.options, mode: 'apply', expect: check.fingerprint });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.config, 'community-plugins.json'), 'utf8')), ['unrelated']);
  assert.equal((await fs.stat(path.join(f.current, 'data.json'))).mtimeMs, before.mtimeMs);
});

test('rollback refuses concurrent user edits before restoring any file', async t => {
  const f = await fixture(t);
  const check = await migrate(f.options);
  await migrate({ ...f.options, mode: 'apply', expect: check.fingerprint });
  await fs.writeFile(path.join(f.current, 'data.json'), 'user edit');
  await assert.rejects(migrate({ ...f.options, mode: 'rollback' }), /deployed file changed/);
  assert.equal(await fs.readFile(path.join(f.current, 'main.js'), 'utf8'), 'new bundle');
  assert.equal(await fs.readFile(path.join(f.current, 'data.json'), 'utf8'), 'user edit');
});

test('rollback verifies backup integrity', async t => {
  const f = await fixture(t);
  const check = await migrate(f.options);
  await migrate({ ...f.options, mode: 'apply', expect: check.fingerprint });
  const journal = JSON.parse(await fs.readFile(path.join(f.backup, 'migration.json'), 'utf8'));
  const change = journal.changes.find((row: { before: string | null }) => row.before !== null);
  await fs.writeFile(path.join(f.backup, change.backup), 'corrupted');
  await assert.rejects(migrate({ ...f.options, mode: 'rollback' }), /integrity/);
});

test('write failure automatically restores already-deployed files', async t => {
  const f = await fixture(t);
  const check = await migrate(f.options);
  const rename = fs.rename.bind(fs);
  const patch = t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (to === path.join(f.config, 'hotkeys.json')) throw new Error('simulated write failure');
    return rename(from, to);
  });
  await assert.rejects(migrate({ ...f.options, mode: 'apply', expect: check.fingerprint }), /simulated write failure/);
  patch.mock.restore();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.config, 'community-plugins.json'), 'utf8')), ['unrelated', OLD]);
  await assert.rejects(fs.access(path.join(f.current, 'main.js')));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.backup, 'migration.json'), 'utf8')).status, 'rolled-back');
});

test('version bump and release verification synchronize all four files', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'package.json'), encode({ name: NEW, version: '0.2.0' }));
  await fs.writeFile(path.join(f.source, 'package-lock.json'), encode({ version: '0.2.0', packages: { '': { version: '0.2.0' } } }));
  await fs.writeFile(path.join(f.source, 'versions.json'), encode({ '0.2.0': '1.7.2' }));
  assert.equal(await bumpVersion(f.source, '0.2.1'), '0.2.1');
  assert.equal(await verifyRelease('0.2.1', f.source), '0.2.1');
  await assert.rejects(verifyRelease('v0.2.1', f.source), /semver/);
  await assert.rejects(verifyRelease('0.2.0', f.source), /differ/);
  await assert.rejects(bumpVersion(f.source, '01.2.1'), /semver/);
});

test('sanitizer detects concrete sensitive strings without reporting itself', async () => {
  const sensitive = [
    ['/', 'Users', '/', 'someone', '/private.md'].join(''),
    ['omnicontrol', '://focus?session=', 'example'].join(''),
    ['12345678', '1234', '4123', '8123', '123456789012'].join('-'),
    'ghp_' + 'a'.repeat(36),
  ].join('\n');
  assert.equal(scanText(sensitive).length, 4);
  assert.equal(scanText('Use /path/to/vault and synthetic key ABCD2345.').length, 0);
  const own = await fs.readFile(new URL('../scripts/sanitize.mjs', import.meta.url), 'utf8');
  assert.deepEqual(scanText(own), []);
});

test('staged sanitizer reads index contents, not later working-tree edits', async t => {
  const f = await fixture(t);
  const git = (...args: string[]) => execFileSync('git', ['-C', f.source, ...args]);
  git('init', '-q');
  const file = path.join(f.source, 'sample.txt');
  await fs.writeFile(file, 'ghp_' + 'x'.repeat(36));
  git('add', 'sample.txt');
  await fs.writeFile(file, 'safe working tree');
  assert.equal((await sanitize(f.source, true)).findings.length, 1);
  assert.equal((await sanitize(f.source, false)).findings.length, 0);
});
