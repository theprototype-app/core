// 36-vr (plan 55) — the VR bindings map with no browser: defaults = the shipped controller map,
// conflicts (turn + teleport may share a stick, nothing else may share), swap, mirror, reset, the
// menu hand following vrMenuHand both ways, and a stored map surviving a "reload" (normalize).
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { vrMenuHand } from '../../src/stores/sceneStore';
import {
	VR_ACTIONS,
	defaultBindings,
	normalizeBindings,
	bindingConflicts,
	followMenuHand,
	setBinding,
	resetBindings,
	mirrorBindings,
	isLeftHanded,
	bindingOf,
	handOf,
	buttonIndexOf,
	actionPressed,
	stickOf,
	bindingLabel,
	vrBindings
} from '../../src/lib/vr/bindings.js';

/** a fake input source @param {'left'|'right'} hand @param {number[]} down @param {number[]} [axes] */
const src = (hand, down = [], axes = [0, 0, 0, 0]) => ({
	handedness: hand,
	gamepad: { buttons: Array.from({ length: 7 }, (_, i) => ({ pressed: down.includes(i) })), axes }
});

beforeEach(() => {
	resetBindings();
	vrMenuHand.set('right');
});

describe('defaults are the shipped map', () => {
	it('menu B · mode Y · pause X · talk A · ping right stick · move left · turn + teleport right · drag-the-world right', () => {
		const d = defaultBindings();
		expect(d.menu).toEqual({ hand: 'right', control: 'secondary' });
		expect(d.mode).toEqual({ hand: 'left', control: 'secondary' });
		expect(d.pause).toEqual({ hand: 'left', control: 'primary' });
		expect(d.ptt).toEqual({ hand: 'right', control: 'primary' });
		expect(d.ping).toEqual({ hand: 'right', control: 'stickClick' });
		expect(d.move).toEqual({ hand: 'left', control: 'stick' });
		expect(d.turn).toEqual({ hand: 'right', control: 'stick' });
		expect(d.teleport).toEqual({ hand: 'right', control: 'stick' });
		expect(d.worldPan).toEqual({ hand: 'right', control: 'grip' });
		expect(bindingConflicts(d)).toEqual([]);
	});
	it('reads go through the map: B on the right is the menu, X on the left is the game menu', () => {
		expect(actionPressed('menu', src('right', [5]))).toBe(true);
		expect(actionPressed('menu', src('left', [5]))).toBe(false); // Y is the mode button, not the menu
		expect(actionPressed('mode', src('left', [5]))).toBe(true);
		expect(actionPressed('pause', src('left', [4]))).toBe(true);
		expect(actionPressed('ptt', src('right', [4]))).toBe(true);
		expect(buttonIndexOf('move')).toBe(-1);
		expect(bindingLabel('menu')).toBe('B (right)');
		const session = { inputSources: [src('left', [], [0, 0, 0.3, -0.9]), src('right', [], [0, 0, 0.8, 0.1])] };
		expect({ ...stickOf('move', session) }).toEqual({ x: 0.3, y: -0.9 });
		expect({ ...stickOf('turn', session) }).toEqual({ x: 0.8, y: 0.1 });
	});
});

describe('conflicts', () => {
	it('turn and teleport share a stick; move may not join them', () => {
		const m = defaultBindings();
		expect(bindingConflicts(m)).toEqual([]);
		m.move = { hand: 'right', control: 'stick' };
		expect(bindingConflicts(m).map((p) => p.join('+'))).toEqual(['move+turn', 'move+teleport']);
	});
	it('a conflicting set is REFUSED and nothing changes; swap moves the other action to the old place', () => {
		const before = get(vrBindings);
		const refused = setBinding('menu', { control: 'primary' }); // A — talk lives there
		expect(refused).toEqual({ ok: false, conflict: 'ptt' });
		expect(get(vrBindings)).toBe(before);
		const swapped = setBinding('menu', { control: 'primary' }, { swap: true });
		expect(swapped).toEqual({ ok: true, swapped: 'ptt' });
		expect(bindingOf('menu')).toEqual({ hand: 'right', control: 'primary' });
		expect(bindingOf('ptt')).toEqual({ hand: 'right', control: 'secondary' });
		expect(bindingConflicts(get(vrBindings))).toEqual([]);
	});
	it('a locked row cannot be rebound', () => {
		expect(setBinding('grab', { hand: 'left' }).ok).toBe(false);
		expect(bindingOf('grab').hand).toBe('both');
	});
});

