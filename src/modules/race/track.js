// 36-backlog-21c (plan 21-C4): the RACE TRACK maths — checkpoints DERIVED from the road, the lap
// judge, and the race standings. Pure: splineTube only, no scene, no GL, so it runs in vitest.
//
// Revived from core commit 233c707 (roadGates.js), which b58ec10 removed from core on purpose:
// laps are racing RULES, not world-building, so they belong to the race module. It is a CORE
// module (the Mini Golf shape), so it may import splineTube where an installable one could not.
//
// THE ROAD IS THE DATA. The road is a Spline object carrying `userData.spline` — replicated by
// toJSON, saved in the .tpscene, editable by any peer, normalizeSpline'd on both sides of the
// wire. Every peer derives the same checkpoints from the same record with ZERO messages
// (determinism is the netcode). Move a control point and the checkpoints follow.
//
// PROGRESS, NOT GATES, decides a lap. A driver reversing back and forth over the finish line
// would farm crossings off gates; the naive interval between two positions is the part NOT
// travelled once the parameter wraps (the animation loop-wrap lesson). A lap needs the
// arc-length parameter to WRAP from the last quarter to the first with all four quadrant flags
// set since the previous lap.

import { splineCurve, normalizeSpline } from '../../lib/splineTube.js';
// (the .js is deliberate: it keeps this file importable straight from node for the unit tests)

