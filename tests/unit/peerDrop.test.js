import { describe, it, expect } from 'vitest';
import {
	quietPeerError,
	unavailablePeerId,
	LEAVE_QUIET_MS,
	ICE_DROP_GRACE_MS,
	UNAVAILABLE_STRIKES,
	strikesNeeded,
	consentCounters,
	linkSilence,
	LINK_SILENT_MS,
	keepPeerId
} from '../../src/lib/peerDrop.js';
import { Peer } from 'peerjs';

// F-3: a dropped peer leaves Users within seconds and a leave never toasts "Connection error".
describe('F-3 peer drop policy', () => {
	const now = 1_000_000;
	it('keeps leave/drop symptoms off the screen while a leave or redial is in flight', () => {
		for (const type of ['webrtc', 'disconnected', 'negotiation-failed', 'connection-closed']) {
			expect(quietPeerError(type, { lastLeaveAt: now - 1000, reconnecting: 0, now })).toBe(true);
			expect(quietPeerError(type, { lastLeaveAt: 0, reconnecting: 1, now })).toBe(true);
		}
	});
	it('still shows them when nothing is leaving (a real failure is news)', () => {
		expect(quietPeerError('webrtc', { lastLeaveAt: now - LEAVE_QUIET_MS - 1, reconnecting: 0, now })).toBe(false);
		expect(quietPeerError('webrtc', { lastLeaveAt: 0, reconnecting: 0, now })).toBe(false);
	});
	it('never hides errors that are not leave symptoms', () => {
		for (const type of ['browser-incompatible', 'invalid-id', 'ssl-unavailable', 'unavailable-id'])
			expect(quietPeerError(type, { lastLeaveAt: now, reconnecting: 3, now })).toBe(false);
	});
	it('reads the id from the END of the peerjs message (the old regex answered "Could")', () => {
		expect(unavailablePeerId('Could not connect to peer e6f54')).toBe('e6f54');
		expect(unavailablePeerId('Could not connect to peer a1b2c ')).toBe('a1b2c');
		expect(unavailablePeerId('something else')).toBe('');
		expect(unavailablePeerId(undefined)).toBe('');
	});
	it('a link closed for silence needs one "not on the server" answer, a closed channel three', () => {
		expect(strikesNeeded(true)).toBe(1);
		expect(strikesNeeded(false)).toBe(UNAVAILABLE_STRIKES);
		expect(UNAVAILABLE_STRIKES).toBeGreaterThan(1);
	});
	it('drops a silent peer well inside the reconnect window', () => {
		// grace + the first redial (0.5 s) + one EXPIRE answer (~5 s) < the 15.5 s window
		expect(ICE_DROP_GRACE_MS + 500 + 5000).toBeLessThan(15500);
	});

	it('reads the SELECTED pair\'s consent counters (transport first, then a selected/nominated pair)', () => {
		const viaTransport = new Map([
			['T', { type: 'transport', selectedCandidatePairId: 'P2' }],
			['P1', { id: 'P1', type: 'candidate-pair', requestsSent: 1, responsesReceived: 1 }],
			['P2', { id: 'P2', type: 'candidate-pair', requestsSent: 9, responsesReceived: 8 }]
		]);
		expect(consentCounters(viaTransport)).toEqual({ requestsSent: 9, responsesReceived: 8 });
		const nominated = [{ id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', requestsSent: 3, responsesReceived: 3 }];
		expect(consentCounters(nominated)).toEqual({ requestsSent: 3, responsesReceived: 3 });
		expect(consentCounters([{ type: 'candidate-pair', state: 'waiting' }])).toBeNull();
		expect(consentCounters(null)).toBeNull();
	});
	it('a link is silent only when we kept asking and nothing answered for LINK_SILENT_MS', () => {
		let v = linkSilence(null, { requestsSent: 10, responsesReceived: 10 }, 0);
		expect(v.silent).toBe(false);
		v = linkSilence(v.state, { requestsSent: 12, responsesReceived: 10 }, LINK_SILENT_MS - 1);
		expect(v.silent).toBe(false);
		const dead = linkSilence(v.state, { requestsSent: 13, responsesReceived: 10 }, LINK_SILENT_MS);
		expect(dead.silent).toBe(true);
		// an answer resets the clock
		const alive = linkSilence(v.state, { requestsSent: 13, responsesReceived: 11 }, LINK_SILENT_MS + 5000);
		expect(alive.silent).toBe(false);
		// no requests going out (an idle pair libwebrtc stopped pinging) is never "silent"
		expect(linkSilence({ responses: 5, requests: 5, at: 0 }, { requestsSent: 5, responsesReceived: 5 }, 60000).silent).toBe(false);
		// no stats = never silent
		expect(linkSilence({ responses: 5, requests: 5, at: 0 }, null, 60000).silent).toBe(false);
	});
});

// net-drop-1: peerjs's Peer.disconnect() (every signaling drop) sets `id` to null until the socket
// re-registers, and everything that asks "who am I" read null for the length of the drop — the
// cloud roles plugin then counted itself ALONE, wiped its role map, and a joiner came back from a
// healed drop as a viewer whose every edit stayed local (net-drop on deployed builds, B -> A red).
describe('keepPeerId: our id survives a signaling drop', () => {
	/** the real peerjs Peer, disconnected the way a dropped socket disconnects it */
	function droppedPeer(/** @type {boolean} */ kept) {
		const peer = Object.create(Peer.prototype);
		Object.assign(peer, { _id: 'abc12', _lastServerId: null, _disconnected: false, _open: true, _destroyed: false });
		peer._socket = { close() {} };
		peer.emit = () => true;
		if (kept) keepPeerId(peer, 'abc12');
		expect(peer.id).toBe('abc12');
		peer.disconnect();
		expect(peer.disconnected).toBe(true);
		return peer;
	}
	it('counterfactual: an unwrapped peerjs Peer reads null while disconnected', () => {
		expect(droppedPeer(false).id).toBe(null);
	});
	it('a wrapped Peer keeps reading its id through the drop, and peerjs still reconnects on it', () => {
		const peer = droppedPeer(true);
		expect(peer.id).toBe('abc12');
		// peerjs keeps its own bookkeeping: the reconnect re-registers the id it remembered
		expect(peer._lastServerId).toBe('abc12');
		/** @type {string[]} */
		const started = [];
		peer._socket = { start: (/** @type {string} */ id) => started.push(id), close() {} };
		peer._options = {};
		peer.reconnect();
		expect(started).toEqual(['abc12']);
		expect(peer.id).toBe('abc12');
	});
	it('the live id wins over the remembered one, and a missing peer or id is left alone', () => {
		const peer = Object.create(Peer.prototype);
		peer._id = 'zzz99';
		keepPeerId(peer, 'abc12');
		expect(peer.id).toBe('zzz99');
		expect(keepPeerId(null, 'abc12')).toBe(null);
		const bare = { id: 'x' };
		expect(keepPeerId(bare, '')).toBe(bare);
		expect(bare.id).toBe('x');
	});
});
