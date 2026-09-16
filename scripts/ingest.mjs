#!/usr/bin/env node
// CMDS Zotero agent CLI (contract 2). Bridge-first through the Obsidian CLI; offline fallback over the vault's
// validated index for read-only actions. Every response is JSON on stdout with an envelope; see
// skills/cmds-zotero/references/cli-contract-v2.md.
//
// Transport notes: a busy Obsidian renderer makes `obsidian eval` return exit 0 with EMPTY stdout while the eval
// still runs. Only that signature (exit 0, no result and no error line) is retried before submission, up to three
// times; a CLI that fails to spawn or exits non-zero is immediate bridge loss so offline fallback stays instant.
// A submission with unknown outcome is never repeated. After acceptance every bridge failure (empty output or a
// transport error) is retried until the --timeout deadline, then reported as timeout.
// Completed results persist in the plugin until this script acknowledges them (p.service.ackJob) or their TTL.
// CMDS_ZOTERO_POLL_MS overrides the poll deadline in milliseconds instead of --timeout seconds. It is honoured only
// inside the node test runner (NODE_TEST_CONTEXT set) so user shells cannot bypass the --timeout bounds.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.require ??= createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, 'ingest-core.mjs');

const ACTION_API_VERSION = { connection: 1, info: 2, refresh: 1, resolve: 1, identity: 2, cites: 2, reconcile: 2, diagnostics: 1, 'pdf-text': 2, locate: 2 };
const V1_ACTIONS = Object.keys(ACTION_API_VERSION).filter(action => ACTION_API_VERSION[action] === 1);
const V2_ACTIONS = Object.keys(ACTION_API_VERSION).filter(action => ACTION_API_VERSION[action] === 2);
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
const pollOverride = process.env.NODE_TEST_CONTEXT && /^\d+$/.test(process.env.CMDS_ZOTERO_POLL_MS ?? '') ? Number(process.env.CMDS_ZOTERO_POLL_MS) : null;
const timeoutMs = pollOverride ?? (parsed.values['--timeout'] ?? (action === 'pdf-text' ? 900 : 300)) * 1000;
const offline = parsed.values['--offline'] === true;
const TRANSIENT_DELAY_MS = 500;
const DISCOVERY_RETRIES = 3;
// Throws raised by the eval wrapper itself or by the plugin's lifecycle/capacity guards: the plugin is not (usably)
// present, so they stay requires-obsidian. Every other startJob throw is the plugin validating the request.
const LIFECYCLE_ERROR = /is not loaded|Wrong vault|was unloaded|Too many active/;

// Exit 0 with neither a result nor an error line is the busy-renderer signature: the eval ran, only its output was lost.
function classifyBridgeOutput(output) {
	const lines = output.split(/\r?\n/).filter(Boolean);
	const result = lines.findLast(value => value.startsWith('=> '));
	if (result) return { kind: 'result', value: JSON.parse(result.slice(3)) };
	const error = lines.map(l => /^Error: (.*)$/.exec(l)).find(Boolean);
	if (error) return { kind: 'plugin-error', message: error[1] };
	return { kind: 'bridge-failure', transient: true, message: lines.length ? lines.join(' ') : 'Empty output from the Obsidian CLI' };
}

