// 54i k: the possess hop (src/lib/possessJump.js) — Space / gamepad A lift the possessed object
// `height` metres and the scene's gravity lands it back on the take-off height.
import { describe, it, expect } from 'vitest';
import { POSSESS_JUMP_CODES, POSSESS_JUMP_HEIGHT, startHop, stepHop } from '../../src/lib/possessJump.js';

/** fly a hop at 60 fps; the peak, the frames in the air, the landing height @param {any} hop @param {number} y */
function fly(hop, y) {
	let peak = y;
	let frames = 0;
	while (hop && frames < 1000) {
		const s = stepHop(hop, y, 1 / 60);
		y = s.y;
		hop = s.hop;
		peak = Math.max(peak, y);
		frames++;
	}
	return { peak, frames, y };
}

describe('possess jump (54i k)', () => {
	it('Space and gamepad A are the jump codes; 1.2 m by default', () => {
		expect(POSSESS_JUMP_CODES).toEqual(['Space', 'GamepadA']);
		expect(POSSESS_JUMP_HEIGHT).toBe(1.2);
	});
	it('leaves the ground, peaks at the height asked and lands exactly where it took off', () => {
		const r = fly(startHop(0.5, 1.2, 9.81), 0.5);
		expect(r.peak).toBeGreaterThan(0.5 + 1.15);
		expect(r.peak).toBeLessThan(0.5 + 1.25);
		expect(r.y).toBe(0.5);
		// airtime 2·sqrt(2h/g) ≈ 0.99 s
		expect(r.frames / 60).toBeGreaterThan(0.9);
		expect(r.frames / 60).toBeLessThan(1.1);
	});
	it("follows the scene's gravity: half the gravity, twice the airtime", () => {
		const a = fly(startHop(0, 1, 9.81), 0).frames;
		const b = fly(startHop(0, 1, 9.81 / 4), 0).frames;
		expect(b / a).toBeGreaterThan(1.9);
		expect(b / a).toBeLessThan(2.1);
	});
	it('height 0, upward or zero gravity: no hop', () => {
		expect(startHop(0, 0)).toBe(null);
		expect(startHop(0, 1, -9.81)).toBe(null);
		expect(startHop(0, 1, 0)).toBe(null);
	});
	it('a long frame cannot tunnel below the take-off height', () => {
		const s = stepHop({ base: 0, vy: -50, g: 9.81 }, 0.2, 5);
		expect(s.y).toBe(0);
		expect(s.landed).toBe(true);
	});
});
