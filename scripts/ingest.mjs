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
// Job polls back off (PERF-09): 50, 100, 200 and 400 ms after the first four polls, then every 500 ms until the deadline;
// pre-submission discovery retries keep their fixed 500 ms.
// CMDS_ZOTERO_POLL_MS overrides the poll deadline in milliseconds instead of --timeout seconds, and CMDS_ZOTERO_DELAY_MS
// replaces every discovery-retry and poll delay (PERF-10). Both are honoured only inside the node test runner
// (NODE_TEST_CONTEXT set) so user shells cannot bypass the --timeout bounds or the polling pace.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.require ??= createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, 'ingest-core.mjs');
// Obsidian's default configuration folder. The offline core takes the folder as a parameter and names no default itself, because
// the plugin's lint rules forbid the literal in src/; this wrapper is where the default lives. --config-dir overrides it.
const DEFAULT_CONFIG_DIR = '.obsidian';

const ACTION_API_VERSION = { connection: 1, info: 2, refresh: 1, resolve: 1, identity: 2, cites: 2, reconcile: 2, diagnostics: 1, 'pdf-text': 2, locate: 2, recent: 2, import: 2, annotations: 2, citing: 2 };
// Actions added after the first contract-2 host (0.4.0), with the plugin version that added them: an older host does not list
// them and is refused before submission (plugin-too-old).
const ACTION_SINCE = { recent: '0.5', import: '0.5', annotations: '0.6', citing: '0.6' };
const LATER_ACTIONS = new Set(Object.keys(ACTION_SINCE));
// Request features added to an existing action later (0.6.1): an older host does not list them in service.features and is
// refused before submission (plugin-too-old), so a new flag is never silently dropped or rejected as an invalid request.
const FEATURE_SINCE = { 'diagnostics-env': '0.6.1', 'import-modes': '0.6.3' };
const requestedFeature = () => {
	if (action === 'diagnostics' && request.env === true) return 'diagnostics-env';
	if (action === 'import' && (request.adopt !== undefined || request.rebuild === true || request.scope !== undefined)) return 'import-modes';
	return null;
};
const V1_ACTIONS = Object.keys(ACTION_API_VERSION).filter(action => ACTION_API_VERSION[action] === 1);
const V2_ACTIONS = Object.keys(ACTION_API_VERSION).filter(action => ACTION_API_VERSION[action] === 2);
const OFFLINE_CAPABLE = new Set(['connection', 'info', 'resolve', 'identity', 'cites', 'reconcile', 'diagnostics', 'locate', 'annotations', 'citing']);
const LIVE_ONLY = new Set(['refresh', 'pdf-text', 'recent', 'import']);