/** @param {any} value @param {number} fallback */
const num = (value, fallback) => {
	const parsed = parseFloat(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Per-point radius at an ARC-LENGTH fraction u. splineTube's `radiusAt` takes the CURVE
 * parameter t, and u is not t on anything but a uniformly spaced spline.
 * @param {number[]} radii @param {number} u @param {boolean} closed
 */
function radiusAtU(radii, u, closed) {
	const n = radii.length;
	if (n === 0) return 1;
	if (n === 1) return radii[0];
	const span = (n - (closed ? 0 : 1)) * Math.min(Math.max(u, 0), 1);
	const index = Math.min(Math.floor(span), n - 1);
	const weight = span - index;
	const a = radii[index % n];
	const b = radii[(index + 1) % n];
	return a + (b - a) * weight;
}

/**
 * `count` checkpoints evenly spaced ALONG THE TARMAC (`getPointAt` is arc-length
 * parameterised; `getPoint` would crowd them wherever the control points bunch). Checkpoint 0
 * is the start/finish line; on a closed road the last one stops short of the wrap.
 * Positions are in the ROAD's own frame (the record's frame).
 * @param {any} spline the road's `userData.spline` record
 * @param {number} count
 * @returns {{index: number, u: number, position: number[], tangent: number[], width: number}[]}
 */
export function checkpointsFor(spline, count) {
	const curve = splineCurve(spline);
	const total = Math.max(Math.round(num(count, 0)), 0);
	if (!curve || total < 1) return [];
	const data = normalizeSpline(spline);
	const radii = data.points.map((p) => p.radius);
	const divisor = data.closed ? total : Math.max(total - 1, 1);
	const out = [];
	for (let i = 0; i < total; i++) {
		const u = total === 1 ? 0 : Math.min(i / divisor, 1);
		const point = curve.getPointAt(u);
		const tangent = curve.getTangentAt(u);
		out.push({
			index: i,
			u,
			position: [point.x, point.y, point.z],
			tangent: [tangent.x, tangent.y, tangent.z],
			// a checkpoint spans the road: the tube's DIAMETER there
			width: radiusAtU(radii, u, data.closed) * 2
		});
	}
	return out;
}

/** samples per metre of road for the projection (clamped below) */
const SAMPLES_PER_M = 2;

/**
 * A projector for one road record: `project([x, z])` → where that point is along the road.
 * Building it samples the curve ONCE (arc-length spaced) and buckets the samples into an XZ
 * grid, so a per-frame projection tests a handful of samples instead of all of them — the C3
 * carve's hash-grid shape. Pure and stateless after construction.
 * @param {any} spline
 * @returns {null | {length: number, closed: boolean, project: (xz: number[]) => {u: number, distance: number, quadrant: number, along: number[]}}}
 */
export function makeProjector(spline) {
	const curve = splineCurve(spline);
	if (!curve) return null;
	const data = normalizeSpline(spline);
	const length = curve.getLength();
	const count = Math.min(Math.max(Math.round(length * SAMPLES_PER_M), 32), 4000);
	const points = curve.getSpacedPoints(count);
	// a closed curve's last spaced point IS the first one again
	const n = data.closed ? count : count + 1;
	const xs = new Float64Array(n);
	const zs = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		xs[i] = points[i].x;
		zs[i] = points[i].z;
	}
	const maxR = Math.max(...data.points.map((p) => p.radius), 1);
	const cell = Math.max(maxR * 2, 4);
	/** @type {Map<string, number[]>} */
	const grid = new Map();
	const key = (/** @type {number} */ cx, /** @type {number} */ cz) => cx + ',' + cz;
	for (let i = 0; i < n; i++) {
		const k = key(Math.floor(xs[i] / cell), Math.floor(zs[i] / cell));
		const list = grid.get(k);
		if (list) list.push(i);
		else grid.set(k, [i]);
	}
	/** brute force: the fallback when the point is far from every sample */
	const nearestAll = (/** @type {number} */ x, /** @type {number} */ z) => {
		let best = 0;
		let bestD = Infinity;
		for (let i = 0; i < n; i++) {
			const d = (xs[i] - x) ** 2 + (zs[i] - z) ** 2;
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		return [best, bestD];
	};
	return {
		length,
		closed: data.closed,
		project(xz) {
			const x = num(xz?.[0], 0);
			const z = num(xz?.[1], 0);
			const cx = Math.floor(x / cell);
			const cz = Math.floor(z / cell);
			let best = -1;
			let bestD = Infinity;
			for (let dx = -1; dx <= 1; dx++)
				for (let dz = -1; dz <= 1; dz++)
					for (const i of grid.get(key(cx + dx, cz + dz)) ?? []) {
						const d = (xs[i] - x) ** 2 + (zs[i] - z) ** 2;
						// ties go to the lower index, so the answer never depends on bucket order
						if (d < bestD || (d === bestD && i < best)) {
							bestD = d;
							best = i;
						}
					}
			// off the grid's neighbourhood (a car far from the road): the honest full scan
			if (best < 0 || bestD > cell * cell) [best, bestD] = nearestAll(x, z);
			const u = Math.min(best / count, 1) % 1;
			return { u, distance: Math.sqrt(bestD), quadrant: Math.min(Math.floor(u * 4), 3), along: [xs[best], zs[best]] };
		}
	};
}

/** a fresh lap tracker — plain data, so it can live in module state and a test can drive it
 * @param {number=} laps */
export function newLapState(laps = 0) {
	return { laps, quadrants: [false, false, false, false], lastU: -1 };
}

/**
 * Feed one progress sample into a lap tracker. A lap counts only when u wraps from the last
 * quarter back to the first AND all four quadrant flags are set — which stops both cheats:
 * reversing over the line (never sets the middle flags) and sitting on it (the wrap needs
 * quadrant 3 first). The first sample only seeds `lastU` (a car on the grid behind the line
 * is not a lap).
 * @param {any} state from `newLapState` (mutated)
 * @param {{u: number, quadrant: number} | null} progress
 * @returns {{lapped: boolean, laps: number}}
 */
export function trackLap(state, progress) {
	if (!state || !progress) return { lapped: false, laps: state?.laps ?? 0 };
	const { u, quadrant } = progress;
	if (state.lastU < 0) {
		state.lastU = u;
		// a grid slot BEHIND the line starts in the last quarter; that quarter is not driven yet
		if (quadrant !== 3) state.quadrants[quadrant] = true;
		return { lapped: false, laps: state.laps };
	}
	state.quadrants[quadrant] = true;
	const wrapped = state.lastU > 0.75 && u < 0.25;
	const complete = wrapped && state.quadrants.every(Boolean);
	if (wrapped) {
		// every forward wrap starts a fresh lap's flags, counted or not
		state.quadrants = [false, false, false, false];
		state.quadrants[quadrant] = true;
	}
	if (complete) state.laps += 1;
	state.lastU = u;
	return { lapped: complete, laps: state.laps };
}

/**
 * The standings: one row per driver, in race order. Finished drivers first by finishing time,
 * then the rest by laps and then by progress along the current lap; ties by id, so every peer
 * sorts identically.
 * @template {{id: string, laps: number, u?: number, finish?: number}} T
 * @param {T[]} rows @returns {T[]}
 */
export function standings(rows) {
	return [...rows].sort((a, b) => {
		const fa = a.finish && a.finish > 0 ? a.finish : Infinity;
		const fb = b.finish && b.finish > 0 ? b.finish : Infinity;
		if (fa !== fb) return fa - fb;
		if ((b.laps ?? 0) !== (a.laps ?? 0)) return (b.laps ?? 0) - (a.laps ?? 0);
		if ((b.u ?? 0) !== (a.u ?? 0)) return (b.u ?? 0) - (a.u ?? 0);
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

/** seconds → "m:ss.t" @param {number} s */
export function lapTime(s) {
	if (!Number.isFinite(s) || s <= 0) return '–';
	const m = Math.floor(s / 60);
	const rest = s - m * 60;
	return m + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
}

/**
 * One frame of the ARCADE car (the authority applies it): the new body velocity from the
 * current one, the car's heading and the driver's input. Pure. Forward is the body's local -Z
 * (the chase camera sits at +Z). Grip bleeds the sideways slide, the throttle eases the forward
 * speed toward its target, and steering turns harder the faster the car goes (and flips in
 * reverse, like a real car).
 * @param {{linvel: number[], yaw: number, throttle: number, steer: number, dt: number}} s
 * @param {{maxSpeed: number, accel: number, brake: number, turnRate: number, grip: number}} p
 * @returns {{linvel: number[], yawRate: number, speed: number}}
 */
export function driveStep(s, p) {
	const fx = -Math.sin(s.yaw);
	const fz = -Math.cos(s.yaw);
	const vx = num(s.linvel?.[0], 0);
	const vy = num(s.linvel?.[1], 0);
	const vz = num(s.linvel?.[2], 0);
	const dt = Math.min(Math.max(num(s.dt, 0), 0), 0.1);
	const throttle = Math.max(-1, Math.min(1, num(s.throttle, 0)));
	const steer = Math.max(-1, Math.min(1, num(s.steer, 0)));
	let forward = vx * fx + vz * fz;
	const sideX = vx - forward * fx;
	const sideZ = vz - forward * fz;
	const target = throttle >= 0 ? throttle * p.maxSpeed : throttle * p.maxSpeed * 0.4;
	// braking (input against the motion) bites harder than accelerating
	const rate = Math.sign(target - forward) !== Math.sign(forward) && Math.abs(forward) > 0.5 ? p.brake : p.accel;
	const step = rate * dt;
	if (Math.abs(target - forward) <= step) forward = target;
	else forward += Math.sign(target - forward) * step;
	const keep = Math.pow(1 - Math.min(Math.max(p.grip, 0), 1), dt * 10);
	const linvel = [fx * forward + sideX * keep, vy, fz * forward + sideZ * keep];
	const steerScale = Math.min(Math.abs(forward) / 6, 1) * Math.sign(forward || 1);
	return { linvel, yawRate: -steer * p.turnRate * steerScale, speed: forward };
}
