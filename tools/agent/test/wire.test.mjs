// Wire engine, test flight 2 (T3/T4/T5): signaling + ICE from the link, TURN from /api/tp/turn,
// and a graceful leave. MOCK peerjs + a fake fetch: no network. Run: node test/wire.test.mjs
import { EventEmitter } from 'node:events';
import { PeerBridge } from '../src/peerBridge.js';
import { fetchTurn, iceServersFrom } from '../src/turn.js';
import { WireEngine } from '../src/wireEngine.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
	if (cond) {
		pass++;
		console.log('PASS ' + name);
	} else {
		fail++;
		console.log('FAIL ' + name);
	}
};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const json = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// --- fetchTurn ---
const good = { urls: ['turn:peerjs.theprototype.app:3478?transport=udp'], username: '1999999999:gabc', credential: 'c2VjcmV0', ttl: 86400, expiresAt: 1999999999 };
let r = await fetchTurn('https://pb.example/api/tp/turn', { fetchImpl: json(200, good), nowS: 1000 });
check('a full credential is taken', r.reason === 'ok' && r.entry.username === good.username && r.entry.urls.length === 1);
r = await fetchTurn('https://pb.example/api/tp/turn', { fetchImpl: json(200, { ...good, credential: '' }), nowS: 1000 });
check('an empty credential is NO credential (libwebrtc refuses the whole connection over it)', r.entry === null && r.reason === 'incomplete credential');
r = await fetchTurn('https://pb.example/api/tp/turn', { fetchImpl: json(200, { ...good, username: '' }), nowS: 1000 });
check('an empty username is no credential either', r.entry === null);
r = await fetchTurn('https://pb.example/api/tp/turn', { fetchImpl: json(200, good), nowS: 2000000000 });
check('an expired credential is refused', r.entry === null && r.reason === 'expired credential');
r = await fetchTurn('https://pb.example/api/tp/turn', { fetchImpl: json(503, { message: 'TURN is not configured' }) });
check('503 (not configured) → none, with the reason', r.entry === null && r.reason === 'HTTP 503');
r = await fetchTurn('https://pb.example/api/tp/turn', {
	fetchImpl: (_u, o) => new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
	timeoutMs: 20
});
check('a hung endpoint times out instead of holding the join', r.entry === null && r.reason === 'timed out');
r = await fetchTurn('https://pb.example/api/tp/turn', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
check('an unreachable endpoint → none', r.entry === null && /ENOTFOUND/.test(r.reason));
check('iceServersFrom: STUN then TURN', JSON.stringify(iceServersFrom(['stun:a:3478'], good)) === JSON.stringify([{ urls: ['stun:a:3478'] }, { urls: good.urls, username: good.username, credential: good.credential }]));
check('iceServersFrom: nothing → []', iceServersFrom([], null).length === 0);

// --- mock peerjs that records its options ---
class MockConn extends EventEmitter {
	constructor(peer) {
		super();
		this.peer = peer;
		this.open = false;
		this.sent = [];
		this.closed = false;
	}
	send(m) {
		this.sent.push(m);
	}
	close() {
		this.closed = true;
		this.open = false;
		this.emit('close');
	}
	_open() {
		this.open = true;
		this.emit('open');
	}
}
/** @type {any[]} */
const peers = [];
class MockPeer extends EventEmitter {
	constructor(id, options) {
		super();
		this.id = id;
		this.options = options;
		this.outConns = [];
		this.destroyed = false;
		peers.push(this);
		setTimeout(() => this.emit('open', id), 1);
	}
	connect(peerId) {
		const c = new MockConn(peerId);
		this.outConns.push(c);
		return c;
	}
	destroy() {
		this.destroyed = true;
	}
	reconnect() {
		this.reconnects = (this.reconnects || 0) + 1;
	}
}

// ICE + signaling reach the Peer (the TURN fetch replaced by a ready list here)
const server = { host: 'peerjs.theprototype.app', port: 443, path: '/peerjs', secure: true };
const ice = iceServersFrom(['stun:peerjs.theprototype.app:3478'], good);
const b = new PeerBridge({ agentId: 'agent1', name: 'Claude', hostId: 'host1', server, iceServers: ice, approvalTimeout: 5000 });
b._Peer = MockPeer;
await b.start();
const p = peers[0];
check('signaling host from the link reaches the Peer', p.options.host === 'peerjs.theprototype.app' && p.options.path === '/peerjs' && p.options.secure === true);
check('STUN + TURN reach the Peer config', p.options.config.iceServers.length === 2 && p.options.config.iceServers[1].credential === good.credential);

// public cloud only when asked: still carries ICE when there is any
const b2 = new PeerBridge({ agentId: 'agent2', hostId: 'host1', server: null, iceServers: [{ urls: ['stun:x:1'] }] });
b2._Peer = MockPeer;
await b2.start();
check('public cloud + STUN: options carry only the config', peers[1].options && !peers[1].options.host && peers[1].options.config.iceServers.length === 1);
b2.shutdown(0);

// connect (whitelisted host: the first conn just opens)
b.connectToHost('host1');
await tick();
const out = p.outConns[0];
out._open();
await tick();
const inbound = new MockConn('peer2');
p.emit('connection', inbound);
inbound._open();
await tick(80);
check('connected', b.state === 'connected');

// --- graceful leave (T5) ---
const outSentBefore = out.sent.length;
const done = b.shutdown(40);
check('state is closed at once (nothing redials)', b.state === 'closed');
const byeOut = out.sent.slice(outSentBefore).find((m) => m.type === 'disconnected');
check('goodbye sent to the host BEFORE closing', !!byeOut && byeOut.peerId === 'agent1' && out.closed === false);
check('goodbye sent on inbound conns too', inbound.sent.some((m) => m.type === 'disconnected' && m.peerId === 'agent1'));
await done;
check('then every conn closes', out.closed && inbound.closed);
check('then the Peer is destroyed', p.destroyed === true);
const outs = p.outConns.length;
p.emit('disconnected');
await tick(2100);
check('a late close/disconnect after leaving does not redial or reconnect', p.outConns.length === outs && !p.reconnects);
check('shutdown twice is harmless', (await b.shutdown()) === undefined);

// --- the TURN fetch inside start() ---
const realFetch = globalThis.fetch;
let asked = null;
globalThis.fetch = async (u) => {
	asked = u;
	return { ok: true, status: 200, json: async () => good };
};
const b3 = new PeerBridge({ agentId: 'agent3', hostId: 'h', server, stun: ['stun:s:3478'], turnApi: 'https://pb.theprototype.app/api/tp/turn' });
b3._Peer = MockPeer;
await b3.start();
globalThis.fetch = realFetch;
check('start() asks the TURN endpoint', asked === 'https://pb.theprototype.app/api/tp/turn');
check('…and the minted credential is on the Peer', peers[2].options.config.iceServers.some((s) => s.username === good.username));
check('status reports TURN ok', b3.status().turn === 'ok');
b3.shutdown(0);

// --- WireEngine wiring: endpoints from the link ---
let seen = null;
const we = new WireEngine({
	link: 'https://theprototype.app/#F0FD3',
	makeBridge: async (hostId, endpoints) => {
		seen = { hostId, endpoints };
		const br = new PeerBridge({ agentId: 'agent4', hostId, server: endpoints.server, iceServers: [] });
		br._Peer = MockPeer;
		return br;
	}
});
check('wire: production link → production signaling (never the public cloud by default)', we.endpoints.server.host === 'peerjs.theprototype.app');
check('wire: production link → PocketBase TURN', we.endpoints.turnApi === 'https://pb.theprototype.app/api/tp/turn');
await we.start();
check('wire: the bridge dials the link\'s host', seen.hostId === 'f0fd3' && we.bridge.hostId === 'f0fd3');
check('wire: describe names the signaling server', we.describe().signaling === 'peerjs.theprototype.app:443/peerjs');
const wpub = new WireEngine({ link: 'F0FD3', server: 'public', makeBridge: async () => null });
check('wire: --peer-server public is the one way to the public cloud', wpub.endpoints.server === null && wpub.describe().signaling === 'public PeerJS cloud');
await we.close();
check('wire: close() leaves', we.bridge === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
