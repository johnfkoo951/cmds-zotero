#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Patterns match concrete data, not the escaped pattern source in this file.
const RULES = [
  ['personal home path', /(?:\/(?:Users|home)\/[a-zA-Z][\w.-]*\/|[A-Z]:\\Users\\[^\\\r\n]+\\)/g],
  ['private session URI', /(?:omnicontrol|claude):\/\/[^\s"'<>]+/gi],
  ['session sharing link', /https:\/\/(?:claude\.ai|chatgpt\.com)\/(?:share|chat|code)\/[^\s"'<>]+/gi],
  ['UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi],
  ['credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['assigned secret', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[=:]\s*["'][A-Za-z0-9_+\/.=-]{20,}["']/gi],
];
export function scanText(text) {
  const findings = [];
  for (const [rule, pattern] of RULES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ rule, line: text.slice(0, match.index).split('\n').length });
  }
  return findings;
}
export async function sanitize(root = ROOT, staged = false) {
  const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
  const names = git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  if (!names.length) throw new Error('No files selected. Initialize/stage public-safe sources first.');
  const findings = [];
  for (const name of names) {
    let bytes;
    try { bytes = staged ? git(['show', `:${name}`]) : await fs.readFile(path.join(root, name)); }
    catch (error) { if (!staged && error.code === 'ENOENT') continue; throw error; }
    if (bytes.includes(0)) {
      findings.push({ file: name, line: 1, rule: 'binary requires manual review (remove from public source selection)' });
      continue;
    }
    findings.push(...scanText(bytes.toString('utf8')).map(finding => ({ file: name, ...finding })));
  }
  return { selected: names.length, findings };
}
async function cli() {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--staged')) throw new Error('Usage: node scripts/sanitize.mjs [--staged]');
    const result = await sanitize(ROOT, process.argv.includes('--staged'));
    console.log(JSON.stringify(result, null, 2));
    if (result.findings.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli();
