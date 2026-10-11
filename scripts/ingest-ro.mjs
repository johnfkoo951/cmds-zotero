#!/usr/bin/env node
// Read-only wrapper for commands that may not refresh, extract, or write: forwards to ingest.mjs after
// rejecting every mutating action or flag. Intended as the allowed tool for read-only agent commands.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const READ_ONLY = new Set(['connection', 'info', 'resolve', 'identity', 'cites', 'locate', 'diagnostics', 'reconcile']);
const FORBIDDEN = new Set(['--apply', '--refresh', '--force', '--out']); // 0.5 R10: --out writes a sidecar
const args = process.argv.slice(2);
const actionIndex = args.indexOf('--action');
const action = actionIndex >= 0 ? args[actionIndex + 1] : 'resolve';
if (!READ_ONLY.has(action)) { process.stderr.write(`ingest-ro: action ${action} is not read-only.\n`); process.exit(2); }
for (const arg of args) if (FORBIDDEN.has(arg)) { process.stderr.write(`ingest-ro: ${arg} is not allowed.\n`); process.exit(2); }
const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'ingest.mjs'), ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
