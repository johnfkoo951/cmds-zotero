#!/usr/bin/env node
// CMDS Zotero agent CLI (contract 2). Bridge-first through the Obsidian CLI; offline fallback over the vault's
// validated index for read-only actions. Every response is JSON on stdout with an envelope; see
// skills/cmds-zotero/references/cli-contract-v2.md.
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, 'ingest-core.mjs');

const V1_ACTIONS = ['connection', 'refresh', 'resolve', 'diagnostics'];
const V2_ACTIONS = ['info', 'identity', 'cites', 'reconcile', 'pdf-text', 'locate'];
const OFFLINE_CAPABLE = new Set(['connection', 'info', 'resolve', 'identity', 'cites', 'reconcile', 'diagnostics', 'locate']);
const LIVE_ONLY = new Set(['refresh', 'pdf-text']);

// name → { type, actions (null = all), help }
const FLAGS = {
	'--vault': { type: 'string', actions: null, help: 'Vault name (required)' },
	'--vault-path': { type: 'string', actions: null, help: 'Absolute vault path for offline mode (else resolved from obsidian.json)' },
	'--action': { type: 'string', actions: null, help: V1_ACTIONS.concat(V2_ACTIONS).join('|') },
	'--offline': { type: 'boolean', actions: null, help: 'Skip the Obsidian bridge and answer from the index file' },
	'--allow-stale': { type: 'boolean', actions: ['resolve', 'identity', 'cites', 'reconcile', 'diagnostics'], help: 'Accept negative verdicts from a stale index' },
	'--refresh': { type: 'boolean', actions: ['resolve', 'identity'], help: 'Force an index refresh first (live only)' },
	'--timeout': { type: 'integer', actions: null, min: 30, max: 3600, help: 'Seconds to wait for the plugin job (default 300; pdf-text 900)' },
	'--strict': { type: 'boolean', actions: ['cites', 'reconcile'], help: 'Exit 1 when any error-severity diagnostic is reported' },
	'--citekey': { type: 'string', actions: ['resolve', 'identity', 'pdf-text', 'locate'], help: 'Citation key selector' },
	'--item-key': { type: 'string', actions: ['resolve', 'identity', 'pdf-text', 'locate'], help: 'Eight-character Zotero item key (requires --library)' },
	'--library': { type: 'integer', actions: ['resolve', 'identity', 'pdf-text', 'locate'], min: 1, max: 1e9, help: 'Local library ID' },
	'--doi': { type: 'string', actions: ['resolve', 'identity'], help: 'DOI selector' },
	'--arxiv': { type: 'string', actions: ['resolve', 'identity'], help: 'arXiv id selector' },
	'--title': { type: 'string', actions: ['resolve', 'identity'], help: 'Exact title selector' },
	'--query': { type: 'string', actions: ['resolve', 'identity'], help: 'Free-text selector (never resolves; ranks candidates)' },
	'--year': { type: 'string', actions: ['resolve', 'identity'], help: 'Narrow a title/query selector by year' },
	'--author': { type: 'string', actions: ['resolve', 'identity'], help: 'Narrow a title/query selector by surname' },
	'--raw-source': { type: 'string', actions: ['identity'], help: 'Raw Source wikilink for the S01 block' },
	'--attachment': { type: 'string', actions: ['identity', 'pdf-text', 'locate'], help: 'Attachment key when an item has several PDFs' },
	'--style': { type: 'string', actions: ['identity', 'cites'], help: 'CSL style id (default from settings)' },
	'--no-bibliography': { type: 'boolean', actions: ['identity'], help: 'Skip the BBT bibliography call' },
	'--path': { type: 'string', actions: ['cites', 'locate'], help: 'Vault-relative file or folder' },
	'--recursive': { type: 'boolean', actions: ['cites'], help: 'Recurse into folders' },
	'--bibliography': { type: 'boolean', actions: ['cites'], help: 'Emit a ## References block' },
	'--folders': { type: 'string', actions: ['reconcile'], help: 'Narrow reconcile to these folders (comma-separated)' },
	'--apply': { type: 'boolean', actions: ['reconcile'], help: 'Write allow-listed hub frontmatter keys (live only)' },
	'--file': { type: 'string', actions: ['pdf-text', 'locate'], help: 'Vault-relative PDF instead of a Zotero attachment' },
	'--pages': { type: 'string', actions: ['pdf-text'], help: 'Page range to inline, e.g. 1-5,9' },
	'--force': { type: 'boolean', actions: ['pdf-text'], help: 'Re-extract even when a cache exists' },
	'--quote': { type: 'string', actions: ['locate'], help: 'Quote text to locate (≤ 8 KiB)' },
	'--if-older-than': { type: 'integer', actions: ['refresh'], min: 1, max: 10080, help: 'Refresh only when the index is older than N minutes' },
};

