// 71 TR4 — a TURN server small enough to read, for tests only (RFC 5766 over UDP with a long-term
// credential): Allocate, Refresh, CreatePermission, Send + Data indications, ChannelBind + ChannelData.
// It lets a suite run a real relay without coturn or the production box, and it counts the bytes it
// actually carried, which is what proves a connection went through it.
const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC = 0x2112a442;
const A = { USERNAME: 0x0006, MI: 0x0008, ERROR: 0x0009, LIFETIME: 0x000d, PEER: 0x0012, DATA: 0x0013, REALM: 0x0014, NONCE: 0x0015, RELAYED: 0x0016, MAPPED: 0x0020, CHANNEL: 0x000c };
const M = { ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, PERMISSION: 0x008, CHANNEL_BIND: 0x009, BINDING: 0x001 };

function xorAddr(addr, port) {
	const b = Buffer.alloc(8);
	b[1] = 1;
	b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
	addr.split('.').forEach((o, i) => (b[4 + i] = Number(o) ^ ((MAGIC >>> (24 - i * 8)) & 255)));
	return b;
}
function parseXorAddr(b) {
	const port = b.readUInt16BE(2) ^ (MAGIC >>> 16);
	const addr = [0, 1, 2, 3].map((i) => b[4 + i] ^ ((MAGIC >>> (24 - i * 8)) & 255)).join('.');
	return { addr, port };
}
function parse(msg) {
	const type = msg.readUInt16BE(0);
	const len = msg.readUInt16BE(2);
	const attrs = new Map();
	let i = 20;
	while (i + 4 <= 20 + len) {
		const t = msg.readUInt16BE(i);
		const l = msg.readUInt16BE(i + 2);
		attrs.set(t, msg.subarray(i + 4, i + 4 + l));
		i += 4 + l + ((4 - (l % 4)) % 4);
	}
	return { type, method: (type & 0xf) | ((type >> 1) & 0x70) | ((type >> 2) & 0xf80), cls: ((type >> 7) & 2) | ((type >> 4) & 1), txid: msg.subarray(8, 20), attrs };
}
function build(method, cls, txid, attrs, key) {
	const type = (method & 0xf) | ((method & 0x70) << 1) | ((method & 0xf80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);
	const parts = [];
	for (const [t, v] of attrs) {
		const h = Buffer.alloc(4);
		h.writeUInt16BE(t, 0);
		h.writeUInt16BE(v.length, 2);
		parts.push(h, v, Buffer.alloc((4 - (v.length % 4)) % 4));
	}
	let body = Buffer.concat(parts);
	const head = Buffer.alloc(20);
	head.writeUInt16BE(type, 0);
	head.writeUInt32BE(MAGIC, 4);
	Buffer.from(txid).copy(head, 8);
	if (key) {
		head.writeUInt16BE(body.length + 24, 2);
		const mac = crypto.createHmac('sha1', key).update(Buffer.concat([head, body])).digest();
		const h = Buffer.alloc(4);
		h.writeUInt16BE(A.MI, 0);
		h.writeUInt16BE(20, 2);
		body = Buffer.concat([body, h, mac]);
	}
	head.writeUInt16BE(body.length, 2);
	return Buffer.concat([head, body]);
}

/** @param {{host?: string, username?: string, credential?: string}} [opts] */
async function startMiniTurn({ host = '127.0.0.1', username = 'tester', credential = 'relay-test', realm = 'mini' } = {}) {
	const key = crypto.createHash('md5').update(`${username}:${realm}:${credential}`).digest();
	const nonce = Buffer.from(crypto.randomBytes(8).toString('hex'));
	const server = dgram.createSocket('udp4');
	const allocations = new Map();
	const stats = { allocations: 0, relayedOut: 0, relayedIn: 0, peers: new Set(), refusedAuth: 0 };

	const tuple = (r) => `${r.address}:${r.port}`;
	async function allocate(rinfo) {
		const relay = dgram.createSocket('udp4');
		await new Promise((res) => relay.bind(0, host, res));
		const a = { rinfo, relay, channels: new Map(), byPeer: new Map(), perms: new Set() };
		relay.on('message', (data, from) => {
			if (!a.perms.has(from.address)) return;
			stats.relayedIn += data.length;
			const ch = a.byPeer.get(`${from.address}:${from.port}`);
			if (ch) {
				const h = Buffer.alloc(4);
				h.writeUInt16BE(ch, 0);
				h.writeUInt16BE(data.length, 2);
				server.send(Buffer.concat([h, data, Buffer.alloc((4 - (data.length % 4)) % 4)]), rinfo.port, rinfo.address);
			} else {
				server.send(build(M.DATA, 1, crypto.randomBytes(12), [[A.PEER, xorAddr(from.address, from.port)], [A.DATA, data]]), rinfo.port, rinfo.address);
			}
		});
		allocations.set(tuple(rinfo), a);
		stats.allocations++;
		return a;
	}

	server.on('message', async (msg, rinfo) => {
		try {
			// ChannelData
			if ((msg[0] & 0xc0) === 0x40) {
				const a = allocations.get(tuple(rinfo));
				const peer = a?.channels.get(msg.readUInt16BE(0));
				if (!peer) return;
				const data = msg.subarray(4, 4 + msg.readUInt16BE(2));
				stats.relayedOut += data.length;
				a.relay.send(data, peer.port, peer.addr);
				return;
			}
			const m = parse(msg);
			const reply = (cls, attrs, signed = true) => server.send(build(m.method, cls, m.txid, attrs, signed ? key : null), rinfo.port, rinfo.address);
			if (m.method === M.BINDING) return reply(2, [[A.MAPPED, xorAddr(rinfo.address, rinfo.port)]], false);
			if (m.method === M.SEND) {
				const a = allocations.get(tuple(rinfo));
				const peer = parseXorAddr(m.attrs.get(A.PEER));
				if (!a?.perms.has(peer.addr)) return;
				const data = m.attrs.get(A.DATA);
				stats.relayedOut += data.length;
				a.relay.send(data, peer.port, peer.addr);
				return;
			}
			// everything else is authenticated
			if (!m.attrs.has(A.USERNAME) || !m.attrs.has(A.MI)) {
				const err = Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized')]);
				return reply(3, [[A.ERROR, err], [A.REALM, Buffer.from(realm)], [A.NONCE, nonce]], false);
			}
			if (m.attrs.get(A.USERNAME).toString() !== username) {
				stats.refusedAuth++;
				const err = Buffer.concat([Buffer.from([0, 0, 4, 1]), Buffer.from('Unauthorized')]);
				return reply(3, [[A.ERROR, err], [A.REALM, Buffer.from(realm)], [A.NONCE, nonce]], false);
			}
			let a = allocations.get(tuple(rinfo));
			if (m.method === M.ALLOCATE) {
				a = a || (await allocate(rinfo));
				const life = Buffer.alloc(4);
				life.writeUInt32BE(600);
				return reply(2, [[A.RELAYED, xorAddr(host, a.relay.address().port)], [A.LIFETIME, life], [A.MAPPED, xorAddr(rinfo.address, rinfo.port)]]);
			}
			if (m.method === M.REFRESH) {
				const life = Buffer.alloc(4);
				life.writeUInt32BE(m.attrs.get(A.LIFETIME)?.readUInt32BE(0) ?? 600);
				return reply(2, [[A.LIFETIME, life]]);
			}
			if (!a) return reply(3, [[A.ERROR, Buffer.concat([Buffer.from([0, 0, 4, 37]), Buffer.from('No allocation')])]]);
			if (m.method === M.PERMISSION) {
				const peer = parseXorAddr(m.attrs.get(A.PEER));
				a.perms.add(peer.addr);
				stats.peers.add(peer.addr);
				return reply(2, []);
			}
			if (m.method === M.CHANNEL_BIND) {
				const ch = m.attrs.get(A.CHANNEL).readUInt16BE(0);
				const peer = parseXorAddr(m.attrs.get(A.PEER));
				a.perms.add(peer.addr);
				a.channels.set(ch, peer);
				a.byPeer.set(`${peer.addr}:${peer.port}`, ch);
				return reply(2, []);
			}
		} catch (e) {
			console.log('miniTurn: dropped a bad packet: ' + e.message);
		}
	});
	await new Promise((res) => server.bind(0, host, res));
	const port = server.address().port;
	return {
		host,
		port,
		username,
		credential,
		url: `turn:${host}:${port}?transport=udp`,
		stats,
		close() {
			for (const a of allocations.values()) a.relay.close();
			server.close();
		}
	};
}

module.exports = { startMiniTurn };
