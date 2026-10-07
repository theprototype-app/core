// @ts-nocheck — plain fixture objects (scene stubs, touch declarations)
// 37-avatar-fix R24 — FLYING IS OPT-IN. A game flies only when it says so; a scene can remove the
// option for everything; the editor is untouched. One rule (locomotionPolicy.flyDecision) behind
// resolvePlaySettings, read by desktop Play (grounded), the touch buttons and VR Interact.
import { describe, it, expect, beforeEach } from 'vitest';
import { flyDecision, normalizeLocomotion, locomotionPolicy } from '../../src/lib/locomotionPolicy.js';
import { resolvePlaySettings } from '../../src/lib/playSettings.js';
import { setScenePhysics } from '../../src/lib/scenePhysics.js';
import { setCharControl } from '../../src/lib/charController.js';
import { resolveTouchControls } from '../../src/lib/touchActions.js';

const CONTROLLER = (mode) => ({ mode, speed: 0.1, jumpHeight: 1, eyeHeight: 1.7, gravity: true, sourceNodeId: 'n' });
/** a module's scene-root group publishing the play contract (the dungeon module's name: core-owned scope) */
const publisher = (play) => ({ children: [{ name: 'dungeon-module', userData: { play } }] });

describe('flyDecision (the pure rule)', () => {
	it('off unless something asks; removed beats everything; an explicit pin keeps it off', () => {
		expect(flyDecision({})).toEqual({ fly: false, reason: 'off' });
		expect(flyDecision({ flyFlag: true }).fly).toBe(true);
		expect(flyDecision({ publisherUngrounded: true }).fly).toBe(true);
		expect(flyDecision({ controllerFlies: true }).fly).toBe(true);
		expect(flyDecision({ flyFlag: true, pinned: true })).toEqual({ fly: false, reason: 'pinned' });
		expect(flyDecision({ flyFlag: true, controllerFlies: true, removed: true })).toEqual({ fly: false, reason: 'removed' });
	});
	it('normalizeLocomotion keeps noFly only when true', () => {
		expect(normalizeLocomotion({ noFly: true })).toEqual({ noFly: true });
		expect(normalizeLocomotion({ noFly: false })).toBe(null);
		expect(normalizeLocomotion({ fly: true, noFly: 'yes' })).toEqual({ fly: true });
	});
});

describe('resolvePlaySettings: every game is grounded unless it opts in', () => {
	beforeEach(() => {
		setCharControl(null);
		setScenePhysics({ play: { grounded: false, locomotion: null } });
	});
	it('a scene with the stored default (grounded: false, no fly) WALKS now', () => {
		const s = resolvePlaySettings(null);
		expect(s.locomotion.fly).toBe(false);
		expect(s.grounded).toBe(true);
		expect(s.fly).toBe('off');
	});
	it('Configure Scene ▸ Flying: Allowed flies, Removed does not', () => {
		setScenePhysics({ play: { locomotion: { fly: true } } });
		expect(resolvePlaySettings(null)).toMatchObject({ grounded: false, fly: 'allowed', locomotion: { fly: true } });
		setScenePhysics({ play: { locomotion: { noFly: true } } });
		expect(resolvePlaySettings(null)).toMatchObject({ grounded: true, fly: 'removed', locomotion: { fly: false } });
	});
	it("a game module's opt-in counts — fly: true, or un-grounding play (Dungeon Realms' disableFlight off)", () => {
		expect(resolvePlaySettings(publisher({ locomotion: { fly: true } })).locomotion.fly).toBe(true);
		expect(resolvePlaySettings(publisher({ grounded: false })).locomotion.fly).toBe(true);
		expect(resolvePlaySettings(publisher({ grounded: true })).locomotion.fly).toBe(false);
	});
	it("a scene's Removed beats a module's opt-in (and a module cannot lift it)", () => {
		setScenePhysics({ play: { locomotion: { noFly: true } } });
		expect(resolvePlaySettings(publisher({ grounded: false, locomotion: { fly: true, noFly: false } })).fly).toBe('removed');
	});
	it('a Character Controller node in fly mode is a game designed to fly; walk mode is not', () => {
		setCharControl(CONTROLLER('fly'));
		expect(resolvePlaySettings(null).locomotion.fly).toBe(true);
		setCharControl(CONTROLLER('walk'));
		expect(resolvePlaySettings(null).locomotion.fly).toBe(false);
		setCharControl(CONTROLLER('fly'));
		setScenePhysics({ play: { locomotion: { noFly: true } } });
		expect(resolvePlaySettings(null).locomotion.fly).toBe(false);
	});
	it('VR: Interact flies only when allowed; Edit (the editor) always flies', () => {
		expect(locomotionPolicy('interact', resolvePlaySettings(null).locomotion).fly).toBe(false);
		setScenePhysics({ play: { locomotion: { fly: true } } });
		expect(locomotionPolicy('interact', resolvePlaySettings(null).locomotion).fly).toBe(true);
		setScenePhysics({ play: { locomotion: { noFly: true } } });
		expect(locomotionPolicy('edit', resolvePlaySettings(null).locomotion).fly).toBe(true);
	});
});

