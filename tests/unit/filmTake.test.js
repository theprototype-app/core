// @ts-nocheck: inline fixtures (the pure fold is typed in filmTake.js)
// 68 V4: a Film take into the sequence — shots, reduced keys within the error budget, Cut holds,
// Move extends, Retake replaces + trims, live-control tracks (fov, roll) play back exactly.
import { describe, it, expect } from 'vitest';
import { commitTake, filmShots, filmTrackOf, uniformSamples, DEFAULT_BUDGET, MARKERS_REC } from '../../src/lib/film/filmTake.js';
import { normalizeSequence, propsAt, propTrackOf, shotAt } from '../../src/lib/sequenceCore.js';
import { sampleCurve, quatAngleDeg, maxError } from '../../src/lib/curveCore.js';

const CAM = 'cam-1';
const yawQ = (deg) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];

/** a 30 Hz walk: x from x0 at 1 m/s with a gentle S, a turning yaw, fov `fov(t)` */
function walk(t0, t1, { x0 = 0, fov = () => 50, roll = () => 0, z = 0 } = {}) {
	const out = [];
	for (let t = t0; t <= t1 + 1e-9; t += 1 / 30) {
		const u = t - t0;
		out.push({ t, pos: [x0 + u, 1.6 + 0.2 * Math.sin(u * 2), z], quat: yawQ(20 * Math.sin(u)), fov: fov(u), roll: roll(u) });
	}
	return out;
}

const empty = () => normalizeSequence({ id: 'seq-1', name: 'Film', duration: 10, tracks: [] });

