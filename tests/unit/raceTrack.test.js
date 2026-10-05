import { describe, it, expect } from 'vitest';
import { checkpointsFor, makeProjector, newLapState, trackLap, standings, lapTime, driveStep } from '../../src/modules/race/track.js';

// 36-backlog-21c (plan 21-C4 + C8): the race track leaf — checkpoints derived from the road,
// the arc-length projector, the quadrant lap judge, standings and the arcade car step.

/** a closed oval road, ~2*(40+20) wide, record in its own frame */
const oval = () => {
	const points = [];
	for (let i = 0; i < 12; i++) {
		const a = (i / 12) * Math.PI * 2;
		points.push({ pos: [Math.cos(a) * 30, 0, Math.sin(a) * 18], radius: 4 });
	}
	return { points, closed: true };
};

/** walk the oval's curve: n samples of [x, z] for one lap starting at fraction `from` */
/** @param {any} spline @param {number} [n] @param {number} [from] @param {number} [dir] @returns {number[][]} */
const lapPath = (spline, n = 200, from = 0, dir = 1) => {
	const p = makeProjector(spline);
	if (!p) throw new Error('no projector');
	// the projector's own samples are on the curve, so re-derive positions from checkpoints
	const pts = checkpointsFor(spline, n).map((c) => [c.position[0], c.position[2]]);
	const start = Math.round(from * n);
	return Array.from({ length: n }, (_, i) => pts[(((start + dir * i) % n) + n) % n]);
};

describe('checkpointsFor', () => {
	it('spaces checkpoints evenly ALONG THE TARMAC, not by control point', () => {
		// two short spans and one long one: parameter spacing would be very uneven
		const spline = { points: [{ pos: [0, 0, 0], radius: 3 }, { pos: [2, 0, 0], radius: 3 }, { pos: [4, 0, 0], radius: 3 }, { pos: [40, 0, 0], radius: 3 }], closed: false };
		const cps = checkpointsFor(spline, 5);
		expect(cps).toHaveLength(5);
		const gaps = cps.slice(1).map((c, i) => Math.hypot(c.position[0] - cps[i].position[0], c.position[2] - cps[i].position[2]));
		const ratio = Math.max(...gaps) / Math.min(...gaps);
		expect(ratio).toBeLessThan(1.1);
	});
	it('a closed road divides the loop (no two checkpoints on the line)', () => {
		const cps = checkpointsFor(oval(), 4);
		expect(cps.map((c) => c.u)).toEqual([0, 0.25, 0.5, 0.75]);
		expect(cps[0].width).toBeCloseTo(8, 5);
	});
	it('is a pure function of the record (two peers agree byte for byte)', () => {
		expect(JSON.stringify(checkpointsFor(oval(), 8))).toBe(JSON.stringify(checkpointsFor(oval(), 8)));
	});
	it('nothing for no road or no count', () => {
		expect(checkpointsFor(null, 4)).toEqual([]);
		expect(checkpointsFor(oval(), 0)).toEqual([]);
	});
});

describe('makeProjector', () => {
	it('projects a point on the road to its arc-length fraction', () => {
		const spline = oval();
		const p = /** @type {any} */ (makeProjector(spline));
		for (const c of checkpointsFor(spline, 8)) {
			const got = p.project([c.position[0], c.position[2]]);
			const du = Math.min(Math.abs(got.u - c.u), 1 - Math.abs(got.u - c.u));
			expect(du).toBeLessThan(0.01);
			expect(got.distance).toBeLessThan(0.5);
		}
	});
	it('the bucketed answer equals the brute-force answer (grid is an optimisation, not a change)', () => {
		const spline = oval();
		const p = /** @type {any} */ (makeProjector(spline));
		const dense = checkpointsFor(spline, 4000).map((c) => [c.position[0], c.position[2], c.u]);
		for (const xz of [[31, 1], [-29, -3], [0, 17], [5, -20], [12, 9]]) {
			const got = p.project(xz);
			let best = Infinity;
			let bu = 0;
			for (const d of dense) {
				const dd = (d[0] - xz[0]) ** 2 + (d[1] - xz[1]) ** 2;
				if (dd < best) [best, bu] = [dd, d[2]];
			}
			expect(Math.abs(got.distance - Math.sqrt(best))).toBeLessThan(0.3);
			const du = Math.min(Math.abs(got.u - bu), 1 - Math.abs(got.u - bu));
			expect(du).toBeLessThan(0.01);
		}
	});
	it('a point far off the road still projects (full-scan fallback)', () => {
		const p = /** @type {any} */ (makeProjector(oval()));
		const got = p.project([300, 0]);
		expect(got.u).toBeGreaterThanOrEqual(0);
		expect(got.u).toBeLessThan(1);
		expect(got.distance).toBeGreaterThan(200);
	});
});

