#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage: node scripts/ingest.mjs --vault NAME --action connection|refresh|resolve|diagnostics [--citekey KEY] [--item-key KEY --library ID]\n');
  process.exit(0);
}
const allowed = new Set(['--vault', '--action', '--citekey', '--item-key', '--library']);
const values = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]) || values.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
    process.stderr.write('Invalid or duplicate argument. Use --help.\n');
    process.exit(2);
  }
  values.set(args[i], args[i + 1]);
}
const vault = values.get('--vault');
const action = values.get('--action') ?? 'resolve';
if (!vault || !['connection', 'refresh', 'resolve', 'diagnostics'].includes(action)) {
  process.stderr.write('An explicit vault and supported action are required. Use --help.\n');
  process.exit(2);
}
const request = {
  ...(values.has('--citekey') ? { citekey: values.get('--citekey') } : {}),
  ...(values.has('--item-key') ? { itemKey: values.get('--item-key') } : {}),
  ...(values.has('--library') ? { libraryID: Number(values.get('--library')) } : {}),
};
if (request.libraryID !== undefined && (!Number.isSafeInteger(request.libraryID) || request.libraryID < 1)) {
  process.stderr.write('Library ID must be a positive integer.\n');
  process.exit(2);
}
function evaluate(expression) {
  const code = `(()=>{if(app.vault.getName()!==${JSON.stringify(vault)})throw new Error('Wrong vault');const p=app.plugins.plugins['cmds-zotero'];if(!p||p.service?.apiVersion!==1)throw new Error('CMDS Zotero service is not loaded.');return JSON.stringify(${expression})})()`;
  const output = execFileSync('obsidian', [`vault=${vault}`, 'eval', `code=${code}`], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = output.split(/\r?\n/).findLast(value => value.startsWith('=> '));
  if (!line) throw new Error('No structured result was returned. Check that the vault and Obsidian CLI are available.');
  return JSON.parse(line.slice(3));
}
try {
  // Long-lived promises are not reliably returned by every Obsidian CLI build.
  // Start exactly once, then query the bounded in-memory job until it terminates.
  const id = evaluate(`p.service.startJob(${JSON.stringify(action)},${JSON.stringify(request)})`);
  const deadline = Date.now() + 300000;
  while (true) {
    const job = evaluate(`p.service.getJob(${JSON.stringify(id)})`);
    if (job.state === 'failed') throw new Error(job.error ?? 'Ingest request failed.');
    if (job.state === 'completed') {
      process.stdout.write(JSON.stringify(job.result, null, 2) + '\n');
      if (job.result?.status === 'unavailable') process.exitCode = 1;
      break;
    }
    if (job.state !== 'pending') throw new Error('Unsupported job response.');
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ingest. Check plugin diagnostics before retrying.');
    await delay(500);
  }
} catch (error) {
  process.stderr.write(JSON.stringify({apiVersion: 1, status: 'unavailable', message: error instanceof Error ? error.message : 'CLI request failed.'}) + '\n');
  process.exitCode = 1;
}
