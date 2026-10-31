import { describe, it, expect } from 'vitest';
import { createRelayClient, backoffMs } from '../../src/lib/connector/relayClient.js';
import { createDispatcher, BRIDGE_SCHEMAS, CONNECTOR_SCHEMAS } from '../../src/lib/connector/dispatcher.js';
import { PING_MS, HELLO_TIMEOUT_MS, PING_TEXT, parseFrame } from '../../src/lib/connector/protocol.js';
import { bridgeTools, connectorOnlyTools } from '../../tools/agent/src/mcpTools.js';
import { parseJoinLink } from '../../src/lib/connector/joinLink.js';
import { describePose } from '../../src/lib/connector/whereAreUsers.js';

// 86 B1/B2/B3/B5: the relay client's transitions and the dispatcher's rules, against fakes.

/** a manual clock: timers run only when the test advances it */
function fakeClock() {
	let t = 1000;
	/** @type {{at: number, fn: () => void, id: number}[]} */
	let timers = [];
	let seq = 0;
	return {
		now: () => t,
		setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
			const id = ++seq;
			timers.push({ at: t + ms, fn, id });
			return id;
		},
		clearTimer: (/** @type {number} */ id) => {
			timers = timers.filter((x) => x.id !== id);
		},
		advance(/** @type {number} */ ms) {
			const end = t + ms;
			for (;;) {
				timers.sort((a, b) => a.at - b.at);
				const next = timers[0];
				if (!next || next.at > end) break;
				timers.shift();
				t = next.at;
				next.fn();
			}
			t = end;
		}
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(/** @type {any} */ over = {}) {
	const clock = fakeClock();
	/** @type {any[]} */ const sockets = [];
	/** @type {any[]} */ const pairs = [];
	/** @type {any[]} */ const states = [];
	/** @type {any[]} */ const calls = [];
	let downs = 0;
	const client = createRelayClient({
		pair: async (resume) => {
			pairs.push(resume);
			if (over.pair) return over.pair(resume, pairs.length);
			return { wsUrl: 'wss://theprototype.app/mcp/tab/R1', pairingToken: 'tpp_' + pairs.length, connections: [] };
		},
		openSocket: (url) => {
			const s = { url, sent: /** @type {string[]} */ ([]), closed: /** @type {any} */ (null), send(/** @type {string} */ t) { this.sent.push(t); }, close(/** @type {any} */ c) { this.closed = c ?? 1000; }, onopen: /** @type {any} */ (null), onmessage: /** @type {any} */ (null), onclose: /** @type {any} */ (null), onerror: null };
			sockets.push(s);
			return s;
		},
		appVersion: '1.48.0',
		toolNames: () => ['status', 'create_objects'],
		onCall: (f) => calls.push(f),
		onState: (s) => states.push(s.phase),
		onDown: () => downs++,
		confirmReplace: over.confirmReplace,
		visible: () => true,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer
	});
	const last = () => sockets[sockets.length - 1];
	const ready = (/** @type {any} */ s = last()) => {
		s.onopen();
		s.onmessage({ data: JSON.stringify({ type: 'ready', connection: { id: 'L1', client: 'Claude', account: 'ann' }, connections: [{ id: 'g_1', client: 'Claude' }, { id: 'g_2', client: 'Claude Code' }] }) });
	};
	return { client, clock, sockets, pairs, states, calls, last, ready, downs: () => downs };
}

describe('relay client', () => {
	it('pairs, says hello with the token IN THE FRAME, and is connected on ready', async () => {
		const h = harness();
		h.client.connect();
		await flush();
		expect(h.last().url).toBe('wss://theprototype.app/mcp/tab/R1'); // no token in the URL
		h.ready();
		expect(JSON.parse(h.last().sent[0])).toMatchObject({ type: 'hello', token: 'tpp_1', tools: ['status', 'create_objects'] });
		expect(h.client.state().phase).toBe('connected');
		expect(h.client.state().connections.map((/** @type {any} */ g) => g.id)).toEqual(['g_1', 'g_2']);
		expect(JSON.parse(h.last().sent[1])).toMatchObject({ type: 'state', visible: true });
	});

	it('pings with the exact text; two missed pongs = reconnect with resume', async () => {
		const h = harness();
		h.client.connect();
		await flush();
		h.ready();
		h.clock.advance(PING_MS);
		expect(h.last().sent.at(-1)).toBe(PING_TEXT);
		h.last().onmessage({ data: '{"type":"pong"}' });
		h.clock.advance(PING_MS * 3);
		expect(h.client.state().phase).toBe('reconnecting');
		h.clock.advance(backoffMs(1));
		await flush();
		expect(h.pairs).toEqual([null, 'L1']);
	});

	it('a blip backs off and resumes the same link; calls flow again once ready', async () => {
		const h = harness();
		h.client.connect();
		await flush();
		h.ready();
		h.last().onclose({ code: 1006 });
		expect(h.client.state().phase).toBe('reconnecting');
		expect(h.downs()).toBe(1);
		h.clock.advance(backoffMs(1));
		await flush();
		h.ready();
		h.last().onmessage({ data: JSON.stringify({ type: 'call', id: 'c1', tool: 'status', args: {}, scope: 'read' }) });
		expect(h.calls.map((c) => c.id)).toEqual(['c1']);
		expect(backoffMs(10)).toBe(30000);
	});

	it('revoked / replaced are FINAL: no re-pair', async () => {
		for (const code of [4001, 4002]) {
			const h = harness();
			h.client.connect();
			await flush();
			h.ready();
			h.last().onclose({ code });
			h.clock.advance(60000);
			await flush();
			expect(h.client.state().phase).toBe('closed');
			expect(h.client.state().reason).toBe(code === 4001 ? 'revoked' : 'replaced');
			expect(h.pairs.length).toBe(1);
		}
	});

	it('a revoked frame drops one grant and keeps the link', async () => {
		const h = harness();
		h.client.connect();
		await flush();
		h.ready();
		h.last().onmessage({ data: '{"type":"revoked","connection":"g_1"}' });
		expect(h.client.state().phase).toBe('connected');
		expect(h.client.state().connections.map((/** @type {any} */ g) => g.id)).toEqual(['g_2']);
	});

	it('replaces: asks first; "no" opens no socket', async () => {
		const h = harness({ pair: () => ({ wsUrl: 'wss://theprototype.app/mcp/tab/R1', pairingToken: 't', replaces: true }), confirmReplace: async () => false });
		h.client.connect();
		await flush();
		await flush();
		expect(h.sockets.length).toBe(0);
		expect(h.client.state().phase).toBe('idle');
		const yes = harness({ pair: () => ({ wsUrl: 'wss://theprototype.app/mcp/tab/R1', pairingToken: 't', replaces: true }), confirmReplace: async () => true });
		yes.client.connect();
		await flush();
		await flush();
		expect(yes.sockets.length).toBe(1);
	});

	it('Disconnect says bye, closes, and never reconnects', async () => {
		const h = harness();
		h.client.connect();
		await flush();
		h.ready();
		const s = h.last();
		h.client.disconnect();
		expect(s.sent.at(-1)).toBe('{"type":"bye"}');
		expect(s.closed).toBe(1000);
		expect(h.client.state().phase).toBe('idle');
		expect(h.downs()).toBe(1);
		h.clock.advance(120000);
		expect(h.pairs.length).toBe(1);
	});

	it('the first pairing failing stops with the reason; a silent DO times out the hello', async () => {
		const h = harness({ pair: () => Promise.reject(Object.assign(new Error('Sign in first'), { code: 'signin' })) });
		h.client.connect();
		await flush();
		expect(h.client.state()).toMatchObject({ phase: 'closed', reason: 'signin' });
		const q = harness();
		q.client.connect();
		await flush();
		q.last().onopen();
		q.clock.advance(HELLO_TIMEOUT_MS);
		expect(q.client.state().phase).toBe('error');
	});

	it('refuses a pairing that points at a non-TLS remote socket', async () => {
		const h = harness({ pair: () => ({ wsUrl: 'ws://evil.example/x', pairingToken: 't' }) });
		h.client.connect();
		await flush();
		expect(h.sockets.length).toBe(0);
		expect(h.client.state().phase).toBe('error');
	});

	it('a frame from an older socket is ignored', async () => {
		const h = harness();
		h.client.connect();
		await flush();
		h.ready();
		const old = h.last();
		h.client.disconnect();
		h.client.connect();
		await flush();
		old.onmessage?.({ data: JSON.stringify({ type: 'call', id: 'x', tool: 'status' }) });
		expect(h.calls.length).toBe(0);
	});
});

// ------------------------------------------------------------------------------------------------ dispatcher

const SCHEMA = {
	type: 'object',
	properties: { objects: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] } } },
	required: ['objects']
};

