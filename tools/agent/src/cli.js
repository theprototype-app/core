#!/usr/bin/env node
// theprototype-agent CLI (roadmap #10). Joins a session as a peer and builds/edits
// the scene. Modes: --repl (own LLM loop), --mcp (stdio MCP server), --smoke
// (scripted create/move/color/delete for testing).
import { PeerBridge } from './peerBridge.js';
import { uuid, createMsg, moveMsg, colorMsg, deleteMsg } from './messages.js';

/** Minimal argv parser: --flag value | --flag | --flag=value. */
function parseArgs(argv) {
	/** @type {Record<string, any>} */
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const eq = a.indexOf('=');
			if (eq >= 0) {
				out[a.slice(2, eq)] = a.slice(eq + 1);
			} else {
				const key = a.slice(2);
				const next = argv[i + 1];
				if (next && !next.startsWith('--')) {
					out[key] = next;
					i++;
				} else out[key] = true;
			}
		} else out._.push(a);
	}
	return out;
}

function parseServer(args) {
	// --peer-server host:port[:insecure]  (default: public cloud). Path defaults to
	// /peerjs — the app's self-hosted convention (Settings: Caddy/TLS, 443, /peerjs).
	if (!args['peer-server']) return null;
	const [host, port, insecure] = String(args['peer-server']).split(':');
	return {
		host,
		port: Number(port) || 443,
		secure: insecure !== 'insecure',
		path: args['peer-path'] || '/peerjs',
		key: args['peer-key'] || ''
	};
}

function makeBridge(args) {
	return new PeerBridge({
		agentId: args.id || 'agt' + Math.floor(Math.random() * 90000 + 10000).toString(36),
		name: args.name || 'agent',
		hostId: args.peer || null,
		server: parseServer(args),
		approvalTimeout: args['approval-timeout'] ? Number(args['approval-timeout']) * 1000 : 120000,
		verbose: !!args.verbose
	});
}

// (peerBridge installs a process-wide guard that swallows transient signaling
// socket errors — e.g. the public cloud's 429 — so they don't crash the process.)

async function runSmoke(args) {
	if (!args.peer) {
		console.error('--smoke needs --peer <hostId>');
		process.exit(2);
	}
	const bridge = makeBridge(args);
	bridge.on('approval-needed', () => console.error('[agent] waiting for the host to APPROVE the join…'));
	await bridge.start();
	console.error('[agent] peer id: ' + bridge.agentId + ' — connecting to host ' + args.peer);
	bridge.connectToHost(args.peer);
	await bridge.waitUntilConnected();
	console.error('[agent] connected. Running scripted mutations…');

	const id = uuid();
	bridge.broadcast(createMsg(id, 'Box', [1, 1, 1]));
	console.error('  created box ' + id);
	await sleep(600);
	bridge.broadcast(moveMsg(id, [0, 0.5, 0], [0, 0, 0], [1, 1, 1]));
	console.error('  moved box up');
	await sleep(600);
	bridge.broadcast(colorMsg(id, '#22aaff'));
	console.error('  colored box blue');
	await sleep(1200);
	bridge.broadcast(deleteMsg(id, bridge.agentId));
	console.error('  deleted box');
	await sleep(800);
	console.error('[agent] smoke OK. status: ' + JSON.stringify(bridge.status()));
	bridge.shutdown();
	process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
	console.error(
		[
			'theprototype-agent — join a session as a peer and build the scene',
			'',
			'Usage:',
			'  node src/cli.js --repl  --peer <hostId> [--api-url URL --api-key KEY --model M]',
			'  node src/cli.js --mcp   [--peer <hostId>]',
			'  node src/cli.js --smoke --peer <hostId>',
			'',
			'Flags:',
			'  --peer <hostId>        the session peer id to join (from the app Connect box)',
			'  --name <display>       display name in the session (default "agent")',
			'  --id <id>              stable peer id (a whitelisted id rejoins without approval)',
			'  --peer-server h:p[:insecure]   use a local PeerServer instead of the public cloud',
			'  --approval-timeout <s> seconds to wait for the host to approve (default 120)',
			'  --api-url / --api-key / --model   OpenAI-compatible endpoint for --repl',
			'                         (or env AGENT_API_URL / AGENT_API_KEY / AGENT_MODEL)',
			'  --verbose              log the connection state machine'
		].join('\n')
	);
}

const args = parseArgs(process.argv.slice(2));

if (args.smoke) {
	runSmoke(args).catch((e) => {
		console.error('[agent] smoke failed: ' + e.message);
		process.exit(1);
	});
} else if (args.repl) {
	import('./repl.js').then((m) => m.runRepl(args, makeBridge)).catch((e) => {
		console.error('[agent] repl failed: ' + e.message);
		process.exit(1);
	});
} else if (args.mcp) {
	import('./mcpServer.js').then((m) => m.runMcp(args, makeBridge)).catch((e) => {
		console.error('[agent] mcp failed: ' + e.message);
		process.exit(1);
	});
} else {
	usage();
	process.exit(args.help ? 0 : 2);
}