describe('commitTake', () => {
	it('a first take makes ONE shot and pose tracks whose keys stay within the budget', () => {
		const samples = walk(1, 4);
		const r = commitTake(empty(), { camera: CAM, cameraName: 'Cam', mode: 'cut', samples });
		expect(r).not.toBeNull();
		const seq = normalizeSequence(r.seq);
		const shots = filmShots(seq, CAM);
		expect(shots).toHaveLength(1);
		expect(shots[0].t).toBeCloseTo(1, 6);
		expect(shots[0].dur).toBeCloseTo(3, 1);
		expect(shots[0].camera).toBe(CAM);
		const pos = propTrackOf(seq, CAM, 'position');
		const rot = propTrackOf(seq, CAM, 'quaternion');
		expect(pos.keys.length).toBeLessThan(samples.length / 3); // reduced
		expect(pos.keys.length).toBe(rot.keys.length); // shared key times
		for (const s of samples) {
			const p = sampleCurve('vec3', pos.keys, s.t);
			expect(Math.hypot(p[0] - s.pos[0], p[1] - s.pos[1], p[2] - s.pos[2])).toBeLessThanOrEqual(DEFAULT_BUDGET.pos + 1e-6);
			expect(quatAngleDeg(sampleCurve('quat', rot.keys, s.t), s.quat)).toBeLessThanOrEqual(DEFAULT_BUDGET.angDeg + 1e-6);
		}
		// a constant fov / roll add no tracks
		expect(propTrackOf(seq, CAM, 'camera.fov')).toBeNull();
		expect(propTrackOf(seq, CAM, 'camera.roll')).toBeNull();
		// the shot is what the player looks through
		expect(shotAt(seq, 2)?.item.camera).toBe(CAM);
		expect(seq.duration).toBe(10);
	});

	it('a tighter budget keeps more keys, and the error bound still holds', () => {
		const samples = walk(0, 3);
		const loose = commitTake(empty(), { camera: CAM, mode: 'cut', samples, budget: { pos: 0.05, angDeg: 2 } });
		const tight = commitTake(empty(), { camera: CAM, mode: 'cut', samples, budget: { pos: 0.002, angDeg: 0.1 } });
		const nl = propTrackOf(loose.seq, CAM, 'position').keys.length;
		const nt = propTrackOf(tight.seq, CAM, 'position').keys.length;
		expect(nt).toBeGreaterThan(nl);
		const keys = propTrackOf(tight.seq, CAM, 'position').keys;
		expect(maxError('vec3', keys, samples.map((s) => ({ t: s.t, v: s.pos }))).error).toBeLessThanOrEqual(0.002 + 1e-6);
	});

	it('Cut: a second shot, and the first one HOLDS its last pose up to the cut', () => {
		const a = commitTake(empty(), { camera: CAM, mode: 'cut', samples: walk(0, 2) });
		const b = commitTake(a.seq, { camera: CAM, mode: 'cut', samples: walk(2, 4, { x0: 50 }), sessionStart: 0 });
		const seq = normalizeSequence(b.seq);
		expect(filmShots(seq, CAM)).toHaveLength(2);
		const pos = propTrackOf(seq, CAM, 'position').keys;
		// just before the cut: still near the end of shot 1 (x≈2), never gliding toward x=50
		expect(sampleCurve('vec3', pos, 1.999)[0]).toBeCloseTo(2, 1);
		expect(sampleCurve('vec3', pos, 2.0)[0]).toBeCloseTo(50, 3);
		expect(shotAt(seq, 1.5)?.item.id).not.toBe(shotAt(seq, 2.5)?.item.id);
	});

	it('Move: extends the shot it continues (one item), the fly is in the keys', () => {
		const a = commitTake(empty(), { camera: CAM, mode: 'cut', samples: walk(0, 2) });
		// the recorded fly: from x=2 to x=10 over 1.5 s, then the walk carries on
		const fly = [];
		for (let t = 2; t <= 3.5 + 1e-9; t += 1 / 30) {
			const s = (t - 2) / 1.5;
			const e = s * s * (3 - 2 * s);
			fly.push({ t, pos: [2 + 8 * e, 1.6, 0], quat: yawQ(0), fov: 50, roll: 0 });
		}
		const b = commitTake(a.seq, { camera: CAM, mode: 'move', itemId: a.itemId, samples: [...fly, ...walk(3.5 + 1 / 30, 5, { x0: 10 })] });
		const seq = normalizeSequence(b.seq);
		const shots = filmShots(seq, CAM);
		expect(shots).toHaveLength(1);
		expect(shots[0].t).toBeCloseTo(0, 6);
		expect(shots[0].dur).toBeCloseTo(5, 1);
		const pos = propTrackOf(seq, CAM, 'position').keys;
		const mid = sampleCurve('vec3', pos, 2.75)[0];
		expect(mid).toBeGreaterThan(4);
		expect(mid).toBeLessThan(8);
	});

	it('Retake: replaces the shot, trims the next one, keeps its keys after the take', () => {
		let seq = empty();
		const s1 = commitTake(seq, { camera: CAM, mode: 'cut', samples: walk(0, 2) });
		const s2 = commitTake(s1.seq, { camera: CAM, mode: 'cut', samples: walk(2, 4, { x0: 20 }) });
		const s3 = commitTake(s2.seq, { camera: CAM, mode: 'cut', samples: walk(4, 6, { x0: 40 }) });
		const shot2 = filmShots(s3.seq, CAM)[1];
		// a retake of shot 2 that runs long, into shot 3
		const re = commitTake(s3.seq, { camera: CAM, mode: 'retake', itemId: shot2.id, samples: walk(2, 4.5, { x0: -10 }) });
		seq = normalizeSequence(re.seq);
		const shots = filmShots(seq, CAM);
		expect(shots).toHaveLength(3);
		expect(shots.some((s) => s.id === shot2.id)).toBe(false);
		expect(shots[1].t).toBeCloseTo(2, 6);
		expect(shots[2].t).toBeCloseTo(4.5, 1);
		expect(shots[2].t + shots[2].dur).toBeCloseTo(6, 1);
		const pos = propTrackOf(seq, CAM, 'position').keys;
		expect(sampleCurve('vec3', pos, 3)[0]).toBeCloseTo(-9, 1); // the retake
		expect(sampleCurve('vec3', pos, 5.5)[0]).toBeCloseTo(41.5, 1); // shot 3's own keys survive
		expect(sampleCurve('vec3', pos, 1)[0]).toBeCloseTo(1, 1); // shot 1 untouched
	});

	it('live controls are their own tracks and play back exactly (fov zoom, dutch roll)', () => {
		const samples = walk(0, 3, { fov: (u) => 50 - 10 * u, roll: (u) => (u > 1 ? 12 : 0) });
		const r = commitTake(empty(), { camera: CAM, mode: 'cut', samples, base: { fov: 50, roll: 0 } });
		const seq = normalizeSequence(r.seq);
		const fov = propTrackOf(seq, CAM, 'camera.fov');
		const roll = propTrackOf(seq, CAM, 'camera.roll');
		expect(fov).not.toBeNull();
		expect(roll).not.toBeNull();
		for (const s of samples) {
			expect(Math.abs(sampleCurve('number', fov.keys, s.t) - s.fov)).toBeLessThanOrEqual(DEFAULT_BUDGET.fov + 1e-6);
			expect(Math.abs(sampleCurve('number', roll.keys, s.t) - s.roll)).toBeLessThanOrEqual(DEFAULT_BUDGET.roll + 1e-6);
		}
		// the player's read: every property at t, in one call
		const at = propsAt(seq, 2);
		const byPath = Object.fromEntries(at.map((p) => [p.path, p.value]));
		expect(byPath['camera.fov']).toBeCloseTo(30, 1);
		expect(byPath['camera.roll']).toBeCloseTo(12, 1);
		expect(byPath.position[0]).toBeCloseTo(2, 1);
	});

	it('a control first moved in a LATER shot holds its base value through the earlier ones', () => {
		const a = commitTake(empty(), { camera: CAM, mode: 'cut', samples: walk(0, 2), base: { fov: 50 }, sessionStart: 0 });
		const b = commitTake(a.seq, { camera: CAM, mode: 'cut', samples: walk(2, 4, { fov: (u) => 50 - 10 * u }), base: { fov: 50 }, sessionStart: 0 });
		const fov = propTrackOf(normalizeSequence(b.seq), CAM, 'camera.fov').keys;
		expect(sampleCurve('number', fov, 1)).toBeCloseTo(50, 3);
		expect(sampleCurve('number', fov, 3.5)).toBeCloseTo(35, 1);
	});

	it('grows the sequence to the end of a take that ran past it, and records the raw ref', () => {
		const raw = { hash: 'abc', rate: 30, t0: 8, n: 120 };
		const r = commitTake(empty(), { camera: CAM, mode: 'cut', samples: walk(8, 12), raw });
		expect(r.seq.duration).toBeCloseTo(12, 1);
		expect(propTrackOf(r.seq, CAM, 'position').raw).toEqual([raw]);
		const again = commitTake(r.seq, { camera: CAM, mode: 'cut', samples: walk(12, 13), raw: { ...raw, hash: 'def' } });
		expect(propTrackOf(again.seq, CAM, 'position').raw.map((x) => x.hash)).toEqual(['abc', 'def']);
	});

	it('markers tapped during the take become event items on the camera markers track', () => {
		const r = commitTake(empty(), { camera: CAM, cameraName: 'Cam', mode: 'cut', samples: walk(0, 3), markers: [0.5, 2.25, 9] });
		const seq = normalizeSequence(r.seq);
		const mt = seq.tracks.find((tr) => tr.kind === 'event' && tr.rec === MARKERS_REC + CAM);
		expect(mt.items.map((it) => it.t)).toEqual([0.5, 2.25]); // 9 s is outside the segment
		expect(mt.items.every((it) => it.dur === 0 && it.name.startsWith('mark'))).toBe(true);
		const again = commitTake(r.seq, { camera: CAM, mode: 'cut', samples: walk(3, 4), markers: [3.5] });
		expect(again.seq.tracks.filter((tr) => tr.rec === MARKERS_REC + CAM)).toHaveLength(1);
		expect(again.seq.tracks.find((tr) => tr.rec === MARKERS_REC + CAM).items).toHaveLength(3);
	});

		it('refuses a segment too short to be a shot, and never touches its input', () => {
		const seq = empty();
		const frozen = JSON.stringify(seq);
		expect(commitTake(seq, { camera: CAM, mode: 'cut', samples: walk(0, 0) })).toBeNull();
		commitTake(seq, { camera: CAM, mode: 'cut', samples: walk(0, 2) });
		expect(JSON.stringify(seq)).toBe(frozen);
		expect(filmTrackOf(seq, CAM)).toBeNull();
	});
});

describe('uniformSamples', () => {
	it('puts jittery frame times onto a 30 Hz grid, slerping the rotation', () => {
		const frames = [];
		let t = 0;
		for (let i = 0; i < 40; i++) {
			frames.push({ t, pos: [t, 0, 0], quat: yawQ(t * 30), fov: 50 + t });
			t += 1 / 30 + (i % 3 === 0 ? 0.012 : -0.004);
		}
		const u = uniformSamples(frames, 30);
		for (let i = 1; i < u.length - 1; i++) expect(u[i].t - u[i - 1].t).toBeCloseTo(1 / 30, 6);
		for (const s of u) {
			expect(s.pos[0]).toBeCloseTo(s.t, 6);
			expect(s.fov).toBeCloseTo(50 + s.t, 6);
			expect(quatAngleDeg(s.quat, yawQ(s.t * 30))).toBeLessThan(0.05);
		}
	});
});
