// @ts-nocheck — plain fixtures; the module under test is typed
import { describe, it, expect, beforeEach } from 'vitest';
import {
	waterVolumes,
	normalizeWater,
	invertAffine,
	localBounds,
	MAX_RIPPLES,
	RIPPLE_LIFE
} from '../../src/lib/water/volumes.js';
import {
	waveComponents,
	waveHeightAt,
	gerstnerOffset,
	normalizeWaves,
	MAX_WAVES
} from '../../src/lib/water/waves.js';

// 36-water contracts W1 (volumes) + W2 (disturbances). The module imports nothing, so the
// scene here is plain stand-ins: {uuid, userData, matrixWorld.elements, geometry.boundingBox}.

/** column-major TRS (rotation about Y only — water stays upright) */
function trs({ pos = [0, 0, 0], rotY = 0, scale = [1, 1, 1] } = {}) {
	const c = Math.cos(rotY);
	const s = Math.sin(rotY);
	const [sx, sy, sz] = scale;
	return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, pos[0], pos[1], pos[2], 1];
}

/** a box geometry stand-in, unit cube by default */
function box(min = [-0.5, -0.5, -0.5], max = [0.5, 0.5, 0.5]) {
	return {
		boundingBox: {
			min: { x: min[0], y: min[1], z: min[2] },
			max: { x: max[0], y: max[1], z: max[2] }
		}
	};
}

let n = 0;
/** @param {any} o */
function obj(o = {}) {
	return {
		uuid: o.uuid ?? `u${++n}`,
		userData: o.water === undefined ? {} : { water: o.water },
		matrixWorld: { elements: trs(o) },
		matrix: { elements: trs(o.local ?? {}) },
		geometry: o.geometry === undefined ? box() : o.geometry,
		children: o.children ?? []
	};
}

function root(...children) {
	return { uuid: 'root', userData: {}, children };
}

beforeEach(() => waterVolumes.reset());

describe('normalizeWater', () => {
	it('fills the physics defaults and types every field', () => {
		const w = normalizeWater({});
		expect(w.version).toBe(1);
		expect(w.shape).toBe('box');
		expect(w.level).toBe(null);
		expect(w.density).toBe(1000);
		expect(w.flow).toEqual([0, 0, 0]);
		expect(w.look).toEqual({});
		expect(w.waves).toEqual({});
		expect(w.bubbles).toEqual({});
	});
	it('rejects junk and keeps unknown keys (forward compatible)', () => {
		const w = normalizeWater({
			shape: 'torus',
			density: -5,
			flow: ['a', 2],
			level: NaN,
			future: 7,
			look: { tint: '#fff' }
		});
		expect(w.shape).toBe('box');
		expect(w.density).toBe(1);
		expect(w.flow).toEqual([0, 2, 0]);
		expect(w.level).toBe(null);
		expect(w.future).toBe(7);
		expect(w.look.tint).toBe('#fff');
	});
	it('is a copy — editing the result never touches the blob', () => {
		const blob = { look: { a: 1 }, flow: [1, 0, 0] };
		const w = normalizeWater(blob);
		w.look.a = 2;
		w.flow[0] = 9;
		expect(blob.look.a).toBe(1);
		expect(blob.flow[0]).toBe(1);
	});
});