describe('the lap judge', () => {
	it('a real circuit counts exactly one lap per wrap (leaving the grid is the start, not a lap)', () => {
		const spline = oval();
		const p = /** @type {any} */ (makeProjector(spline));
		const s = newLapState();
		// start just before the line (the grid): the first crossing STARTS the race
		const path = lapPath(spline, 200, 0.97);
		let laps = 0;
		const seen = [];
		for (let lap = 0; lap < 3; lap++) {
			for (const xz of path) laps = trackLap(s, p.project(xz)).laps;
			seen.push(laps);
		}
		// three passes of the path from 0.97 end at 0.97 again: two laps done, the third not yet
		expect(seen).toEqual([0, 1, 2]);
		for (const xz of path.slice(0, 10)) laps = trackLap(s, p.project(xz)).laps;
		expect(laps).toBe(3);
	});
	it('ANTI-CHEAT: reversing back and forth over the line counts nothing', () => {
		const spline = oval();
		const p = /** @type {any} */ (makeProjector(spline));
		const s = newLapState();
		const near = checkpointsFor(spline, 400);
		const before = near[392];
		const after = near[8];
		let laps = 0;
		for (let i = 0; i < 30; i++) {
			laps = trackLap(s, p.project([before.position[0], before.position[2]])).laps;
			laps = trackLap(s, p.project([after.position[0], after.position[2]])).laps;
		}
		expect(laps).toBe(0);
	});
	it('driving the circuit BACKWARDS counts nothing', () => {
		const spline = oval();
		const p = /** @type {any} */ (makeProjector(spline));
		const s = newLapState();
		const path = lapPath(spline, 200, 0.5, -1);
		let laps = 0;
		for (let lap = 0; lap < 3; lap++) for (const xz of path) laps = trackLap(s, p.project(xz)).laps;
		expect(laps).toBe(0);
	});
	it('a short-cut across the infield (skipping a quarter) does not count', () => {
		const spline = oval();
		const p = /** @type {any} */ (makeProjector(spline));
		const s = newLapState();
		const path = lapPath(spline, 200, 0.97).filter((xz) => {
			const u = p.project(xz).u;
			return !(u > 0.3 && u < 0.7);
		});
		let laps = 0;
		for (const xz of path) laps = trackLap(s, p.project(xz)).laps;
		expect(laps).toBe(0);
	});
	it('premise: the cheat path does cross the line (so the zero above is not vacuous)', () => {
		const spline = oval();
		const p = /** @type {any} */ (makeProjector(spline));
		const near = checkpointsFor(spline, 400);
		expect(p.project([near[392].position[0], near[392].position[2]]).u).toBeGreaterThan(0.75);
		expect(p.project([near[8].position[0], near[8].position[2]]).u).toBeLessThan(0.25);
	});
});

describe('standings + lapTime', () => {
	it('finishers by time, then laps, then progress, ties by id', () => {
		const rows = standings([
			{ id: 'b', laps: 2, u: 0.5 },
			{ id: 'a', laps: 2, u: 0.5 },
			{ id: 'c', laps: 3, u: 0.1, finish: 95.2 },
			{ id: 'd', laps: 3, u: 0.1, finish: 91.0 },
			{ id: 'e', laps: 2, u: 0.9 }
		]);
		expect(rows.map((r) => r.id)).toEqual(['d', 'c', 'e', 'a', 'b']);
	});
	it('formats m:ss.t', () => {
		expect(lapTime(65.27)).toBe('1:05.3');
		expect(lapTime(9.04)).toBe('0:09.0');
		expect(lapTime(0)).toBe('–');
	});
});

describe('driveStep (the arcade car)', () => {
	const P = { maxSpeed: 20, accel: 10, brake: 25, turnRate: 2, grip: 0.9 };
	it('throttle eases the forward speed toward its target along -Z of the heading', () => {
		let v = [0, 0, 0];
		for (let i = 0; i < 30; i++) v = driveStep({ linvel: v, yaw: 0, throttle: 1, steer: 0, dt: 1 / 60 }, P).linvel;
		expect(v[2]).toBeCloseTo(-5, 1);
		expect(Math.abs(v[0])).toBeLessThan(1e-9);
	});
	it('keeps the vertical velocity (gravity is the simulation\'s)', () => {
		expect(driveStep({ linvel: [0, -3, 0], yaw: 0, throttle: 0, steer: 0, dt: 1 / 60 }, P).linvel[1]).toBe(-3);
	});
	it('grip bleeds the sideways slide', () => {
		const out = driveStep({ linvel: [5, 0, -10], yaw: 0, throttle: 0.5, steer: 0, dt: 1 / 60 }, P);
		expect(Math.abs(out.linvel[0])).toBeLessThan(5);
	});
	it('steering turns more with speed, none at a standstill, and flips in reverse', () => {
		expect(driveStep({ linvel: [0, 0, 0], yaw: 0, throttle: 0, steer: 1, dt: 1 / 60 }, P).yawRate).toBeCloseTo(0, 9);
		const fwd = driveStep({ linvel: [0, 0, -10], yaw: 0, throttle: 0.5, steer: 1, dt: 1 / 60 }, P).yawRate;
		const back = driveStep({ linvel: [0, 0, 10], yaw: 0, throttle: -0.5, steer: 1, dt: 1 / 60 }, P).yawRate;
		expect(fwd).toBeLessThan(0);
		expect(back).toBeGreaterThan(0);
	});
	it('braking against the motion bites harder than accelerating', () => {
		const brake = driveStep({ linvel: [0, 0, -10], yaw: 0, throttle: -1, steer: 0, dt: 0.1 }, P).speed;
		const accel = driveStep({ linvel: [0, 0, 0], yaw: 0, throttle: 1, steer: 0, dt: 0.1 }, P).speed;
		expect(10 - brake).toBeGreaterThan(accel);
	});
});