describe('the plan-55 acceptance: move to the right hand, menu to A — everything follows', () => {
	it('move → right swaps the turn stick to the left; the frame reads follow', () => {
		// turn + teleport both live on the right stick: the swap has to carry BOTH across
		expect(setBinding('move', { hand: 'right' }).conflict).toBe('turn');
		expect(setBinding('move', { hand: 'right' }, { swap: true })).toEqual({ ok: true, swapped: 'turn,teleport' });
		expect(handOf('move')).toBe('right');
		expect(handOf('turn')).toBe('left');
		expect(handOf('teleport')).toBe('left');
		expect(bindingConflicts(get(vrBindings))).toEqual([]);
		const session = { inputSources: [src('left', [], [0, 0, 0.9, 0]), src('right', [], [0, 0, 0, -1])] };
		expect(stickOf('move', session).y).toBe(-1);
		expect(stickOf('turn', session).x).toBe(0.9);
		setBinding('menu', { control: 'primary' }, { swap: true });
		expect(actionPressed('menu', src('right', [4]))).toBe(true);
	});
	it('the map survives a reload (normalize of the stored JSON is the identity on a valid map)', () => {
		setBinding('move', { hand: 'right' }, { swap: true });
		const stored = JSON.parse(JSON.stringify(get(vrBindings)));
		expect(normalizeBindings(stored)).toEqual(get(vrBindings));
	});
	it('a corrupt or conflicting stored map falls back to the defaults', () => {
		expect(normalizeBindings('nonsense')).toEqual(defaultBindings());
		expect(normalizeBindings({ menu: { hand: 'left', control: 'secondary' } })).toEqual(defaultBindings()); // clashes with mode
		expect(normalizeBindings({ move: { hand: 'up', control: 'banana' } })).toEqual(defaultBindings());
	});
});

describe('the menu hand (vrMenuHand) and the menu binding are one fact', () => {
	it('moving the menu to the left puts Edit/Interact on the right B — the old rule', () => {
		vrMenuHand.set('left');
		expect(bindingOf('menu')).toEqual({ hand: 'left', control: 'secondary' });
		expect(bindingOf('mode')).toEqual({ hand: 'right', control: 'secondary' });
		expect(bindingConflicts(get(vrBindings))).toEqual([]);
	});
	it('rebinding the menu hand moves vrMenuHand', () => {
		setBinding('menu', { hand: 'left' }, { swap: true });
		expect(get(vrMenuHand)).toBe('left');
		expect(handOf('mode')).toBe('right');
	});
	it('followMenuHand is pure', () => {
		const d = defaultBindings();
		const n = followMenuHand(d, 'left');
		expect(d.menu.hand).toBe('right');
		expect(n.menu.hand).toBe('left');
	});
});

describe('left-handed + reset', () => {
	it('mirror flips every remappable hand, keeps the controls, and the toggle reads it', () => {
		expect(isLeftHanded()).toBe(false);
		mirrorBindings();
		expect(isLeftHanded()).toBe(true);
		expect(bindingOf('move')).toEqual({ hand: 'right', control: 'stick' });
		expect(bindingOf('menu')).toEqual({ hand: 'left', control: 'secondary' });
		expect(get(vrMenuHand)).toBe('left');
		expect(bindingOf('grab').hand).toBe('both');
		mirrorBindings();
		expect(get(vrBindings)).toEqual(defaultBindings());
	});
	it('reset restores every action', () => {
		setBinding('ping', { hand: 'left' });
		resetBindings();
		expect(get(vrBindings)).toEqual(defaultBindings());
		expect(VR_ACTIONS.length).toBeGreaterThanOrEqual(11);
	});
});
