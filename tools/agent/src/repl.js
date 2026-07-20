// REPL mode (roadmap #10 B4): a readline loop that drives the scene through an
// OpenAI-compatible endpoint's tool-calls. Slash commands: /status /list /raw /quit.
import readline from 'node:readline';
import { executeTool, TOOL_SCHEMAS, systemPrompt } from './tools.js';
import { runChat } from './llmClient.js';

/**
 * @param {Record<string, any>} args
 * @param {(args: any) => import('./peerBridge.js').PeerBridge} makeBridge
 */
export async function runRepl(args, makeBridge) {
	const cfg = {
		apiUrl: args['api-url'] || process.env.AGENT_API_URL,
		apiKey: args['api-key'] || process.env.AGENT_API_KEY || '',
		model: args.model || process.env.AGENT_MODEL
	};
	if (!args.peer) throw new Error('--repl needs --peer <hostId>');
	if (!cfg.apiUrl || !cfg.model) throw new Error('--repl needs --api-url and --model (or env AGENT_API_URL / AGENT_MODEL)');

	const bridge = makeBridge(args);
	bridge.on('approval-needed', () => console.error('\n[agent] waiting for the host to APPROVE the join in the app…'));
	await bridge.start();
	console.error('[agent] peer id: ' + bridge.agentId + ' (name "' + bridge.name + '") — joining host ' + args.peer);
	bridge.connectToHost(args.peer);
	try {
		await bridge.waitUntilConnected();
	} catch (e) {
		console.error('[agent] ' + e.message);
		bridge.shutdown();
		process.exit(1);
	}
	console.error('[agent] connected. Type a request, or /help. Ctrl+C to quit.\n');

	/** @type {any[]} */
	const history = [{ role: 'system', content: systemPrompt() }];

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'scene> ' });
	rl.prompt();

	rl.on('line', async (line) => {
		const text = line.trim();
		if (!text) return rl.prompt();

		if (text.startsWith('/')) {
			handleSlash(text, bridge, rl);
			return;
		}

		rl.pause();
		history.push({ role: 'user', content: 'Scene the agent knows: ' + JSON.stringify(bridge.registry.list()) + '\nRequest: ' + text });
		try {
			const reply = await runChat({
				cfg,
				messages: history,
				tools: TOOL_SCHEMAS,
				executeTool: (name, a) => {
					const r = executeTool(bridge, name, a);
					console.log('  · ' + name + ' ' + summarizeArgs(name, a));
					return r;
				}
			});
			if (reply) console.log('\n' + reply + '\n');
		} catch (e) {
			console.error('[agent] error: ' + e.message + '\n');
		}
		rl.resume();
		rl.prompt();
	});

	rl.on('close', () => {
		bridge.shutdown();
		process.exit(0);
	});
}

function summarizeArgs(name, a) {
	if (name === 'create_objects') return '(' + (a.objects?.length ?? 0) + ')';
	if (name === 'update_objects') return '(' + (a.updates?.length ?? 0) + ')';
	if (name === 'delete_objects') return '(' + (a.uuids?.length ?? 0) + ')';
	return '';
}

function handleSlash(text, bridge, rl) {
	const [cmd, ...rest] = text.slice(1).split(/\s+/);
	if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') {
		rl.close();
		return;
	}
	if (cmd === 'status') {
		console.log(JSON.stringify(bridge.status(), null, 2));
	} else if (cmd === 'list') {
		const objs = bridge.registry.list();
		if (!objs.length) console.log('(no tracked objects)');
		else for (const o of objs) console.log('  ' + o.uuid.slice(0, 8) + '  ' + (o.name || o.kind || '?') + '  [' + (o.tracked || 'full') + ']');
	} else if (cmd === 'raw') {
		try {
			const msg = JSON.parse(rest.join(' '));
			bridge.broadcast(msg);
			console.log('sent.');
		} catch (e) {
			console.log('bad JSON: ' + e.message);
		}
	} else if (cmd === 'help') {
		console.log('/status  /list  /raw <json>  /quit — anything else is a natural-language request');
	} else {
		console.log('unknown command /' + cmd + ' (try /help)');
	}
	rl.prompt();
}