function usage(action) {
	const lines = ['Usage: node scripts/ingest.mjs --vault NAME --action ACTION [flags]', '', 'Actions: ' + V1_ACTIONS.concat(V2_ACTIONS).join(', '), ''];
	for (const [name, flag] of Object.entries(FLAGS)) {
		if (action && flag.actions && !flag.actions.includes(action)) continue;
		lines.push(`  ${name.padEnd(18)} ${flag.help}${flag.actions ? '  [' + flag.actions.join(',') + ']' : ''}`);
	}
	return lines.join('\n') + '\n';
}

function fail(message, code = 2) { process.stderr.write(message.endsWith('\n') ? message : message + '\n'); process.exit(code); }

function parseArgs(argv) {
	const values = {};
	for (let i = 0; i < argv.length; i++) {
		const name = argv[i];
		if (name === '--help' || name === '-h') return { help: true, values };
		const flag = FLAGS[name];
		if (!flag) fail(`Unknown argument: ${name}. Use --help.`);
		if (name in values) fail(`Duplicate argument: ${name}.`);
		if (flag.type === 'boolean') { values[name] = true; continue; }
		const raw = argv[i + 1];
		if (raw === undefined || (raw.startsWith('--') && raw.length > 2)) fail(`Missing value for ${name}.`);
		i++;
		if (flag.type === 'integer') {
			if (!/^\d+$/.test(raw)) fail(`${name} must be an integer.`);
			const n = Number(raw);
			if (!Number.isSafeInteger(n) || n < flag.min || n > flag.max) fail(`${name} must be between ${flag.min} and ${flag.max}.`);
			values[name] = n;
		} else values[name] = raw;
	}
	return { help: false, values };
}

const parsed = parseArgs(process.argv.slice(2));
const action = parsed.values['--action'] ?? 'resolve';
if (parsed.help) { process.stdout.write(usage(V1_ACTIONS.concat(V2_ACTIONS).includes(action) ? action : undefined)); process.exit(0); }
const vault = parsed.values['--vault'];
if (!vault) fail('An explicit --vault is required. Use --help.');
if (!V1_ACTIONS.concat(V2_ACTIONS).includes(action)) fail(`Unsupported action: ${action}. Use --help.`);
for (const [name, flag] of Object.entries(FLAGS)) if (name in parsed.values && flag.actions && !flag.actions.includes(action)) fail(`${name} does not apply to --action ${action}.`);

