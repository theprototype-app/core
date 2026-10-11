// 41 G4: the Interact carry's release — the last frames only, capped, direction kept.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { cursorThrow, CURSOR_THROW_MAX, THROW_WINDOW_MS } from '../../src/lib/throwVelocity.js';

/** @param {number} t @param {number} x */
const at = (t, x, y = 0) => ({ t, pos: new THREE.Vector3(x, y, 0), quat: new THREE.Quaternion() });

describe('cursorThrow', () => {
	it('measures the move of the last frames', () => {
		const v = cursorThrow([at(0, 0), at(16, 0.016), at(32, 0.032), at(48, 0.048)], 50);
		expect(v.linvel.x).toBeCloseTo(1, 3);
	});
	it('caps a flick to CURSOR_THROW_MAX and keeps its direction', () => {
		const v = cursorThrow([at(0, 0, 0), at(16, 1.6, 1.6)], 20); // ~141 m/s diagonal
		expect(v.linvel.length()).toBeCloseTo(CURSOR_THROW_MAX, 5);
		expect(v.linvel.x).toBeCloseTo(v.linvel.y, 6);
	});
	it('a finger that stopped before letting go throws nothing', () => {
		const v = cursorThrow([at(0, 0), at(16, 0.5), at(32, 1)], 32 + THROW_WINDOW_MS + 200);
		expect(v.linvel.length()).toBe(0);
	});
	it('only the samples inside the window count', () => {
		// a fast early move, then a slow one just before the release
		const v = cursorThrow([at(0, 0), at(16, 2), at(200, 2), at(216, 2.016), at(232, 2.032)], 240);
		expect(v.linvel.x).toBeCloseTo(1, 3);
	});
});
