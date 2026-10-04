// 34 R2 (kit-entities): kit.mover's pure half — seek / arrive / patrol, separation, STUCK
// detection + recovery (sidestep, then a re-path), knock-back re-seat. Every guard here has a
// counterfactual beside it: the same scenario with the guard switched off must FAIL, or the
// check proves nothing (the "a check that cannot fail" rule).
import { describe, it, expect } from 'vitest';
import {
	createMover,
	setGoal,
	setPath,
	knock,
	stepMovers,
	planPath,
	pushOut,
	MOVER_DEFAULTS
} from '../../src/lib/kit/moverCore.js';

const DT = 1 / 30;

/** @param {string} id @param {number[]} pos @param {any} [opts] */
function ent(id, pos, opts = {}) {
	return { id, pos: [...pos], yaw: 0, dead: false, mover: createMover(opts) };
}

/** run the movers for `secs` from t0, returning the end time @param {any[]} ents @param {number} secs @param {any} [world] @param {number} [t0] @param {(t: number) => void} [each] */
function run(ents, secs, world = {}, t0 = 0, each) {
	let t = t0;
	const n = Math.round(secs / DT);
	for (let i = 0; i < n; i++) {
		t += DT;
		each?.(t);
		stepMovers(ents, DT, t, world);
	}
	return t;
}

/** @param {any} e @param {number[]} g */
const distTo = (e, g) => Math.hypot(e.pos[0] - g[0], e.pos[2] - g[g.length >= 3 ? 2 : 1]);

describe('seek / arrive / patrol', () => {
	it('seek reaches its goal and stops in reach', () => {
		const e = ent('a', [0, 0, 0]);
		setGoal(e.mover, [10, 0, 0], 'seek', 0);
		run([e], 8);
		expect(distTo(e, [10, 0])).toBeLessThanOrEqual(MOVER_DEFAULTS.reach + 0.05);
		expect(e.mover.arrived).toBe(true);
		expect(e.mover.stuckCount).toBe(0); // open ground: nothing to recover from
	});

	it('arrive slows down inside `slow` (seek does not)', () => {
		const a = ent('a', [0, 0, 0]);
		const s = ent('s', [0, 0, 5]);
		setGoal(a.mover, [10, 0, 0], 'arrive', 0);
		setGoal(s.mover, [10, 0, 5], 'seek', 0);
		/** speed when 1 m out */
		let va = -1;
		let vs = -1;
		run([a, s], 8, {}, 0, () => {
			if (va < 0 && distTo(a, [10, 0]) < 1.2) va = Math.hypot(a.mover.vel[0], a.mover.vel[1]);
			if (vs < 0 && distTo(s, [10, 0, 5]) < 1.2) vs = Math.hypot(s.mover.vel[0], s.mover.vel[1]);
		});
		expect(va).toBeGreaterThan(0);
		expect(va).toBeLessThan(vs * 0.75);
	});

	it('patrol visits every waypoint in order and loops', () => {
		const e = ent('p', [0, 0, 0]);
		const path = [
			[0, 0, 0],
			[6, 0, 0],
			[6, 0, 6],
			[0, 0, 6]
		];
		setPath(e.mover, path, true, 0);
		/** @type {number[]} */
		const visits = [];
		run([e], 30, {}, 0, () => {
			if (visits[visits.length - 1] !== e.mover.wp) visits.push(e.mover.wp);
		});
		// at least one full lap, in order, wrapping
		const lap = visits.join(',');
		expect(lap).toContain('1,2,3,0,1');
	});

	it('ping-pong patrol turns back at the end', () => {
		const e = ent('p', [0, 0, 0]);
		setPath(
			e.mover,
			[
				[0, 0, 0],
				[4, 0, 0],
				[8, 0, 0]
			],
			false,
			0
		);
		/** @type {number[]} */
		const visits = [];
		run([e], 20, {}, 0, () => {
			if (visits[visits.length - 1] !== e.mover.wp) visits.push(e.mover.wp);
		});
		expect(visits.join(',')).toContain('1,2,1,0,1');
	});
});

