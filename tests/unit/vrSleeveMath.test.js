// Roadmap 82 P1-P4: the VR sleeve's take / grow / latch / cancel maths (pure, no headset).
import { describe, it, expect } from 'vitest';
import {
	GROW_NEAR,
	GROW_FAR,
	CANCEL_NEAR,
	CANCEL_ARM,
	MAX_VIEW_DEG,
	growthTarget,
	stepGrowth,
	growthFactor,
	viewAngleDeg,
	clampedOffset,
	cancelStep,
	flyBackProgress,
	placementScale,
	originRadius
} from '../../src/lib/vrSleeveMath.js';

const GHOST = 0.032;
// the 2 m default Box: max extent 2, radius about its origin sqrt(3)
const BOX_EXTENT = 2;
const BOX_RADIUS = Math.sqrt(3);

/** the held object's view angle for a hand at `hand` aiming -Z, head at `head` @param {number[]} hand @param {number[]} head @param {number} radius */
function heldView(hand, head, radius, base = 0) {
	const o = clampedOffset(hand[0], hand[1], hand[2], 0, 0, -1, head[0], head[1], head[2], radius, base);
	const c = [hand[0], hand[1], hand[2] - o];
	const dist = Math.hypot(c[0] - head[0], c[1] - head[1], c[2] - head[2]);
	return { offset: o, deg: viewAngleDeg(radius, dist) };
}

describe('P1 growth curve', () => {
	it('is 0 at the wrist, 1 from 40 cm, linear in between', () => {
		expect(growthTarget(0)).toBe(0);
		expect(growthTarget(GROW_NEAR)).toBe(0);
		expect(growthTarget(GROW_FAR)).toBe(1);
		expect(growthTarget(1)).toBe(1);
		expect(growthTarget((GROW_NEAR + GROW_FAR) / 2)).toBeCloseTo(0.5, 6);
	});
	it('the factor runs ghost -> true size x world scale, monotonic, in log space', () => {
		const ghost = GHOST / BOX_EXTENT;
		for (const world of [1, 0.1, 0.02]) {
			expect(growthFactor(0, ghost, world)).toBeCloseTo(ghost, 9);
			expect(growthFactor(1, ghost, world)).toBeCloseTo(world, 9);
			let prev = growthFactor(0, ghost, world);
			for (let t = 0.1; t <= 1.0001; t += 0.1) {
				const f = growthFactor(t, ghost, world);
				if (world > ghost) expect(f).toBeGreaterThan(prev);
				prev = f;
			}
		}
		// log-lerp: halfway is the geometric mean, not half of true size
		expect(growthFactor(0.5, 0.01, 1)).toBeCloseTo(0.1, 9);
	});
	it('the shown growth chases the wanted one at a bounded rate (a distance take still grows)', () => {
		let t = 0;
		let frames = 0;
		while (t < 1 && frames < 1000) {
			t = stepGrowth(t, 1, 1 / 72);
			frames++;
		}
		expect(t).toBe(1);
		expect(frames).toBeGreaterThan(10); // not a pop
		expect(frames).toBeLessThan(40); // under ~0.5 s
		expect(stepGrowth(0.5, 0.2, 1)).toBeCloseTo(0.2, 9); // never overshoots
	});
	it('the object never covers more than 50 deg of view — a 2 m box at full size, hand anywhere', () => {
		const head = [0, 1.6, 0];
		for (const hand of [[0.2, 1.2, -0.3], [0, 1.6, -0.1], [-0.3, 1.0, 0.1], [0.1, 1.5, -0.6]]) {
			for (const t of [0, 0.25, 0.5, 0.75, 1]) {
				const r = BOX_RADIUS * growthFactor(t, GHOST / BOX_EXTENT, 1);
				const { deg } = heldView(hand, head, r);
				expect(deg).toBeLessThanOrEqual(MAX_VIEW_DEG + 1e-6);
			}
		}
		// the BUG it replaces: full size 0.9 m in front of a hand at 1.2 m, eye 0.4 m above
		const oldDist = Math.hypot(0.4, 0.9);
		expect(viewAngleDeg(BOX_RADIUS, oldDist)).toBeGreaterThan(90);
	});
	it('a ghost-sized object sits just in front of the hand (no clamp needed)', () => {
		const r = BOX_RADIUS * (GHOST / BOX_EXTENT);
		const { offset } = heldView([0.2, 1.2, -0.3], [0, 1.6, 0], r);
		expect(offset).toBeCloseTo(r + 0.04, 6);
	});
	it('the clamp respects a longer reel length (the base offset wins when farther)', () => {
		const r = 0.1;
		expect(heldView([0, 1.2, -0.3], [0, 1.6, 0], r, 3).offset).toBeCloseTo(3, 6);
	});
});

describe('P3 cancel', () => {
	it('arms only once the hand has left the wrist, then cancels within 10 cm', () => {
		expect(cancelStep(0.02, false)).toBe(0); // a direct take starts AT the wrist
		expect(cancelStep(CANCEL_ARM + 0.01, false)).toBe(1);
		expect(cancelStep(0.12, true)).toBe(0);
		expect(cancelStep(CANCEL_NEAR - 0.01, true)).toBe(2);
	});
	it('the fly-back eases to 1 and is instant under reduced motion', () => {
		expect(flyBackProgress(0, 220)).toBe(0);
		expect(flyBackProgress(110, 220)).toBeCloseTo(0.75, 6);
		expect(flyBackProgress(400, 220)).toBe(1);
		expect(flyBackProgress(0, 0)).toBe(1);
	});
});

describe('P2 world-scale-correct placement', () => {
	it('a preview at true size x world scale lands at local scale 1 (true size) in every world', () => {
		for (const world of [1, 0.1, 0.02, 4]) {
			expect(placementScale(world * 1, world)).toBeCloseTo(1, 9);
			expect(placementScale(world * 1.5, world)).toBeCloseTo(1.5, 9); // the stick scale survives
		}
	});
	it('origin radius is conservative for an off-centre shape', () => {
		expect(originRadius(-1, -1, -1, 1, 1, 1)).toBeCloseTo(Math.sqrt(3), 9);
		expect(originRadius(0, 0, 0, 2, 1, 2)).toBeCloseTo(3, 9);
	});
});
