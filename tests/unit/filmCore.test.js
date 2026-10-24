// 68 V2/V3/V5: Film mode's pure maths — sensor → camera quaternion (screen-rotation aware),
// recentre, horizon lock, roll, movement, lens, One-Euro, raw packing
import { describe, it, expect } from 'vitest';
import {
	cameraQuatFromAngles,
	deviceQuatFromAngles,
	cameraQuatFromDevice,
	forwardOf,
	quatRotate,
	quatMul,
	quatAxisAngle,
	recentreOffset,
	yawOf,
	levelHorizon,
	rollOf,
	withRoll,
	filmOrientation,
	lookAtQuat,
	moveStep,
	stickValue,
	walkPosition,
	clampWalkScale,
	fovForFocal,
	focalForFov,
	pinchFov,
	snapToLens,
	oneEuro,
	oneEuroQuat,
	smoothingParams,
	packRaw,
	unpackRaw,
	formatTake
} from '../../src/lib/film/filmCore.js';

const near = (/** @type {number[]} */ a, /** @type {number[]} */ b, d = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < d);
const up = (/** @type {number[]} */ q) => quatRotate(q, [0, 1, 0]);

describe('sensor → camera orientation', () => {
	it('flat on the table, screen up, the camera films straight DOWN', () => {
		expect(near(forwardOf(cameraQuatFromAngles(0, 0, 0)), [0, -1, 0])).toBe(true);
	});
	it('upright in portrait (beta 90) it films the horizon, north = -Z, up is up', () => {
		const q = cameraQuatFromAngles(0, 90, 0);
		expect(near(forwardOf(q), [0, 0, -1])).toBe(true);
		expect(near(up(q), [0, 1, 0])).toBe(true);
	});
	it('alpha turns the camera about the vertical (compass)', () => {
		// alpha 90 = the device's top points WEST (alpha counts counter-clockwise from north)
		const q = cameraQuatFromAngles(90, 90, 0);
		expect(near(forwardOf(q), [-1, 0, 0])).toBe(true);
	});
	it('tilting back (beta 120) looks up', () => {
		expect(forwardOf(cameraQuatFromAngles(0, 120, 0))[1]).toBeCloseTo(Math.sin(Math.PI / 6), 9); // 30° above the horizon
	});
	it('SCREEN ROTATION: landscape (angle 90) holding the phone sideways still films level', () => {
		// held in landscape with the top to the left: the device is rolled -90° about its
		// back axis (gamma -90 upright → the W3C angles a browser reports)
		const portrait = cameraQuatFromAngles(0, 90, 0, 0);
		// rotate the DEVICE by +90° about the screen normal, then tell the maths the screen
		// turned too → the image must be the same as upright portrait
		const dev = quatMul(deviceQuatFromAngles(0, 90, 0), quatAxisAngle([0, 0, 1], (90 * Math.PI) / 180));
		const landscape = cameraQuatFromDevice(dev, 90);
		expect(near(forwardOf(landscape), forwardOf(portrait))).toBe(true);
		expect(near(up(landscape), up(portrait))).toBe(true);
		// without the screen compensation the horizon would be rolled 90°
		const wrong = cameraQuatFromDevice(dev, 0);
		expect(Math.abs(Math.abs(rollOf(wrong)) - 90)).toBeLessThan(1e-6);
	});
	it('all four screen angles keep the horizon level for a matching device roll', () => {
		for (const angle of [0, 90, 180, 270]) {
			const dev = quatMul(deviceQuatFromAngles(30, 80, 0), quatAxisAngle([0, 0, 1], (angle * Math.PI) / 180));
			expect(Math.abs(rollOf(cameraQuatFromDevice(dev, angle)))).toBeLessThan(1e-6);
		}
	});
});

describe('recentre / horizon lock / roll', () => {
	it('recentre matches the target yaw and keeps pitch', () => {
		const sensor = cameraQuatFromAngles(37, 100, 0); // facing somewhere, tilted up 10°
		const target = quatAxisAngle([0, 1, 0], 1.2);
		const q = filmOrientation(sensor, { offset: recentreOffset(sensor, target) });
		expect(yawOf(q)).toBeCloseTo(yawOf(target), 6);
		expect(forwardOf(q)[1]).toBeCloseTo(forwardOf(sensor)[1], 6);
	});
	it('horizon lock removes roll and keeps where it looks', () => {
		const rolled = quatMul(cameraQuatFromAngles(10, 80, 0), quatAxisAngle([0, 0, 1], 0.4));
		expect(Math.abs(rollOf(rolled))).toBeGreaterThan(5);
		const lv = levelHorizon(rolled);
		expect(Math.abs(rollOf(lv))).toBeLessThan(1e-6);
		expect(near(forwardOf(lv), forwardOf(rolled))).toBe(true);
	});
	it('the dutch dial and the level bubble agree on sign and size', () => {
		const lv = levelHorizon(cameraQuatFromAngles(0, 90, 0));
		expect(rollOf(withRoll(lv, 12))).toBeCloseTo(12, 6);
		expect(rollOf(withRoll(lv, -30))).toBeCloseTo(-30, 6);
		expect(rollOf(filmOrientation(cameraQuatFromAngles(0, 90, 40), { horizonLock: true, roll: 7 }))).toBeCloseTo(7, 6);
	});
	it('track-a-target aims -Z at the target', () => {
		const q = lookAtQuat([0, 1, 5], [3, 2, 1]);
		const f = forwardOf(q);
		const d = [3, 1, -4].map((c) => c / Math.hypot(3, 1, -4));
		expect(near(f, d)).toBe(true);
		expect(Math.abs(rollOf(q))).toBeLessThan(1e-6);
	});
});

