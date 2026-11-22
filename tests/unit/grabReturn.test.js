// 85 I1: the Grabbable release rule and the return glide (grabReturn.js)
import { describe, it, expect } from 'vitest';
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { grabRule, startGlide, stepGlides, cancelGlide, gliding, grabReturnDebug, homeFor } from '../../src/lib/grabReturn.js';

/** @param {string} uuid */
const box = (uuid) => {
	const o = new THREE.Object3D();
	o.uuid = uuid;
	return o;
};

describe('grabRule', () => {
	it('defaults to stay and clamps the numbers', () => {
		expect(grabRule({})).toEqual({ release: 'stay', delay: 1, duration: 0.6 });
		expect(grabRule({ release: 'return', returnAfter: -5, returnTime: 999 })).toEqual({ release: 'return', delay: 0, duration: 30 });
		expect(grabRule({ release: 'nonsense', returnAfter: 'x' }).release).toBe('stay');
	});
});

describe('the return glide', () => {
	it('waits, glides home at 20 Hz and lands exactly with a final send', () => {
		const o = box('g1');
		o.position.set(4, 2, 0);
		o.rotation.set(0, 1, 0);
		startGlide(o, { pos: [0, 1, 0], quat: [0, 0, 0, 1] }, { delay: 1, duration: 0.5 }, 1000);
		expect(gliding('g1')).toBe(true);
		/** @type {[number, boolean][]} */
		const sent = [];
		const send = (/** @type {any} */ obj, /** @type {boolean} */ fin) => sent.push([obj.position.x, fin]);
		stepGlides(1500, send);
		expect(sent).toEqual([]); // still waiting
		expect(o.position.x).toBe(4);
		stepGlides(2250, send); // half-way
		expect(o.position.x).toBeCloseTo(2, 6);
		stepGlides(2260, send); // under 50 ms since the last send: no message
		expect(sent.length).toBe(1);
		stepGlides(2600, send); // past the end
		expect(o.position.toArray()).toEqual([0, 1, 0]);
		expect(Math.abs(o.quaternion.w)).toBeCloseTo(1, 9);
		expect(sent[sent.length - 1]).toEqual([0, true]);
		expect(gliding('g1')).toBe(false);
	});
	it('a new grab cancels it, and a deleted object drops it', () => {
		const o = box('g2');
		startGlide(o, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, { delay: 0, duration: 1 }, 0);
		cancelGlide('g2');
		expect(gliding('g2')).toBe(false);
		const p = box('g3');
		startGlide(p, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, { delay: 0, duration: 1 }, 0);
		stepGlides(100, () => {}, () => false);
		expect(grabReturnDebug()).not.toContain('g3');
	});
});

describe('homeFor', () => {
	it('is where the object is when nothing glides it', () => {
		const o = box('h1');
		o.position.set(1, 2, 3);
		expect(homeFor(o)).toEqual({ pos: [1, 2, 3], quat: [0, 0, 0, 1] });
	});
	it('keeps the glide home when the object is caught on its way back', () => {
		const o = box('h2');
		o.position.set(5, 0, 0);
		startGlide(o, { pos: [0, 1, 0], quat: [0, 0, 0, 1] }, { delay: 0, duration: 1 }, 0);
		stepGlides(500, () => {}, () => true);
		expect(o.position.x).toBeGreaterThan(0);
		expect(homeFor(o).pos).toEqual([0, 1, 0]);
		cancelGlide('h2');
		expect(homeFor(o).pos).toEqual(o.position.toArray());
	});
});
