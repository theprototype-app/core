import { describe, it, expect } from 'vitest';
import { normalizeView, clampSize, frameSize, viewPose, boundsOf, linearToSrgb, acesFilmic, linearFrameToSrgb } from '../../src/lib/agent/screenshotCore.js';
import { missingToolsFor } from '../../src/lib/agent/toolPolicy.js';

// 55 A5 (screenshot arithmetic) + A6 (the tool policy's words).

describe('views and sizes', () => {
	it('normalises the view and clamps the size', () => {
		expect(normalizeView('TOP')).toBe('top');
		expect(normalizeView('sideways')).toBe('iso');
		expect(normalizeView(undefined)).toBe('iso');
		expect(clampSize(undefined)).toBe(768);
		expect(clampSize(10)).toBe(64);
		expect(clampSize(99999)).toBe(2048);
		expect(clampSize('512')).toBe(512);
	});
	it('keeps the longest side at size and the aspect', () => {
		expect(frameSize(800, 16 / 9)).toEqual({ w: 800, h: 450 });
		expect(frameSize(800, 0.5)).toEqual({ w: 400, h: 800 });
		expect(frameSize(800, NaN)).toEqual({ w: 800, h: 450 });
	});
});

describe('viewPose', () => {
	const b = { center: [2, 1, -3], radius: 5 };
	it('top looks straight down with north up; front looks down -Z; iso from +X+Y+Z', () => {
		const top = viewPose('top', b, 50, 1);
		expect(top.position[0]).toBeCloseTo(2);
		expect(top.position[2]).toBeCloseTo(-3);
		expect(top.position[1]).toBeGreaterThan(1 + 5);
		expect(top.up).toEqual([0, 0, -1]);
		const front = viewPose('front', b, 50, 1);
		expect(front.position[0]).toBeCloseTo(2);
		expect(front.position[1]).toBeCloseTo(1);
		expect(front.position[2]).toBeGreaterThan(-3 + 5);
		const iso = viewPose('iso', b, 50, 1);
		expect(iso.position.every((v, i) => v > b.center[i])).toBe(true);
		expect(iso.target).toEqual([2, 1, -3]);
	});
	it('stands far enough that the sphere fits the NARROWER fov', () => {
		const wide = viewPose('front', b, 50, 2);
		const tall = viewPose('front', b, 50, 0.5);
		const dist = (/** @type {{position: number[]}} */ p) => Math.hypot(p.position[0] - 2, p.position[1] - 1, p.position[2] + 3);
		expect(dist(tall)).toBeGreaterThan(dist(wide));
		// the sphere's silhouette half-angle stays inside the vertical half-fov on a wide frame
		expect(Math.asin(5 / dist(wide))).toBeLessThan((25 * Math.PI) / 180);
		expect(wide.near).toBeGreaterThan(0);
		expect(wide.far).toBeGreaterThan(dist(wide) + 5);
	});
	it('an empty scene frames a small patch at the origin', () => {
		expect(boundsOf(null)).toMatchObject({ center: [0, 0.5, 0], radius: 4, empty: true });
		expect(boundsOf({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }).empty).toBe(true);
		const r = boundsOf({ min: [0, 0, 0], max: [2, 2, 2] });
		expect(r.center).toEqual([1, 1, 1]);
		expect(r.radius).toBeCloseTo(Math.sqrt(3));
	});
});

describe('linear frame -> sRGB bytes', () => {
	it('matches the sRGB transfer curve', () => {
		expect(linearToSrgb(0)).toBe(0);
		expect(linearToSrgb(1)).toBeCloseTo(1);
		expect(linearToSrgb(0.214)).toBeCloseTo(0.5, 2);
		expect(linearToSrgb(-1)).toBe(0);
		expect(linearToSrgb(9)).toBeCloseTo(1);
	});
	it('ACES maps white below 1 and black to ~0, monotonically', () => {
		const black = acesFilmic([0, 0, 0]);
		expect(Math.abs(black[0])).toBeLessThan(0.01);
		const a = acesFilmic([0.2, 0.2, 0.2])[0];
		const b = acesFilmic([0.8, 0.8, 0.8])[0];
		expect(b).toBeGreaterThan(a);
		expect(acesFilmic([10, 10, 10])[0]).toBeLessThan(1.05);
	});
	it('flips rows (WebGL reads bottom-up) and sets alpha', () => {
		// 1x2: bottom row red, top row blue (linear 1.0)
		const src = new Float32Array([1, 0, 0, 1, 0, 0, 1, 1]);
		const out = linearFrameToSrgb(src, 1, 2);
		expect([...out]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
	});
	it('byte targets go through the same curve', () => {
		const out = linearFrameToSrgb(new Uint8Array([55, 55, 55, 255]), 1, 1, { bytes: true });
		expect(out[0]).toBe(Math.round(linearToSrgb(55 / 255) * 255));
		const aces = linearFrameToSrgb(new Uint8Array([255, 255, 255, 255]), 1, 1, { bytes: true, toneMapping: 'aces' });
		expect(aces[0]).toBeGreaterThan(200);
		expect(aces[0]).toBeLessThan(255);
	});
});

describe('tool policy (A6)', () => {
	const all = { physics: true, meshLocal: false, meshHost: false, hostKnown: true, behaviours: true };
	it('explains a missing generate_mesh, pointing at the host', () => {
		const m = missingToolsFor(all);
		expect(m.map((x) => x.name)).toEqual(['generate_mesh']);
		expect(m[0].reason).toMatch(/host/);
		expect(missingToolsFor({ ...all, hostKnown: false })[0].reason).toMatch(/not joined/);
	});
	it('nothing missing when the host (or this page) can generate', () => {
		expect(missingToolsFor({ ...all, meshHost: true })).toEqual([]);
		expect(missingToolsFor({ ...all, meshLocal: true })).toEqual([]);
	});
	it('names the behaviour and physics gaps', () => {
		const m = missingToolsFor({ ...all, meshLocal: true, behaviours: false, physics: false }).map((x) => x.name);
		expect(m).toEqual(['set_physics', 'create_joints', 'control_simulation', 'create_behaviour', 'edit_behaviour']);
	});
});
