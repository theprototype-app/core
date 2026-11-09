// 78 F2 / F3 / F8: the pure halves of On Hover, Hover Animate and Toggle Animation.
import { describe, it, expect } from 'vitest';
import { runsOf, hoverEnvelope, ringLength, hoverStep, doorApply, doorPoseAt, poseIndexOf, ease } from '../../src/lib/hoverCore.js';

describe('hover runs and the swing', () => {
	it('re-stamps closer than the gap continue one run', () => {
		const runs = runsOf([10, 10.25, 10.5, 12], 0.45);
		expect(runs).toEqual([
			{ start: 10, last: 10.5, end: 10.95 },
			{ start: 12, last: 12, end: 12.45 }
		]);
	});
	it('is 0 before any stamp and rings after one', () => {
		const p = { mode: 'restart', freq: 1, damping: 1 };
		expect(hoverEnvelope(p, [], 0.3, 5)).toBe(0);
		expect(hoverEnvelope(p, [5], 0.3, 4.9)).toBe(0);
		expect(hoverEnvelope(p, [5], 0.3, 5.25)).toBeCloseTo(Math.exp(-0.25), 6);
	});
	it('is a pure function of (stamps, t): two peers agree exactly', () => {
		const p = { mode: 'energy', freq: 1.2, damping: 1.2 };
		const a = hoverEnvelope(p, [100, 101.3], 0.3, 101.7);
		const b = hoverEnvelope(p, [101.3, 100], 0.3, 101.7);
		expect(a).toBe(b);
	});
	it('energy adds a swing per hover; restart keeps only the newest', () => {
		const e = hoverEnvelope({ mode: 'energy', freq: 1, damping: 0.5 }, [0, 1], 0.3, 1.25);
		const r = hoverEnvelope({ mode: 'restart', freq: 1, damping: 0.5 }, [0, 1], 0.3, 1.25);
		expect(r).toBeCloseTo(Math.exp(-0.125), 6);
		expect(e).toBeCloseTo(Math.exp(-0.125) + Math.exp(-0.625) * Math.sin(2 * Math.PI * 1.25), 6);
	});
	it('once ignores a hover while the first swing still rings', () => {
		const p = { mode: 'once', freq: 1, damping: 2 };
		const len = ringLength(2);
		expect(hoverEnvelope(p, [0, 0.5], 0.3, 0.75)).toBeCloseTo(hoverEnvelope(p, [0], 0.3, 0.75), 9);
		expect(hoverEnvelope(p, [0, len + 1], 0.3, len + 1.25)).toBeCloseTo(Math.exp(-0.5), 6);
	});
	it('while rings out after the hover; stop stops dead', () => {
		const w = hoverEnvelope({ mode: 'while', freq: 1, damping: 1 }, [0, 0.25, 0.5], 0.45, 1.2);
		const s = hoverEnvelope({ mode: 'stop', freq: 1, damping: 1 }, [0, 0.25, 0.5], 0.45, 1.2);
		expect(s).toBe(0);
		expect(Math.abs(w)).toBeGreaterThan(0);
	});
	it('inout eases in while hovered and back out after', () => {
		const p = { mode: 'inout', inoutSeconds: 0.2 };
		expect(hoverEnvelope(p, [0, 0.25], 0.45, 0.3)).toBe(1);
		expect(hoverEnvelope(p, [0, 0.25], 0.45, 0.8)).toBeCloseTo(1 - 0.1 / 0.2, 6);
		expect(hoverEnvelope(p, [0, 0.25], 0.45, 2)).toBe(0);
	});
});

describe('hover hysteresis', () => {
	it('enters at once, leaves only after 120 ms unseen', () => {
		const over = new Map();
		expect(hoverStep(over, ['bell'], 1)).toEqual({ entered: ['bell'], left: [] });
		expect(hoverStep(over, ['bell'], 1.06)).toEqual({ entered: [], left: [] });
		expect(hoverStep(over, [], 1.12)).toEqual({ entered: [], left: [] });
		expect(hoverStep(over, ['bell'], 1.15)).toEqual({ entered: [], left: [] });
		expect(hoverStep(over, [], 1.3)).toEqual({ entered: [], left: ['bell'] });
	});
});

describe('Toggle Animation', () => {
	const pose = (name, ry) => ({ name, p: [0, 0, 0], r: [0, ry, 0], s: [1, 1, 1] });
	const poses = [pose('closed', 0), pose('ajar', 0.5), pose('open', 1.5)];
	const rest = (to) => ({ from: null, fromPose: null, to, start: -Infinity, end: -Infinity });
	const opts = { duration: 1, interrupt: 'reverse', ease: 'linear' };

	it('toggle goes closed -> open (the last pose) -> closed', () => {
		let st = doorApply(rest(0), { kind: 'toggle', t: 10 }, poses, opts);
		expect(st).toMatchObject({ from: 0, to: 2, start: 10, end: 11 });
		expect(doorPoseAt(st, poses, 10.5, 'linear').pose.r[1]).toBeCloseTo(0.75, 6);
		expect(doorPoseAt(st, poses, 12, 'linear')).toMatchObject({ moving: false });
		st = doorApply(st, { kind: 'toggle', t: 20 }, poses, opts);
		expect(st.to).toBe(0);
	});
	it('go to a named pose; an unknown name changes nothing', () => {
		const st = doorApply(rest(0), { kind: 'goto', t: 1, pose: 'Ajar' }, poses, opts);
		expect(st.to).toBe(1);
		const same = rest(0);
		expect(doorApply(same, { kind: 'goto', t: 1, pose: 'nowhere' }, poses, opts)).toBe(same);
		expect(poseIndexOf(poses, 2)).toBe(2);
		expect(poseIndexOf(poses, '1')).toBe(1);
	});
	it('interrupt reverse starts from where the door is; finish ignores presses while moving', () => {
		const moving = doorApply(rest(0), { kind: 'open', t: 0 }, poses, opts);
		const rev = doorApply(moving, { kind: 'close', t: 0.5 }, poses, opts);
		expect(rev.to).toBe(0);
		expect(rev.fromPose.r[1]).toBeCloseTo(0.75, 6);
		expect(doorPoseAt(rev, poses, 0.5, 'linear').pose.r[1]).toBeCloseTo(0.75, 6);
		const fin = doorApply(moving, { kind: 'close', t: 0.5 }, poses, { ...opts, interrupt: 'finish' });
		expect(fin).toBe(moving);
	});
	it('a press for where it already rests is nothing', () => {
		const st = rest(2);
		expect(doorApply(st, { kind: 'open', t: 5 }, poses, opts)).toBe(st);
	});
	it('smooth easing ends where it starts and finishes', () => {
		expect(ease(0)).toBe(0);
		expect(ease(1)).toBe(1);
		expect(ease(0.5)).toBe(0.5);
	});
});