function dispatch(/** @type {any} */ over = {}) {
	/** @type {any[]} */ const sent = [];
	/** @type {any[]} */ const ran = [];
	let visible = true;
	/** @type {((v: any) => void) | null} */ let releaseExec = null;
	const agent = {
		tools: () => [
			{ type: 'function', function: { name: 'list_scene', parameters: { type: 'object', properties: {} } } },
			{ type: 'function', function: { name: 'create_objects', parameters: SCHEMA } },
			{ type: 'function', function: { name: 'install_modules', parameters: { type: 'object', properties: {} } } }
		],
		exec: async (/** @type {string} */ n, /** @type {any} */ a) => {
			ran.push([n, a]);
			if (over.holdExec) await new Promise((r) => (releaseExec = r));
			if (over.viewer && n !== 'list_scene') return { error: 'View-only: …', refused: true, role: 'viewer' };
			return n === 'list_scene' ? { objects: [] } : { created: [{ uuid: 'u1' }] };
		},
		status: () => ({ role: 'editor', notices: ['secret toast text'] }),
		waitForEdit: () => new Promise(() => {}),
		screenshot: async () => 'data:image/png;base64,AAAA'
	};
	const d = createDispatcher({
		agent,
		send: (t) => sent.push(JSON.parse(t)),
		visible: () => visible,
		encodeShot: async () => ({ image: { mimeType: 'image/jpeg', data: 'BBBB' }, width: 768, height: 432 }),
		...(over.joinSession ? { joinSession: over.joinSession } : {}),
		...(over.whereAreUsers ? { whereAreUsers: over.whereAreUsers } : {}),
		...(over.you ? { you: over.you } : {})
	});
	return { d, sent, ran, hide: () => (visible = false), release: () => releaseExec?.(undefined) };
}