describe('separation', () => {
	it('bodies spawned on one spot spread apart and never overlap while chasing one goal', () => {
		/** @type {any[]} */
		const ents = [];
		for (let i = 0; i < 8; i++) ents.push(ent('s' + i, [0, 0, 0]));
		for (const e of ents) setGoal(e.mover, [12, 0, 0], 'seek', 0);
		let worst = Infinity;
		run(ents, 10, {}, 0, (t) => {
			if (t < 0.5) return; // let the pile split first
			for (let i = 0; i < ents.length; i++)
				for (let j = i + 1; j < ents.length; j++)
					worst = Math.min(worst, distTo(ents[i], ents[j].pos));
		});
		// two radii is touching; allow a little squash under the crowd's push
		expect(worst).toBeGreaterThan(MOVER_DEFAULTS.radius * 2 * 0.8);
	});

	it('COUNTERFACTUAL: with separation and the body push off, the pile stays stacked', () => {
		/** @type {any[]} */
		const ents = [];
		for (let i = 0; i < 8; i++) ents.push(ent('s' + i, [0, 0, 0], { separation: 0, radius: 0 }));
		for (const e of ents) setGoal(e.mover, [12, 0, 0], 'seek', 0);
		run(ents, 10);
		expect(distTo(ents[0], ents[7].pos)).toBeLessThan(0.05);
	});
});

// the W1 class: a body pinned against a wall that is in the way of its goal
/** a U-shaped pocket opening toward -z, its back wall between the mover and a goal at +z */
const POCKET = {
	obstacles: [
		{ minX: -2.5, maxX: 2.5, minZ: 3, maxZ: 3.6 }, // back wall
		{ minX: -2.5, maxX: -1.9, minZ: -1, maxZ: 3.6 }, // left side
		{ minX: 1.9, maxX: 2.5, minZ: -1, maxZ: 3.6 } // right side
	]
};

describe('STUCK detection + recovery', () => {
	it('a mover driven into a concave pocket notices it is stuck, re-paths and reaches the goal', () => {
		const e = ent('u', [0, 0, -3]);
		setGoal(e.mover, [0, 0, 10], 'seek', 0);
		run([e], 25, POCKET);
		expect(e.mover.stuckCount).toBeGreaterThan(0);
		expect(e.mover.repaths).toBeGreaterThan(0);
		expect(distTo(e, [0, 10])).toBeLessThanOrEqual(MOVER_DEFAULTS.reach + 0.05);
	});

	it('COUNTERFACTUAL: with stuck detection off, the same mover stays in the pocket', () => {
		const e = ent('u', [0, 0, -3], { stuckAfter: 1e9 });
		setGoal(e.mover, [0, 0, 10], 'seek', 0);
		run([e], 25, POCKET);
		expect(e.mover.stuckCount).toBe(0);
		expect(distTo(e, [0, 10])).toBeGreaterThan(5);
	});

	it('a pillar dead ahead is steered round without stopping (look-ahead avoidance)', () => {
		const e = ent('c', [0, 0, -6]);
		setGoal(e.mover, [0, 0, 6], 'seek', 0);
		const world = { obstacles: [{ x: 0, z: 0, r: 1 }] };
		run([e], 10, world);
		expect(distTo(e, [0, 6])).toBeLessThanOrEqual(MOVER_DEFAULTS.reach + 0.05);
	});

	// W1, the reported class: a crowd pinned behind a wall that stands between it and its goal,
	// every body pressing into the wall and into each other. The wall's only way round is at
	// the FAR end from the goal, so seeking (sliding along it) is a local minimum.
	const LONG_WALL = {
		obstacles: [{ minX: -12, maxX: 4, minZ: 0, maxZ: 0.5 }],
		bounds: { minX: -12, maxX: 7, minZ: -10, maxZ: 12 }
	};
	/** @param {any} [opts] */
	const crowd = (opts) => {
		/** @type {any[]} */
		const ents = [];
		for (let i = 0; i < 10; i++)
			ents.push(ent('w' + i, [-8 + (i % 5) * 1.2, 0, -3 - Math.floor(i / 5) * 1.2], opts));
		for (const e of ents) setGoal(e.mover, [-6, 0, 6], 'seek', 0);
		return ents;
	};

	it('W1: ten bodies pinned behind a wall all re-path round it and reach the goal; the crowd there settles', () => {
		const ents = crowd();
		run(ents, 40, LONG_WALL);
		for (const e of ents) {
			expect(e.pos[2]).toBeGreaterThan(0.5); // nobody left behind the wall
			expect(distTo(e, [-6, 6])).toBeLessThan(2); // 10 bodies of r 0.4 crowd the goal
			expect(e.mover.repaths).toBeGreaterThan(0);
		}
		// one recovery per body is enough here: no thrashing (sidestep loops) on the way or at the goal
		const total = ents.reduce((a, e) => a + e.mover.stuckCount, 0);
		expect(total).toBeLessThanOrEqual(ents.length * 3);
	});

	it('W1 COUNTERFACTUAL: with stuck detection off, every body stays pinned behind the wall', () => {
		const ents = crowd({ stuckAfter: 1e9 });
		run(ents, 40, LONG_WALL);
		for (const e of ents) expect(e.pos[2]).toBeLessThan(0.5);
	});

	it('a crowd queued at its goal waits instead of thrashing (no stuck events once it has gathered)', () => {
		/** @type {any[]} */
		const ents = [];
		for (let i = 0; i < 12; i++) ents.push(ent('q' + i, [Math.cos(i) * 6, 0, Math.sin(i) * 6]));
		for (const e of ents) setGoal(e.mover, [0, 0, 0], 'seek', 0);
		const t = run(ents, 12);
		const before = ents.reduce((a, e) => a + e.mover.stuckCount, 0);
		run(ents, 20, {}, t);
		expect(ents.reduce((a, e) => a + e.mover.stuckCount, 0)).toBe(before);
	});
});

