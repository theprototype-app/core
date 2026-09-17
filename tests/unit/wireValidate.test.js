import { describe, it, expect } from 'vitest';
import {
	isUuid,
	isFiniteArray,
	isVec3,
	isQuatOrEuler,
	sanitizeTransform,
	validateWireMessage,
	VALIDATORS
} from '../../src/lib/wireValidate.js';

// 27-I (audit L9) + 27-A. The wire validator is the one module in this batch whose whole
// job is deciding what a hostile peer may hand the appliers, and it imports NOTHING — so
// it is exactly what a unit layer is for: no browser, no peer, no scene.

describe('shape predicates', () => {
	it('accepts a plausible uuid and rejects the rest', () => {
		expect(isUuid('2bfe3770-7caa-4037-87ee-ca9c557993a7')).toBe(true);
		expect(isUuid('')).toBe(false);
		expect(isUuid(null)).toBe(false);
		expect(isUuid(42)).toBe(false);
		expect(isUuid('x'.repeat(65))).toBe(false); // unbounded strings are not identifiers
	});

	it('treats NaN and Infinity as NOT numbers, which is the whole point', () => {
		expect(isVec3([1, 2, 3])).toBe(true);
		expect(isVec3([1, 2, NaN])).toBe(false);
		expect(isVec3([1, 2, Infinity])).toBe(false);
		expect(isVec3([1, 2])).toBe(false);
		expect(isVec3('1,2,3')).toBe(false);
		expect(isFiniteArray([1, 2, 3, 4], 4)).toBe(true);
		expect(isFiniteArray([1, 2, 3], 4)).toBe(false);
	});

	it('takes a rotation as either an Euler triple or a quaternion', () => {
		expect(isQuatOrEuler([0, 0, 0])).toBe(true);
		expect(isQuatOrEuler([0, 0, 0, 1])).toBe(true);
		expect(isQuatOrEuler([0, 0])).toBe(false);
	});
});

describe('validateWireMessage', () => {
	it('ALLOWS a type it has never heard of — the additive rule', () => {
		// A peer one release ahead sends types this table cannot know. Rejecting them on
		// shape would make every forward-compatible message a dropped message.
		expect(validateWireMessage({ type: 'something-from-2027', whatever: true })).toBe(true);
	});

	it('refuses the structural messages whose appliers would throw', () => {
		expect(validateWireMessage({ type: 'hosts', hosts: 'not-an-array' })).toBe(false);
		expect(validateWireMessage({ type: 'hosts', hosts: ['a', 'b'] })).toBe(true);
		expect(validateWireMessage({ type: 'userdata', userdata: 'nope' })).toBe(false);
		expect(validateWireMessage({ type: 'locked', lockeditems: {} })).toBe(false);
	});

	it('refuses a transform that would poison the matrix', () => {
		const good = { type: 'move', uuid: 'abc', pos: [1, 2, 3], rot: [0, 0, 0], scale: [1, 1, 1] };
		expect(validateWireMessage(good)).toBe(true);
		expect(validateWireMessage({ ...good, pos: [NaN, 2, 3] })).toBe(false);
		expect(validateWireMessage({ ...good, scale: [1, 1] })).toBe(false);
		expect(validateWireMessage({ ...good, uuid: 123 })).toBe(false);
	});

	it('cannot itself be made to throw by a hostile shape', () => {
		// a validator that throws IS a rejection, never an escape into the dispatcher
		const nasty = {
			type: 'move',
			get uuid() {
				throw new Error('boom');
			}
		};
		expect(() => validateWireMessage(nasty)).not.toThrow();
		expect(validateWireMessage(nasty)).toBe(false);
	});

	it('has no validator that rejects its own well-formed message', () => {
		// a cheap guard against a typo in the table silently dropping a whole domain
		const samples = {
			hosts: { hosts: [] },
			userdata: { userdata: [] },
			locked: { lockeditems: [] },
			delete: { uuid: 'a' },
			disconnected: { peerId: 'a' },
			atscene: { peerId: 'a' },
			assetchunk: { hash: 'h', seq: 0 },
			assetstart: { hash: 'h', chunks: 2, size: 10 }
		};
		for (const [type, body] of Object.entries(samples))
			expect(validateWireMessage({ type, ...body }), type).toBe(true);
		expect(Object.keys(VALIDATORS).length).toBeGreaterThan(20);
	});
});

describe('sanitizeTransform', () => {
	const current = { pos: [9, 9, 9], rot: [1, 1, 1], scale: [2, 2, 2] };

	it('keeps the current value for each non-finite component, and says it repaired', () => {
		const out = sanitizeTransform([NaN, 5, 6], [0, 0, 0], [1, 1, 1], current);
		// null is a REAL answer from this function (nothing usable at all), so assert it
		// away first — the test should state which case it is in, not assume one.
		expect(out).not.toBeNull();
		expect(out?.pos).toEqual([9, 5, 6]); // the broken axis falls back, the good ones apply
		expect(out?.repaired).toBe(true);
	});

	it('reports no repair when everything is finite', () => {
		const out = sanitizeTransform([1, 2, 3], [0, 0, 0], [1, 1, 1], current);
		expect(out).not.toBeNull();
		expect(out?.repaired).toBe(false);
		expect(out?.pos).toEqual([1, 2, 3]);
	});

	it('returns null when there is nothing usable at all', () => {
		expect(sanitizeTransform(undefined, undefined, undefined, current)).toBe(null);
	});
});
