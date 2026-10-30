#!/usr/bin/env node
// theprototype-agent CLI (roadmap 10 → 55 A3). Joins a theprototype.app session as a peer and
// builds/edits the scene.
//   theprototype-agent mcp   <link>   stdio MCP server (Claude Code, Claude Desktop, …)
//   theprototype-agent repl  <link>   your own OpenAI-compatible LLM drives the scene
//   theprototype-agent smoke <link>   a scripted create/move/colour/delete (no LLM)
// <link> = https://theprototype.app/#F0FD3[&invite=…] or the bare id F0FD3.
// --engine=browser (default) drives the real app in headless Chromium; --engine=wire is the
// light Node peer (objects only). The older --mcp/--repl/--smoke --peer <id> forms still work.
import { readFileSync } from 'node:fs';
import { parseLink, redactLink } from './link.js';
import { BrowserEngine } from './browserEngine.js';
import { WireEngine } from './wireEngine.js';

const BOOLEAN = new Set(['mcp', 'serve', 'static-tools', 'no-static-tools', 'repl', 'smoke', 'verbose', 'compat', 'headed', 'insecure', 'no-turn', 'no-install', 'help', 'version']);
const MODES = ['mcp', 'serve', 'repl', 'smoke'];

/** argv → flags: --flag value | --flag=value | --bool; a known boolean never eats the next word. */
export function parseArgs(/** @type {string[]} */ argv) {
	/** @type {Record<string, any>} */
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h') out.help = true;
		else if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1);
			else {
				const key = a.slice(2);
				const next = argv[i + 1];
				if (!BOOLEAN.has(key) && next !== undefined && !next.startsWith('--')) {
					out[key] = next;
					i++;
				} else out[key] = true;
			}
		} else out._.push(a);
	}
	return out;
}

/** Which mode, and the link it was given (positional, --link, or the old --peer). */
export function modeAndLink(/** @type {Record<string, any>} */ args) {
	let mode = MODES.find((m) => args[m] === true) || null;
	const pos = [...args._];
	if (!mode && MODES.includes(pos[0])) mode = pos.shift();
	const link = pos[0] || args.link || args.peer || null;
	return { mode, link: link ? String(link) : null };
}

/** --peer-server host[:port[:insecure]] | public → an override for endpointsFor (undefined = from the link). */
export function parseServer(/** @type {Record<string, any>} */ args) {
	const v = args['peer-server'];
	if (!v) return undefined;
	if (v === 'public') return 'public';
	const [host, port, insecure] = String(v).split(':');
	return { host, port: Number(port) || 443, secure: insecure !== 'insecure', path: args['peer-path'] || '/peerjs', key: args['peer-key'] || '' };
}

/** Optional mesh-generation backend config from flags/env (roadmap 11 G8, wire engine). */
function parseMeshConfig(/** @type {Record<string, any>} */ args) {
	const kind = args['mesh-kind'] || process.env.AGENT_MESH_KIND;
	const url = args['mesh-url'] || process.env.AGENT_MESH_URL;
	if (!kind || !url) return null;
	/** @type {any} */
	const cfg = {
		kind,
		baseUrl: url,
		apiKey: args['mesh-key'] || process.env.AGENT_MESH_KEY || '',
		mode: args['mesh-mode'] || process.env.AGENT_MESH_MODE || 'preview',
		outputNodeId: args['mesh-output-node'] || process.env.AGENT_MESH_OUTPUT_NODE || ''
	};
	const wfPath = args['mesh-workflow'] || process.env.AGENT_MESH_WORKFLOW;
	if (kind === 'comfyui' && wfPath) {
		try {
			cfg.workflowJson = readFileSync(wfPath, 'utf8');
		} catch (e) {
			console.error('[agent] could not read --mesh-workflow ' + wfPath + ': ' + /** @type {any} */ (e).message);
		}
	}
	return cfg;
}

/** The wire engine's PeerBridge for one host. */
async function makePeerBridge(/** @type {Record<string, any>} */ args, /** @type {string} */ hostId, /** @type {any} */ endpoints, /** @type {string} */ name) {
	const { PeerBridge } = await import('./peerBridge.js');
	const bridge = new PeerBridge({
		agentId: args.id || 'agt' + Math.floor(Math.random() * 90000 + 10000).toString(36),
		name,
		hostId,
		server: endpoints.server,
		stun: endpoints.stun,
		turnApi: endpoints.turnApi,
		approvalTimeout: args['approval-timeout'] ? Number(args['approval-timeout']) * 1000 : 120000,
		verbose: !!args.verbose
	});
	bridge.meshConfig = parseMeshConfig(args);
	return bridge;
}

