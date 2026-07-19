// Headless console agent bridge (roadmap #10 B6). Connects the Node PeerBridge to
// a real browser session, approves the join in the app, and asserts the agent's
// scene mutations appear in the browser + it shows in the Users list. The LLM is
// bypassed — we drive the bridge directly.
//
// The agent joins the SAME signaling server the app uses: the self-hosted
// VITE_PEER_* config from .env when present (browsers on theprototype.app:5173
// resolve to it via peerServer.js default mode), else the public PeerJS cloud
// (which rate-limits repeated connects — re-run if it 429s).
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const agentDir = path.resolve(__dirname, '../../tools/agent/src');
const importAgent = (f) => import(pathToFileURL(path.join(agentDir, f)).href);

function serverFromEnv() {
	try {
		const raw = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8');
		/** @type {Record<string, string>} */
		const env = {};
		for (const line of raw.split(/\r?\n/)) {
			const m = line.match(/^\s*(VITE_[A-Z_]+)\s*=\s*(.*)\s*$/);
			if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
		if (!env.VITE_PEER_HOST) return null;
		return {
			host: env.VITE_PEER_HOST,
			port: Number(env.VITE_PEER_PORT) || 443,
			path: env.VITE_PEER_PATH || '/peerjs',
			secure: env.VITE_PEER_SECURE !== 'false',
			key: env.VITE_PEER_KEY || ''
		};
	} catch {
		return null;
	}
}

async function ensurePeerId(peer) {
	await peer.page.waitForFunction(
		() => {
			let id = null;
			window.__stores.peers.subscribe((p) => (id = p && p.peer ? p.peer.id : null))();
			return !!id;
		},
		{ timeout: 30000 }
	);
	return peer.page.evaluate(
		() => new Promise((r) => window.__stores.peers.subscribe((p) => r(p && p.peer ? p.peer.id : null))())
	);
}

const objCount = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g ? g.children.length : 0))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	const hostId = await ensurePeerId(A);
	console.log('host id: ' + hostId);

	const { PeerBridge } = await importAgent('peerBridge.js');
	const { createMsg, colorMsg, moveMsg, deleteMsg } = await importAgent('messages.js');

	const server = serverFromEnv();
	console.log('agent signaling: ' + (server ? server.host + ':' + server.port + server.path : 'public cloud'));
	const bridge = new PeerBridge({ agentId: 'e2eagent', name: 'agent', hostId, server, approvalTimeout: 90000, verbose: true });
	bridge.on('failed', (r) => console.log('[bridge failed] ' + r));

	await bridge.start();
	console.log('agent peer id: ' + bridge.agentId);
	bridge.connectToHost(hostId);

	// approve the join in the app
	await A.page.getByRole('button', { name: 'Approve' }).click({ timeout: 60000 });

	await bridge.waitUntilConnected(90000);
	h.check(true, 'agent bridge reached connected');

	// it shows in the host Users list with the display name (the userdata handshake
	// lands a beat after the conn opens — poll, don't read instantly)
	await h.eventually(
		() =>
			A.page.evaluate(
				(id) =>
					new Promise((r) =>
						window.__stores.userdata.subscribe((rows) => {
							const row = (rows || []).find((u) => u[0] === id);
							r(row ? row[1] : null);
						})()
					),
				bridge.agentId
			),
		(name) => name === 'agent',
		'agent appears in the host Users list as "agent"'
	);

	const base = await objCount(A);

	// create a box, move it, color it -> assert it lands in the host scene
	const id = require('crypto').randomUUID();
	bridge.broadcast(createMsg(id, 'Box', [1, 1, 1]));
	bridge.broadcast(moveMsg(id, [0, 0.5, 0], [0, 0, 0], [1, 1, 1]));
	bridge.broadcast(colorMsg(id, '#22aaff'));

	await h.eventually(() => objCount(A), (n) => n === base + 1, 'agent-created box appears in the host scene');

	const color = await A.page.evaluate(
		(uuid) =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const o = g.getObjectByProperty('uuid', uuid);
					r(o && o.material && o.material.color ? o.material.color.getHexString() : null);
				})()
			),
		id
	);
	h.check(color === '22aaff', 'agent-set color applied on the host');

	// delete it
	bridge.broadcast(deleteMsg(id, bridge.agentId));
	await h.eventually(() => objCount(A), (n) => n === base, 'agent delete removed the box on the host');

	bridge.shutdown();
	await h.finish(browser);
});
