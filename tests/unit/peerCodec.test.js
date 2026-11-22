// @ts-nocheck - hand-built frames
import { describe, it, expect } from 'vitest';
import { pack, unpack } from 'peerjs-js-binarypack';
import { decodeFrame, createJoiner, peerSerializers, SafeBinaryConnection, FRAME_LIMITS, PIECE_BYTES } from '../../src/lib/peerCodec.js';

const bytes = (...b) => new Uint8Array(b).buffer;
const reason = (fn) => {
	try {
		fn();
	} catch (e) {
		return e.reason ?? 'threw ' + e.message;
	}
	return 'no error';
};

/** what PeerJS 1.5's sender produces for a message over one piece (its Chunker) */
function piecesOf(message, id = 1) {
	const blob = pack(message);
	const total = Math.ceil(blob.byteLength / PIECE_BYTES);
	const out = [];
	for (let n = 0, start = 0; start < blob.byteLength; n++, start += PIECE_BYTES)
		out.push(unpack(pack({ __peerData: id, n, data: blob.slice(start, Math.min(blob.byteLength, start + PIECE_BYTES)), total })));
	return out;
}

describe('decodeFrame reads what PeerJS writes, exactly as PeerJS reads it', () => {
	const corpus = [
		0, 1, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 40, -1, -32, -33, -128, -129, -32768, -32769, -(2 ** 31), -(2 ** 31) - 1,
		0.5, -1.25, 1e300, Math.PI, true, false, null,
		'', 'a', 'x'.repeat(15), 'x'.repeat(16), 'x'.repeat(70000), 'héllo wörld', '日本語テキスト', 'emoji \u{1F600} and \u{1F680}', 'ä日\u{1F600}'.repeat(5000),
		[], [1, 2, 3], new Array(20).fill('a'), new Array(70000).fill(1),
		{}, { type: 'move', uuid: 'abc', p: [1.5, -2, 3], q: [0, 0, 0, 1] },
		{ type: 'batch', items: [{ type: 'object', element: { metadata: { version: 4.7 }, object: { children: [{ a: { b: { c: [1, { d: null }] } } }] } } }] },
		Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, i])),
		Object.fromEntries(Array.from({ length: 70000 }, (_, i) => ['k' + i, i % 3]))
	];
	it('every value of the corpus decodes to what the PeerJS decoder gives', () => {
		let checked = 0;
		for (const v of corpus) {
			let frame;
			try {
				frame = pack(v);
			} catch {
				continue; // a value PeerJS cannot send at all (an integer past its packer's range)
			}
			checked++;
			expect(decodeFrame(frame)).toEqual(unpack(frame));
		}
		expect(checked).toBeGreaterThanOrEqual(corpus.length - 3);
	});
	it('binary values come back as ArrayBuffers with the same bytes', () => {
		for (const n of [0, 5, 15, 16, 300, 70000]) {
			const src = new Uint8Array(n).map((_, i) => i * 7);
			const out = decodeFrame(pack({ type: 'objectfile', bytes: src.buffer, view: src }));
			const ref = unpack(pack({ type: 'objectfile', bytes: src.buffer, view: src }));
			expect(out.bytes).toBeInstanceOf(ArrayBuffer);
			expect(new Uint8Array(out.bytes)).toEqual(new Uint8Array(ref.bytes));
			expect(new Uint8Array(out.view)).toEqual(new Uint8Array(ref.view));
		}
	});
});

