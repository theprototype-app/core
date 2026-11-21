import { describe, it, expect } from 'vitest';
import { heldRestamp, isHeldStamp, applyNodeTrigger } from '../../src/lib/flowRuntime.js';

// 2.0-n3b (G28 pause-p): a held key re-stamps its Key Press node ~3/s, so `keypress P -> behaviour.pressed`
// ran on.pressed twice for a press longer than ~0.2 s — pause, then resume. A behaviour input treats a stamp
// inside the previous press's pulse window as that same press.
describe('held-key re-stamp on a behaviour input', () => {
	const key = { id: 'k', type: 'keypress', data: { code: 'KeyP', edge: 'down', pulse: 0.3 } };
	it('a re-stamp 0.2 s into a held press is the same press', () => {
		expect(heldRestamp([key], 100, 100.2)).toBe(true);
		expect(heldRestamp([{ id: 'g', type: 'gamepadbutton', data: { button: 'GamepadA' } }], 100, 100.21)).toBe(true);
		// a saved node with no edge / pulse keeps the defaults
		expect(heldRestamp([{ id: 'k0', type: 'keypress', data: { code: 'KeyP' } }], 100, 100.2)).toBe(true);
	});
	it('a second press after the pulse is a new press', () => {
		expect(heldRestamp([key], 100, 100.5)).toBe(false);
	});
	it('only key and pad sources: an On Click, an up edge or a mixed fan-in act on every stamp', () => {
		expect(heldRestamp([{ id: 'c', type: 'onclick', data: {} }], 100, 100.1)).toBe(false);
		expect(heldRestamp([{ ...key, data: { ...key.data, edge: 'up' } }], 100, 100.1)).toBe(false);
		expect(heldRestamp([key, { id: 'c', type: 'onclick', data: {} }], 100, 100.1)).toBe(false);
		expect(heldRestamp([], 100, 100.1)).toBe(false);
	});
	it('a stamp from the past (a clock step, a restored log) is not swallowed', () => {
		expect(heldRestamp([key], 100, 99.9)).toBe(false);
	});
});

// 2.0-int (pause-p): under ~10 fps two re-stamps land more than a pulse apart, so the dt rule
// read the second as a new press and a toggle ran twice. A re-stamp is MARKED at its source.
describe('isHeldStamp (marked held re-stamps)', () => {
	const src = { id: 'kp-held', type: 'keypress', data: { code: 'KeyP' } };
	it('a marked re-stamp is the same press whatever the gap; a press is not', () => {
		applyNodeTrigger('kp-held', 200, false);
		expect(isHeldStamp([src], 200)).toBe(false);
		applyNodeTrigger('kp-held', 200.45, false, null, null, undefined, false, null, true);
		expect(isHeldStamp([src], 200.45)).toBe(true);
		expect(heldRestamp([src], 200, 200.45)).toBe(false); // the old rule alone missed it
		applyNodeTrigger('kp-held', 203, false);
		expect(isHeldStamp([src], 203)).toBe(false);
	});
	it('a received re-stamp is marked the same way', () => {
		applyNodeTrigger('kp-held2', 50.5, false, null, null, undefined, true, 'peer-b', true);
		expect(isHeldStamp([{ ...src, id: 'kp-held2' }], 50.5)).toBe(true);
		expect(isHeldStamp([], 50.5)).toBe(false);
	});
});