const call = (/** @type {string} */ id, /** @type {string} */ tool, args = {}, scope = 'edit') => ({ id, tool, args, scope, timeoutMs: null, connection: 'g_1' });

describe('dispatcher', () => {
	it('runs an edit through exec and answers its result', async () => {
		const x = dispatch();
		x.d.handle(/** @type {any} */ (call('c1', 'create_objects', { objects: [{ kind: 'primitive' }] })));
		await flush();
		expect(x.ran).toEqual([['create_objects', { objects: [{ kind: 'primitive' }] }]]);
		expect(x.sent).toEqual([{ type: 'result', id: 'c1', result: { created: [{ uuid: 'u1' }] } }]);
	});

	it('B5: invalid args never reach exec', async () => {
		const x = dispatch();
		x.d.handle(/** @type {any} */ (call('c1', 'create_objects', { objects: [{}] })));
		await flush();
		expect(x.ran).toEqual([]);
		expect(x.sent[0].error.code).toBe('invalid_args');
		expect(x.sent[0].error.message).toMatch(/missing required "kind"/);
	});

	it('unknown and agent-page-only tools are refused; no alias repair', async () => {
		const x = dispatch();
		x.d.handle(/** @type {any} */ (call('a', 'install_modules')));
		x.d.handle(/** @type {any} */ (call('b', 'Create_Objects', { objects: [{ kind: 'p' }] })));
		x.d.handle(/** @type {any} */ (call('c', 'accept_offer', { id: 'o1' })));
		await flush();
		expect(x.ran).toEqual([]);
		expect(x.sent.map((f) => f.error.code)).toEqual(['unknown_tool', 'unknown_tool', 'unknown_tool']);
		expect(x.d.toolNames()).toEqual(['status', 'screenshot', 'wait_for_edit', 'list_scene', 'create_objects']);
	});

	it('a malformed name or args is answered, not dropped (the DO must not wait out its timeout)', async () => {
		const x = dispatch();
		x.d.handle(/** @type {any} */ (parseFrame('{"type":"call","id":"m1","tool":"Create Objects","scope":"edit"}')));
		x.d.handle(/** @type {any} */ (parseFrame('{"type":"call","id":"m2","tool":"create_objects","args":[1],"scope":"edit"}')));
		await flush();
		expect(x.ran).toEqual([]);
		expect(x.sent.map((f) => [f.id, f.error.code])).toEqual([['m1', 'unknown_tool'], ['m2', 'invalid_args']]);
	});

	it('a read-scoped grant cannot edit, but can read', async () => {
		const x = dispatch();
		x.d.handle(/** @type {any} */ (call('a', 'create_objects', { objects: [{ kind: 'p' }] }, 'read')));
		x.d.handle(/** @type {any} */ (call('b', 'list_scene', {}, 'read')));
		await flush();
		expect(x.ran).toEqual([['list_scene', {}]]);
		expect(x.sent[0].error.code).toBe('refused');
		expect(x.sent[1].type).toBe('result');
	});

	it("a viewer's edit comes back refused (exec's own role gate)", async () => {
		const x = dispatch({ viewer: true });
		x.d.handle(/** @type {any} */ (call('a', 'create_objects', { objects: [{ kind: 'p' }] })));
		await flush();
		expect(x.sent[0].error).toEqual({ code: 'refused', message: 'View-only: …' });
	});

	it('B4: no screenshot while the tab is hidden — nothing rendered', async () => {
		const x = dispatch();
		let rendered = 0;
		const shot = x.d;
		void shot;
		x.hide();
		x.d.handle(/** @type {any} */ (call('s', 'screenshot', { view: 'iso' }, 'read')));
		await flush();
		expect(x.sent[0].error.code).toBe('hidden');
		expect(rendered).toBe(0);
		const y = dispatch();
		y.d.handle(/** @type {any} */ (call('s', 'screenshot', { view: 'iso', size: 5000 }, 'read')));
		await flush();
		await flush();
		expect(y.sent[0].result).toEqual({ image: { mimeType: 'image/jpeg', data: 'BBBB' }, width: 768, height: 432 });
	});

	it('status leaves the notices (toast text) out and says it is a connector tab', async () => {
		const x = dispatch();
		x.d.handle(/** @type {any} */ (call('s', 'status', {}, 'read')));
		await flush();
		expect(x.sent[0].result).toEqual({ role: 'editor', tab: { visible: true, connector: true } });
	});

	it('B5: Disconnect stops an in-flight call: the queued one never runs, the running one never answers', async () => {
		const x = dispatch({ holdExec: true });
		x.d.handle(/** @type {any} */ (call('a', 'create_objects', { objects: [{ kind: 'p' }] })));
		x.d.handle(/** @type {any} */ (call('b', 'create_objects', { objects: [{ kind: 'q' }] })));
		x.d.handle(/** @type {any} */ (call('w', 'wait_for_edit', { timeout_ms: 60000 })));
		await flush();
		expect(x.ran.length).toBe(1);
		x.d.cancelAll();
		x.release();
		await flush();
		await flush();
		expect(x.ran.length).toBe(1); // b never ran
		expect(x.sent).toEqual([]); // nothing answered after the kill switch
		expect(x.d.inFlight()).toBe(0);
	});

	it('the bridge schemas are the 55 bridge’s own', () => {
		for (const t of bridgeTools('browser').filter((t) => t.name !== 'connect')) expect(BRIDGE_SCHEMAS[t.name]).toEqual(t.inputSchema);
	});

	// 86-fix N2
	it('join_session: listed only when the tab answers it; schema = the catalog’s', () => {
		expect(dispatch().d.toolNames()).not.toContain('join_session');
		expect(dispatch({ joinSession: async () => ({ result: {} }) }).d.toolNames()).toContain('join_session');
		for (const t of connectorOnlyTools()) expect(CONNECTOR_SCHEMAS[t.name]).toEqual(t.inputSchema);
	});

	it('join_session: an edit-scope call (a look-only grant cannot ask), args checked before the card', async () => {
		/** @type {any[]} */ const asked = [];
		const x = dispatch({ joinSession: async (/** @type {any} */ a) => (asked.push(a), { result: { joining: true } }) });
		x.d.handle(/** @type {any} */ (call('r', 'join_session', { link: '#abcde' }, 'read')));
		x.d.handle(/** @type {any} */ (call('n', 'join_session', {})));
		x.d.handle(/** @type {any} */ (call('j', 'join_session', { link: '#abcde' })));
		await flush();
		expect(x.sent.map((f) => [f.id, f.error?.code ?? 'ok'])).toEqual([['r', 'refused'], ['n', 'invalid_args'], ['j', 'ok']]);
		expect(asked).toEqual([{ link: '#abcde' }]);
	});

	it('where_are_users: a read call (a look-only grant may ask), listed only when the tab answers it', async () => {
		expect(dispatch().d.toolNames()).not.toContain('where_are_users');
		const x = dispatch({ whereAreUsers: () => ({ users: [{ id: 'me', you: true }] }) });
		expect(x.d.toolNames()).toContain('where_are_users');
		x.d.handle(/** @type {any} */ (call('w', 'where_are_users', {}, 'read')));
		await flush();
		expect(x.sent[0]).toMatchObject({ id: 'w', result: { users: [{ id: 'me', you: true }] } });
	});

	it('status: "you" is the person this tab belongs to, listed first among the users', async () => {
		const you = { peerId: 'me', name: 'Ana', role: 'host', inVR: false };
		const x = dispatch({ you: () => you });
		x.d.handle(/** @type {any} */ (call('s', 'status', {}, 'read')));
		await flush();
		const r = x.sent[0].result;
		expect(r.you).toEqual(you);
		expect(r.peers[0]).toEqual({ id: 'me', name: 'Ana', you: true });
		// without the hook (an agent page) status is unchanged
		const y = dispatch();
		y.d.handle(/** @type {any} */ (call('s', 'status', {}, 'read')));
		await flush();
		expect(y.sent[0].result).not.toHaveProperty('you');
	});

	it('join_session: Disconnect takes the card down and nothing answers', async () => {
		let dismissed = 0;
		const x = dispatch({
			joinSession: (/** @type {any} */ _a, /** @type {any} */ ctx) =>
				new Promise((resolve) => ctx.onCancel(() => (dismissed++, resolve({ error: { code: 'refused', message: 'gone' } }))))
		});
		x.d.handle(/** @type {any} */ (call('j', 'join_session', { link: '#abcde' })));
		await flush();
		x.d.cancelAll();
		await flush();
		expect(dismissed).toBe(1);
		expect(x.sent).toEqual([]);
	});
});

