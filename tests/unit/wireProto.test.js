// 101 F1 — the session protocol number: absent = 1, unreadable = refused, the verdict's two halves.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	WIRE_PROTO,
	PROTO_ABSENT,
	protoOf,
	protoVerdict,
	myCaps,
	capsOf,
	refuseMessage,
	isRefuseMessage,
	olderPeers,
	noteOlderPeer,
	clearOlderPeer,
	resetWireProto,
	setWireProtoForTest
} from '../../src/lib/wireProto.js';

describe('wireProto', () => {
	beforeEach(() => {
		setWireProtoForTest(1);
		resetWireProto();
	});

	it('this release speaks protocol 1, and a peer that says nothing is protocol 1', () => {
		expect(WIRE_PROTO).toBe(1);
		expect(PROTO_ABSENT).toBe(1);
		expect(protoOf(undefined)).toBe(1);
		expect(protoOf(null)).toBe(1);
		expect(protoVerdict(protoOf(undefined))).toBe('ok');
	});

	it('anything that is not a positive integer is unreadable, and unreadable is refused (fail closed)', () => {
		for (const bad of ['2', 1.5, 0, -1, NaN, Infinity, {}, [], true, 1001]) {
			expect(Number.isNaN(protoOf(bad))).toBe(true);
			expect(protoVerdict(protoOf(bad))).not.toBe('ok');
		}
		expect(protoOf(2)).toBe(2);
	});

	it('higher = we are stale, lower = they must reload', () => {
		expect(protoVerdict(2, 1)).toBe('stale');
		expect(protoVerdict(1, 2)).toBe('older');
		expect(protoVerdict(3, 3)).toBe('ok');
		expect(protoVerdict(NaN, 1)).toBe('older');
	});

	it('the test hook moves the live binding; bad values are ignored', () => {
		expect(setWireProtoForTest(2)).toBe(2);
		expect(WIRE_PROTO).toBe(2);
		expect(refuseMessage()).toEqual({ type: 'refuse', reason: 'proto', need: 2 });
		setWireProtoForTest(0);
		setWireProtoForTest(2.5);
		expect(WIRE_PROTO).toBe(2);
	});

	it('caps: the flags that exist today, fc only when the fast channel is on', () => {
		expect(myCaps()).toEqual({ wb: 1, dev: 1 });
		expect(myCaps({ fc: true })).toEqual({ wb: 1, dev: 1, fc: 1 });
		expect(capsOf(undefined)).toEqual({});
		expect(capsOf([1])).toEqual({});
		expect(capsOf({ wb: 1, future: 'x' })).toEqual({ wb: 1, future: 'x' });
		const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, 1]));
		expect(Object.keys(capsOf(many)).length).toBe(64);
	});

	it('a refuse message has to be well formed to count', () => {
		expect(isRefuseMessage({ type: 'refuse', reason: 'proto', need: 2 })).toBe(true);
		expect(isRefuseMessage({ type: 'refuse', reason: 'proto', need: '2' })).toBe(false);
		expect(isRefuseMessage({ type: 'refuse', reason: 'other', need: 2 })).toBe(false);
		expect(isRefuseMessage({ type: 'refuse', reason: 'proto', need: 0 })).toBe(false);
		expect(isRefuseMessage(null)).toBe(false);
	});

	it('People rows: deduped per peer, newest first, bounded, cleared by a return and by leaving', () => {
		noteOlderPeer('aaaa1', 'Ada', 1);
		noteOlderPeer('bbbb1', '', 1);
		noteOlderPeer('aaaa1', 'Ada', 1);
		expect(get(olderPeers).map((r) => r.peerId)).toEqual(['aaaa1', 'bbbb1']);
		for (let i = 0; i < 20; i++) noteOlderPeer('p' + i, '', 1);
		expect(get(olderPeers).length).toBe(8);
		clearOlderPeer('p19');
		expect(get(olderPeers).some((r) => r.peerId === 'p19')).toBe(false);
		resetWireProto();
		expect(get(olderPeers)).toEqual([]);
	});
});
