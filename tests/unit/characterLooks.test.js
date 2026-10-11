// @ts-nocheck — plain fixtures (a seeded generator and px arithmetic), checked by the assertions
// 41 G8/G9: the customise panel's presets, its Custom entry, Surprise me, and the framing maths.
import { describe, it, expect } from 'vitest';
import { presetList, presetLook, presetOf, lookOf, sameLook, lookSignature, randomLook, LOOK_KEYS } from '../../src/lib/avatars/characterLooks.js';
import * as THREE from 'three';
import { fitDistance, fitToCorners, centreOffset, freeRect, BODY_HEIGHT, BODY_WIDTH, FILL, MIN_DIST } from '../../src/lib/avatars/characterFraming.js';
import { AVATAR_DEFAULTS } from '../../src/lib/avatarModel.js';
import { CHARACTERS } from '../../src/lib/avatars/catalog.js';

/** a seeded generator (mulberry32) so a failure reproduces */
function seeded(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('presets (G9)', () => {
	it('lists Auto, every rigged character, then the classic head', () => {
		const ids = presetList().map((p) => p.id);
		expect(ids[0]).toBe('auto');
		expect(ids.at(-1)).toBe('classic');
		expect(ids.slice(1, -1)).toEqual(CHARACTERS.map((c) => c.id));
	});

	it('a preset is its defaults, and every look key is decided by it', () => {
		const look = presetLook('mage');
		expect(Object.keys(look).sort()).toEqual([...LOOK_KEYS].sort());
		expect(look).toMatchObject({ character: 'mage', head: AVATAR_DEFAULTS.head, hat: 'none', outfit: '', body: AVATAR_DEFAULTS.body });
	});

	it('presetOf names the preset a config IS, and null once a look key differs', () => {
		const base = { ...AVATAR_DEFAULTS, ...presetLook('knight'), showLabel: false };
		expect(presetOf(base)).toBe('knight');
		expect(presetOf({ ...base, hat: 'crown' })).toBeNull();
		expect(presetOf({ ...base, body: '#123456' })).toBeNull();
		// the name label is a pref, not part of a character
		expect(presetOf({ ...base, showLabel: true })).toBe('knight');
		// colours compare case-insensitively (a colour input reports lower case)
		expect(presetOf({ ...base, body: AVATAR_DEFAULTS.body.toUpperCase() })).toBe('knight');
		expect(presetOf(AVATAR_DEFAULTS)).toBe('auto');
		expect(presetOf({ ...AVATAR_DEFAULTS, character: 'from-a-newer-build' })).toBeNull();
	});

	it('lookOf keeps only look keys, filling the defaults', () => {
		const l = lookOf({ character: 'rogue', showLabel: false, extra: 1 });
		expect(Object.keys(l).sort()).toEqual([...LOOK_KEYS].sort());
		expect(l.character).toBe('rogue');
		expect(l.hat).toBe(AVATAR_DEFAULTS.hat);
	});
});

describe('Surprise me (G9)', () => {
	it('deals a different look from the previous one on every press', () => {
		const rand = seeded(41);
		let prev = { ...AVATAR_DEFAULTS };
		for (let i = 0; i < 200; i++) {
			const next = randomLook(prev, rand);
			expect(sameLook(next, prev)).toBe(false);
			prev = next;
		}
	});

	it('ten presses are ten distinct characters (head/hat/shape and colours vary)', () => {
		for (const seed of [1, 2, 3, 99, 12345]) {
			const rand = seeded(seed);
			const seen = new Set();
			let prev = null;
			for (let i = 0; i < 10; i++) {
				prev = randomLook(prev, rand);
				seen.add(lookSignature(prev));
			}
			expect(seen.size).toBe(10);
		}
	});

	it('every dealt look is a valid config: a known body, a known hat, real colours', () => {
		const rand = seeded(7);
		const bodies = new Set([...CHARACTERS.map((c) => c.id), 'classic']);
		const hats = new Set();
		const characters = new Set();
		let prev = null;
		for (let i = 0; i < 300; i++) {
			const l = randomLook(prev, rand);
			expect(bodies.has(l.character)).toBe(true);
			expect(['none', 'cap', 'tophat', 'crown']).toContain(l.hat);
			expect(l.body).toMatch(/^#[0-9a-f]{6}$/);
			expect(l.outfit === '' || /^#[0-9a-f]{6}$/.test(l.outfit)).toBe(true);
			hats.add(l.hat);
			characters.add(l.character);
			prev = l;
		}
		// over 300 deals every hat and most bodies show up
		expect(hats.size).toBe(4);
		expect(characters.size).toBeGreaterThanOrEqual(CHARACTERS.length);
	});

	it('a generator that repeats itself still never deals the same look twice in a row', () => {
		const stuck = () => 0.5;
		const first = randomLook(null, stuck);
		const second = randomLook(first, stuck);
		expect(sameLook(first, second)).toBe(false);
	});
});

describe('framing (G8)', () => {
	const t = Math.tan((40 * Math.PI) / 360);
	/** how many css px the body's envelope spans at a distance */
	const span = (metres, dist, viewH) => (metres * viewH) / (2 * dist * t);

	for (const [name, view, panel, sheet] of [
		['desktop 1440x900, side drawer', { left: 0, top: 0, width: 1440, height: 900 }, { left: 1100, top: 64, width: 340, height: 836 }, false],
		['unfolded 770x850, side drawer', { left: 0, top: 0, width: 770, height: 850 }, { left: 430, top: 64, width: 340, height: 786 }, false],
		['folded 390x896, bottom sheet', { left: 0, top: 0, width: 390, height: 896 }, { left: 0, top: 436, width: 390, height: 400 }, true]
	]) {
		it(`${name}: the whole envelope fits the free rect, centred on it`, () => {
			const free = freeRect(view, panel, sheet);
			if (sheet) expect(free.y + free.h).toBeLessThanOrEqual(panel.top);
			else expect(free.x + free.w).toBeLessThanOrEqual(panel.left);
			const d = fitDistance({ viewH: view.height, free, fovDeg: 40 });
			expect(d).toBeGreaterThanOrEqual(MIN_DIST);
			expect(span(BODY_HEIGHT, d, view.height)).toBeLessThanOrEqual(free.h * FILL + 0.5);
			expect(span(BODY_WIDTH, d, view.height)).toBeLessThanOrEqual(free.w * FILL + 0.5);
			const [fw, fh, ox, oy, w, h] = centreOffset(view.width, view.height, free);
			expect([fw, fh, w, h]).toEqual([view.width, view.height, view.width, view.height]);
			// the camera's centre of view (the full image's centre) lands on the free centre
			expect(view.width / 2 - ox).toBeCloseTo(free.x + free.w / 2, 6);
			expect(view.height / 2 - oy).toBeCloseTo(free.y + free.h / 2, 6);
		});
	}

	it('a narrow free rect is fitted by its WIDTH, not only its height', () => {
		const free = { x: 0, y: 0, w: 120, h: 800 };
		const d = fitDistance({ viewH: 800, free, fovDeg: 40 });
		expect(span(BODY_WIDTH, d, 800)).toBeCloseTo(120 * FILL, 3);
	});

	it('a drawer that leaves nothing frames on the whole canvas instead of collapsing', () => {
		const free = freeRect({ left: 0, top: 0, width: 400, height: 800 }, { left: 20, top: 64, width: 380, height: 736 }, false);
		expect(free.w).toBe(400);
	});
});

describe('fitting the measured body (G8)', () => {
	it('puts the farthest projected corner of a 3/4-view box at the fill line of the free rect', () => {
		const box = new THREE.Box3(new THREE.Vector3(-1.1, 0, -0.4), new THREE.Vector3(1.1, 2.6, 0.4));
		const corners = [];
		for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
		const target = [0, 1.3, 0];
		const v = [0.7, 0.2, 0.7];
		const len = Math.hypot(...v);
		const dir = v.map((n) => n / len);
		for (const [w, hgt, free] of [
			[770, 850, { x: 0, y: 64, w: 430, h: 786 }],
			[390, 896, { x: 0, y: 64, w: 390, h: 296 }],
			[1440, 900, { x: 0, y: 64, w: 1100, h: 836 }]
		]) {
			const cam = new THREE.PerspectiveCamera(40, w / hgt, 0.1, 500);
			const d0 = fitDistance({ viewH: hgt, free, fovDeg: 40 });
			const d = fitToCorners({ cam, corners, target, dir, dist: d0, viewW: w, viewH: hgt, free });
			cam.position.set(...target.map((t, i) => t + dir[i] * d));
			cam.lookAt(...target);
			cam.updateMatrixWorld(true);
			let worst = 0;
			for (const c of corners) {
				const p = c.clone().project(cam);
				const px = ((p.x + 1) / 2) * w;
				const py = ((1 - p.y) / 2) * hgt;
				expect(px).toBeGreaterThanOrEqual(free.x - 0.5);
				expect(px).toBeLessThanOrEqual(free.x + free.w + 0.5);
				expect(py).toBeGreaterThanOrEqual(free.y - 0.5);
				expect(py).toBeLessThanOrEqual(free.y + free.h + 0.5);
				worst = Math.max(worst, Math.abs(px - (free.x + free.w / 2)) / (free.w / 2), Math.abs(py - (free.y + free.h / 2)) / (free.h / 2));
			}
			// tight: the body fills the free rect to the fill line, not a guess's worth less
			expect(worst).toBeGreaterThan(FILL - 0.03);
			expect(worst).toBeLessThan(FILL + 0.01);
		}
	});
});