describe('touch: no Up/Down buttons unless the game flies', () => {
	const ids = (spec) => spec.actions.map((a) => a.id);
	it('the built-in (no controller) game shows the explore preset, not the fly one', () => {
		const spec = resolveTouchControls({ fly: true, canFly: false });
		expect(spec.preset).toBe('explore');
		expect(ids(spec)).not.toContain('up');
		expect(ids(spec)).not.toContain('down');
	});
	it('a game that flies keeps them', () => {
		expect(ids(resolveTouchControls({ fly: true, canFly: true }))).toEqual(expect.arrayContaining(['up', 'down']));
	});
	it("a module that DECLARES a fly preset or Up/Down loses them when flying is not allowed", () => {
		const declared = [{ owner: 'm', preset: 'fly', actions: [{ id: 'up', label: 'Up', icon: 'up', keys: ['KeyE'] }] }];
		const spec = resolveTouchControls({ declared, canFly: false });
		expect(spec.preset).toBe('explore');
		expect(ids(spec)).not.toContain('up');
	});
});

// Every shipped game's play block (scenes repo `main` @e8f03cf, read from each .tpscene's
// session.json `physics.play` + its Character Controller node) and what it gets now. Only the Jam
// Room was designed to fly (its VR fly); Dungeon Realms flies only when its own Game Rules ▸
// disableFlight is turned off. Every other game WALKS — Football, Marble maze, Stars Room, Target
// toss and the General templates used to fly on desktop by default.
const GAMES = [
	['dungeon-realms', { grounded: true }, null, { grounded: true }, 'pinned'],
	['dungeon-realms (disableFlight off)', { grounded: true }, null, { grounded: false }, 'allowed'],
	['escape-room', { grounded: true, locomotion: { teleport: true } }, 'walk', null, 'pinned'],
	['football', { grounded: false }, null, null, 'off'],
	['jam-room', { grounded: false, locomotion: { teleport: true, fly: true, worldGrab: true } }, null, null, 'allowed'],
	['marble-maze', { grounded: false }, null, null, 'off'],
	['mini-golf', { grounded: false, locomotion: { teleport: true } }, 'walk', null, 'off'],
	['race', { grounded: false, locomotion: { teleport: true } }, 'walk', null, 'off'],
	['sky-run', { grounded: false }, 'walk', null, 'off'],
	['stars-room', { grounded: false, locomotion: { teleport: true } }, null, null, 'off'],
	['target-toss', { grounded: false }, null, null, 'off'],
	['towers', { grounded: false }, 'walk', null, 'off'],
	['untangle', { grounded: true, locomotion: { worldGrab: true } }, null, null, 'pinned'],
	['waves', { grounded: true, locomotion: { teleport: false, fly: false } }, null, null, 'pinned'],
	['templates (castle, forest, market, tavern, wizard, architecture)', { grounded: false }, null, null, 'off']
];

describe('every shipped game: no flying unless designed to', () => {
	beforeEach(() => setCharControl(null));
	for (const [name, play, controller, published, want] of GAMES) {
		it(`${name} -> ${want}`, () => {
			setScenePhysics({ play: { grounded: play.grounded, locomotion: play.locomotion ?? null } });
			setCharControl(controller ? CONTROLLER(controller) : null);
			const s = resolvePlaySettings(published ? publisher(published) : null);
			expect(s.fly).toBe(want);
			expect(s.locomotion.fly).toBe(want === 'allowed');
			expect(s.grounded).toBe(want !== 'allowed');
		});
	}
});