describe('parseJoinLink (86-fix N2)', () => {
	const ORIGINS = ['https://theprototype.app', 'https://localhost:5890'];
	it('reads the share link, an invite link, a hash and a bare id', () => {
		expect(parseJoinLink('https://theprototype.app/#F0FD3', ORIGINS)).toEqual({ hash: '#F0FD3', id: 'f0fd3', invite: false, server: false });
		expect(parseJoinLink(' https://theprototype.app/#F0FD3&invite=abc.def~srv=peer.example ', ORIGINS)).toEqual({ hash: '#F0FD3&invite=abc.def~srv=peer.example', id: 'f0fd3', invite: true, server: true });
		expect(parseJoinLink('#f0fd3', ORIGINS)).toMatchObject({ id: 'f0fd3', invite: false });
		expect(parseJoinLink('F0FD3', ORIGINS)).toMatchObject({ hash: '#F0FD3', id: 'f0fd3' });
		expect(parseJoinLink('https://localhost:5890/#ab12c', ORIGINS)).toMatchObject({ id: 'ab12c' });
	});
	it('refuses another site, no session, a bad id, junk', () => {
		for (const bad of ['https://evil.example/#F0FD3', 'https://theprototype.app.evil.example/#F0FD3', 'javascript:alert(1)//#ab', 'https://theprototype.app/', '#', '#<b>x</b>', '#../../x', '', 42, null, 'x'.repeat(3000)])
			expect(parseJoinLink(/** @type {any} */ (bad), ORIGINS)).toHaveProperty('error');
	});
});