describe('decodeFrame refuses a stated length the frame does not hold', () => {
	it('array and map counts larger than the bytes left', () => {
		expect(reason(() => decodeFrame(bytes(0xdd, 0xff, 0xff, 0xff, 0xff)))).toBe('count');
		expect(reason(() => decodeFrame(bytes(0xdf, 0xff, 0xff, 0xff, 0xff)))).toBe('count');
		expect(reason(() => decodeFrame(bytes(0xdc, 0x00, 0x05, 1, 2, 3)))).toBe('count');
		expect(reason(() => decodeFrame(bytes(0x93, 1, 2)))).toBe('count');
		// a map needs two bytes per entry
		expect(reason(() => decodeFrame(bytes(0x82, 0xa1, 0x61, 1)))).toBe('count');
	});
	it('strings, binary and fixed-size numbers past the end', () => {
		expect(reason(() => decodeFrame(bytes(0xd9, 0x7f, 0xff, 0xff, 0xff)))).toBe('short');
		expect(reason(() => decodeFrame(bytes(0xdb, 0x7f, 0xff, 0xff, 0xff)))).toBe('short');
		expect(reason(() => decodeFrame(bytes(0xb5, 0x61)))).toBe('short');
		expect(reason(() => decodeFrame(bytes(0xcb, 1, 2)))).toBe('short');
		expect(reason(() => decodeFrame(bytes(0xcd, 1)))).toBe('short');
		expect(reason(() => decodeFrame(bytes()))).toBe('short');
	});
	it('counterfactual: the PeerJS decoder takes the same 5-byte header as a 16M-entry array', () => {
		expect(unpack(bytes(0xdd, 0x01, 0x00, 0x00, 0x00)).length).toBe(2 ** 24);
		expect(reason(() => decodeFrame(bytes(0xdd, 0x01, 0x00, 0x00, 0x00)))).toBe('count');
	});
	it('work is bounded by the bytes: the largest legal count in a frame decodes', () => {
		const n = 1000;
		const frame = new Uint8Array(3 + n);
		frame.set([0xdc, n >> 8, n & 0xff]);
		expect(decodeFrame(frame.buffer)).toHaveLength(n);
	});
	it('nesting deeper than the limit', () => {
		const deep = new Uint8Array(FRAME_LIMITS.depth + 2).fill(0x91);
		expect(reason(() => decodeFrame(deep.buffer))).toBe('depth');
		const ok = new Uint8Array(51).fill(0x91);
		ok[50] = 0x01;
		expect(() => decodeFrame(ok.buffer)).not.toThrow();
	});
	it('a map key that is not a string, or is __proto__', () => {
		expect(reason(() => decodeFrame(bytes(0x81, 0x01, 0x02)))).toBe('key');
		expect(reason(() => decodeFrame(bytes(0x81, 0x91, 0x01, 0x02)))).toBe('key');
		const hand = new Uint8Array([0x81, 0xb9, ...new TextEncoder().encode('__proto__'), 0x80]);
		expect(reason(() => decodeFrame(hand.buffer))).toBe('key');
		// counterfactual: the PeerJS decoder hands back an object whose prototype the sender chose
		expect(Object.getPrototypeOf(unpack(hand.buffer))).not.toBe(Object.prototype);
	});
	it('a code point past U+10FFFF is refused (PeerJS threw a RangeError)', () => {
		expect(reason(() => decodeFrame(bytes(0xa0 + 0x10 + 4, 0xf7, 0xbf, 0xbf, 0xbf)))).toBe('string');
	});
	it('one message creates a bounded number of objects (a one-byte value can be a whole object)', () => {
		const n = 1000;
		// empty array, empty map, empty binary, one-byte binary, one-character string
		for (const el of [0x90, 0x80, 0xa0, 0xa1, 0xb1]) {
			const wide = el === 0xa1 || el === 0xb1;
			const frame = new Uint8Array(3 + n * (wide ? 2 : 1));
			frame.set([0xdc, n >> 8, n & 0xff]);
			for (let i = 0, at = 3; i < n; i++) {
				frame[at++] = el;
				if (wide) frame[at++] = 0x61;
			}
			expect(reason(() => decodeFrame(frame.buffer, { objects: 500 }))).toBe('objects');
			expect(() => decodeFrame(frame.buffer, { objects: 5000 })).not.toThrow();
		}
		// a key repeated through the message costs only once
		const rows = Array.from({ length: 2000 }, (_, i) => ({ uuid: 'u' + i, type: 'Mesh' }));
		const frame = pack(rows);
		expect(decodeFrame(frame, { objects: 2000 * 3 + 10 })).toEqual(unpack(frame));
		expect(reason(() => decodeFrame(frame, { objects: 2000 * 3 - 10 }))).toBe('objects');
		// numbers and empty strings create nothing and cost nothing
		const nums = new Uint8Array(3 + n).fill(0x01);
		nums.set([0xdc, n >> 8, n & 0xff]);
		expect(() => decodeFrame(nums.buffer, { objects: 1 })).not.toThrow();
	});
	it('only an ArrayBuffer or the bytes of a joined message is a frame', () => {
		expect(reason(() => decodeFrame('text'))).toBe('not-bytes');
	});
});

