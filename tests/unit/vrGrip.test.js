import { describe, it, expect } from 'vitest';
import { isScenery, pickGripTarget, gripMovesWorld, SCENERY_EXTENT } from '../../src/lib/vrGrip.js';
import { contactGrabAllowed, secondGripVerdict, grabMoved, CONTACT_MAX_EXTENT, GRAB_MOVED_M, GRAB_JOIN_MS } from '../../src/lib/vrGrip.js';

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
	// 33 E4: "not all objects positions can be moved in edit mode when in game" — a wall,
	// a floor or an arena was held by NOTHING. Selected, it is held in Edit like any object.
	it('Edit: SELECTED scenery is held (select-then-grab); unselected still passes through', () => {
		const selectedWall = { scenery: true, grabbable: false, selected: true };
		expect(pickGripTarget([selectedWall, ball], 'edit')).toBe(0);
		expect(pickGripTarget([wall, selectedWall], 'edit')).toBe(1);
		expect(pickGripTarget([wall, ball], 'edit')).toBe(1);
	});
	it('Interact: selection never makes scenery holdable (a player cannot pick up the room)', () => {
		const selectedWall = { scenery: true, grabbable: false, selected: true };
		expect(pickGripTarget([selectedWall, ball], 'interact')).toBe(1);
		expect(pickGripTarget([selectedWall], 'interact')).toBe(-1);
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

// 31 K1: an Interact grip moves the world only with the play block's worldGrab
describe('31 K1 gripMovesWorld', () => {
	it('Edit always, Interact only with worldGrab', () => {
		expect(gripMovesWorld('edit')).toBe(true);
		expect(gripMovesWorld('interact')).toBe(false);
		expect(gripMovesWorld('interact', true)).toBe(true);
	});
});

// 52 (V5): the universal world grab

describe('contactGrabAllowed (52 V5)', () => {
	it('a cup in the hand: yes', () => {
		expect(contactGrabAllowed(box([-0.1, 0.9, -0.5], [0.1, 1.1, -0.3]), head)).toBe(true);
	});
	it('anything over ~2 m on any axis: no (a 3 m crate, a 10 m wall)', () => {
		expect(contactGrabAllowed(box([0, 0, 0], [3, 1, 1]), head)).toBe(false);
		expect(contactGrabAllowed(box([-5, 0, -3.25], [5, 4, -2.75]), head)).toBe(false);
		expect(contactGrabAllowed(box([0, 0, 0], [CONTACT_MAX_EXTENT, 1, 1]), null)).toBe(true);
	});
	it('a hollow box around the headset: no, however small', () => {
		expect(contactGrabAllowed(box([-0.9, 0, -0.9], [0.9, 1.9, 0.9]), head)).toBe(false);
		expect(contactGrabAllowed(box([-0.9, 0, -0.9], [0.9, 1.9, 0.9]), { x: 3, y: 1.6, z: 0 })).toBe(true);
	});
	it('terrain and locked objects: no', () => {
		const b = box([0, 0, 0], [1, 1, 1]);
		expect(contactGrabAllowed(b, null, { terrain: true })).toBe(false);
		expect(contactGrabAllowed(b, null, { locked: true })).toBe(false);
		expect(contactGrabAllowed(null, null)).toBe(false);
	});
});

describe('pickGripTarget never takes terrain (52 V5)', () => {
	it('even selected, the ray passes through terrain', () => {
		expect(pickGripTarget([{ scenery: true, grabbable: false, selected: true, terrain: true }, { scenery: false, grabbable: false }], 'edit')).toBe(1);
		expect(pickGripTarget([{ scenery: false, grabbable: false, selected: true, terrain: true }], 'edit')).toBe(-1);
	});
});

describe('secondGripVerdict (52 V5)', () => {
	const base = { setting: /** @type {'always'} */ ('always'), mode: /** @type {'edit'} */ ('edit') };
	it('nothing or air in the other hand: the world', () => {
		expect(secondGripVerdict({ ...base, otherGrab: null })).toBe('world');
	});
	it('an UNMOVED object in the other hand: dropped, the world', () => {
		expect(secondGripVerdict({ ...base, otherGrab: { moved: false } })).toBe('world');
		expect(secondGripVerdict({ ...base, otherGrab: { moved: false, set: true } })).toBe('world');
	});
	it('an object the other hand already MOVED: two-hand scale (a set keeps its own rule)', () => {
		expect(secondGripVerdict({ ...base, otherGrab: { moved: true } })).toBe('scale');
		expect(secondGripVerdict({ ...base, otherGrab: { moved: true, set: true } })).toBe('legacy');
	});
	it('a moved object in one hand, the other grip on a DIFFERENT object: that hand holds it (33 G4)', () => {
		expect(secondGripVerdict({ ...base, otherGrab: { moved: true }, takesOther: true })).toBe('legacy');
		expect(secondGripVerdict({ ...base, otherGrab: { moved: false }, takesOther: true })).toBe('world');
	});
	it('the pre-52 rule: "Only in empty air", Interact, stretch mode, a busy other hand', () => {
		expect(secondGripVerdict({ ...base, setting: 'emptyAir', otherGrab: null })).toBe('legacy');
		expect(secondGripVerdict({ ...base, mode: 'interact', otherGrab: null })).toBe('legacy');
		expect(secondGripVerdict({ ...base, stretch: true, otherGrab: null })).toBe('legacy');
		expect(secondGripVerdict({ ...base, otherBusy: true, otherGrab: null })).toBe('legacy');
	});
});

describe('grabMoved (52 V5)', () => {
	it('past ~2 cm counts, a tremble does not', () => {
		expect(grabMoved([0, 1, 0], [0.015, 1, 0])).toBe(false);
		expect(grabMoved([0, 1, 0], [0, 1, GRAB_MOVED_M + 0.001])).toBe(true);
		expect(GRAB_JOIN_MS).toBe(250);
	});
});