/** One engine for one link. @param {Record<string, any>} args @param {string} link @param {string} name */
function makeEngine(args, link, name) {
	if ((args.engine || 'browser') === 'wire') {
		return new WireEngine({
			link,
			server: parseServer(args),
			turnUrl: args['no-turn'] ? false : args['turn-url'],
			makeBridge: (hostId, endpoints) => makePeerBridge(args, hostId, endpoints, name)
		});
	}
	return new BrowserEngine({
		link,
		name,
		compat: !!args.compat,
		headless: !args.headed,
		insecure: args.insecure ? true : undefined,
		install: !args['no-install'],
		verbose: !!args.verbose
	});
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

async function runSmoke(/** @type {Record<string, any>} */ args, /** @type {string} */ link) {
	const engine = await makeEngine(args, link, args.name || 'agent');
	const done = async (/** @type {number} */ code) => {
		await engine.close().catch(() => {});
		process.exit(code);
	};
	process.on('SIGINT', () => done(130));
	console.error('[agent] joining ' + redactLink(link) + ' (' + engine.kind + ' engine)');
	await engine.start();
	console.error('[agent] waiting for the host to let us in (Approve, or an invite link)…');
	const t0 = Date.now();
	while (!(await engine.joined())) {
		if (Date.now() - t0 > (Number(args['approval-timeout']) || 120) * 1000) throw new Error('not let in within the approval timeout');
		await sleep(500);
	}
	console.error('[agent] in the session. Running scripted edits…');
	const created = await engine.exec('create_objects', {
		objects: [{ kind: 'primitive', primitive: 'Box', name: 'Agent smoke box', position: [0, 0.5, 0], color: '#22aaff' }]
	});
	const uuid = created?.created?.[0]?.uuid;
	console.error('  created ' + (uuid || JSON.stringify(created)));
	if (!uuid) return done(1);
	await sleep(800);
	console.error('  moved: ' + JSON.stringify(await engine.exec('update_objects', { updates: [{ uuid, position: [0, 1, 0] }] })).slice(0, 120));
	await sleep(800);
	console.error('  deleted: ' + JSON.stringify(await engine.exec('delete_objects', { uuids: [uuid] })).slice(0, 120));
	await sleep(500);
	console.error('[agent] smoke OK');
	return done(0);
}

function usage() {
	console.error(
		[
			'theprototype-agent — join a theprototype.app session as a peer and build the scene',
			'',
			'  theprototype-agent mcp   <link>   MCP server over stdio (claude mcp add theprototype -- npx -y @theprototype/agent mcp <link>)',
			'  theprototype-agent serve --port <n> [link]   MCP over HTTP on 127.0.0.1 (claude mcp add --transport http theprototype http://127.0.0.1:<n>/mcp)',
			'  theprototype-agent repl  <link>   your own OpenAI-compatible model (--api-url --api-key --model)',
			'  theprototype-agent smoke <link>   scripted create/move/delete, no model',
			'',
			'  <link>  https://theprototype.app/#F0FD3 (an &invite=… link joins without an Approve) or the bare id',
			'',
			'  --engine browser|wire   browser (default): the real app in headless Chromium — scene, flows, physics, mesh gen;',
			'                          wire: a light Node peer, objects only (needs @roamhq/wrtc)',
			'  --name <display>        your name in the session (MCP: taken from the client, e.g. "Claude")',
			'  --compat                browser engine on an app older than 1.48 (no window.tpAgent)',
			'  --headed                show the browser   --insecure  accept any TLS cert (auto on local dev)',
			'  --no-install            never download a browser (TP_AGENT_BROWSER=<path> picks one)',
			'  --peer-server h:p[:insecure] | public   wire: signaling override (default: from the link)',
			'  --turn-url <url> | --no-turn            wire: TURN credentials endpoint (default: from the link)',
			'  --id <id>               wire: stable peer id   --approval-timeout <s>  (default 120)',
			'  --static-tools          list the full tool catalog before a join (the default with serve; --no-static-tools = off)',
			'  --verbose               log to stderr'
		].join('\n')
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.version) {
		const { PKG_VERSION } = await import('./mcpServer.js');
		console.error(PKG_VERSION);
		return process.exit(0);
	}
	const { mode, link } = modeAndLink(args);
	if (!mode || args.help) {
		usage();
		return process.exit(args.help ? 0 : 2);
	}
	if (link) parseLink(link); // a bad link fails here, readably, before anything launches
	const kind = (args.engine || 'browser') === 'wire' ? 'wire' : 'browser';
	if (args.engine && !['browser', 'wire'].includes(args.engine)) throw new Error('--engine is browser or wire');

	if (mode === 'mcp' || mode === 'serve') {
		const m = await import('./mcpServer.js');
		const wantCatalog = mode === 'serve' ? !args['no-static-tools'] : !!args['static-tools'];
		const staticTools = kind === 'wire' ? (await import('./tools.js')).TOOL_SCHEMAS : wantCatalog ? m.catalogHostTools() : undefined;
		const deps = { kind, link, staticTools, makeEngine: (/** @type {string} */ l, /** @type {any} */ name) => makeEngine(args, l, name) };
		if (mode === 'serve') {
			const { runHttp } = await import('./httpServer.js');
			await runHttp(args, deps);
		} else await m.runMcp(args, deps);
		return;
	}
	if (!link) throw new Error(mode + ' needs a session link: theprototype-agent ' + mode + ' https://theprototype.app/#<id>');
	if (mode === 'smoke') return runSmoke(args, link);
	if (mode === 'repl') {
		const { runRepl } = await import('./repl.js');
		return runRepl(args, link, (/** @type {string} */ l) => makeEngine(args, l, args.name || 'agent'));
	}
}

main().catch((e) => {
	console.error('[agent] ' + String((e && e.message) || e).split('\n')[0]);
	process.exit(1);
});
