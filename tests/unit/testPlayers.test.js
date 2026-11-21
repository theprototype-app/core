import { describe, it, expect, vi } from 'vitest';
import { LocalDataConnection, createBotPeer, LINK_TAG, HELLO_EVERY_MS, HELLO_TRIES } from '../../src/lib/testPlayers/localLink.js';
import { botMayApply, VIEWER_ALLOWED } from '../../src/lib/testPlayers/roles.js';
import { overlayStorage } from '../../src/lib/safeStorage.js';
import { setFrameRefusalHandler } from '../../src/lib/peerCodec.js';

// 61 G3 — Test with players. The transport is checked end to end in the e2e suite (two bots in real
// frames); here: one local link's contract (open / data / close, the byte meter, the codec's limits),
// the role table, and the storage overlay a bot frame writes into.

/** a linked pair over one MessageChannel, both ends opened as the hub does */
function pair() {
	const ch = new MessageChannel();
	const a = new LocalDataConnection({ peer: 'bbbbb', metadata: { jr: 1, proto: 1 }, port: ch.port1 });
	const b = new LocalDataConnection({ peer: 'aaaaa', metadata: { jr: 1, proto: 1 }, port: ch.port2 });
	return { a, b, ch };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('local link', () => {
	it('carries the dial metadata and has no RTCPeerConnection', () => {
		const { a } = pair();
		expect(a.metadata).toEqual({ jr: 1, proto: 1 });
		expect(a.peerConnection).toBeNull();
		expect(a.__tpLocal).toBe(true);
		expect(a.open).toBe(false);
	});

	it('opens on the far end saying so, then delivers messages decoded by the app codec, in order', async () => {
		const { a, b, ch } = pair();
		/** @type {any[]} */
		const got = [];
		b.on('data', (/** @type {any} */ d) => got.push(d));
		let opened = 0;
		a.on('open', () => opened++);
		ch.port2.postMessage({ ctl: 'open' }); // what Endpoint.accept sends
		b.markOpen();
		await tick();
		expect(opened).toBe(1);
		expect(a.open).toBe(true);
		a.send({ type: 'hello', n: 1 });
		a.send({ type: 'bytes', buffer: new Uint8Array([1, 2, 3]).buffer });
		a.send({ type: 'hello', n: 2 });
		await tick();
		expect(got.map((d) => d.type)).toEqual(['hello', 'bytes', 'hello']);
		expect(got[0].n).toBe(1);
		expect(new Uint8Array(got[1].buffer)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('meters every arriving frame on dataChannel (the inbound bytes budget listens there)', async () => {
		const { a, b, ch } = pair();
		let bytes = 0;
		b.dataChannel.addEventListener('message', (/** @type {any} */ e) => (bytes += e.data.byteLength));
		ch.port2.postMessage({ ctl: 'open' });
		b.markOpen();
		await tick();
		a.send({ type: 'x', s: 'y'.repeat(1000) });
		await tick();
		expect(bytes).toBeGreaterThan(1000);
		expect(b.bytesIn).toBe(bytes);
	});

	it('refuses an undecodable frame through the codec refusal handler; the link stays up', async () => {
		const { b } = pair();
		/** @type {string[]} */
		const refused = [];
		setFrameRefusalHandler((peer, reason) => refused.push(peer + ':' + reason));
		/** @type {any[]} */
		const got = [];
		b.on('data', (/** @type {any} */ d) => got.push(d));
		b.markOpen();
		b.receive(new Uint8Array([0xd9, 0, 0, 0, 9]).buffer); // a string header claiming bytes that are not there
		expect(got).toEqual([]);
		expect(refused.length).toBe(1);
		expect(refused[0].startsWith('aaaaa:')).toBe(true);
		expect(b.open).toBe(true);
		setFrameRefusalHandler(() => {});
	});

	it('nothing flows before open; send before open is an error, not a throw', async () => {
		const { a, b } = pair();
		/** @type {any[]} */
		const errors = [];
		a.on('error', (/** @type {any} */ e) => errors.push(e.type));
		a.send({ type: 'early' });
		expect(errors).toEqual(['not-open-yet']);
		/** @type {any[]} */
		const got = [];
		b.on('data', (/** @type {any} */ d) => got.push(d));
		b.receive(new ArrayBuffer(4));
		expect(got).toEqual([]);
	});

	it('close ends both sides once, asynchronously', async () => {
		const { a, b, ch } = pair();
		ch.port2.postMessage({ ctl: 'open' });
		b.markOpen();
		await tick();
		let closedA = 0;
		let closedB = 0;
		a.on('close', () => closedA++);
		b.on('close', () => closedB++);
		a.close();
		a.close();
		expect(a.open).toBe(false);
		expect(closedA).toBe(0); // PeerJS fires close async too
		await tick(20);
		expect(closedA).toBe(1);
		expect(closedB).toBe(1);
		expect(b.open).toBe(false);
		a.send({ type: 'late' }); // after close: an error event, never a throw
	});

	it("the far end saying 'unavailable' closes the dial and marks it", async () => {
		const { a, ch } = pair();
		let closed = 0;
		a.on('close', () => closed++);
		ch.port2.postMessage({ ctl: 'unavailable' });
		await tick(20);
		expect(closed).toBe(1);
		expect(/** @type {any} */ (a).__unavailable).toBe(true);
	});
});

describe('bot roles', () => {
	it('an editor may do anything', () => {
		expect(botMayApply('editor', 'create', false)).toBe(true);
		expect(botMayApply('editor', 'clearscene', false)).toBe(true);
	});
	it("a viewer sends the roles plugin's viewer set only", () => {
		for (const t of VIEWER_ALLOWED) expect(botMayApply('viewer', t, false)).toBe(true);
		for (const t of ['create', 'object', 'move', 'delete', 'clearscene', 'nodetrigger', 'playmode', 'game']) expect(botMayApply('viewer', t, true)).toBe(false);
	});
	it('a player plays: triggers and play state always, moving things only while in Play, never editing', () => {
		expect(botMayApply('player', 'playmode', false)).toBe(true);
		expect(botMayApply('player', 'nodetrigger', false)).toBe(true);
		expect(botMayApply('player', 'game', false)).toBe(true);
		expect(botMayApply('player', 'move', false)).toBe(false);
		expect(botMayApply('player', 'move', true)).toBe(true);
		for (const t of ['create', 'object', 'delete', 'clearscene', 'nodes', 'graphcreate', 'environment']) expect(botMayApply('player', t, true)).toBe(false);
	});
});

describe('bot storage overlay', () => {
	/** @returns {Storage} */
	function real() {
		/** @type {Map<string, string>} */
		const m = new Map([['theme', 'dark'], ['username', 'Ada']]);
		return /** @type {any} */ ({
			getItem: (/** @type {string} */ k) => (m.has(k) ? m.get(k) : null),
			setItem: (/** @type {string} */ k, /** @type {string} */ v) => m.set(k, v),
			removeItem: (/** @type {string} */ k) => m.delete(k),
			clear: () => m.clear(),
			key: (/** @type {number} */ i) => [...m.keys()][i] ?? null,
			get length() {
				return m.size;
			},
			_map: m
		});
	}
	it("reads the host's values, writes and removes in memory only", () => {
		const r = real();
		const o = overlayStorage(r);
		expect(o.getItem('theme')).toBe('dark');
		o.setItem('theme', 'light');
		o.setItem('autosave', 'false');
		o.removeItem('username');
		expect(o.getItem('theme')).toBe('light');
		expect(o.getItem('username')).toBeNull();
		expect(o.getItem('autosave')).toBe('false');
		// the real store is untouched
		expect(/** @type {any} */ (r)._map.get('theme')).toBe('dark');
		expect(/** @type {any} */ (r)._map.get('username')).toBe('Ada');
		expect(/** @type {any} */ (r)._map.has('autosave')).toBe(false);
		expect(o.length).toBe(2);
		expect(new Set([o.key(0), o.key(1)])).toEqual(new Set(['theme', 'autosave']));
	});
	it('clear hides the host values without touching them; no read-through store = empty', () => {
		const r = real();
		const o = overlayStorage(r);
		o.clear();
		expect(o.getItem('theme')).toBeNull();
		expect(o.length).toBe(0);
		expect(/** @type {any} */ (r)._map.size).toBe(2);
		const s = overlayStorage(null);
		expect(s.getItem('tp:rejoin')).toBeNull();
		s.setItem('tp:rejoin', '{}');
		expect(s.getItem('tp:rejoin')).toBe('{}');
	});
});

describe('bot hello', () => {
	/** a node stand-in for the frame's window: messages are dispatched to it by hand */
	function fakeFrame() {
		const g = /** @type {any} */ (globalThis);
		const had = { window: g.window, location: g.location };
		g.window = new EventTarget();
		g.location = { origin: 'https://x.test' };
		/** @type {any[]} */
		const sent = [];
		const hub = /** @type {any} */ ({ postMessage: (/** @type {any} */ m) => sent.push(m) });
		const deliver = (/** @type {any} */ data) => {
			const ev = /** @type {any} */ (new Event('message'));
			Object.defineProperty(ev, 'data', { value: data });
			Object.defineProperty(ev, 'source', { value: hub });
			Object.defineProperty(ev, 'origin', { value: 'https://x.test' });
			ev.ports = [];
			g.window.dispatchEvent(ev);
		};
		const restore = () => Object.assign(g, had);
		return { hub, sent, deliver, restore };
	}

	it('says hello again until the hub welcomes it (a lost first hello does not strand the frame)', () => {
		vi.useFakeTimers();
		const f = fakeFrame();
		try {
			const peer = createBotPeer('abc12', { test: 'tst1', hub: f.hub });
			const hellos = () => f.sent.filter((m) => m[LINK_TAG] === 1 && m.kind === 'hello' && m.id === 'abc12').length;
			expect(hellos()).toBe(1);
			// the hub never saw it: the frame keeps asking
			vi.advanceTimersByTime(HELLO_EVERY_MS * 3);
			expect(hellos()).toBe(4);
			expect(peer.open).toBe(false);
			f.deliver({ [LINK_TAG]: 1, kind: 'welcome', test: 'tst1', id: 'abc12' });
			expect(peer.open).toBe(true);
			vi.advanceTimersByTime(HELLO_EVERY_MS * 5);
			expect(hellos()).toBe(4); // welcomed: no more hellos
			peer.destroy();
		} finally {
			f.restore();
			vi.useRealTimers();
		}
	});

	it('gives up after HELLO_TRIES (a frame whose host is gone does not ask for ever)', () => {
		vi.useFakeTimers();
		const f = fakeFrame();
		try {
			const peer = createBotPeer('abc13', { test: 'tst2', hub: f.hub });
			vi.advanceTimersByTime(HELLO_EVERY_MS * (HELLO_TRIES + 10));
			expect(f.sent.filter((m) => m.kind === 'hello').length).toBe(1 + HELLO_TRIES);
			peer.destroy();
		} finally {
			f.restore();
			vi.useRealTimers();
		}
	});
});
