import { describe, it, expect } from 'vitest';
import { normalizeView, clampSize, frameSize, viewPose, boundsOf, linearToSrgb, acesFilmic, linearFrameToSrgb, planShot, parseAspect, dirFrom } from '../../src/lib/agent/screenshotCore.js';
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
		// mcp-fix: a person's own tab hosts its own session, so "not joined" would contradict status.joined
		expect(missingToolsFor({ ...all, hostKnown: false, personTab: true })[0].reason).not.toMatch(/not joined/);
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

describe('17: shape, angles and the camera a shot asks for', () => {
	it('framed views are 4:3 whatever the canvas; current keeps the canvas', () => {
		for (const view of ['top', 'front', 'iso']) expect(planShot({ view, size: 700 }, 3.8)).toMatchObject({ w: 700, h: 525, current: false });
		expect(planShot({ view: 'focus', uuid: 'u', size: 700 }, 2)).toMatchObject({ w: 700, h: 525 });
		expect(planShot({ view: 'current', size: 700 }, 2)).toMatchObject({ w: 700, h: 350, current: true });
		expect(planShot({ size: 800 }, 3.8)).toMatchObject({ w: 800, h: 600, view: 'iso' });
	});
	it('aspect reads as a ratio or a number and stays clamped', () => {
		expect(parseAspect('4:3')).toBeCloseTo(4 / 3);
		expect(parseAspect('16/9')).toBeCloseTo(16 / 9);
		expect(parseAspect('1.5')).toBe(1.5);
		expect(parseAspect(2)).toBe(2);
		for (const bad of ['wide', '4:0', 0, -1, NaN, null]) expect(parseAspect(bad), String(bad)).toBe(null);
		expect(planShot({ view: 'iso', aspect: '1:1', size: 500 }, 3)).toMatchObject({ w: 500, h: 500 });
		expect(planShot({ view: 'current', aspect: '1:1', size: 500 }, 3)).toMatchObject({ w: 500, h: 500 });
		expect(planShot({ view: 'iso', aspect: 40, size: 800 }, 1)).toMatchObject({ w: 800, h: 200 });
		expect(planShot({ view: 'iso', aspect: 'wide' }, 1).problem).toMatch(/aspect/);
	});
	it('from names an angle, or yaw and pitch in degrees', () => {
		expect(dirFrom('left')).toEqual([-1, 0, 0]);
		expect(dirFrom('below')).toEqual([0, -1, 0]);
		const right = /** @type {number[]} */ (dirFrom({ yaw: 90, pitch: 0 }));
		expect(right[0]).toBeCloseTo(1);
		expect(right[2]).toBeCloseTo(0);
		expect(/** @type {number[]} */ (dirFrom({ yaw: 0, pitch: 90 }))[1]).toBeCloseTo(1);
		expect(dirFrom('sideways')).toBe(null);
		expect(dirFrom({ yaw: 'x', pitch: 0 })).toBe(null);
		expect(planShot({ from: 'sideways' }, 1).problem).toMatch(/from is one of/);
		expect(planShot({ view: 'current', from: 'left' }, 2)).toMatchObject({ current: false, dir: [-1, 0, 0] });
	});
	it('viewPose stands where the angle says, closer with zoom, further with margin', () => {
		const b = { center: [1, 2, 3], radius: 2 };
		const left = viewPose('iso', b, 50, 4 / 3, 1.15, [-1, 0, 0]);
		expect(left.position[0]).toBeLessThan(1);
		expect(left.position[1]).toBe(2);
		expect(left.target).toEqual([1, 2, 3]);
		const near = viewPose('iso', b, 50, 4 / 3, 1.15, [-1, 0, 0], 2);
		expect(1 - near.position[0]).toBeCloseTo((1 - left.position[0]) / 2);
		expect(viewPose('iso', b, 50, 4 / 3, 2, [-1, 0, 0]).position[0]).toBeLessThan(left.position[0]);
		expect(viewPose('top', b, 50, 1).up).toEqual([0, 0, -1]);
		expect(viewPose('iso', b, 50, 1, 1.15, [0, -1, 0]).up).toEqual([0, 0, 1]);
		expect(viewPose('iso', b, 50, 1, 1.15, [1, 0, 0]).up).toEqual([0, 1, 0]);
	});
	it('focus takes one uuid or many; a free camera needs both points', () => {
		expect(planShot({ view: 'focus' }, 1).problem).toMatch(/focus needs/);
		expect(planShot({ view: 'focus', uuids: ['a', 'b'], uuid: 'a' }, 1)).toMatchObject({ uuids: ['a', 'b'] });
		expect(planShot({ camera: { position: [0, 1, 2] } }, 1).problem).toMatch(/position and target/);
		expect(planShot({ camera: { position: [0, 1, 2], target: [0, 1, 2] } }, 1).problem).toMatch(/same point/);
		expect(planShot({ view: 'focus', camera: { position: [0, 1, 2], target: [0, 0, 0] } }, 1)).toMatchObject({ problem: null, free: { position: [0, 1, 2], target: [0, 0, 0] }, current: false });
	});
	it('zoom and margin stay in range', () => {
		expect(planShot({ zoom: 100, margin: 0 }, 1)).toMatchObject({ zoom: 10, margin: 0.5 });
		expect(planShot({}, 1)).toMatchObject({ zoom: 1, margin: 1.15 });
	});
});
