// @ts-nocheck — fake RTCPeerConnection / timer fixtures; the module itself is typed
import { describe, it, expect } from 'vitest';
import {
	poseKey,
	stampPose,
	nextPoseSeq,
	createStaleFilter,
	createKeyframer,
	createFastLinks,
	FAST_CHANNEL_ID,
	FAST_MAX_BYTES,
	FAST_MAX_BUFFERED
} from '../../src/lib/fastChannel.js';

// 60 Q2: the fast movement channel's pure parts — keys, sequence numbers, the stale filter,
// the trailing keyframe and the channel bookkeeping (with a fake RTCPeerConnection).

describe('poseKey', () => {
	it('keys camera/hands per sender stream and moves per object', () => {
		expect(poseKey({ type: 'camera', peerId: 'a' })).toBe('camera');
		expect(poseKey({ type: 'vrhands' })).toBe('vrhands');
		expect(poseKey({ type: 'move', uuid: 'u1' })).toBe('move:u1');
	});
	it('answers null for everything that is not a latest-wins pose', () => {
		expect(poseKey({ type: 'object' })).toBeNull();
		expect(poseKey({ type: 'move' })).toBeNull();
		expect(poseKey(null)).toBeNull();
	});
});

describe('stampPose', () => {
	it('stamps poses with a monotonic ps, once', () => {
		const a = stampPose({ type: 'move', uuid: 'x' });
		const b = stampPose({ type: 'camera' });
		expect(b.ps).toBeGreaterThan(a.ps);
		const keep = a.ps;
		stampPose(a); // a keyframe re-send keeps its original number
		expect(a.ps).toBe(keep);
	});
	it('leaves non-pose payloads untouched', () => {
		const edit = { type: 'object', uuid: 'x' };
		stampPose(edit);
		expect('ps' in edit).toBe(false);
	});
	it('starts above the clock x100 so a reloaded sender outruns its previous page', () => {
		expect(nextPoseSeq()).toBeGreaterThan((Date.now() - 60_000) * 100);
	});
});

describe('createStaleFilter', () => {
	it('drops a pose older than (or equal to) the newest applied for that sender + key', () => {
		const f = createStaleFilter();
		expect(f.accept('A', { type: 'camera', ps: 10 })).toBe(true);
		expect(f.accept('A', { type: 'camera', ps: 9 })).toBe(false); // overtaken datagram
		expect(f.accept('A', { type: 'camera', ps: 10 })).toBe(false); // keyframe duplicate
		expect(f.accept('A', { type: 'camera', ps: 11 })).toBe(true);
		expect(f.stats).toEqual({ accepted: 2, stale: 2 });
	});
	it('keeps keys apart: per object, per sender, per type', () => {
		const f = createStaleFilter();
		expect(f.accept('A', { type: 'move', uuid: 'u1', ps: 50 })).toBe(true);
		expect(f.accept('A', { type: 'move', uuid: 'u2', ps: 5 })).toBe(true);
		expect(f.accept('B', { type: 'move', uuid: 'u1', ps: 5 })).toBe(true);
		expect(f.accept('A', { type: 'camera', ps: 5 })).toBe(true);
	});
	it('a late streamed move loses to the committed move that ended the drag', () => {
		const f = createStaleFilter();
		const streamed = { type: 'move', uuid: 'u', ps: 100 };
		const committed = { type: 'move', uuid: 'u', ps: 101 };
		expect(f.accept('A', committed)).toBe(true);
		expect(f.accept('A', streamed)).toBe(false);
	});
	it('always accepts an unstamped message (an older build) and records nothing', () => {
		const f = createStaleFilter();
		expect(f.accept('A', { type: 'move', uuid: 'u' })).toBe(true);
		expect(f.accept('A', { type: 'move', uuid: 'u' })).toBe(true);
		expect(f.size()).toBe(0);
		expect(f.accept('A', { type: 'object', ps: 1 })).toBe(true); // not a pose
	});
	it('forgets a peer on disconnect (a fresh page may restart lower)', () => {
		const f = createStaleFilter();
		f.accept('A', { type: 'camera', ps: 100 });
		f.accept('B', { type: 'camera', ps: 100 });
		f.dropPeer('A');
		expect(f.accept('A', { type: 'camera', ps: 1 })).toBe(true);
		expect(f.accept('B', { type: 'camera', ps: 1 })).toBe(false);
	});
});

/** a manual clock for the keyframer */
function fakeTimers() {
	let now = 0;
	const timers = new Map();
	let id = 0;
	return {
		setTimer: (fn, ms) => (timers.set(++id, { fn, at: now + ms }), id),
		clearTimer: (t) => timers.delete(t),
		advance(ms) {
			now += ms;
			for (const [t, v] of [...timers]) if (v.at <= now) (timers.delete(t), v.fn());
		},
		pending: () => timers.size
	};
}

