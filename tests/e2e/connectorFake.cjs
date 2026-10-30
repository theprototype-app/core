// 86 — the connector's FAKE half for e2e: the cloud plugin's connector provider (a signed-in build) and the
// Durable Object (Playwright's routeWebSocket plays cloud worker-mcp/PROTOCOL.md § 1). Shared by the
// connector-* suites; no server and no Worker are needed.
const RELAY = 'wss://relay.connector.test/mcp/tab/R1';

/** install a fake connector provider (the cloud plugin's half) on a page */
async function installProvider(page, grants = [{ id: 'g_1', client: 'Claude', scopes: ['session:read', 'session:edit'], lastUsed: Date.now() }]) {
	await page.evaluate(
		({ relay, grants }) => {
			window.__connectorFake = { revoked: [], pairs: [] };
			window.__stores.cloudHooks.setConnectorProvider({
				pair: async ({ resume }) => {
					window.__connectorFake.pairs.push(resume ?? null);
					return { wsUrl: relay, pairingToken: 'tpp_e2e_' + window.__connectorFake.pairs.length, expiresAt: Date.now() + 60000, replaces: false, connections: grants };
				},
				connections: async () => ({ connections: grants.filter((g) => !window.__connectorFake.revoked.includes(g.id)), tab: { linked: true } }),
				revoke: async (id) => void window.__connectorFake.revoked.push(id),
				revokeAll: async () => void window.__connectorFake.revoked.push('*'),
				account: () => ({ signedIn: true, name: 'ann' })
			});
		},
		{ relay: RELAY, grants }
	);
}

/** the fake DO: records every frame the tab sends, answers hello with ready, lets the test send calls */
async function fakeRelay(page, url = RELAY) {
	/** @type {any} */
	const relay = { frames: [], sockets: 0, ws: null, closed: [] };
	await page.routeWebSocket(url, (ws) => {
		relay.sockets++;
		relay.ws = ws;
		ws.onMessage((msg) => {
			const text = String(msg);
			let f;
			try {
				f = JSON.parse(text);
			} catch {
				f = { raw: text };
			}
			relay.frames.push({ text, f });
			if (f.type === 'hello') ws.send(JSON.stringify({ type: 'ready', connection: { id: 'L1', client: 'Claude', account: 'ann' }, connections: [{ id: 'g_1', client: 'Claude', scopes: ['session:read', 'session:edit'] }] }));
			if (text === '{"type":"ping"}') ws.send('{"type":"pong"}');
		});
		ws.onClose((code) => relay.closed.push(code));
	});
	relay.call = (id, tool, args = {}, scope = 'edit') => relay.ws.send(JSON.stringify({ type: 'call', id, tool, args, scope, connection: 'g_1', timeoutMs: 120000 }));
	relay.cancel = (id) => relay.ws.send(JSON.stringify({ type: 'cancel', id }));
	/** the tab's answer to one call (or null when none came) */
	relay.answer = async (id, timeout = 20000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < timeout) {
			const a = relay.frames.find((x) => x.f.id === id && (x.f.type === 'result' || x.f.type === 'error'));
			if (a) return a.f;
			await new Promise((r) => setTimeout(r, 150));
		}
		return null;
	};
	return relay;
}

const connectorPhase = (peer) =>
	peer.page.evaluate(() => {
		let s;
		window.__stores.connectorStore.connectorState.subscribe((v) => (s = v))();
		return s.phase;
	});

module.exports = { RELAY, installProvider, fakeRelay, connectorPhase };