const SELECTORS = ['--citekey', '--item-key', '--doi', '--arxiv', '--title', '--query'];
if (['resolve', 'identity'].includes(action)) {
	const given = SELECTORS.filter(name => name in parsed.values);
	// identity may pair --citekey (vault key) with one other selector; resolve takes exactly one.
	const distinct = action === 'identity' ? given.filter(name => name !== '--citekey') : given;
	if (action === 'resolve' && given.length !== 1) fail('resolve needs exactly one selector: --citekey | --item-key --library | --doi | --arxiv | --title | --query.');
	if (action === 'identity' && given.length === 0) fail('identity needs a selector: --citekey | --item-key --library | --doi | --arxiv | --title | --query.');
	if (action === 'identity' && distinct.length > 1) fail('identity accepts --citekey plus at most one other selector.');
	if ('--item-key' in parsed.values && (!/^[A-Z0-9]{8}$/.test(parsed.values['--item-key']) || !('--library' in parsed.values))) fail('Stable resolution requires an eight-character item key and --library.');
	if (('--year' in parsed.values || '--author' in parsed.values) && !('--title' in parsed.values || '--query' in parsed.values)) fail('--year and --author narrow --title or --query only.');
}
if (['pdf-text', 'locate'].includes(action)) {
	const target = ['--citekey', '--item-key', '--file'].filter(name => name in parsed.values);
	if (action === 'pdf-text' && target.length !== 1) fail('pdf-text needs exactly one target: --citekey | --item-key --library | --file.');
	if (action === 'locate' && !('--path' in parsed.values) && target.length !== 1) fail('locate needs --path, or one target with --quote.');
	if (action === 'locate' && !('--path' in parsed.values) && !('--quote' in parsed.values)) fail('locate needs --quote when --path is not given.');
	if ('--quote' in parsed.values && Buffer.byteLength(parsed.values['--quote']) > 8192) fail('--quote must be at most 8 KiB.');
	if ('--item-key' in parsed.values && (!/^[A-Z0-9]{8}$/.test(parsed.values['--item-key']) || !('--library' in parsed.values))) fail('--item-key requires eight characters and --library.');
}
if (action === 'cites' && !('--path' in parsed.values)) fail('cites needs --path.');

const request = {};
const map = { '--citekey': 'citekey', '--item-key': 'itemKey', '--library': 'libraryID', '--doi': 'doi', '--arxiv': 'arxiv', '--title': 'title', '--query': 'query', '--year': 'year', '--author': 'author', '--raw-source': 'rawSource', '--attachment': 'attachment', '--style': 'style', '--no-bibliography': 'noBibliography', '--path': 'path', '--recursive': 'recursive', '--bibliography': 'bibliography', '--folders': 'folders', '--apply': 'apply', '--file': 'file', '--pages': 'pages', '--force': 'force', '--quote': 'quote', '--if-older-than': 'ifOlderThanMinutes', '--allow-stale': 'allowStale', '--refresh': 'refresh', '--strict': 'strict' };
for (const [name, key] of Object.entries(map)) if (name in parsed.values) request[key] = parsed.values[name];
if (request.folders) request.folders = request.folders.split(',').map(s => s.trim()).filter(Boolean);
const timeoutMs = (parsed.values['--timeout'] ?? (action === 'pdf-text' ? 900 : 300)) * 1000;
const offline = parsed.values['--offline'] === true;

function classifyBridgeOutput(output) {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const result = lines.findLast(value => value.startsWith('=> '));
	if (result) return { kind: 'result', value: JSON.parse(result.slice(3)) };
	const error = lines.map(l => /^Error: (.*)$/.exec(l)).find(Boolean);
	if (error) return { kind: 'plugin-error', message: error[1] };
	return { kind: 'bridge-failure', message: lines.length ? lines.join(' ') : 'Empty output from the Obsidian CLI' };
}

function evaluate(expression) {
	const code = `(()=>{if(app.vault.getName()!==${JSON.stringify(vault)})throw new Error('Wrong vault');const p=app.plugins.plugins['cmds-zotero'];if(!p||!p.service)throw new Error('CMDS Zotero service is not loaded.');return JSON.stringify(${expression})})()`;
	let output;
	try {
		output = execFileSync('obsidian', [`vault=${vault}`, 'eval', `code=${code}`], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		const detail = error && typeof error === 'object' && 'stdout' in error && error.stdout ? String(error.stdout) : error instanceof Error ? error.message : 'Obsidian CLI failed';
		return { kind: 'bridge-failure', message: detail.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? 'Obsidian CLI failed' };
	}
	return classifyBridgeOutput(output);
}

async function runLive() {
	const versions = evaluate(`{apiVersion:p.service.apiVersion,apiVersions:p.service.apiVersions||[p.service.apiVersion]}`);
	if (versions.kind !== 'result') return { bridge: versions };
	const apiVersions = Array.isArray(versions.value.apiVersions) ? versions.value.apiVersions : [versions.value.apiVersion];
	if (V2_ACTIONS.includes(action) && !apiVersions.includes(2)) return { bridge: { kind: 'too-old', apiVersions } };
	let id = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		const started = evaluate(`p.service.startJob(${JSON.stringify(action)},${JSON.stringify(request)})`);
		if (started.kind === 'result') { id = started.value; break; }
		if (started.kind === 'plugin-error' && /Too many active/.test(started.message) && attempt < 3) { await delay(1000 * 2 ** attempt); continue; }
		return { bridge: started };
	}
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const job = evaluate(`p.service.getJob(${JSON.stringify(id)})`);
		if (job.kind !== 'result') return { bridge: job };
		if (job.value.state === 'failed') return { bridge: { kind: 'plugin-error', message: job.value.error ?? 'Ingest request failed.' } };
		if (job.value.state === 'completed') return { result: job.value.result };
		if (job.value.state !== 'pending') return { bridge: { kind: 'plugin-error', message: 'Unsupported job response.' } };
		if (Date.now() >= deadline) return { bridge: { kind: 'timeout', message: `Timed out after ${timeoutMs / 1000}s waiting for the plugin job.` } };
		await delay(500);
	}
}