describe('createJoiner puts PeerJS pieces back together within limits', () => {
	it('a message PeerJS sends in pieces comes back whole', () => {
		const message = { type: 'objectfile', bytes: new Uint8Array(100000).map((_, i) => i).buffer, name: 'a.glb' };
		const j = createJoiner();
		let whole = null;
		for (const p of piecesOf(message, 7)) whole = j.add(p) ?? whole;
		expect(j.size).toBe(0);
		const out = decodeFrame(whole.buffer);
		expect(out.name).toBe('a.glb');
		expect(new Uint8Array(out.bytes)).toEqual(new Uint8Array(message.bytes));
	});
	it('a piece whose data is a number, not bytes, allocates nothing and is refused', () => {
		const j = createJoiner();
		expect(reason(() => j.add({ __peerData: 1, n: 0, total: 2, data: 1.5e9 }))).toBe('piece-data');
		expect(j.size).toBe(0);
	});
	it('bad ids, counts and indexes', () => {
		const j = createJoiner();
		const d = new ArrayBuffer(10);
		expect(reason(() => j.add({ __peerData: 'x', n: 0, total: 2, data: d }))).toBe('piece-id');
		expect(reason(() => j.add({ __peerData: 1, n: 0, total: 0, data: d }))).toBe('piece-total');
		expect(reason(() => j.add({ __peerData: 1, n: 0, total: FRAME_LIMITS.pieces + 1, data: d }))).toBe('piece-total');
		expect(reason(() => j.add({ __peerData: 1, n: 2, total: 2, data: d }))).toBe('piece-index');
		expect(reason(() => j.add({ __peerData: 1, n: 'length', total: 2, data: d }))).toBe('piece-index');
		expect(reason(() => j.add({ __peerData: 1, n: 0, total: 2, data: new ArrayBuffer(FRAME_LIMITS.pieceBytes + 1) }))).toBe('piece-data');
		expect(j.add({ __peerData: 1, n: 0, total: 3, data: d })).toBeNull();
		expect(reason(() => j.add({ __peerData: 1, n: 0, total: 3, data: d }))).toBe('piece-again');
		expect(j.size).toBe(0);
		expect(j.add({ __peerData: 2, n: 0, total: 3, data: d })).toBeNull();
		expect(reason(() => j.add({ __peerData: 2, n: 1, total: 4, data: d }))).toBe('piece-total');
	});
	it('a joined message has a size cap', () => {
		const j = createJoiner({ messageBytes: 100 });
		expect(j.add({ __peerData: 3, n: 0, total: 3, data: new ArrayBuffer(60) })).toBeNull();
		expect(reason(() => j.add({ __peerData: 3, n: 1, total: 3, data: new ArrayBuffer(60) }))).toBe('piece-size');
		expect(j.size).toBe(0);
	});
	it('a bounded number of messages are in flight; the oldest makes way and is counted', () => {
		const dropped = [];
		const j = createJoiner({}, (r) => dropped.push(r));
		const d = new ArrayBuffer(4);
		const n = FRAME_LIMITS.partials + 10;
		for (let id = 1; id <= n; id++) j.add({ __peerData: id, n: 0, total: 2, data: d });
		expect(j.size).toBe(FRAME_LIMITS.partials);
		expect(dropped).toEqual(Array(10).fill('piece-dropped'));
		// message 1 went first: its second piece now starts a new, incomplete entry
		expect(j.add({ __peerData: 1, n: 1, total: 2, data: d })).toBe(null);
	});
	it('pieces of several messages may interleave (the app\'s links are unordered)', () => {
		const j = createJoiner();
		const piecesOf = (id, bytes) => {
			const total = Math.ceil(bytes.length / 3);
			return Array.from({ length: total }, (_, n) => ({ __peerData: id, n, total, data: bytes.slice(n * 3, n * 3 + 3).buffer }));
		};
		const a = piecesOf(1, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
		const b = piecesOf(2, new Uint8Array([9, 8, 7, 6, 5]));
		const order = [a[2], b[1], a[0], b[0], a[1]];
		const out = order.map((p) => j.add(p)).filter(Boolean);
		expect(out.map((u) => [...u])).toEqual([[9, 8, 7, 6, 5], [1, 2, 3, 4, 5, 6, 7]]);
		expect(j.size).toBe(0);
		expect(j.held).toBe(0);
	});
	it('bytes held for unfinished messages have one budget per link', () => {
		const dropped = [];
		const j = createJoiner({ heldBytes: 10, messageBytes: 10 }, (r) => dropped.push(r));
		j.add({ __peerData: 1, n: 0, total: 2, data: new ArrayBuffer(6) });
		j.add({ __peerData: 2, n: 0, total: 2, data: new ArrayBuffer(6) });
		expect(dropped).toEqual(['piece-dropped']);
		expect(j.size).toBe(1);
		expect(j.held).toBe(6);
	});
});

describe('SafeBinaryConnection', () => {
	/** a connection object with no RTCPeerConnection behind it: only the receive path runs */
	function rig() {
		const conn = Object.create(SafeBinaryConnection.prototype);
		conn.peer = 'peerX';
		const data = [];
		const refused = [];
		let closed = 0;
		conn.emit = (ev, v) => ev === 'data' && data.push(v);
		conn.close = () => closed++;
		conn._refuse = (r) => refused.push(r);
		return { conn, data, refused, closed: () => closed, frame: (buf) => conn._handleDataMessage({ data: buf }) };
	}
	it('delivers an ordinary message, joins pieces, and honours the close record', () => {
		const r = rig();
		r.frame(pack({ type: 'chat', text: 'hi' }));
		for (const p of piecesOf({ type: 'big', s: 'y'.repeat(50000) }, 9)) r.frame(pack(p));
		r.frame(pack({ __peerData: { type: 'close' } }));
		expect(r.data.map((m) => m.type)).toEqual(['chat', 'big']);
		expect(r.data[1].s.length).toBe(50000);
		expect(r.closed()).toBe(1);
		expect(r.refused).toEqual([]);
	});
	it('skips the malformed frames and keeps going', () => {
		const r = rig();
		r.frame(bytes(0xdf, 0xff, 0xff, 0xff, 0xff));
		r.frame(bytes(0xdd, 0x7f, 0xff, 0xff, 0xff));
		r.frame(pack({ __peerData: 424242, n: 0, total: 2, data: 1.5e9 }));
		r.frame(bytes(0xc0));
		// a joined message that is itself a piece
		for (const p of piecesOf({ __peerData: 5, n: 0, total: 1, data: new ArrayBuffer(4), pad: 'z'.repeat(20000) }, 11)) r.frame(pack(p));
		r.frame(new ArrayBuffer(FRAME_LIMITS.frameBytes + 1));
		r.frame(pack({ type: 'chat', text: 'still here' }));
		expect(r.refused).toEqual(['count', 'count', 'piece-data', 'empty', 'piece-nested', 'frame-size']);
		expect(r.data.map((m) => m.text)).toEqual(['still here']);
	});
	it('a joined message reads exactly as PeerJS reads it: binary inside comes back as a Uint8Array', () => {
		const r = rig();
		const src = new Uint8Array(40000).map((_, i) => i * 13);
		const message = { type: 'objectfile', bytes: src.buffer, name: 'n', nested: { more: src.slice(0, 9).buffer } };
		for (const p of piecesOf(message, 3)) r.frame(pack(p));
		// PeerJS 1.5 joins the pieces into one Uint8Array and unpacks that
		const joined = new Uint8Array(pack(message));
		const ref = unpack(joined);
		expect(r.data).toHaveLength(1);
		expect(r.data[0]).toEqual(ref);
		expect(r.data[0].bytes).toBeInstanceOf(Uint8Array);
		expect(ref.bytes).toBeInstanceOf(Uint8Array);
	});
	it('uses only the first data channel of a link', () => {
		const conn = Object.create(SafeBinaryConnection.prototype);
		const refused = [];
		conn._refuse = (r) => refused.push(r);
		const first = { close() {} , addEventListener() {} };
		let extraClosed = false;
		const extra = { close: () => (extraClosed = true), addEventListener() {} };
		conn._initializeDataChannel(first);
		expect(conn.dataChannel).toBe(first);
		conn._initializeDataChannel(extra);
		expect(conn.dataChannel).toBe(first);
		expect(extraClosed).toBe(true);
		expect(refused).toEqual(['channel']);
	});
});

describe('peerSerializers', () => {
	it('every codec name a dial may ask for, inherited names included, is this codec', () => {
		const s = { raw: 1, json: 1, binary: 1, ...peerSerializers() };
		for (const name of ['default', 'binary', 'binary-utf8', 'raw', 'json', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])
			expect(s[name]).toBe(SafeBinaryConnection);
		expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
	});
});
