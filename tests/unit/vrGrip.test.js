import { describe, it, expect } from 'vitest';
import { isScenery, pickGripTarget, gripMovesWorld, SCENERY_EXTENT } from '../../src/lib/vrGrip.js';

// 30b P2: the grip rule. The game-scene shapes below are the real ones from the Quest report
// (Towers' 26 m floor, Stars Room's 12.5 m walls, the football pitch's 5.5 m glass).
/** @param {number[]} min @param {number[]} max */
const box = (min, max) => ({
	min: { x: min[0], y: min[1], z: min[2] },
	max: { x: max[0], y: max[1], z: max[2] }
});
const head = { x: 0, y: 1.6, z: 0 };

describe('isScenery', () => {
	it('a floor, a wall and a glass side are scenery by extent', () => {
		expect(isScenery(box([-13, -0.45, -13], [13, 0.05, 13]), head)).toBe(true); // Towers floor
		expect(isScenery(box([-6.25, 0, -6.25], [6.25, 7, -5.75]), head)).toBe(true); // Stars Room wall
		expect(isScenery(box([-1.525, 0, -2.75], [-1.475, 2.4, 2.75]), head)).toBe(true); // football glass
	});
	it('a cube, a ball, a podium are not', () => {
		expect(isScenery(box([-0.3, 0.5, -0.3], [0.3, 1.1, 0.3]), head)).toBe(false);
		expect(isScenery(box([-0.22, 1.08, -0.22], [0.22, 1.52, 0.22]), { x: 3, y: 1.6, z: 3 })).toBe(false);
	});
	it('the extent threshold is inclusive at SCENERY_EXTENT', () => {
		expect(isScenery(box([0, 0, 0], [SCENERY_EXTENT, 1, 1]), null)).toBe(true);
		expect(isScenery(box([0, 0, 0], [SCENERY_EXTENT - 0.01, 1, 1]), null)).toBe(false);
	});
	it('a small room you stand INSIDE is scenery (head inside the bounds)', () => {
		const booth = box([-1.5, 0, -1.5], [1.5, 2.4, 1.5]);
		expect(isScenery(booth, head)).toBe(true);
		expect(isScenery(booth, { x: 5, y: 1.6, z: 0 })).toBe(false);
	});
	it('empty or missing bounds hold nothing and are never scenery', () => {
		expect(isScenery(null, head)).toBe(false);
		expect(isScenery(box([1, 1, 1], [-1, -1, -1]), head)).toBe(false); // Box3.makeEmpty()
		expect(isScenery(box([NaN, 0, 0], [1, 1, 1]), head)).toBe(false);
	});
});

describe('pickGripTarget', () => {
	const wall = { scenery: true, grabbable: false };
	const podium = { scenery: false, grabbable: false };
	const ball = { scenery: false, grabbable: true };
	it('Edit: scenery is passed through; the first real object is taken', () => {
		expect(pickGripTarget([wall, podium, ball], 'edit')).toBe(1);
		expect(pickGripTarget([wall, ball], 'edit')).toBe(1);
	});
	it('Edit: only scenery along the ray = empty air (the world gesture)', () => {
		expect(pickGripTarget([wall, wall], 'edit')).toBe(-1);
		expect(pickGripTarget([], 'edit')).toBe(-1);
	});
	it('Interact: only a grabbable body is taken, through scenery', () => {
		expect(pickGripTarget([wall, ball], 'interact')).toBe(1);
	});
	it('Interact: a non-grabbable object in front blocks the grab', () => {
		expect(pickGripTarget([podium, ball], 'interact')).toBe(-1);
		expect(pickGripTarget([wall, podium], 'interact')).toBe(-1);
	});
});

describe('gripMovesWorld', () => {
	it('only Edit moves the world', () => {
		expect(gripMovesWorld('edit')).toBe(true);
		expect(gripMovesWorld('interact')).toBe(false);
	});
});
