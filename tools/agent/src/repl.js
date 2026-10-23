// REPL mode (roadmap 10 B4 → 55 A3): a readline loop that drives the scene through an
// OpenAI-compatible endpoint's tool calls. Either engine: the browser engine hands the model
// the host app's own tools and system prompt; the wire engine its fixed object catalog.
// Slash commands: /status /tools /raw <tool> <json> /quit.
import readline from 'node:readline';
import { runChat } from './llmClient.js';
import { mapHostTools } from './mcpTools.js';
import { redactLink } from './link.js';

/**
 * @param {Record<string, any>} args
 * @param {string} link
 * @param {(link: string) => any} makeEngine
 */
export async function runRepl(args, link, makeEngine) {
	const cfg = {
		apiUrl: args['api-url'] || process.env.AGENT_API_URL,
		apiKey: args['api-key'] || process.env.AGENT_API_KEY || '',
		model: args.model || process.env.AGENT_MODEL
	};
	if (!cfg.apiUrl || !cfg.model) throw new Error('repl needs --api-url and --model (or env AGENT_API_URL / AGENT_MODEL)');

	const engine = makeEngine(link);
	const quit = async (/** @type {number} */ code) => {
		await engine.close().catch(() => {});
		process.exit(code);
	};
	process.on('SIGINT', () => quit(0));
	console.error('[agent] joining ' + redactLink(link) + ' (' + engine.kind + ' engine)…');
	await engine.start();
	console.error('[agent] waiting for the host to let us in (Approve, or an invite link)…');
	const t0 = Date.now();
	while (!(await engine.joined())) {
		if (Date.now() - t0 > (Number(args['approval-timeout']) || 120) * 1000) {
			console.error('[agent] not let in within the approval timeout');
			return quit(1);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	console.error('[agent] in the session. Type a request, or /help. Ctrl+C to quit.\n');

	const toolsFor = async () => mapHostTools(await engine.tools(), []).tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
	/** @type {any[]} */
	const history = [{ role: 'system', content: await engine.systemPrompt() }];

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'scene> ' });
	rl.prompt();

	rl.on('line', async (line) => {
		const text = line.trim();
		if (!text) return rl.prompt();
		rl.pause();
		try {
			if (text.startsWith('/')) await handleSlash(text, engine, rl, toolsFor);
			else {
				history.push({ role: 'user', content: text });
				const reply = await runChat({
					cfg,
					messages: history,
					tools: await toolsFor(),
					executeTool: (name, a) => engine.exec(name, a),
					onTool: (name, a) => console.log('  · ' + name + ' ' + summarizeArgs(a))
				});
				if (reply) console.log('\n' + reply + '\n');
			}
		} catch (e) {
			console.error('[agent] error: ' + /** @type {any} */ (e).message + '\n');
		}
		rl.resume();
		rl.prompt();
	});
	rl.on('close', () => quit(0));
}

/** @param {any} a */
function summarizeArgs(a) {
	for (const k of ['objects', 'updates', 'uuids', 'nodes']) if (Array.isArray(a?.[k])) return '(' + a[k].length + ' ' + k + ')';
	return '';
}

/** @param {string} text @param {any} engine @param {any} rl @param {() => Promise<any[]>} toolsFor */
async function handleSlash(text, engine, rl, toolsFor) {
	const [cmd, ...rest] = text.slice(1).split(/\s+/);
	if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') return rl.close();
	if (cmd === 'status') console.log(JSON.stringify({ ...engine.describe(), session: await engine.status() }, null, 2));
	else if (cmd === 'tools') for (const t of await toolsFor()) console.log('  ' + t.name);
	else if (cmd === 'raw') {
		const [name, ...json] = rest;
		try {
			console.log(JSON.stringify(await engine.exec(name, json.length ? JSON.parse(json.join(' ')) : {}), null, 2));
		} catch (e) {
			console.log('bad call: ' + /** @type {any} */ (e).message);
		}
	} else if (cmd === 'help') console.log('/status  /tools  /raw <tool> <json>  /quit — anything else is a request for the model');
	else console.log('unknown command /' + cmd + ' (try /help)');
}
