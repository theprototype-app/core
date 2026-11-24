// 92-correct row 4: walk speed is per second — the same distance in 5 s at 30, 60, 90 and 120 Hz and
// under a throttled tab (3 fps), and an old scene keeps its feel at 60 Hz.
import { describe, it, expect } from 'vitest';
import { makeRealClock, frameDistance, STEP_CAP_S, AUTHORED_HZ } from '../../src/lib/realStep.js';
import { createMover, setGoal, stepMovers } from '../../src/lib/kit/moverCore.js';

/** distance a per-frame speed covers in `secs` at `hz`, through the real clock @param {number} hz @param {number} secs */
function flown(hz, secs, perFrame = 0.1) {
	const clock = makeRealClock();
	let d = 0;
	const frames = Math.round(secs * hz);
	clock(0); // the first frame of the run
	for (let i = 1; i <= frames; i++) d += frameDistance(perFrame, clock((i * 1000) / hz));
	return d;
}

describe('the real clock and the per-frame speed', () => {
	it('an old scene feels the same at 60 Hz: one frame = the stored number', () => {
		expect(frameDistance(0.1, 1 / AUTHORED_HZ)).toBeCloseTo(0.1, 10);
	});
	it('the same distance in 5 s at 30, 60, 90, 120 Hz and at 3 fps', () => {
		const want = 0.1 * 60 * 5; // 30 m
		for (const hz of [30, 60, 90, 120, 3]) expect(flown(hz, 5)).toBeCloseTo(want, 6);
	});
	it('a frame longer than the cap (a hidden tab coming back) counts only the cap', () => {
		const clock = makeRealClock();
		clock(0);
		expect(clock(10_000)).toBe(STEP_CAP_S);
		expect(STEP_CAP_S).toBe(1);
		expect(clock(9_000)).toBe(0); // a clock that went back moves nothing
	});
});

describe('kit movers (NPCs)', () => {
	/** x after 5 s of seeking far away at `hz` @param {number} hz */
	function walked(hz) {
		const e = { id: 'a', pos: [0, 0, 0], yaw: 0, dead: false, mover: createMover({ speed: 2 }) };
		setGoal(e.mover, [100, 0, 0], 'seek', 0);
		let t = 0;
		const dt = 1 / hz;
		for (let i = 0; i < Math.round(5 * hz); i++) {
			t += dt;
			stepMovers([e], dt, t, {});
		}
		return e.pos[0];
	}
	it('cover the same ground at 30, 60, 120 Hz and at 3 fps (it fell behind below 10 fps)', () => {
		const ref = walked(60);
		expect(ref).toBeGreaterThan(8);
		for (const hz of [30, 120, 3]) expect(Math.abs(walked(hz) - ref)).toBeLessThan(0.35);
	});
});