describe('knock-back re-seat', () => {
	it('a knocked mover is thrown, then re-seated on the ground, inside the bounds, out of the wall', () => {
		const e = ent('k', [0, 1.7, 0]);
		setGoal(e.mover, [0, 0, 10], 'seek', 0);
		const world = {
			obstacles: [{ minX: 2, maxX: 4, minZ: -2, maxZ: 2 }],
			bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 12 },
			groundY: 0
		};
		run([e], 0.2, world);
		knock(e.mover, [25, 0], 0.2);
		let t = run([e], 0.1, world, 0.2);
		expect(e.mover.knock[0]).not.toBe(0); // still flying
		t = run([e], 2, world, t);
		expect(e.mover.reseats).toBe(1);
		expect(e.pos[1]).toBe(0); // on the ground
		// not inside the wall it was thrown at
		const p = [...e.pos];
		expect(pushOut(p, e.mover.radius, world)).toBe(false);
		// and back on its way: the knock did not read as "stuck"
		run([e], 12, world, t);
		expect(e.mover.stuckCount).toBe(0);
		expect(distTo(e, [0, 10])).toBeLessThanOrEqual(MOVER_DEFAULTS.reach + 0.05);
	});

	it('a knock is bounded (a hostile 10 km/s throw lands inside the level)', () => {
		const e = ent('k', [0, 0, 0]);
		knock(e.mover, [10000, 0], 0);
		expect(Math.hypot(e.mover.knock[0], e.mover.knock[1])).toBeLessThanOrEqual(30 + 1e-9);
		knock(e.mover, [NaN, 1], 0);
		expect(Number.isFinite(e.mover.knock[0])).toBe(true);
	});
});

describe('planPath', () => {
	it('routes out of a pocket and round its wall', () => {
		const route = planPath([0, 2.4], [0, 10], POCKET, 0.4);
		expect(route).not.toBeNull();
		const r = /** @type {number[][]} */ (route);
		expect(r[r.length - 1]).toEqual([0, 10]);
		// every leg is clear of the walls (sampled)
		let prev = [0, 2.4];
		for (const q of r) {
			for (let k = 0; k <= 20; k++) {
				const p = [prev[0] + ((q[0] - prev[0]) * k) / 20, 0, prev[1] + ((q[1] - prev[1]) * k) / 20];
				expect(pushOut(p, 0.3, POCKET)).toBe(false);
			}
			prev = q;
		}
	});

	it('answers null when the goal is walled in', () => {
		const box = {
			obstacles: [
				{ minX: -3, maxX: 3, minZ: 2, maxZ: 2.5 },
				{ minX: -3, maxX: 3, minZ: 7.5, maxZ: 8 },
				{ minX: -3, maxX: -2.5, minZ: 2, maxZ: 8 },
				{ minX: 2.5, maxX: 3, minZ: 2, maxZ: 8 }
			]
		};
		expect(planPath([0, -2], [0, 5], box, 0.4)).toBeNull();
	});
});
