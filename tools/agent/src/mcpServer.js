// MCP mode (roadmap #10 B5): a stdio MCP server exposing the scene tools so any
// MCP host (Claude Code, etc.) can drive the session. The server starts
// IMMEDIATELY and connects to the session in the background — tools report
// "awaiting approval" until connected, so tool registration never blocks on the
// human approval step.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { executeTool, TOOL_SCHEMAS } from './tools.js';

/**
 * @param {Record<string, any>} args
 * @param {(args: any) => import('./peerBridge.js').PeerBridge} makeBridge
 */
export async function runMcp(args, makeBridge) {
	let bridge = null;
	let connecting = false;

	const startBridge = async (hostId) => {
		if (bridge && bridge.hostId === hostId && bridge.everConnected) return bridge.status();
		if (connecting) return { state: 'connecting', note: 'a connection attempt is already in progress' };
		connecting = true;
		bridge = makeBridge({ ...args, peer: hostId });
		try {
			await bridge.start();
			bridge.connectToHost(hostId);
			// do NOT await approval here — return and let tools poll status
			bridge.waitUntilConnected().catch(() => {});
		} catch (e) {
			connecting = false;
			return { state: 'error', error: e.message };
		}
		connecting = false;
		return bridge.status();
	};

	// If a host was given up front, begin connecting in the background.
	if (args.peer) startBridge(args.peer);

	const server = new Server(
		{ name: 'theprototype-agent', version: '0.1.0' },
		{ capabilities: { tools: {} } }
	);

	const connectTool = {
		name: 'connect',
		description: 'Join a theprototype.app session by its peer id (from the app Connect box). Returns immediately; a human must Approve the join in the app before edits take effect. Poll get_status.',
		inputSchema: { type: 'object', properties: { peer_id: { type: 'string' } }, required: ['peer_id'] }
	};

	const allTools = [connectTool, ...TOOL_SCHEMAS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))];

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const name = req.params.name;
		const a = req.params.arguments || {};
		const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

		if (name === 'connect') {
			const status = await startBridge(a.peer_id);
			return text({ ...status, note: 'If not yet connected, ask the host to Approve the join, then call get_status.' });
		}
		if (name === 'get_status') {
			return text(bridge ? bridge.status() : { state: 'idle', note: 'not connected — call connect first' });
		}
		if (!bridge || !bridge.everConnected) {
			return text({
				error: 'not connected',
				state: bridge ? bridge.state : 'idle',
				note: bridge
					? 'awaiting human approval in the session (state=' + bridge.state + '). Ask the host to Approve, then retry.'
					: 'call connect with the session peer id first'
			});
		}
		const result = executeTool(bridge, name, a);
		return text(result);
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error('[agent] MCP stdio server ready' + (args.peer ? ' (connecting to ' + args.peer + '…)' : ' (call connect to join a session)'));
}