describe('createKeyframer', () => {
	it('re-sends the LAST fast pose once the key goes quiet, to the peers that got it fast', () => {
		const t = fakeTimers();
		const sent = [];
		const k = createKeyframer((p, peers) => sent.push([p.ps, peers]), { delay: 250, ...t });
		k.noteFast('camera', { ps: 1 }, ['B']);
		t.advance(100);
		k.noteFast('camera', { ps: 2 }, ['B', 'C']);
		t.advance(200);
		expect(sent).toEqual([]); // still streaming
		t.advance(60);
		expect(sent).toEqual([[2, ['B', 'C']]]);
		t.advance(1000);
		expect(sent.length).toBe(1); // once
	});
	it('a reliable send of the same key supersedes the keyframe', () => {
		const t = fakeTimers();
		const sent = [];
		const k = createKeyframer((p) => sent.push(p), { delay: 250, ...t });
		k.noteFast('move:u', { ps: 1 }, ['B']);
		k.noteReliable('move:u');
		t.advance(1000);
		expect(sent).toEqual([]);
		expect(t.pending()).toBe(0);
	});
	it('keys are independent; a departed peer is owed nothing; clear disarms all', () => {
		const t = fakeTimers();
		const sent = [];
		const k = createKeyframer((p, peers) => sent.push([p.k, peers]), { delay: 10, ...t });
		k.noteFast('move:a', { k: 'a' }, ['B', 'C']);
		k.noteFast('move:b', { k: 'b' }, ['B']);
		k.dropPeer('C');
		t.advance(20);
		expect(sent).toEqual([
			['a', ['B']],
			['b', ['B']]
		]);
		k.noteFast('move:c', { k: 'c' }, ['B']);
		k.clear();
		t.advance(20);
		expect(sent.length).toBe(2);
	});
});

/** a fake RTCPeerConnection whose channels open on demand */
function fakePc() {
	const made = [];
	return {
		made,
		createDataChannel(label, init) {
			const dc = {
				label,
				init,
				readyState: 'connecting',
				sent: [],
				send(t) {
					this.sent.push(t);
				},
				close() {
					this.readyState = 'closed';
					this.onclose?.();
				}
			};
			made.push(dc);
			return dc;
		}
	};
}

describe('createFastLinks', () => {
	it('creates ONE negotiated unordered, no-retransmit channel per RTCPeerConnection', () => {
		const links = createFastLinks();
		const pc = fakePc();
		const conn = { peerConnection: pc };
		expect(links.open('B', conn, () => {})).toBe(true);
		expect(links.open('B', conn, () => {})).toBe(true); // idempotent
		expect(pc.made.length).toBe(1);
		expect(pc.made[0].init).toEqual({
			ordered: false,
			maxRetransmits: 0,
			negotiated: true,
			id: FAST_CHANNEL_ID
		});
	});
	it('falls back (false) until the channel is open, and for an oversized message', () => {
		const links = createFastLinks();
		const pc = fakePc();
		links.open('B', { peerConnection: pc }, () => {});
		expect(links.trySend('B', '{}')).toBe(false); // connecting
		pc.made[0].readyState = 'open';
		pc.made[0].onopen?.();
		expect(links.trySend('B', '{"type":"camera"}')).toBe(true);
		expect(links.trySend('B', 'x'.repeat(FAST_MAX_BYTES + 1))).toBe(false);
		expect(links.trySend('Z', '{}')).toBe(false); // no channel to that peer
		expect(links.stats.tooBig).toBe(1);
	});
	it('skips (true, not sent) behind a send backlog — a stale pose must not queue', () => {
		const links = createFastLinks();
		const pc = fakePc();
		links.open('B', { peerConnection: pc }, () => {});
		pc.made[0].readyState = 'open';
		pc.made[0].bufferedAmount = FAST_MAX_BUFFERED + 1;
		expect(links.trySend('B', '{}')).toBe(true);
		expect(pc.made[0].sent).toEqual([]);
		expect(links.stats.congested).toBe(1);
	});
	it('a newer connection replaces the old channel; a conn without an RTCPeerConnection is refused', () => {
		const links = createFastLinks();
		const pc1 = fakePc();
		const pc2 = fakePc();
		links.open('B', { peerConnection: pc1 }, () => {});
		links.open('B', { peerConnection: pc2 }, () => {});
		expect(pc1.made[0].readyState).toBe('closed');
		expect(links.peers()).toEqual(['B']);
		expect(links.open('C', {}, () => {})).toBe(false);
	});
	it('parses JSON text into the receive path and ignores junk', () => {
		const links = createFastLinks();
		const pc = fakePc();
		const got = [];
		links.open('B', { peerConnection: pc }, (d) => got.push(d));
		pc.made[0].onmessage({ data: '{"type":"move","uuid":"u","ps":3}' });
		pc.made[0].onmessage({ data: 'not json' });
		pc.made[0].onmessage({ data: new ArrayBuffer(2) });
		expect(got).toEqual([{ type: 'move', uuid: 'u', ps: 3 }]);
		expect(links.stats.parseErrors).toBe(1);
	});
	it('close / closeAll drop the links', () => {
		const links = createFastLinks();
		links.open('B', { peerConnection: fakePc() }, () => {});
		links.open('C', { peerConnection: fakePc() }, () => {});
		links.close('B');
		expect(links.peers()).toEqual(['C']);
		links.closeAll();
		expect(links.peers()).toEqual([]);
	});
});
