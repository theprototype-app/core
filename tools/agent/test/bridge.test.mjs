// Deterministic test of the PeerBridge approval state machine + send queue, using
// a MOCK peer (no network). Proves the join dance that the cloud e2e exercises:
//   connect -> host closes unknown conn -> awaiting-approval -> host connects back
//   + gossips hosts -> agent reopens a fresh conn -> handshake + flush queue.
// Run: node test/bridge.test.mjs
import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { PeerBridge } from '../src/peerBridge.js';
import { createMsg } from '../src/messages.js';

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
const tick = () => new Promise((r) => setTimeout(r, 5));

// --- mock peerjs ---
class MockConn extends EventEmitter {
	constructor(peer) {
		super();
		this.peer = peer;
		this.open = false;
		this.sent = [];
	}
	send(m) {
		this.sent.push(m);
	}
	close() {
		this.open = false;
		this.emit('close');
	}
	_open() {
		this.open = true;
		this.emit('open');
	}
}
class MockPeer extends EventEmitter {
	constructor(id) {
		super();
		this.id = id;
		this.outConns = [];
		setTimeout(() => this.emit('open', id), 1); // async open like real peerjs
	}
	connect(peerId) {
		const c = new MockConn(peerId);
		this.outConns.push(c);
		return c;
	}
	destroy() {}
	reconnect() {}
}

const run = async () => {
	const bridge = new PeerBridge({ agentId: 'agent1', name: 'agent', hostId: 'host1', approvalTimeout: 5000 });
	bridge._Peer = MockPeer; // inject the mock

	let connected = false;
	bridge.on('connected', () => (connected = true));
	let approvalNeeded = false;
	bridge.on('approval-needed', () => (approvalNeeded = true));

	await bridge.start();
	check('start resolves on peer open', bridge.agentId === 'agent1');

	// queue a mutation BEFORE connecting — must flush on connect
	bridge.broadcast(createMsg('box1', 'Box', [1, 1, 1]));
	check('mutation queues while disconnected', bridge.queue.length === 1);

	bridge.connectToHost('host1');
	await tick();
	const firstConn = bridge.peer.outConns[0];
	check('opened an outgoing conn to the host', firstConn && firstConn.peer === 'host1');

	// host rejects the unknown peer: close without opening
	firstConn.close();
	await tick();
	check('entered awaiting-approval after host closed the conn', bridge.state === 'awaiting-approval');
	check('emitted approval-needed', approvalNeeded === true);
	check('not connected yet', connected === false);

	// human approves: host opens ITS OWN inbound conn and gossips hosts
	const inbound = new MockConn('host1');
	bridge.peer.emit('connection', inbound);
	inbound._open();
	inbound.emit('data', { type: 'hosts', hosts: ['host1'] });
	await tick();

	// the agent should have opened a fresh outgoing conn to the host
	const reConn = bridge.peer.outConns.find((c, i) => i > 0 && c.peer === 'host1');
	check('reopened a fresh outgoing conn after the hosts gossip', !!reConn);

	reConn._open();
	await tick();

	check('reached connected', connected === true && bridge.everConnected);
	check('state is connected', bridge.state === 'connected');

	// handshake was sent on the reopened conn (locked, hosts, userdata) — NO modules
	const types = reConn.sent.map((m) => m.type);
	check('handshake sent locked+hosts+userdata', types.includes('locked') && types.includes('hosts') && types.includes('userdata'));
	check('handshake OMITS modules', !types.includes('modules'));
	const userRow = reConn.sent.find((m) => m.type === 'userdata').userdata[0];
	check('userdata carries the agent name', userRow[0] === 'agent1' && userRow[1] === 'agent');

	// the queued mutation flushed on connect
	check('queued create flushed to the host', reConn.sent.some((m) => m.type === 'create' && m.uuid === 'box1'));
	check('registry recorded the flushed create', bridge.registry.objects.has('box1'));

	// a further broadcast goes straight out
	bridge.broadcast(createMsg('box2', 'Sphere'));
	check('subsequent broadcast sends immediately', reConn.sent.some((m) => m.type === 'create' && m.uuid === 'box2'));

	bridge.shutdown();
	check('shutdown -> closed', bridge.state === 'closed');

	console.log('\n' + pass + ' passed, ' + fail + ' failed');
	process.exit(fail ? 1 : 0);
};

run();