function evaluate(expression) {
	const code = `(()=>{if(app.vault.getName()!==${JSON.stringify(vault)})throw new Error('Wrong vault');const p=app.plugins.plugins['cmds-zotero'];if(!p||!p.service)throw new Error('CMDS Zotero service is not loaded.');return JSON.stringify(${expression})})()`;
	let output;
	try {
		output = execFileSync('obsidian', [`vault=${vault}`, 'eval', `code=${code}`], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		const detail = error && typeof error === 'object' && 'stdout' in error && error.stdout ? String(error.stdout) : error instanceof Error ? error.message : 'Obsidian CLI failed';
		// A CLI that could not spawn or exited non-zero (Obsidian not running, CLI missing) is not the busy-renderer case.
		return { kind: 'bridge-failure', transient: false, message: detail.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? 'Obsidian CLI failed' };
	}
	return classifyBridgeOutput(output);
}

// Pre-submission reads are side-effect free, so the transient (empty-output) bridge failure may be retried a few times.
async function evaluateBeforeSubmission(expression) {
	let outcome = evaluate(expression);
	for (let retry = 0; retry < DISCOVERY_RETRIES && outcome.kind === 'bridge-failure' && outcome.transient; retry++) {
		await delay(TRANSIENT_DELAY_MS);
		outcome = evaluate(expression);
	}
	return outcome;
}

async function runLive() {
	const versions = await evaluateBeforeSubmission(`{apiVersion:p.service.apiVersion,apiVersions:p.service.apiVersions||[p.service.apiVersion]}`);
	if (versions.kind !== 'result') return { bridge: versions, phase: 'discovery' };
	const apiVersions = Array.isArray(versions.value.apiVersions) ? versions.value.apiVersions : [versions.value.apiVersion];
	if (!apiVersions.includes(2)) {
		if (V2_ACTIONS.includes(action)) return { bridge: { kind: 'too-old', apiVersions }, phase: 'discovery' };
		if (action === 'resolve' || action === 'diagnostics') return { bridge: { kind: 'too-old-read', apiVersions }, phase: 'discovery' };
		if (action === 'refresh' && Object.keys(request).length) return { bridge: { kind: 'too-old', apiVersions }, phase: 'discovery' };
		// Old-host connection and an unflagged explicit refresh preserve their v1 behavior and are wrapped below.
	}
	let id = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		// The submission itself is never retried on a bridge failure: an empty reply may still have started the job.
		const started = evaluate(`p.service.startJob(${JSON.stringify(action)},${JSON.stringify(request)})`);
		if (started.kind === 'result') { id = started.value; break; }
		if (started.kind === 'plugin-error' && /Too many active/.test(started.message) && attempt < 3) { await delay(1000 * 2 ** attempt); continue; }
		if (started.kind === 'plugin-error' && LIFECYCLE_ERROR.test(started.message)) return { bridge: started, phase: 'discovery' };
		// Any other throw is the plugin rejecting the request before acceptance: Obsidian and the plugin are present.
		if (started.kind === 'plugin-error') return { bridge: { kind: 'invalid-request', message: started.message, apiVersions }, phase: 'discovery' };
		return { bridge: started, phase: 'submission-uncertain' };
	}
	const deadline = Date.now() + timeoutMs;
	let lastBridgeFailure = null;
	while (true) {
		const job = evaluate(`p.service.getJob(${JSON.stringify(id)})`);
		if (job.kind === 'result') {
			lastBridgeFailure = null;
			// A host-side per-action timeout is reported as reason 'timeout' (uncertain outcome), never as a missing Obsidian.
			if (job.value.state === 'failed') return { bridge: { kind: job.value.reason === 'timeout' ? 'timeout' : 'plugin-error', message: job.value.error ?? 'Ingest request failed.' }, phase: 'accepted' };
			if (job.value.state === 'completed') {
				// Best effort: release the persisted result now that it has been read. Failure to acknowledge is not an error.
				evaluate(`typeof p.service.ackJob==='function'?p.service.ackJob(${JSON.stringify(id)}):false`);
				return { result: job.value.result };
			}
			if (job.value.state !== 'pending') return { bridge: { kind: 'plugin-error', message: 'Unsupported job response.' }, phase: 'accepted' };
		} else if (job.kind === 'plugin-error') {
			return { bridge: job, phase: 'accepted' };
		} else {
			// Empty output or a CLI transport failure is transient on a busy renderer; the job keeps its result for us.
			lastBridgeFailure = job.message;
		}
		if (Date.now() >= deadline) {
			const detail = lastBridgeFailure ? ` The last poll failed: ${lastBridgeFailure}.` : '';
			return { bridge: { kind: 'timeout', message: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the plugin job.${detail}` }, phase: 'accepted' };
		}
		await delay(TRANSIENT_DELAY_MS);
	}
}

async function runOffline(obsidianError) {
	if (!existsSync(CORE)) return { apiVersion: V1_ACTIONS.includes(action) ? 1 : 2, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason: 'bundle-missing', message: 'scripts/ingest-core.mjs is missing; run npm run build:core.', checkedAt: new Date().toISOString(), connection: unknownConnection('Offline core bundle is missing.', 'offline') };
	const core = await import(pathToFileURL(CORE).href);
	return core.runAction({ action, vault, vaultPath: parsed.values['--vault-path'] ?? null, request, obsidianError: obsidianError ?? null, now: new Date() });
}

function unknownConnection(obsidianError, mode = offline ? 'offline' : 'live') {
	return { mode, obsidian: 'unavailable', ...(obsidianError ? { obsidianError } : {}), plugin: { status: 'unknown', version: null, apiVersions: null }, bbt: { reachable: null }, index: { source: 'none', path: '', schemaVersion: null, generatedAt: null, ageMinutes: null, count: null, complete: null, stale: null, maxAgeMinutes: 60 }, legacyPluginEnabled: null, git: null };
}
function structuredFailure(reason, message, refused = false, connection = unknownConnection(message)) {
	return { apiVersion: V1_ACTIONS.includes(action) ? 1 : 2, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason, message, ...(V1_ACTIONS.includes(action) ? { status: 'unavailable' } : {}), checkedAt: new Date().toISOString(), connection, ...(refused && action === 'reconcile' && request.apply ? { mode: 'apply', apply: { mode: 'refused', refusedReason: reason } } : {}) };
}
// The plugin answered discovery and rejected the request itself: Obsidian and the plugin are present, only the request is bad.
function presentPluginConnection(apiVersions) {
	const connection = unknownConnection(null);
	connection.obsidian = 'ok';
	connection.plugin = { status: 'ok', version: null, apiVersions };
	return connection;
}
function legacyEnvelope(payload) {
	if (payload && payload.contract === 2 && payload.connection) return payload;
	const capabilities = payload?.capabilities;
	const connection = unknownConnection(null);
	connection.mode = 'live'; connection.obsidian = 'ok'; connection.plugin = { status: 'too-old', version: null, apiVersions: [1] };
	if (capabilities?.zotero && capabilities?.betterbibtex) connection.bbt = { reachable: true, zotero: capabilities.zotero, betterbibtex: capabilities.betterbibtex };
	return { apiVersion: 1, contract: 2, apiVersions: [1, 2], action, vault, ok: true, checkedAt: new Date().toISOString(), connection, ...payload };
}
async function emit(payload) {
	await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(payload, null, 2) + '\n', error => error ? reject(error) : resolve()));
	const refused = payload?.apply?.mode === 'refused';
	const partial = payload?.apply?.mode === 'partial';
	const strictFail = request.strict && Array.isArray(payload?.diagnostics) && payload.diagnostics.some(d => d.severity === 'error');
	if (payload && (payload.ok === false || payload.status === 'unavailable' || refused || partial || strictFail)) {
		process.stderr.write(`reason: ${payload.reason ?? (refused ? payload.apply.refusedReason : partial ? 'apply-failed' : payload.status === 'unavailable' ? 'unavailable' : 'strict')}\n`);
		process.exitCode = 1;
	}
}

async function main() {
	if (!offline) {
		const live = await runLive();
		if (live.result) { await emit(legacyEnvelope(live.result)); return; }
		const bridge = live.bridge;
		if (live.phase === 'accepted' || live.phase === 'submission-uncertain') {
			await emit(structuredFailure(bridge.kind === 'timeout' ? 'timeout' : 'requires-obsidian', `${bridge.message ?? 'The job result is unavailable.'} The submission may have been accepted; do not resubmit automatically.`)); return;
		}
		if (bridge.kind === 'invalid-request') { await emit(structuredFailure('invalid-request', bridge.message, true, presentPluginConnection(bridge.apiVersions))); return; }
		if (bridge.kind === 'plugin-error' || bridge.kind === 'timeout') { await emit(structuredFailure(bridge.kind === 'timeout' ? 'timeout' : 'requires-obsidian', bridge.message)); return; }
		if (bridge.kind === 'too-old' || bridge.kind === 'too-old-read') {
			if (OFFLINE_CAPABLE.has(action) && action !== 'connection' && !(action === 'reconcile' && request.apply)) { await emit(await runOffline(`Loaded plugin supports API versions ${bridge.apiVersions.join(',')}.`)); return; }
			await emit(structuredFailure('plugin-too-old', `The loaded plugin supports API versions ${bridge.apiVersions.join(',')}; ${action} needs contract 2.`, true)); return;
		}
		if (LIVE_ONLY.has(action) || (action === 'reconcile' && request.apply)) { await emit(structuredFailure('requires-obsidian', bridge.message)); return; }
		await emit(await runOffline(bridge.message)); return;
	}
	if (LIVE_ONLY.has(action) || (action === 'reconcile' && request.apply)) { await emit(structuredFailure('requires-obsidian', `${action}${request.apply ? ' --apply' : ''} requires the live host.`, true)); return; }
	if (!OFFLINE_CAPABLE.has(action)) fail(`${action} is not available offline.`);
	await emit(await runOffline(null));
}

try { await main(); }
catch (error) { await emit(structuredFailure('requires-obsidian', error instanceof Error ? error.message : 'CLI request failed.')); }
