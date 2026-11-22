// 68: the allowlisted property registry + "live-control tracks record and play back exactly"
import { describe, it, expect } from 'vitest';
import { PROPS, resolvePath, propType, getProp, setProp, pathsFor, FILM_PATHS } from '../../src/lib/propTracks.js';
import { reduceSamples, sampleCurve, normalizeCurve, valueError } from '../../src/lib/curveCore.js';
import { normalizeSequence, propsAt } from '../../src/lib/sequenceCore.js';

const camera = () => ({
	position: { x: 0, y: 1, z: 2 },
	quaternion: { x: 0, y: 0, z: 0, w: 1 },
	rotation: { x: 0, y: 0, z: 0 },
	scale: { x: 1, y: 1, z: 1 },
	visible: true,
	userData: { camera: /** @type {Record<string, any>} */ ({ kind: 'perspective', fov: 50 }) }
});

describe('propTracks registry', () => {
	it('resolves aliases and refuses anything not allowlisted', () => {
		expect(resolvePath('pos.x')).toBe('position.x');
		expect(resolvePath('camera.fov')).toBe('camera.fov');
		expect(resolvePath('material.uniforms.evil')).toBe('');
		expect(resolvePath('__proto__')).toBe('');
		expect(resolvePath('constructor')).toBe('');
		expect(propType('quaternion')).toBe('quat');
	});
	it('gets and sets; refuses a wrong shape or an object it does not apply to', () => {
		const o = camera();
		expect(setProp(o, 'position', [1, 2, 3])).toBe(true);
		expect(getProp(o, 'position')).toEqual([1, 2, 3]);
		expect(setProp(o, 'position', [1, 'x', 3])).toBe(false);
		expect(setProp(o, 'camera.fov', 'wide')).toBe(false);
		expect(setProp(o, 'camera.fov', 999)).toBe(true);
		expect(o.userData.camera.fov).toBe(179); // clamped
		const box = { position: { x: 0, y: 0, z: 0 }, userData: {} };
		expect(setProp(box, 'camera.fov', 30)).toBe(false);
		expect(getProp(box, 'camera.focus')).toBe(null);
		expect(setProp(o, 'nope', 1)).toBe(false);
	});
	it('a camera marker exposes every Film path', () => {
		const paths = pathsFor(camera());
		for (const p of FILM_PATHS) expect(paths).toContain(p);
		expect(pathsFor({ position: { x: 0, y: 0, z: 0 }, userData: {} })).not.toContain('camera.fov');
		expect(Object.keys(PROPS).length).toBeGreaterThan(10);
	});
});

describe('live-control tracks record and play back exactly', () => {
	// a pinch-zoom and a focus pull recorded at 30 Hz, then reduced, then played through the
	// sequence onto a camera object: every frame lands within the take's error budget, and
	// the recorded KEY moments land exactly
	const rate = 30;
	const fov = Array.from({ length: 151 }, (_, n) => ({ t: 2 + n / rate, v: 50 - 25 * Math.min(1, Math.max(0, (n - 30) / 60)) }));
	const focus = Array.from({ length: 151 }, (_, n) => ({ t: 2 + n / rate, v: n < 75 ? 8 : 2 }));
	const fovKeys = reduceSamples('number', fov, 0.1, { fit: 'bezier' });
	const focusKeys = reduceSamples('number', focus, 0.01);
	const seq = normalizeSequence({
		tracks: [
			{ id: 'f', kind: 'prop', target: 'C', path: 'camera.fov', type: 'number', keys: fovKeys },
			{ id: 'd', kind: 'prop', target: 'C', path: 'camera.focus', type: 'number', keys: focusKeys }
		]
	});
	it('reduces to few keys', () => {
		expect(fovKeys.length).toBeLessThan(12);
		expect(focusKeys.length).toBeLessThan(6);
	});
	it('plays back onto the object within budget at every recorded frame', () => {
		const o = camera();
		for (let n = 0; n < fov.length; n++) {
			for (const p of propsAt(seq, fov[n].t)) setProp(o, p.path, p.value);
			expect(Math.abs(o.userData.camera.fov - fov[n].v)).toBeLessThanOrEqual(0.1 + 1e-9);
			// the focus PULL is a cut between two values; the frames either side are exact
			if (n !== 75 && n !== 74) expect(o.userData.camera.focus).toBeCloseTo(focus[n].v, 9);
		}
	});
	it('the curve passes exactly through each key (record → key → play is lossless at keys)', () => {
		const keys = normalizeCurve('number', fovKeys);
		for (const k of keys) expect(valueError('number', sampleCurve('number', keys, k.t), k.v)).toBeLessThan(1e-9);
	});
});
