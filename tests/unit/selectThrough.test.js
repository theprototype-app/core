import { describe, it, expect } from 'vitest';
import {
	hitOpacity,
	isSeeThrough,
	pickStack,
	primaryIndex,
	isRepeatClick,
	chooseInStack,
	SEE_THROUGH_OPACITY,
	DOUBLE_CLICK_MS,
	CYCLE_WINDOW_MS
} from '../../src/lib/selectThrough.js';

// 30 P2: select-through + click-cycle, the pure part. Plain objects stand in for THREE
// nodes: the functions only read `material`, `visible`, `parent`, `uuid`, `userData`.

/** @param {string} uuid @param {any} [material] @param {any} [extra] */
function node(uuid, material = { opacity: 1, transparent: false }, extra = {}) {
	return { uuid, material, visible: true, parent: null, userData: {}, ...extra };
}
/** @param {any} object @param {number} distance */
const hit = (object, distance) => ({ object, distance, face: { materialIndex: 0 } });
/** top-level resolver: the node itself, or its top-most parent */
const top = (/** @type {any} */ o) => {
	let n = o;
	while (n?.parent) n = n.parent;
	return n;
};

describe('hitOpacity', () => {
	it('reads an opaque material as 1 and ignores opacity without transparent', () => {
		expect(hitOpacity(hit(node('a'), 1))).toBe(1);
		expect(hitOpacity(hit(node('a', { opacity: 0.1, transparent: false }), 1))).toBe(1);
	});
	it('reads the opacity of a transparent material', () => {
		expect(hitOpacity(hit(node('a', { opacity: 0.12, transparent: true }), 1))).toBe(0.12);
	});
	it('reads the FACE material of a multi-material mesh', () => {
		const mesh = node('m', [
			{ opacity: 1, transparent: false },
			{ opacity: 0.05, transparent: true }
		]);
		expect(hitOpacity({ object: mesh, face: { materialIndex: 1 } })).toBe(0.05);
		expect(hitOpacity({ object: mesh, face: { materialIndex: 0 } })).toBe(1);
	});
	it('reads a switched-off material as 0', () => {
		expect(hitOpacity(hit(node('a', { visible: false, opacity: 1 }), 1))).toBe(0);
	});
});

describe('isSeeThrough', () => {
	it('flags glass below the threshold, and only below it', () => {
		const glass = node('g', { opacity: SEE_THROUGH_OPACITY - 0.01, transparent: true });
		const tinted = node('t', { opacity: SEE_THROUGH_OPACITY + 0.01, transparent: true });
		expect(isSeeThrough(hit(glass, 1), glass)).toBe(true);
		expect(isSeeThrough(hit(tinted, 1), tinted)).toBe(false);
	});
	it('honours the pick flag on the TOP-LEVEL object whatever the opacity', () => {
		const wall = node('w');
		wall.userData.pick = 'through';
		expect(isSeeThrough(hit(wall, 1), wall)).toBe(true);
	});
	it('treats a hidden node on the way up as see-through', () => {
		const group = node('grp', null, { visible: false });
		const child = node('c', undefined, { parent: group });
		expect(isSeeThrough(hit(child, 1), group)).toBe(true);
	});
});

describe('pickStack + primaryIndex', () => {
	it('prefers the first OPAQUE target behind a near-invisible shell (the Stars Room case)', () => {
		const shell = node('shell', { opacity: 0.12, transparent: true });
		const star = node('star');
		const floor = node('floor');
		const stack = pickStack([hit(shell, 1), hit(star, 3), hit(floor, 5)], top);
		expect(stack.map((e) => e.uuid)).toEqual(['shell', 'star', 'floor']);
		expect(stack[primaryIndex(stack)].uuid).toBe('star');
	});
	it('falls back to the nearest when everything is see-through', () => {
		const a = node('a', { opacity: 0.1, transparent: true });
		const b = node('b', { opacity: 0.1, transparent: true });
		expect(primaryIndex(pickStack([hit(a, 1), hit(b, 2)], top))).toBe(0);
	});
	it('collapses several hits on one object into ONE entry, opaque if any hit is', () => {
		const group = node('case');
		const pane = node('pane', { opacity: 0.1, transparent: true }, { parent: group });
		const core = node('core', undefined, { parent: group });
		const stack = pickStack([hit(pane, 1), hit(core, 2), hit(pane, 3)], top);
		expect(stack.length).toBe(1);
		expect(stack[0].through).toBe(false);
	});
	it('skips hits that resolve to no top-level object', () => {
		expect(pickStack([hit(node('x'), 1)], () => null)).toEqual([]);
	});
});

describe('isRepeatClick', () => {
	const last = { x: 100, y: 100, t: 1000 };
	it('is a repeat on the same spot after the double-click window', () => {
		expect(isRepeatClick({ x: 103, y: 98, t: 1000 + DOUBLE_CLICK_MS + 50 }, last)).toBe(true);
	});
	it('is NOT a repeat inside the double-click window (that gesture is the double-click action)', () => {
		expect(isRepeatClick({ x: 100, y: 100, t: 1000 + DOUBLE_CLICK_MS - 10 }, last)).toBe(false);
	});
	it('is NOT a repeat after the cycle window or more than 4px away', () => {
		expect(isRepeatClick({ x: 100, y: 100, t: 1000 + CYCLE_WINDOW_MS + 1 }, last)).toBe(false);
		expect(isRepeatClick({ x: 105, y: 100, t: 1000 + DOUBLE_CLICK_MS + 50 }, last)).toBe(false);
		expect(isRepeatClick({ x: 100, y: 100, t: 2000 }, null)).toBe(false);
	});
});

describe('chooseInStack', () => {
	const shell = node('shell', { opacity: 0.1, transparent: true });
	const box = node('box');
	const floor = node('floor');
	const stack = pickStack([hit(shell, 1), hit(box, 2), hit(floor, 4)], top);
	const t0 = 10_000;
	const later = t0 + DOUBLE_CLICK_MS + 100;
	it('a plain click takes the primary', () => {
		expect(chooseInStack(stack, { x: 5, y: 5, t: t0 }, null)).toEqual({ index: 1, cycled: false });
	});
	it('a repeat walks DOWN the stack and wraps back to the shell in front', () => {
		const first = chooseInStack(stack, { x: 5, y: 5, t: later }, { x: 5, y: 5, t: t0, uuid: 'box' });
		expect(stack[first.index].uuid).toBe('floor');
		expect(first.cycled).toBe(true);
		const second = chooseInStack(stack, { x: 5, y: 5, t: later + 600 }, { x: 5, y: 5, t: later, uuid: 'floor' });
		expect(stack[second.index].uuid).toBe('shell');
	});
	it('a repeat whose last pick left the stack starts over at the primary', () => {
		expect(chooseInStack(stack, { x: 5, y: 5, t: later }, { x: 5, y: 5, t: t0, uuid: 'gone' }).index).toBe(1);
	});
	it('an empty stack picks nothing', () => {
		expect(chooseInStack([], { x: 0, y: 0, t: 0 }, null).index).toBe(-1);
	});
});
