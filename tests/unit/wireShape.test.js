// @ts-nocheck - hand-built decoded messages
import { describe, it, expect } from 'vitest';
import { pack, unpack } from 'peerjs-js-binarypack';
import { isPlainMessage } from '../../src/lib/wireShape.js';

describe('isPlainMessage', () => {
	it('accepts plain data, binary and nesting', () => {
		expect(isPlainMessage({ type: 'move', p: [1, 2, 3], n: null, s: 'x', b: true })).toBe(true);
		expect(isPlainMessage({ type: 'objectfile', bytes: new ArrayBuffer(8), view: new Uint8Array(4), f: new Float32Array(2) })).toBe(true);
		expect(isPlainMessage({ type: 'batch', items: [{ type: 'a', deep: { deeper: [{ x: 1 }] } }] })).toBe(true);
		expect(isPlainMessage(JSON.parse('{"type":"x","a":[{"b":{}}]}'))).toBe(true);
	});

	it('refuses an object or array with another prototype, anywhere', () => {
		expect(isPlainMessage(Object.create({ children: [] }))).toBe(false);
		expect(isPlainMessage({ type: 'x', a: [{ b: Object.create(null) }] })).toBe(false);
		const arr = [1, 2];
		Object.setPrototypeOf(arr, { length: 99 });
		expect(isPlainMessage({ type: 'x', arr })).toBe(false);
		expect(isPlainMessage({ type: 'x', fake: Object.create(ArrayBuffer.prototype) })).toBe(false);
		expect(isPlainMessage({ type: 'x', d: new Date() })).toBe(false);
		expect(isPlainMessage({ type: 'x', f() {} })).toBe(false);
	});

	it('refuses an own __proto__ key (what JSON makes of one)', () => {
		expect(isPlainMessage(JSON.parse('{"type":"x","o":{"__proto__":{"a":1}}}'))).toBe(false);
	});

	it('refuses what a binary decode makes of that key', async () => {
		const sent = JSON.parse('{"type":"object","element":{"object":{"type":"Group","__proto__":{"children":[]}}}}');
		const got = unpack(await pack(sent));
		expect(Object.getPrototypeOf(got.element.object)).not.toBe(Object.prototype);
		expect(isPlainMessage(got)).toBe(false);
		const ok = unpack(await pack({ type: 'object', element: { object: { type: 'Group', children: [] } }, bytes: new Uint8Array([1, 2]) }));
		expect(isPlainMessage(ok)).toBe(true);
	});

	it('walks a deep message without recursion', () => {
		let m = { type: 'x' };
		for (let i = 0; i < 200000; i++) m = { c: m };
		expect(isPlainMessage(m)).toBe(true);
	});
});