// name → { type, actions (null = all), help }
const FLAGS = {
	'--vault': { type: 'string', actions: null, help: 'Vault name (required)' },
	'--vault-path': { type: 'string', actions: null, help: 'Absolute vault path for offline mode (else resolved from obsidian.json)' },
	'--config-dir': { type: 'string', actions: null, help: "The vault's configuration folder for offline mode when it is not .obsidian (one name starting with a dot)" },
	'--action': { type: 'string', actions: null, help: V1_ACTIONS.concat(V2_ACTIONS).join('|') },
	'--offline': { type: 'boolean', actions: null, help: 'Skip the Obsidian bridge and answer from the index file' },
	'--allow-stale': { type: 'boolean', actions: ['resolve', 'identity', 'cites', 'reconcile', 'diagnostics', 'import', 'annotations', 'citing'], help: 'Accept negative verdicts from a stale index; import, annotations --fresh: use the saved index when Zotero cannot be read fresh' },
	'--refresh': { type: 'boolean', actions: ['resolve', 'identity'], help: 'Force an index refresh first (live only)' },
	'--timeout': { type: 'integer', actions: null, min: 30, max: 3600, help: 'Seconds to wait for the plugin job (default 300; pdf-text 900)' },
	'--strict': { type: 'boolean', actions: ['cites', 'reconcile'], help: 'Exit 1 when any error-severity diagnostic is reported' },
	'--citekey': { type: 'string', actions: ['resolve', 'identity', 'pdf-text', 'locate', 'import', 'annotations', 'citing'], help: 'Citation key selector' },
	'--item-key': { type: 'string', actions: ['resolve', 'identity', 'pdf-text', 'locate', 'import', 'annotations', 'citing'], help: 'Eight-character Zotero item key (requires --library)' },
	'--library': { type: 'integer', actions: ['resolve', 'identity', 'pdf-text', 'locate', 'import', 'annotations', 'citing'], min: 1, max: 1e9, help: 'Local library ID' },
	'--doi': { type: 'string', actions: ['resolve', 'identity', 'citing'], help: 'DOI selector' },
	'--arxiv': { type: 'string', actions: ['resolve', 'identity', 'citing'], help: 'arXiv id selector' },
	'--title': { type: 'string', actions: ['resolve', 'identity', 'citing'], help: 'Exact title selector' },
	'--query': { type: 'string', actions: ['resolve', 'identity', 'citing'], help: 'Free-text selector (never resolves; ranks candidates)' },
	'--year': { type: 'string', actions: ['resolve', 'identity', 'citing'], help: 'Narrow a title/query selector by year' },
	'--author': { type: 'string', actions: ['resolve', 'identity', 'citing'], help: 'Narrow a title/query selector by surname' },
	'--raw-source': { type: 'string', actions: ['identity'], help: 'Raw Source wikilink for the S01 block' },
	'--attachment': { type: 'string', actions: ['identity', 'pdf-text', 'locate', 'annotations'], help: 'Attachment key when an item has several PDFs; annotations: only that attachment' },
	'--style': { type: 'string', actions: ['identity', 'cites'], help: 'CSL style id (default from settings)' },
	'--locale': { type: 'string', actions: ['identity', 'cites'], help: 'BCP 47 bibliography locale such as en-US or ko-KR (default from note lang or settings)' },
	'--no-bibliography': { type: 'boolean', actions: ['identity'], help: 'Skip the BBT bibliography call' },
	'--path': { type: 'string', actions: ['cites', 'locate'], help: 'Vault-relative file or folder' },
	'--recursive': { type: 'boolean', actions: ['cites'], help: 'Recurse into folders' },
	'--bibliography': { type: 'boolean', actions: ['cites'], help: 'Emit a ## References block' },
	'--folders': { type: 'string', actions: ['reconcile'], help: 'Narrow reconcile to these folders (comma-separated)' },
	'--apply': { type: 'boolean', actions: ['reconcile', 'import'], help: 'reconcile: write allow-listed hub frontmatter keys; import: write the literature note (live only; default is a dry run)' },
	'--days': { type: 'integer', actions: ['recent'], min: 1, max: 365, help: "Zotero reading-history window in days (default: the plugin's setting, 30)" },
	'--file': { type: 'string', actions: ['pdf-text', 'locate'], help: 'Vault-relative PDF instead of a Zotero attachment' },
	'--pages': { type: 'string', actions: ['pdf-text'], help: 'Page range to inline, e.g. 1-5,9' },
	'--force': { type: 'boolean', actions: ['pdf-text', 'cites'], help: 'pdf-text: re-extract even when a cache exists; cites: overwrite an unmarked --out file (never a note)' },
	// 0.5 R10
	'--format': { type: 'string', actions: ['cites'], help: 'With --bibliography: text (default) | markdown | csl-json | bibtex | biblatex' },
	'--out': { type: 'optional-string', actions: ['cites'], help: 'With --bibliography: write the sidecar (live only). No value = .cmds-zotero/bibliography/<slug>.<ext>; a vault-relative path outside it must be absent or plugin-marked' },
	'--quote': { type: 'string', actions: ['locate'], help: 'Quote text to locate (≤ 8 KiB)' },
	// 0.6
	'--stdin': { type: 'boolean', actions: ['resolve'], help: 'Read NDJSON from stdin, one JSON selector object per line (citekey | itemKey+libraryID | doi | arxiv | title [year, author] | query; allowStale), at most 500; prints one envelope per line' },
	'--today': { type: 'boolean', actions: ['annotations'], help: 'Select the paper Zotero opened today (live; resolves only when exactly one paper qualifies)' },
	'--fresh': { type: 'boolean', actions: ['annotations'], help: 'Read the annotations from Zotero now instead of the saved index (live only)' },
	'--color': { type: 'string', actions: ['annotations'], help: 'Only this color: yellow|red|green|blue|purple|magenta|orange|gray, or hex like #ffd400' },
	'--type': { type: 'string', actions: ['annotations'], help: 'Only this annotation type: highlight|underline|note|text|image|ink' },
	'--tag': { type: 'string', actions: ['annotations'], help: 'Only annotations carrying this tag (case-insensitive)' },
	// 0.6.1
	'--env': { type: 'boolean', actions: ['diagnostics'], help: 'Add report-only setup checks (Zotero/BBT versions, legacy plugin, index, Git, pdf.js, other vaults, output folder, Obsidian bridge) as environment.checks' },
	// 0.6.3
	'--adopt': { type: 'string', actions: ['import'], help: 'Adopt this vault-relative note as the literature note (L1 frontmatter + L2 append; live only)' },
	'--rebuild': { type: 'boolean', actions: ['import'], help: 'Repair damaged, duplicate or missing managed markers of the owned note before refreshing it' },
	'--scope': { type: 'string', actions: ['import'], help: 'Refresh only these comma-separated section groups: overview,citation,metadata,notes,annotations' },
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
		// 0.5 R10: an optional value; a following flag (or nothing) means "use the default".
		if (flag.type === 'optional-string') { if (raw === undefined || (raw.startsWith('--') && raw.length > 2)) { values[name] = true; continue; } i++; values[name] = raw; continue; }
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
// 0.6: resolve --stdin takes its selectors from the input lines, so no selector flag (and no per-batch refresh) may accompany it.
const stdin = parsed.values['--stdin'] === true;
if (stdin) {
	const foreign = [...SELECTORS, '--library', '--year', '--author', '--refresh'].filter(name => name in parsed.values);
	if (foreign.length) fail(`--stdin takes the selectors from the input lines; remove ${foreign.join(', ')} (refresh once with --action refresh).`);
}
if (['resolve', 'identity', 'citing'].includes(action)) {
	const given = SELECTORS.filter(name => name in parsed.values);
	// identity may pair --citekey (vault key) with one other selector; resolve takes exactly one.
	const distinct = action === 'identity' ? given.filter(name => name !== '--citekey') : given;
	if ((action === 'resolve' || action === 'citing') && given.length !== 1 && !stdin) fail(`${action} needs exactly one selector: --citekey | --item-key --library | --doi | --arxiv | --title | --query${action === 'resolve' ? ' (or --stdin)' : ''}.`);
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
const IMPORT_SCOPES = ['overview', 'citation', 'metadata', 'notes', 'annotations'];
if (action === 'import') {
	const given = ['--citekey', '--item-key'].filter(name => name in parsed.values);
	const adopting = typeof parsed.values['--adopt'] === 'string' && parsed.values['--adopt'].trim().length > 0;
	if (adopting ? given.length > 1 : given.length !== 1) fail('import needs exactly one selector: --citekey | --item-key --library (optional with --adopt).');
	if ('--item-key' in parsed.values && (!/^[A-Z0-9]{8}$/.test(parsed.values['--item-key']) || !('--library' in parsed.values))) fail('--item-key requires eight characters and --library.');
	if ('--adopt' in parsed.values && !adopting) fail('--adopt must not be empty.');
	if ('--adopt' in parsed.values && '--rebuild' in parsed.values) fail('--adopt and --rebuild cannot be combined.');
	if ('--scope' in parsed.values) {
		const groups = parsed.values['--scope'].split(',').map(s => s.trim()).filter(Boolean);
		if (!groups.length || groups.some(g => !IMPORT_SCOPES.includes(g))) fail(`--scope must be comma-separated values from ${IMPORT_SCOPES.join(', ')}.`);
	}
}
if ('--locale' in parsed.values && !/^[A-Za-z]{2,3}(?:[-_][A-Za-z]{4})?(?:[-_](?:[A-Za-z]{2}|[0-9]{3}))?$/.test(parsed.values['--locale'].trim())) fail('--locale must be a BCP 47 locale such as en-US, de-DE or ko-KR.');
// 0.6
const ANNOTATION_COLORS = ['yellow', 'red', 'green', 'blue', 'purple', 'magenta', 'orange', 'gray'];
const ANNOTATION_TYPES = ['highlight', 'underline', 'note', 'text', 'image', 'ink'];
if (action === 'annotations') {
	if (['--citekey', '--item-key', '--today'].filter(name => name in parsed.values).length !== 1) fail('annotations needs exactly one selector: --citekey | --item-key --library | --today.');
	if ('--item-key' in parsed.values && (!/^[A-Z0-9]{8}$/.test(parsed.values['--item-key']) || !('--library' in parsed.values))) fail('--item-key requires eight characters and --library.');
	if ('--attachment' in parsed.values && !/^[A-Za-z0-9]{8}$/.test(parsed.values['--attachment'])) fail('--attachment must be an eight-character attachment key.');
	if ('--color' in parsed.values && !(ANNOTATION_COLORS.includes(parsed.values['--color'].trim().toLowerCase()) || /^(#[0-9a-fA-F]{3}|#?[0-9a-fA-F]{6})$/.test(parsed.values['--color'].trim()))) fail(`--color must be one of ${ANNOTATION_COLORS.join(', ')} or a hex value such as #ffd400.`);
	if ('--type' in parsed.values && !ANNOTATION_TYPES.includes(parsed.values['--type'].trim().toLowerCase())) fail(`--type must be one of ${ANNOTATION_TYPES.join(', ')}.`);
	if ('--tag' in parsed.values && !parsed.values['--tag'].trim()) fail('--tag must not be empty.');
}
// HYG-02: the offline core joins this name onto the vault root, so it must stay a single dot-folder segment.
if ('--config-dir' in parsed.values && (!/^\.[^/\\]+$/.test(parsed.values['--config-dir']) || parsed.values['--config-dir'] === '..' || parsed.values['--config-dir'].includes('\0'))) fail('--config-dir must be one folder name that starts with a dot.');
// 0.5 R10
const BIBLIOGRAPHY_FORMATS = ['text', 'markdown', 'csl-json', 'bibtex', 'biblatex'];
if (action === 'cites' && '--format' in parsed.values && !BIBLIOGRAPHY_FORMATS.includes(parsed.values['--format'])) fail(`--format must be one of ${BIBLIOGRAPHY_FORMATS.join(', ')}.`);
if (action === 'cites' && ('--format' in parsed.values || '--out' in parsed.values || '--force' in parsed.values) && !('--bibliography' in parsed.values)) fail('--format, --out and --force need --bibliography.');

let request = {};
const map = { '--days': 'days', '--format': 'format', '--out': 'out', '--citekey': 'citekey', '--item-key': 'itemKey', '--library': 'libraryID', '--doi': 'doi', '--arxiv': 'arxiv', '--title': 'title', '--query': 'query', '--year': 'year', '--author': 'author', '--raw-source': 'rawSource', '--attachment': 'attachment', '--style': 'style', '--locale': 'locale', '--no-bibliography': 'noBibliography', '--path': 'path', '--recursive': 'recursive', '--bibliography': 'bibliography', '--folders': 'folders', '--apply': 'apply', '--file': 'file', '--pages': 'pages', '--force': 'force', '--quote': 'quote', '--if-older-than': 'ifOlderThanMinutes', '--allow-stale': 'allowStale', '--refresh': 'refresh', '--strict': 'strict', '--today': 'today', '--fresh': 'fresh', '--color': 'color', '--type': 'type', '--tag': 'tag', '--env': 'env', '--adopt': 'adopt', '--rebuild': 'rebuild', '--scope': 'scope' };
for (const [name, key] of Object.entries(map)) if (name in parsed.values) request[key] = parsed.values[name];
if (request.folders) request.folders = request.folders.split(',').map(s => s.trim()).filter(Boolean);
if (request.scope) request.scope = [...new Set(request.scope.split(',').map(s => s.trim()).filter(Boolean))];
const pollOverride = process.env.NODE_TEST_CONTEXT && /^\d+$/.test(process.env.CMDS_ZOTERO_POLL_MS ?? '') ? Number(process.env.CMDS_ZOTERO_POLL_MS) : null;
const delayOverride = process.env.NODE_TEST_CONTEXT && /^\d+$/.test(process.env.CMDS_ZOTERO_DELAY_MS ?? '') ? Number(process.env.CMDS_ZOTERO_DELAY_MS) : null;
const timeoutMs = pollOverride ?? (parsed.values['--timeout'] ?? (action === 'pdf-text' ? 900 : 300)) * 1000;
const offline = parsed.values['--offline'] === true;
// 0.5 R10: a cites request that writes a sidecar is a live write, like reconcile --apply. 0.6: annotations --fresh and --today ask Zotero.
const liveWrite = LIVE_ONLY.has(action) || (action === 'reconcile' && request.apply === true) || (action === 'cites' && request.out !== undefined) || (action === 'annotations' && (request.fresh === true || request.today === true));
const TRANSIENT_DELAY_MS = 500;
const DISCOVERY_RETRIES = 3;
// PERF-09: most jobs finish within a few hundred milliseconds, so the first polls come quickly; the 500 ms ceiling keeps
// the steady pace at two obsidian CLI spawns per second, as before.
const POLL_DELAYS_MS = [50, 100, 200, 400, 500];
const discoveryDelay = () => delayOverride ?? TRANSIENT_DELAY_MS;
const pollDelay = polls => delayOverride ?? POLL_DELAYS_MS[Math.min(polls, POLL_DELAYS_MS.length) - 1];
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
		await delay(discoveryDelay());
		outcome = evaluate(expression);
	}
	return outcome;
}

async function runLive() {
	const versions = await evaluateBeforeSubmission(`{apiVersion:p.service.apiVersion,apiVersions:p.service.apiVersions||[p.service.apiVersion],actions:Array.isArray(p.service.actions)?p.service.actions:null,features:Array.isArray(p.service.features)?p.service.features:null}`);
	if (versions.kind !== 'result') return { bridge: versions, phase: 'discovery' };
	const apiVersions = Array.isArray(versions.value.apiVersions) ? versions.value.apiVersions : [versions.value.apiVersion];
	// A host that predates an action (no action list, or one without it) would reject it as unsupported: say why instead.
	if (LATER_ACTIONS.has(action) && !(Array.isArray(versions.value.actions) && versions.value.actions.includes(action))) return { bridge: { kind: 'too-old-action', apiVersions }, phase: 'discovery' };
	if (!apiVersions.includes(2)) {
		if (V2_ACTIONS.includes(action)) return { bridge: { kind: 'too-old', apiVersions }, phase: 'discovery' };
		if (action === 'resolve' || action === 'diagnostics') return { bridge: { kind: 'too-old-read', apiVersions }, phase: 'discovery' };
		if (action === 'refresh' && Object.keys(request).length) return { bridge: { kind: 'too-old', apiVersions }, phase: 'discovery' };
		// Old-host connection and an unflagged explicit refresh preserve their v1 behavior and are wrapped below.
	}
	const feature = requestedFeature();
	if (feature && !(Array.isArray(versions.value.features) && versions.value.features.includes(feature))) return { bridge: { kind: 'too-old-feature', feature, apiVersions }, phase: 'discovery' };
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
	let polls = 0;
	while (true) {
		const job = evaluate(`p.service.getJob(${JSON.stringify(id)})`);
		polls++;
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
		await delay(pollDelay(polls));
	}
}

async function runOffline(obsidianError) {
	if (!existsSync(CORE)) return { apiVersion: V1_ACTIONS.includes(action) ? 1 : 2, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason: 'bundle-missing', message: 'scripts/ingest-core.mjs is missing; run npm run build:core.', checkedAt: new Date().toISOString(), connection: unknownConnection('Offline core bundle is missing.', 'offline') };
	const core = await import(pathToFileURL(CORE).href);
	return core.runAction({ action, vault, vaultPath: parsed.values['--vault-path'] ?? null, configDir: parsed.values['--config-dir'] ?? DEFAULT_CONFIG_DIR, request, obsidianError: obsidianError ?? null, now: new Date() });
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

// Set when the live host could not be used and the offline core answered; the batch then answers its remaining lines offline too.
let fellBackOffline = false;
let lastBridgeMessage = null;

async function produce() {
	if (!offline) {
		const live = await runLive();
		if (live.result) return legacyEnvelope(live.result);
		const bridge = live.bridge;
		if (live.phase === 'accepted' || live.phase === 'submission-uncertain') {
			return structuredFailure(bridge.kind === 'timeout' ? 'timeout' : 'requires-obsidian', `${bridge.message ?? 'The job result is unavailable.'} The submission may have been accepted; do not resubmit automatically.`);
		}
		if (bridge.kind === 'invalid-request') return structuredFailure('invalid-request', bridge.message, true, presentPluginConnection(bridge.apiVersions));
		if (bridge.kind === 'plugin-error' || bridge.kind === 'timeout') return structuredFailure(bridge.kind === 'timeout' ? 'timeout' : 'requires-obsidian', bridge.message);
		if (bridge.kind === 'too-old-feature') return structuredFailure('plugin-too-old', `The loaded CMDS Zotero plugin does not accept ${bridge.feature === 'diagnostics-env' ? '--env' : bridge.feature === 'import-modes' ? '--adopt, --rebuild or --scope' : bridge.feature} for ${action}; install CMDS Zotero ${FEATURE_SINCE[bridge.feature]} or later and reload it.${OFFLINE_CAPABLE.has(action) && !liveWrite ? ' Add --offline to answer from the saved index file instead.' : ''}`, true, presentPluginConnection(bridge.apiVersions));
		if (bridge.kind === 'too-old-action') return structuredFailure('plugin-too-old', `The loaded CMDS Zotero plugin does not provide the ${action} action; install CMDS Zotero ${ACTION_SINCE[action]} or later and reload it.${OFFLINE_CAPABLE.has(action) && !liveWrite ? ' Add --offline to answer from the saved index file instead.' : ''}`, true, presentPluginConnection(bridge.apiVersions));
		if (bridge.kind === 'too-old' || bridge.kind === 'too-old-read') {
			if (OFFLINE_CAPABLE.has(action) && action !== 'connection' && !liveWrite) { fellBackOffline = true; lastBridgeMessage = `Loaded plugin supports API versions ${bridge.apiVersions.join(',')}.`; return runOffline(lastBridgeMessage); }
			return structuredFailure('plugin-too-old', `The loaded plugin supports API versions ${bridge.apiVersions.join(',')}; ${action} needs contract 2.`, true);
		}
		if (liveWrite) return structuredFailure('requires-obsidian', bridge.message);
		fellBackOffline = true;
		lastBridgeMessage = bridge.message;
		return runOffline(bridge.message);
	}
	if (liveWrite) return structuredFailure('requires-obsidian', `${action}${request.apply ? ' --apply' : request.out !== undefined ? ' --out' : request.fresh ? ' --fresh' : request.today ? ' --today' : ''} requires the live host${action === 'recent' || action === 'annotations' ? ' and a running Zotero' : ''}.`, true);
	if (!OFFLINE_CAPABLE.has(action)) fail(`${action} is not available offline.`);
	return runOffline(null);
}

async function main() { await emit(await produce()); }

// --- resolve --stdin (0.6): NDJSON selectors in, one envelope per line out --------------------------------------------------
const MAX_STDIN_LINES = 500;
const MAX_STDIN_BYTES = 1024 * 1024;
const STDIN_FIELDS = new Set(['citekey', 'itemKey', 'libraryID', 'doi', 'arxiv', 'title', 'year', 'author', 'query', 'allowStale']);

async function readStdin() {
	if (process.stdin.isTTY) fail('--stdin needs NDJSON on standard input (pipe or redirect a file into the command).');
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > MAX_STDIN_BYTES) fail(`--stdin input is larger than ${MAX_STDIN_BYTES / 1024} KiB.`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/** One entry per non-empty input line: `{ line, request }`, or `{ line, error }` for a line that is not a usable selector object. Line numbers are 1-based. */
function parseSelectorLines(text) {
	const entries = [];
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = index + 1;
		if (!raw.trim()) return;
		let value;
		try { value = JSON.parse(raw); } catch (error) { entries.push({ line, error: `Line ${line} is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }); return; }
		if (!value || typeof value !== 'object' || Array.isArray(value)) { entries.push({ line, error: `Line ${line} must be a JSON object holding one selector.` }); return; }
		const unknown = Object.keys(value).filter(key => !STDIN_FIELDS.has(key));
		if (unknown.length) { entries.push({ line, error: `Line ${line} has unsupported field(s): ${unknown.join(', ')}. Use ${[...STDIN_FIELDS].join(', ')}.` }); return; }
		entries.push({ line, request: value });
	});
	return entries;
}

async function loadCore() { return import(pathToFileURL(CORE).href); }

async function mainStdin() {
	const entries = parseSelectorLines(await readStdin());
	if (!entries.length) fail('--stdin received no input lines.');
	if (entries.length > MAX_STDIN_LINES) fail(`--stdin accepts at most ${MAX_STDIN_LINES} lines per call.`);
	const base = parsed.values['--allow-stale'] ? { allowStale: true } : {};
	const payloads = new Array(entries.length).fill(null);
	const failedLine = entry => structuredFailure('invalid-request', entry.error, true, unknownConnection(null));
	// Live first, line by line: the host stays the source of truth while it answers. Once a line had to fall back to the offline
	// core the host is gone, and every remaining line is answered together by one offline batch (one index load, one vault scan).
	let offlineFrom = offline ? 0 : entries.length;
	for (let i = 0; i < offlineFrom; i++) {
		if (entries[i].error) { payloads[i] = failedLine(entries[i]); continue; }
		request = { ...base, ...entries[i].request };
		fellBackOffline = false;
		payloads[i] = await produce();
		if (fellBackOffline) offlineFrom = i + 1;
	}
	const rest = [];
	for (let i = offlineFrom; i < entries.length; i++) {
		if (entries[i].error) payloads[i] = failedLine(entries[i]); else rest.push(i);
	}
	if (rest.length) {
		if (!existsSync(CORE)) for (const i of rest) payloads[i] = { apiVersion: 1, contract: 2, apiVersions: [1, 2], action, vault, ok: false, reason: 'bundle-missing', status: 'unavailable', message: 'scripts/ingest-core.mjs is missing; run npm run build:core.', checkedAt: new Date().toISOString(), connection: unknownConnection('Offline core bundle is missing.', 'offline') };
		else {
			const core = await loadCore();
			const answers = await core.runActions({ action, vault, vaultPath: parsed.values['--vault-path'] ?? null, configDir: parsed.values['--config-dir'] ?? DEFAULT_CONFIG_DIR, requests: rest.map(i => ({ ...base, ...entries[i].request })), obsidianError: lastBridgeMessage, now: new Date() });
			rest.forEach((i, position) => { payloads[i] = answers[position]; });
		}
	}
	let failed = false;
	for (let i = 0; i < entries.length; i++) {
		const payload = payloads[i];
		await new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ line: entries[i].line, ...payload }) + '\n', error => error ? reject(error) : resolve()));
		if (payload.ok === false || payload.status === 'unavailable') {
			failed = true;
			process.stderr.write(`line ${entries[i].line} reason: ${payload.reason ?? 'unavailable'}\n`);
		}
	}
	if (failed) process.exitCode = 1;
}

try { await (stdin ? mainStdin() : main()); }
catch (error) { await emit(structuredFailure('requires-obsidian', error instanceof Error ? error.message : 'CLI request failed.')); }