async function runOffline(obsidianError) {
	if (!existsSync(CORE)) return { apiVersion: V1_ACTIONS.includes(action) ? 1 : 2, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason: 'bundle-missing', message: 'scripts/ingest-core.mjs is missing; run npm run build:core.', checkedAt: new Date().toISOString(), connection: null };
	const core = await import(pathToFileURL(CORE).href);
	return core.runAction({ action, vault, vaultPath: parsed.values['--vault-path'] ?? null, request, obsidianError: obsidianError ?? null, now: new Date() });
}

function emit(payload) {
	process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
	const refused = payload && payload.apply && payload.apply.mode === 'refused';
	const strictFail = request.strict && Array.isArray(payload?.diagnostics) && payload.diagnostics.some(d => d.severity === 'error');
	if (payload && (payload.ok === false || payload.status === 'unavailable' || refused || strictFail)) {
		process.stderr.write(`reason: ${payload.reason ?? (refused ? payload.apply.refusedReason : payload.status === 'unavailable' ? 'unavailable' : 'strict')}\n`);
		process.exitCode = 1;
	}
}

try {
	if (!offline) {
		const live = await runLive();
		if (live.result) { emit(live.result); process.exit(); }
		const bridge = live.bridge;
		if (bridge.kind === 'plugin-error' || bridge.kind === 'timeout') {
			emit({ apiVersion: V1_ACTIONS.includes(action) ? 1 : 2, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason: bridge.kind === 'timeout' ? 'timeout' : 'requires-obsidian', message: bridge.message, ...(V1_ACTIONS.includes(action) ? { status: 'unavailable' } : {}), checkedAt: new Date().toISOString(), connection: null });
			process.exit();
		}
		if (bridge.kind === 'too-old') {
			emit({ apiVersion: 2, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason: 'plugin-too-old', message: `The loaded plugin supports API versions ${bridge.apiVersions.join(',')}; ${action} needs 2.`, checkedAt: new Date().toISOString(), connection: null });
			process.exit();
		}
		if (LIVE_ONLY.has(action) || (action === 'reconcile' && request.apply)) {
			emit({ apiVersion: V1_ACTIONS.includes(action) ? 1 : 2, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason: 'requires-obsidian', message: bridge.message, ...(V1_ACTIONS.includes(action) ? { status: 'unavailable' } : {}), checkedAt: new Date().toISOString(), connection: null });
			process.exit();
		}
		emit(await runOffline(bridge.message));
		process.exit();
	}
	if (LIVE_ONLY.has(action) || (action === 'reconcile' && request.apply)) fail(`${action}${request.apply ? ' --apply' : ''} requires Obsidian; drop --offline.`);
	if (!OFFLINE_CAPABLE.has(action)) fail(`${action} is not available offline.`);
	emit(await runOffline(null));
} catch (error) {
	process.stderr.write(JSON.stringify({ apiVersion: 1, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason: 'requires-obsidian', status: 'unavailable', message: error instanceof Error ? error.message : 'CLI request failed.' }) + '\n');
	process.exitCode = 1;
}