describe('matrix + bounds helpers', () => {
	it('invertAffine undoes a TRS', () => {
		const m = trs({ pos: [3, -2, 5], rotY: 0.7, scale: [2, 3, 0.5] });
		const inv = invertAffine(m);
		// m * (1,2,3) then inv -> (1,2,3)
		const p = [1, 2, 3];
		const w = [
			m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
			m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
			m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
		];
		const b = [
			inv[0] * w[0] + inv[4] * w[1] + inv[8] * w[2] + inv[12],
			inv[1] * w[0] + inv[5] * w[1] + inv[9] * w[2] + inv[13],
			inv[2] * w[0] + inv[6] * w[1] + inv[10] * w[2] + inv[14]
		];
		b.forEach((v, i) => expect(v).toBeCloseTo(p[i], 9));
		expect(invertAffine([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toBe(null);
	});
	it('localBounds: own geometry, else children through their local matrix, else a unit cube', () => {
		expect(localBounds(obj({ geometry: box([-2, 0, -1], [2, 3, 1]) }))).toEqual([
			-2, 0, -1, 2, 3, 1
		]);
		const child = obj({ local: { pos: [10, 0, 0] } });
		const group = obj({ geometry: null, children: [child] });
		expect(localBounds(group)).toEqual([9.5, -0.5, -0.5, 10.5, 0.5, 0.5]);
		const visual = obj({ local: { pos: [50, 0, 0] } });
		visual.userData.__waterVisual = true;
		expect(localBounds(obj({ geometry: null, children: [child, visual] }))[3]).toBe(10.5);
		expect(localBounds(obj({ geometry: null }))).toEqual([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
	});
	it('localBounds falls back to the position attribute when there is no boundingBox', () => {
		const geometry = { attributes: { position: { array: [0, 0, 0, 4, 1, -2, -1, 2, 3] } } };
		expect(localBounds(obj({ geometry }))).toEqual([-1, 0, -2, 4, 2, 3]);
	});
});

describe('waterVolumes.list', () => {
	it('lists exactly the objects carrying userData.water, nested ones included', () => {
		const a = obj({ water: { shape: 'box' } });
		const dry = obj({});
		const nested = obj({ water: { shape: 'cylinder' } });
		const group = obj({ geometry: null, children: [nested] });
		waterVolumes.setRoot(root(a, dry, group));
		const list = waterVolumes.list();
		expect(list.map((v) => v.uuid).sort()).toEqual([a.uuid, nested.uuid].sort());
		expect(list.find((v) => v.uuid === nested.uuid).shape).toBe('cylinder');
	});
	it('level defaults to the top of the bounds; an explicit level wins', () => {
		const a = obj({ water: {}, geometry: box([-1, -1, -1], [1, 2, 1]) });
		const b = obj({ water: { level: 0.25 } });
		waterVolumes.setRoot(root(a, b));
		const [va, vb] = waterVolumes.list();
		expect(va.level).toBe(2);
		expect(vb.level).toBe(0.25);
	});
	it('no root = no volumes; a removed object leaves the list', () => {
		expect(waterVolumes.list()).toEqual([]);
		const a = obj({ water: {} });
		const r = root(a);
		waterVolumes.setRoot(r);
		expect(waterVolumes.list().length).toBe(1);
		r.children = [];
		expect(waterVolumes.list().length).toBe(0);
	});
	it('get() resolves by uuid, by object and by volume', () => {
		const a = obj({ water: {} });
		waterVolumes.setRoot(root(a));
		const v = waterVolumes.list()[0];
		expect(waterVolumes.get(a.uuid)).toBe(v);
		expect(waterVolumes.get(a)).toBe(v);
		expect(waterVolumes.get(v)).toBe(v);
		expect(waterVolumes.get('nope')).toBe(null);
		expect(waterVolumes.get(obj({}))).toBe(null);
	});
});

describe('waterVolumes.query (W1)', () => {
	it('box: inside → depth + surfaceY; above, below the floor and outside → null', () => {
		// a 4 × 2 × 4 tank centred at (10, 1, 0): floor y = 0, surface y = 2
		const tank = obj({ water: { shape: 'box' }, pos: [10, 1, 0], scale: [4, 2, 4] });
		waterVolumes.setRoot(root(tank));
		const q = waterVolumes.query({ x: 10.5, y: 0.5, z: -1 });
		expect(q.volume.uuid).toBe(tank.uuid);
		expect(q.surfaceY).toBeCloseTo(2, 9);
		expect(q.depth).toBeCloseTo(1.5, 9);
		expect(q.flow).toEqual([0, 0, 0]);
		expect(waterVolumes.query([10, 2.01, 0])).toBe(null);
		expect(waterVolumes.query([10, -0.01, 0])).toBe(null);
		expect(waterVolumes.query([12.01, 1, 0])).toBe(null);
	});
	it('an explicit level lowers the surface below the top of the tank', () => {
		const tank = obj({ water: { level: 0 }, scale: [2, 2, 2] }); // surface at world y 0
		waterVolumes.setRoot(root(tank));
		expect(waterVolumes.query([0, 0.1, 0])).toBe(null);
		expect(waterVolumes.query([0, -0.4, 0]).depth).toBeCloseTo(0.4, 9);
	});
	it('cylinder: the inscribed ellipse, not the square', () => {
		const pool = obj({ water: { shape: 'cylinder' }, scale: [2, 1, 2] }); // radius 1
		waterVolumes.setRoot(root(pool));
		expect(waterVolumes.query([0.7, 0, 0.7])).not.toBe(null); // r = 0.99
		expect(waterVolumes.query([0.75, 0, 0.75])).toBe(null); // r = 1.06, inside the square
	});
	it('plane: no bottom — depth grows without limit inside the footprint', () => {
		const ocean = obj({ water: { shape: 'plane' }, scale: [100, 1, 100] }); // surface y 0.5
		waterVolumes.setRoot(root(ocean));
		expect(waterVolumes.query([3, -40, 3]).depth).toBeCloseTo(40.5, 9);
		expect(waterVolumes.query([60, -1, 0])).toBe(null);
	});
	it('rotated volume: the footprint and the flow rotate with it', () => {
		// long thin river along local X, rotated 90° about Y → runs along world -Z
		const river = obj({ water: { flow: [2, 0, 0] }, rotY: Math.PI / 2, scale: [10, 1, 1] });
		waterVolumes.setRoot(root(river));
		expect(waterVolumes.query([0, 0, 4])).not.toBe(null);
		expect(waterVolumes.query([4, 0, 0])).toBe(null);
		const q = waterVolumes.query([0, 0, -3]);
		expect(q.flow[0]).toBeCloseTo(0, 9);
		expect(q.flow[2]).toBeCloseTo(-2, 9); // flow magnitude survives the scale
	});
	it('overlapping volumes: the top-most surface wins', () => {
		const low = obj({ water: {}, scale: [4, 2, 4] }); // surface 1
		const high = obj({ water: {}, pos: [0, 1, 0], scale: [2, 2, 2] }); // surface 2
		waterVolumes.setRoot(root(low, high));
		expect(waterVolumes.query([0, 0.5, 0]).volume.uuid).toBe(high.uuid);
		expect(waterVolumes.query([1.5, 0.5, 0]).volume.uuid).toBe(low.uuid);
	});
	it('waves lift the surface with the clock; {flat: true} reads the still level', () => {
		const waves = { count: 1, amplitude: 0.2, wavelength: 8, choppiness: 0 };
		const sea = obj({ water: { shape: 'plane', waves }, scale: [100, 1, 100] });
		waterVolumes.setRoot(root(sea));
		const comps = waveComponents(waves);
		const t = 1.3;
		const h = waveHeightAt(comps, 2, 3, t);
		expect(Math.abs(h)).toBeGreaterThan(0.01);
		const q = waterVolumes.query([2, 0, 3], { time: t });
		expect(q.surfaceY).toBeCloseTo(0.5 + h, 9);
		expect(waterVolumes.query([2, 0, 3], { time: t, flat: true }).surfaceY).toBeCloseTo(0.5, 9);
		// the module clock is what query uses when no time is passed
		waterVolumes.setClock(() => t);
		expect(waterVolumes.query([2, 0, 3]).surfaceY).toBeCloseTo(0.5 + h, 9);
		expect(waterVolumes.surfaceY(sea.uuid, 2, 3)).toBeCloseTo(0.5 + h, 9);
	});
	it('a point between the still level and a crest is wet only while the crest is there', () => {
		const waves = { count: 1, amplitude: 0.3, wavelength: 6, choppiness: 0 };
		const sea = obj({ water: { shape: 'plane', waves }, scale: [100, 1, 100] });
		waterVolumes.setRoot(root(sea));
		const comps = waveComponents(waves);
		// find a time with a crest at x = 0 and one with a trough
		let crestT = 0;
		let troughT = 0;
		for (let t = 0; t < 4; t += 0.01) {
			const h = waveHeightAt(comps, 0, 0, t);
			if (h > waveHeightAt(comps, 0, 0, crestT)) crestT = t;
			if (h < waveHeightAt(comps, 0, 0, troughT)) troughT = t;
		}
		expect(waterVolumes.query([0, 0.6, 0], { time: crestT })).not.toBe(null);
		expect(waterVolumes.query([0, 0.6, 0], { time: troughT })).toBe(null);
	});
	it('accepts an explicit volume list (a consumer that already listed)', () => {
		const a = obj({ water: {} });
		waterVolumes.setRoot(root(a));
		const vols = waterVolumes.list();
		waterVolumes.setRoot(root());
		expect(waterVolumes.query([0, 0, 0], { volumes: vols }).volume.uuid).toBe(a.uuid);
	});
});

describe('waterVolumes.onChange / refresh', () => {
	it('fires on add, spec edit, move and removal — and not on an idle refresh', () => {
		const r = root();
		waterVolumes.setRoot(r);
		const seen = [];
		const off = waterVolumes.onChange((list) => seen.push(list.length));
		expect(waterVolumes.refresh()).toBe(false); // empty → empty is no change
		const a = obj({ water: {} });
		r.children.push(a);
		expect(waterVolumes.refresh()).toBe(true);
		expect(waterVolumes.refresh()).toBe(false);
		a.userData.water = { density: 1025 };
		expect(waterVolumes.refresh()).toBe(true);
		a.matrixWorld.elements = trs({ pos: [1, 0, 0] });
		expect(waterVolumes.refresh()).toBe(true);
		r.children = [];
		expect(waterVolumes.refresh()).toBe(true);
		expect(seen).toEqual([1, 1, 1, 0]);
		off();
		r.children.push(obj({ water: {} }));
		waterVolumes.refresh();
		expect(seen.length).toBe(4);
	});
	it('a throwing listener does not starve the others', () => {
		const r = root(obj({ water: {} }));
		waterVolumes.setRoot(r);
		let hit = 0;
		const warn = console.warn;
		console.warn = () => {};
		waterVolumes.onChange(() => {
			throw new Error('boom');
		});
		waterVolumes.onChange(() => hit++);
		waterVolumes.refresh();
		console.warn = warn;
		expect(hit).toBe(1);
	});
});

describe('waterVolumes.disturb (W2)', () => {
	it('records ripples per volume, expires them after RIPPLE_LIFE, caps at MAX_RIPPLES', () => {
		let t = 100;
		waterVolumes.setClock(() => t);
		const a = obj({ water: {}, scale: [10, 1, 10] });
		waterVolumes.setRoot(root(a));
		expect(waterVolumes.disturb(a.uuid, [1, 0.5, 2], 0.4, 0.8)).toBe(true);
		const [r] = waterVolumes.ripplesOf(a.uuid);
		expect(r).toEqual({ x: 1, z: 2, radius: 0.4, strength: 0.8, t: 100 });
		t += RIPPLE_LIFE + 0.01;
		expect(waterVolumes.ripplesOf(a.uuid)).toEqual([]);
		for (let i = 0; i < MAX_RIPPLES + 5; i++) waterVolumes.disturb(a, [i, 0, 0]);
		const live = waterVolumes.ripplesOf(a);
		expect(live.length).toBe(MAX_RIPPLES);
		expect(live[0].x).toBe(5); // the oldest were dropped
	});
	it('refuses a non-water target and sanitises the numbers', () => {
		waterVolumes.setRoot(root());
		expect(waterVolumes.disturb('nope', [0, 0, 0])).toBe(false);
		const a = obj({ water: {} });
		waterVolumes.setRoot(root(a));
		waterVolumes.disturb(a.uuid, { x: 0, y: 0, z: 0 }, -1, NaN);
		const [r] = waterVolumes.ripplesOf(a.uuid);
		expect(r.radius).toBeGreaterThan(0);
		expect(r.strength).toBe(0.5);
	});
	it('a ripple from the future (clock skew after a sync) is not live yet', () => {
		let t = 50;
		waterVolumes.setClock(() => t);
		const a = obj({ water: {} });
		waterVolumes.setRoot(root(a));
		waterVolumes.disturb(a.uuid, [0, 0, 0]);
		t = 49;
		expect(waterVolumes.ripplesOf(a.uuid)).toEqual([]);
	});
});

describe('Gerstner waves', () => {
	it('normalizeWaves clamps', () => {
		const w = normalizeWaves({ count: 99, amplitude: -1, wavelength: 0, choppiness: 7 });
		expect(w.count).toBe(MAX_WAVES);
		expect(w.amplitude).toBe(0);
		expect(w.wavelength).toBeGreaterThan(0);
		expect(w.choppiness).toBe(1);
	});
	it('flat water has no components and zero height', () => {
		expect(waveComponents({ amplitude: 0 })).toEqual([]);
		expect(waveComponents({ count: 0 })).toEqual([]);
		expect(waveHeightAt([], 1, 2, 3)).toBe(0);
	});
	it('the same blob expands to the same components (determinism across peers)', () => {
		const blob = {
			count: 5,
			amplitude: 0.1,
			wavelength: 3,
			speed: 1.2,
			direction: 40,
			choppiness: 0.7
		};
		expect(waveComponents(blob)).toEqual(waveComponents({ ...blob }));
	});
	it('Q·k·A·N never exceeds 1 (no looping crests) and directions are unit vectors', () => {
		for (const c of waveComponents({ count: 8, amplitude: 1, wavelength: 1, choppiness: 1 })) {
			expect(c.q * c.k * c.a * 8).toBeLessThanOrEqual(1 + 1e-9);
			expect(Math.hypot(c.dx, c.dz)).toBeCloseTo(1, 12);
		}
	});
	it('waveHeightAt really is the height ABOVE the point (the displaced vertex lands on it)', () => {
		const comps = waveComponents({ count: 4, amplitude: 0.15, wavelength: 2.5, choppiness: 0.8 });
		for (const [x, z, t] of [
			[0.3, 1.1, 0.5],
			[-4, 2, 3.3],
			[7.7, -0.2, 11]
		]) {
			const h = waveHeightAt(comps, x, z, t);
			// search the rest point whose displaced position lands on (x, z)
			let px = x;
			let pz = z;
			for (let i = 0; i < 50; i++) {
				const o = gerstnerOffset(comps, px, pz, t);
				px = x - o[0];
				pz = z - o[2];
			}
			const o = gerstnerOffset(comps, px, pz, t);
			expect(px + o[0]).toBeCloseTo(x, 4);
			expect(o[1]).toBeCloseTo(h, 3);
		}
	});
});