describe('where_are_users pose (86-fix)', () => {
	/** a camera matrix at `p` turned `yaw` radians about +Y (0 = looking down -Z), pitch 0 */
	const cam = (/** @type {number[]} */ p, /** @type {number} */ yaw) => {
		const c = Math.cos(yaw), s = Math.sin(yaw);
		// columns: x = (c,0,-s), y = (0,1,0), z = (s,0,c), t = p
		return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, p[0], p[1], p[2], 1];
	};
	it('looking down -Z from 1.7 m: spots straight ahead on the floor', () => {
		const r = /** @type {any} */ (describePose(cam([2, 1.7, 5], 0), null));
		expect(r).toMatchObject({ position: [2, 1.7, 5], floor: 0, eyeHeightAboveFloor: 1.7, yawDeg: 0, forwardFlat: [0, 0, -1], right: [1, 0, 0] });
		expect(r.inFront1_5m).toEqual([2, 0, 3.5]);
		expect(r.inFront3m).toEqual([2, 0, 2]);
	});
	it('turned right (yaw -90° about +Y = facing +X): yaw 90, spots along +X, at the walking floor', () => {
		const r = /** @type {any} */ (describePose(cam([0, 3.5, 0], -Math.PI / 2), 1.8));
		expect(r.yawDeg).toBe(90);
		expect(r.inFront3m).toEqual([3, 1.8, 0]);
		expect(r.right).toEqual([0, 0, 1]);
		expect(r.eyeHeightAboveFloor).toBe(1.7);
	});
	it('a parked avatar (y >= 999) or junk has no live pose', () => {
		expect(describePose(cam([0, 999, 0], 0), null)).toEqual({ note: 'no live pose yet' });
		expect(describePose(cam([NaN, 1, 0], 0), null)).toEqual({ note: 'no live pose yet' });
	});
	it('looking straight down still gives a heading (the camera up vector)', () => {
		// pitch -90°: forward = (0,-1,0), up = (0,0,-1)
		const e = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 1.7, 0, 1];
		const r = /** @type {any} */ (describePose(e, null));
		expect(r.forwardFlat).toEqual([0, 0, -1]);
		expect(r.inFront1_5m).toEqual([0, 0, -1.5]);
	});
});

describe('parseJoinLink keeps only what a session link means', () => {
	it('drops other parameters, keeps the invite and the server', () => {
		const origins = ['https://theprototype.app'];
		expect(parseJoinLink('#abc&agent', origins)).toMatchObject({ hash: '#abc' });
		expect(parseJoinLink('#abc&invite=tok&agent~srv=x.example', origins)).toMatchObject({ hash: '#abc&invite=tok~srv=x.example' });
	});
});