describe('movement', () => {
	it('the stick moves along the floor-projected forward and right; lift is world Y', () => {
		const down = cameraQuatFromAngles(0, 45, 0); // looking down-forward
		const p = moveStep([0, 0, 0], down, { x: 0, y: 1 }, 0, 4, 0.25);
		expect(p[1]).toBe(0);
		expect(near(p, [0, 0, -1])).toBe(true);
		const r = moveStep([0, 0, 0], down, { x: 1, y: 0 }, 1, 4, 0.25);
		expect(near(r, [1, 1, 0])).toBe(true);
	});
	it('a dt spike is capped (a stalled tab must not fling the camera)', () => {
		const p = moveStep([0, 0, 0], [0, 0, 0, 1], { x: 0, y: 1 }, 0, 4, 10);
		expect(p[2]).toBeCloseTo(-1, 9);
	});
	it('stickValue: dead zone, rim = 1, gentle near the centre', () => {
		expect(stickValue(3, 3, 60)).toEqual({ x: 0, y: 0 });
		const rim = stickValue(0, -60, 60);
		expect(rim.y).toBeCloseTo(1, 9);
		expect(stickValue(0, -30, 60).y).toBeLessThan(0.5);
		expect(stickValue(0, -600, 60).y).toBeCloseTo(1, 9);
	});
	it('AR walk: 2 m forward × walk scale, turned by the anchor yaw', () => {
		const p = walkPosition([10, 0, 0], Math.PI / 2, [0, 1.6, 0], [0, 1.6, -2], 3);
		// a quarter turn left: the room's -Z becomes the scene's -X
		expect(near(p, [4, 0, 0])).toBe(true);
		expect(clampWalkScale(99)).toBe(20);
		expect(clampWalkScale(0)).toBe(0.1);
	});
});

describe('lens', () => {
	it('focal ↔ fov round-trips and 50 mm ≈ 27° vertical on full frame', () => {
		expect(fovForFocal(50)).toBeCloseTo(26.99, 1);
		for (const mm of [18, 24, 35, 50, 85]) expect(focalForFov(fovForFocal(mm))).toBeCloseTo(mm, 6);
	});
	it('pinch out zooms in by the focal ratio; lens snaps catch near presets', () => {
		expect(focalForFov(pinchFov(fovForFocal(35), 2))).toBeCloseTo(70, 4);
		expect(focalForFov(snapToLens(fovForFocal(49)))).toBeCloseTo(50, 6);
		expect(snapToLens(fovForFocal(42))).toBeCloseTo(fovForFocal(42), 9);
	});
});

describe('One-Euro', () => {
	it('smooths jitter when still and follows a fast move with little lag', () => {
		const f = oneEuro({ minCutoff: 1, beta: 0.5 });
		let seed = 1;
		const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.02;
		let spread = 0;
		for (let n = 0; n < 120; n++) {
			const out = f.filter([1 + noise()], n / 60)[0];
			if (n > 60) spread = Math.max(spread, Math.abs(out - 1));
		}
		expect(spread).toBeLessThan(0.005); // raw jitter is ±0.01
		const g = oneEuro({ minCutoff: 1, beta: 0.5 });
		let out = 0;
		for (let n = 0; n <= 60; n++) out = g.filter([n / 6], n / 60)[0]; // 10 units/s ramp
		expect(10 - out).toBeLessThan(0.6);
	});
	it('the quaternion filter keeps unit length across a sign flip', () => {
		const f = oneEuroQuat({ minCutoff: 2 });
		f.filter([0, 0, 0, 1], 0);
		const q = f.filter([0, 0, 0, -1], 1 / 60); // the same orientation, other hemisphere
		expect(Math.hypot(...q)).toBeCloseTo(1, 9);
		expect(q[3]).toBeCloseTo(1, 6);
	});
	it('smoothing 0 = raw (no filter); more = a lower cutoff', () => {
		expect(smoothingParams(0)).toBe(null);
		expect(/** @type {any} */ (smoothingParams(0.9)).minCutoff).toBeLessThan(/** @type {any} */ (smoothingParams(0.2)).minCutoff);
	});
});

describe('takes', () => {
	it('raw samples pack into Float32 and back (smoothed + unfiltered pose)', () => {
		const s = [
			{ t: 0, pos: [1, 2, 3], quat: [0, 0, 0, 1], fov: 40, focus: 3, aperture: 2.8, roll: 5, rawPos: [1.1, 2, 3], rawQuat: [0, 0.1, 0, 0.99] },
			{ t: 1 / 30, pos: [1, 2, 4], quat: [0, 0, 0, 1], fov: 41 }
		];
		const back = unpackRaw(packRaw(s));
		expect(back.length).toBe(2);
		expect(back[0].rawPos[0]).toBeCloseTo(1.1, 5);
		expect(back[1].rawPos).toEqual([1, 2, 4]);
		expect(back[0].roll).toBe(5);
		expect(formatTake(67.44)).toBe('1:07.4');
	});
});
