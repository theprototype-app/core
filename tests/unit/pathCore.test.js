// @ts-nocheck — plain fixtures; the code under test is typed
// 78 F4: the Path object's pure half — the record (splineTube + path/pathCore) and the schedule
// (motionCore.buildSchedule / scheduleAt / scheduleEvents). The schedule is the netcode: a pure
// function of (path, shared time), so these tests are the proof that two peers agree.
import { describe, it, expect } from 'vitest';
import { normalizeSpline, cloneSpline } from '../../src/lib/splineTube.js';
import {
	newPathRecord,
	normalizePathBlock,
	normalizePathPointExtras,
	isPathRecord,
	reversePath,
	splitPath,
	joinPaths,
	recordFromPatrol,
	PATH_DEFAULTS
} from '../../src/lib/path/pathCore.js';
import { buildSchedule, scheduleAt, scheduleEvents, easeProgress, RANDOM_HOPS } from '../../src/lib/motion/motionCore.js';

const close = (a, b, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const closeV = (a, b, eps = 1e-6) => a.forEach((v, i) => close(v, b[i], eps));

/** a straight 3-point line, 10 m spans, linear */
const line = (extra = []) => [
	{ pos: [0, 0, 0], ...(extra[0] ?? {}) },
	{ pos: [10, 0, 0], ...(extra[1] ?? {}) },
	{ pos: [20, 0, 0], ...(extra[2] ?? {}) }
];

describe('record', () => {
	it('a plain spline normalizes exactly as before (no path block, no extras)', () => {
		const plain = { points: [{ pos: [0, 0, 0], radius: 0.1, wait: 3 }, { pos: [1, 0, 0], radius: 0.1 }], closed: false };
		const n = normalizeSpline(plain);
		expect(n.path).toBeUndefined();
		expect(Object.keys(n)).toEqual(['points', 'color', 'closed', 'radialSegments', 'segmentsPerSpan']);
		expect(Object.keys(n.points[0])).toEqual(['pos', 'radius']);
	});

	it('a Path record keeps its block and its per-point extras through normalize + clone', () => {
		const rec = newPathRecord({ points: line([{ wait: 2 }, { gap: true, speed: 3, ease: 'inout', event: 'look', facing: 90 }]), mode: 'pingpong' });
		const n = normalizeSpline(rec);
		expect(isPathRecord(n)).toBe(true);
		expect(n.path).toEqual({ ...PATH_DEFAULTS, mode: 'pingpong' });
		expect(n.points[0].wait).toBe(2);
		expect(n.points[1]).toMatchObject({ gap: true, speed: 3, ease: 'inout', event: 'look', facing: 90 });
		const c = cloneSpline(n);
		expect(c).toEqual(n);
		c.points[1].pos[0] = 99;
		expect(n.points[1].pos[0]).toBe(10); // no aliasing
	});

	it('clamps and drops bad extras', () => {
		expect(normalizePathPointExtras({ wait: -3, speed: 'fast', ease: 'bounce', gap: 'yes', event: '   ', facing: 'x' })).toEqual({});
		expect(normalizePathPointExtras({ wait: 1e9, speed: 1e9, event: 'x'.repeat(90) })).toEqual({ wait: 3600, speed: 50, event: 'x'.repeat(40) });
		expect(normalizePathBlock({ mode: 'teleport', speed: -1 })).toMatchObject({ mode: 'loop', speed: 0.01 });
	});
});

describe('schedule: waits, speeds, gaps, eases', () => {
	it('walks at the path speed, waits where told, and a gap takes no time', () => {
		// 0 --10 m @2 m/s--> 1 (wait 2 s) --GAP--> 2 (wait 1), once
		const sched = buildSchedule(line([{}, { wait: 2, gap: true }, { wait: 1 }]), { mode: 'once', speed: 2, smooth: false });
		expect(sched.period).toBe(5 + 2 + 0 + 1);
		closeV(scheduleAt(sched, 2.5).p, [5, 0, 0]);
		const waiting = scheduleAt(sched, 6);
		expect(waiting.kind).toBe('wait');
		expect(waiting.point).toBe(1);
		closeV(waiting.p, [10, 0, 0]);
		// the gap: the instant the wait ends it is AT point 2 (no travel in between)
		const after = scheduleAt(sched, 7.0001);
		closeV(after.p, [20, 0, 0]);
		expect(after.point).toBe(2);
		// once: rests at the end for ever
		closeV(scheduleAt(sched, 1e6).p, [20, 0, 0]);
		closeV(scheduleAt(sched, -5).p, [0, 0, 0]);
	});

	it('a point speed overrides the path speed for the span leaving it', () => {
		const sched = buildSchedule(line([{ speed: 10 }, {}]), { mode: 'once', speed: 1, smooth: false });
		expect(sched.period).toBe(1 + 10);
	});

	it('ease shapes progress inside the span, not its duration', () => {
		const lin = buildSchedule(line(), { mode: 'once', speed: 1, smooth: false });
		const eased = buildSchedule(line([{ ease: 'in' }]), { mode: 'once', speed: 1, smooth: false });
		expect(eased.period).toBe(lin.period);
		closeV(scheduleAt(eased, 5).p, [10 * easeProgress(0.5, 'in'), 0, 0]);
		closeV(scheduleAt(eased, 10).p, [10, 0, 0]);
		expect(easeProgress(0.5, 'inout')).toBeCloseTo(0.5);
		expect(easeProgress(0.25, 'out')).toBeGreaterThan(0.25);
	});

	it('faces along travel, holds a set facing while waiting', () => {
		const sched = buildSchedule(line([{}, { wait: 2, facing: 90 }]), { mode: 'once', speed: 1, smooth: false });
		close(scheduleAt(sched, 5).yaw, Math.PI / 2); // walking +x: atan2(1, 0)
		close(scheduleAt(sched, 11).yaw, Math.PI / 2); // facing 90 deg
		const s2 = buildSchedule([{ pos: [0, 0, 0] }, { pos: [0, 0, 10], wait: 3, facing: 180 }, { pos: [0, 0, 20] }], { mode: 'once', speed: 1, smooth: false });
		close(scheduleAt(s2, 11).yaw, Math.PI);
		close(scheduleAt(s2, 5).yaw, 0);
	});
});

describe('schedule: purity (the netcode)', () => {
	it('is a pure function of the record and the time — order of evaluation never matters', () => {
		const pts = [{ pos: [0, 0, 0], wait: 2 }, { pos: [4, 0, 3], gap: true }, { pos: [8, 1, -2], ease: 'inout', speed: 0.7 }, { pos: [3, 0, -6], event: 'turn' }];
		const opts = { closed: true, mode: 'loop', speed: 1.3 };
		const a = buildSchedule(pts, opts);
		const b = buildSchedule(JSON.parse(JSON.stringify(pts)), { ...opts });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		const times = [0, 0.4, 3.7, 17.25, 123.5, 86399.9, 41234.567];
		const forward = times.map((t) => scheduleAt(a, t));
		const backward = [...times].reverse().map((t) => scheduleAt(b, t)).reverse();
		expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
		// a fresh peer joining at t = 41234.567 computes the same pose as one that has run all day
		expect(scheduleAt(buildSchedule(pts, opts), 41234.567)).toEqual(forward[6]);
	});

	it('a start stamp and an offset shift the walk', () => {
		const sched = buildSchedule(line(), { mode: 'once', speed: 1, smooth: false });
		closeV(scheduleAt(sched, 105, { start: 100 }).p, [5, 0, 0]);
		closeV(scheduleAt(sched, 100, { start: 100, offset: 3 }).p, [3, 0, 0]);
	});
});

describe('schedule: modes', () => {
	it('loop on a closed path goes round; on an open one it jumps back to the start', () => {
		const sq = [{ pos: [0, 0, 0] }, { pos: [10, 0, 0] }, { pos: [10, 0, 10] }, { pos: [0, 0, 10] }];
		const closed = buildSchedule(sq, { closed: true, mode: 'loop', speed: 1, smooth: false });
		expect(closed.period).toBe(40);
		closeV(scheduleAt(closed, 35).p, [0, 0, 5]);
		const open = buildSchedule(sq, { closed: false, mode: 'loop', speed: 1, smooth: false });
		expect(open.period).toBe(30);
		closeV(scheduleAt(open, 29.999).p, [0.001, 0, 10], 1e-3);
		closeV(scheduleAt(open, 30.001).p, [0.001, 0, 0], 1e-3);
	});

	it('ping-pong walks back the way it came, waiting once at each end', () => {
		const sched = buildSchedule(line([{ wait: 1 }, {}, { wait: 2 }]), { mode: 'pingpong', speed: 1, smooth: false });
		expect(sched.period).toBe(1 + 20 + 2 + 20);
		closeV(scheduleAt(sched, 22).p, [20, 0, 0]);
		const back = scheduleAt(sched, 23 + 5);
		closeV(back.p, [15, 0, 0]);
		close(back.yaw, -Math.PI / 2); // walking -x
	});

	it('random visits seeded points, the same on every peer, and repeats seamlessly', () => {
		const pts = [{ pos: [0, 0, 0] }, { pos: [5, 0, 0] }, { pos: [5, 0, 5] }, { pos: [0, 0, 5] }, { pos: [-3, 0, 2] }];
		const a = buildSchedule(pts, { mode: 'random', seed: 7, speed: 2, closed: true });
		const b = buildSchedule(pts, { mode: 'random', seed: 7, speed: 2, closed: true });
		const c = buildSchedule(pts, { mode: 'random', seed: 8, speed: 2, closed: true });
		expect(JSON.stringify(a.segs)).toBe(JSON.stringify(b.segs));
		expect(JSON.stringify(a.segs)).not.toBe(JSON.stringify(c.segs));
		const stops = a.segs.filter((s) => s.kind === 'move' && !s.pass);
		expect(stops.length).toBeLessThanOrEqual(RANDOM_HOPS);
		expect(stops[stops.length - 1].to).toBe(0); // closes the cycle
		closeV(scheduleAt(a, a.period * 3 + 0.5).p, scheduleAt(a, 0.5).p);
	});
});

describe('schedule: events', () => {
	it('reports each arrival with its exact shared time, once per window', () => {
		const sched = buildSchedule(line([{}, { event: 'mid', wait: 2 }, { event: 'end' }]), { mode: 'loop', closed: false, speed: 1, smooth: false });
		// period: 10 + 2 + 10 + jump back (0) = 22
		expect(scheduleEvents(sched, 0, 9.9)).toEqual([]);
		expect(scheduleEvents(sched, 9.9, 10.1)).toEqual([{ at: 10, point: 1, event: 'mid' }]);
		expect(scheduleEvents(sched, 21, 22)).toEqual([{ at: 22, point: 2, event: 'end' }]);
		// split windows report each arrival exactly once
		const all = [...scheduleEvents(sched, 0, 30), ...scheduleEvents(sched, 30, 60)];
		const once = scheduleEvents(sched, 0, 60);
		expect(all).toEqual(once);
		expect(once.map((e) => e.at)).toEqual([10, 22, 32, 44, 54]);
		// with a start stamp
		expect(scheduleEvents(sched, 109, 111, { start: 100 })).toEqual([{ at: 110, point: 1, event: 'mid' }]);
		// a huge window (a long pause) does not flood
		expect(scheduleEvents(sched, 0, 1e7).length).toBeLessThanOrEqual(2);
	});
});

describe('record ops', () => {
	const rec = newPathRecord({
		points: [{ pos: [0, 0, 0], wait: 1, speed: 2 }, { pos: [1, 0, 0], gap: true, event: 'b' }, { pos: [2, 0, 0], ease: 'in' }, { pos: [3, 0, 0], facing: 45 }]
	});

	it('reverse keeps point fields on their points and span fields on their spans', () => {
		const r = reversePath(rec);
		expect(r.points.map((p) => p.pos[0])).toEqual([3, 2, 1, 0]);
		expect(r.points[0].facing).toBe(45);
		expect(r.points[3].wait).toBe(1);
		expect(r.points[2].event).toBe('b');
		// old span 0 (0->1, speed 2) is now span 2 (1->0), owned by new point 2
		expect(r.points[2].speed).toBe(2);
		// old span 1 (1->2, gap) is new span 1 (2->1)
		expect(r.points[1].gap).toBe(true);
		// old span 2 (2->3, ease in) is new span 0 (3->2)
		expect(r.points[0].ease).toBe('in');
		expect(r.points[3].speed).toBeUndefined();
		// reverse twice = identity
		expect(reversePath(r)).toEqual(rec);
		// closed: the closing span travels too
		const c = reversePath({ ...rec, closed: true, points: rec.points.map((p, i) => (i === 3 ? { ...p, speed: 9 } : p)) });
		expect(c.points[3].speed).toBe(9);
	});

	it('split: open → two paths sharing the split point; closed → one open path', () => {
		const [a, b] = splitPath(rec, 2);
		expect(a.points.map((p) => p.pos[0])).toEqual([0, 1, 2]);
		expect(a.points[2].ease).toBeUndefined();
		expect(b.points.map((p) => p.pos[0])).toEqual([2, 3]);
		expect(b.points[0].ease).toBe('in');
		expect(splitPath(rec, 0)).toBeNull();
		const [o] = splitPath({ ...rec, closed: true }, 1);
		expect(o.closed).toBe(false);
		expect(o.points.map((p) => p.pos[0])).toEqual([1, 2, 3, 0, 1]);
	});

	it('join welds a shared end point', () => {
		const [a, b] = splitPath(rec, 2);
		const j = joinPaths(a, b);
		expect(j.points.map((p) => p.pos[0])).toEqual([0, 1, 2, 3]);
		expect(j.points[2].ease).toBe('in');
		expect(joinPaths(a, { points: [{ pos: [9, 0, 0] }, { pos: [10, 0, 0] }] }).points.length).toBe(5);
	});
});

// ---- the legacy Path patrol node, reimplemented VERBATIM from flowRuntime.applyPathPatrol (1.63) ----
function oldPatrol(data, time) {
	const points = data.points ?? [];
	const speed = data.speed ?? 1;
	const loop = (data.mode ?? 'loop') === 'loop';
	const segments = [];
	let total = 0;
	const count = loop ? points.length : points.length - 1;
	for (let i = 0; i < count; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
		segments.push({ a, b, length });
		total += length;
	}
	let distance;
	let reverse = false;
	if (loop) distance = (time * speed) % total;
	else {
		const cycle = (time * speed) % (2 * total);
		reverse = cycle > total;
		distance = reverse ? 2 * total - cycle : cycle;
	}
	for (const segment of segments) {
		if (distance > segment.length) {
			distance -= segment.length;
			continue;
		}
		const t = segment.length > 0 ? distance / segment.length : 0;
		const { a, b } = segment;
		return {
			p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
			yaw: reverse ? Math.atan2(a[0] - b[0], a[2] - b[2]) : Math.atan2(b[0] - a[0], b[2] - a[2])
		};
	}
}

describe('Convert: an old Path patrol node becomes a Path object, pose for pose', () => {
	const cases = [
		{ name: 'loop, 4 points', data: { points: [[0, 0, 0], [6, 0, 0], [6, 0.5, 4], [-1, 0, 5]], speed: 1.7, mode: 'loop' } },
		{ name: 'ping-pong, 3 points', data: { points: [[2, 0, 1], [5, 0, 1], [5, 0, 9]], speed: 0.6, mode: 'pingpong' } },
		{ name: 'loop, 2 points (closes into a ping-pong)', data: { points: [[0, 0, 0], [3, 0, 4]], speed: 2, mode: 'loop' } },
		{ name: 'defaults (no speed / mode)', data: { points: [[1, 1, 1], [4, 1, 5], [8, 1, 1]] } }
	];
	for (const c of cases)
		it(c.name, () => {
			const conv = recordFromPatrol(c.data);
			const rec = normalizeSpline(conv.record);
			const world = rec.points.map((p) => ({ ...p, pos: p.pos.map((v, a) => v + conv.center[a]) }));
			const sched = buildSchedule(world, { closed: rec.closed, smooth: rec.path.smooth, mode: rec.path.mode, speed: rec.path.speed });
			for (let t = 0; t < 120; t += 0.37) {
				const want = oldPatrol(c.data, t);
				const got = scheduleAt(sched, t);
				closeV(got.p, want.p, 1e-6);
				// headings agree except exactly on a vertex (the old node used the NEXT segment there)
				const dy = Math.abs(Math.atan2(Math.sin(got.yaw - want.yaw), Math.cos(got.yaw - want.yaw)));
				if (got.progress > 1e-6 && got.progress < 1 - 1e-6) expect(dy).toBeLessThan(1e-6);
			}
			// and at a large shared time (seconds of the day)
			closeV(scheduleAt(sched, 54321.123).p, oldPatrol(c.data, 54321.123).p, 1e-6);
		});

	it('refuses fewer than two points', () => {
		expect(recordFromPatrol({ points: [[0, 0, 0]] })).toBeNull();
		expect(recordFromPatrol({})).toBeNull();
	});
});
