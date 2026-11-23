// 92 (GC1 / GC2 / GC5 / GC8): the authored menus' rules (gameMenusCore), the scene play block they live
// in (old scenes byte-identical, a newer config kept verbatim), the pause rule, the title buttons, the
// menu rows the feature adds (and does NOT add when unused), the save-slot views and auto-admit.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { normalizeGameMenus, menusRules, menusNewer, MENUS_VERSION } from '../../src/lib/gameMenusCore.js';
import { patchGameMenus, titleItems, pauseWanted, setGameMenus } from '../../src/lib/gameMenusPlan.js';
import { normalizeScenePhysics, scenePhysicsState_ } from '../../src/lib/scenePhysics.js';
import { gameMenus } from '../../src/lib/gameMenus.js';
import { shellMenuItems, resetGameShell, pressShellHit, shellMenu, showShellPage, shellListRows, playerSettingViews, stepGameSetting } from '../../src/lib/gameShell.js';
import { autoAdmitVerdict } from '../../src/lib/playJoins.js';
import { slotViewOf } from '../../src/lib/saveSlots.js';
import { SAVE_VERSION } from '../../src/lib/gameLevels/save.js';
import { pendingApprovals } from '../../src/stores/appStore.js';
import { motionPref } from '../../src/lib/motion.js';
import { lookTuning, setGameSetting } from '../../src/lib/gameSettings.js';

describe('92 normalizeGameMenus', () => {
	it('nothing authored = null (the field is left out of the scene)', () => {
		expect(normalizeGameMenus(undefined)).toBe(null);
		expect(normalizeGameMenus({})).toBe(null);
		expect(normalizeGameMenus({ v: 1 })).toBe(null);
		expect(normalizeGameMenus([1, 2])).toBe(null);
	});
	it('clamps the title block and drops unknown keys inside it', () => {
		const m = normalizeGameMenus({ title: { title: '  Sky Run  ', subtitle: 'x'.repeat(400), background: 'nope', color: 'red', evil: '<script>' } });
		expect(m.v).toBe(MENUS_VERSION);
		expect(m.title).toEqual({ on: true, title: 'Sky Run', subtitle: 'x'.repeat(140), background: 'scene', editor: true });
	});
	it('keeps a colour, an image, and editor: false', () => {
		const m = normalizeGameMenus({ title: { background: 'image', image: 'abc123', color: '#102030', editor: false } });
		expect(m.title).toEqual({ on: true, background: 'image', color: '#102030', image: 'abc123', editor: false });
	});
	it('pause / saves / autoAdmit', () => {
		expect(normalizeGameMenus({ pause: { on: false }, saves: {}, autoAdmit: true })).toEqual({ v: 1, pause: { on: false }, saves: { on: true }, autoAdmit: true });
		expect(normalizeGameMenus({ autoAdmit: 'yes' })).toBe(null);
	});
	it('a NEWER config is kept verbatim (never trimmed to what this app knows) and flagged', () => {
		const newer = { v: 99, title: { on: true, title: 'T', fancy: { a: 1 } }, future: [1, 2] };
		const m = normalizeGameMenus(newer);
		expect(m).toEqual(newer);
		expect(menusNewer(m)).toBe(true);
		// the runtime still reads the parts it understands
		expect(menusRules(m).title?.title).toBe('T');
	});
});

describe('92 the scene play block (old scenes unchanged)', () => {
	it('a scene saved before 92 normalizes with NO menus key', () => {
		const old = { gravity: -9.81, play: { interaction: 'grab', grounded: true, simOnPlay: false, spawn: { position: [0, 0, 0], yaw: 0 } }, changedAt: 5 };
		const out = normalizeScenePhysics(old);
		expect('menus' in out.play).toBe(false);
		// and normalizing twice is stable (what a load-then-save does)
		expect(JSON.stringify(normalizeScenePhysics(out))).toBe(JSON.stringify(out));
	});
	it('menus ride the play block and survive a round trip', () => {
		const out = normalizeScenePhysics({ play: { menus: { title: { title: 'A' }, saves: { on: true } } } });
		expect(out.play.menus).toEqual({ v: 1, title: { on: true, title: 'A', background: 'scene', editor: true }, saves: { on: true } });
		expect(normalizeScenePhysics(JSON.parse(JSON.stringify(out))).play.menus).toEqual(out.play.menus);
	});
	it('setGameMenus writes through the scene singleton; null removes a block', () => {
		scenePhysicsState_.set(normalizeScenePhysics({}));
		setGameMenus({ title: { title: 'Hello' }, saves: true });
		expect(get(gameMenus).title?.title).toBe('Hello');
		expect(get(gameMenus).saves).toBe(true);
		setGameMenus({ title: null, saves: null });
		expect(get(scenePhysicsState_).play.menus).toBeUndefined();
		// nothing authored: the 1.74 menu (no pause)
		expect(get(gameMenus)).toEqual({ title: null, pause: false, saves: false, autoAdmit: false });
		setGameMenus({ saves: true });
		expect(get(gameMenus).pause).toBe(true);
		setGameMenus({ pause: { on: false } });
		expect(get(gameMenus).pause).toBe(false);
		setGameMenus({ saves: null, pause: null });
	});
	it('patchGameMenus merges per block', () => {
		const a = patchGameMenus(null, { title: { title: 'X' } });
		const b = patchGameMenus(a, { title: { subtitle: 'Y' }, autoAdmit: true });
		expect(b.title.title).toBe('X');
		expect(b.title.subtitle).toBe('Y');
		expect(b.autoAdmit).toBe(true);
		expect(patchGameMenus(b, { autoAdmit: false }).autoAdmit).toBeUndefined();
	});
});

describe('92 title buttons and the pause rule', () => {
	it('Play only, then Continue / New game / Load when a save exists; Quit only outside exports', () => {
		expect(titleItems({}).map((i) => i.id)).toEqual(['play', 'settings']);
		expect(titleItems({ canQuit: true }).map((i) => i.id)).toEqual(['play', 'settings', 'quit']);
		const withSave = titleItems({ hasSave: true, saves: true, canQuit: true });
		expect(withSave.map((i) => i.id)).toEqual(['continue', 'play', 'load', 'settings', 'quit']);
		expect(withSave[1].label).toBe('New game');
	});
	it('the menu pauses only when nobody else is in Play', () => {
		expect(pauseWanted({ rule: true, othersPlaying: 0 })).toBe(true);
		expect(pauseWanted({ rule: true, othersPlaying: 1 })).toBe(false);
		expect(pauseWanted({ rule: false, othersPlaying: 0 })).toBe(false);
	});
});

describe('92 the pause menu rows', () => {
	beforeEach(() => {
		resetGameShell();
		pendingApprovals.set([]);
		scenePhysicsState_.set(normalizeScenePhysics({}));
	});
	it('feature unused = the rows of 1.74 exactly', () => {
		expect(shellMenuItems().map((i) => i.id)).toEqual(['resume', 'restart', 'settings', 'access', 'help', 'mainmenu', 'editor']);
	});
	it('saves on + a title + a waiting card add Save / Load / Join requests / Quit to title', () => {
		setGameMenus({ title: { title: 'G' }, saves: true });
		pendingApprovals.set(/** @type {any} */ ([{ peerId: 'abcdef123' }]));
		const ids = shellMenuItems().map((i) => i.id);
		expect(ids).toEqual(['resume', 'restart', 'save', 'load', 'settings', 'access', 'help', 'joins', 'title', 'mainmenu', 'editor']);
		expect(shellMenuItems().find((i) => i.id === 'joins')?.label).toBe('Join requests (1)');
	});
	it('the headset list page carries one Admit and one Decline per card', () => {
		pendingApprovals.set(/** @type {any} */ ([{ peerId: 'abcdef123' }]));
		shellMenu.set({ open: true, page: 'main', levelPage: null, standalone: false, slotMode: 'save' });
		showShellPage('joins');
		expect(shellListRows()?.map((r) => r.id)).toEqual(['shell:join:admit:abcdef123', 'shell:join:decline:abcdef123']);
		expect(pressShellHit('shell:join:admit:abcdef123')).toBe(true);
	});
	it('Subtitles and Reduced motion are SHOWN on the settings page and step from a controller', () => {
		const rows = playerSettingViews();
		expect(rows.map((r) => r.id)).toEqual(['captions', 'motion']);
		motionPref.set('system');
		expect(stepGameSetting('motion', 1)).toBe('reduce');
		expect(get(motionPref)).toBe('reduce');
		motionPref.set('system');
	});
	it('Look speed and Invert look tune the look (Default keeps the device answer)', () => {
		setGameSetting('lookSpeed', 100);
		setGameSetting('invertLook', 'default');
		expect(lookTuning(true)).toEqual({ scale: 1, invert: true });
		setGameSetting('lookSpeed', 50);
		setGameSetting('invertLook', 'off');
		expect(lookTuning(true)).toEqual({ scale: 0.5, invert: false });
		setGameSetting('lookSpeed', 100);
		setGameSetting('invertLook', 'default');
	});
});

describe('92 save slot views', () => {
	it('empty, legacy, newer and broken', () => {
		expect(slotViewOf(null, 2).empty).toBe(true);
		const legacy = slotViewOf({ v: SAVE_VERSION, level: '', scene: '', point: null, kept: { vars: {} }, at: 5 }, 1, true);
		expect(legacy.legacy).toBe(true);
		expect(legacy.name).toBe('Saved progress');
		const newer = slotViewOf({ v: SAVE_VERSION + 1, at: 9, slot: { name: 'Mine' } }, 3);
		expect(newer.newer).toBe(true);
		expect(newer.name).toBe('Mine');
		expect(slotViewOf({ v: 0, broken: true }, 2).empty).toBe(false);
	});
	it('a thumbnail that is not an image data URL is dropped', () => {
		const v = slotViewOf({ v: SAVE_VERSION, at: 1, slot: { thumb: 'javascript:alert(1)' } }, 1);
		expect(v.thumb).toBe('');
	});
});

describe('92 Auto-admit while playing', () => {
	const on = { autoAdmit: true, hosting: true, playing: true, heldOut: false, full: false };
	it('admits a person while the host plays with the switch on', () => {
		expect(autoAdmitVerdict({ peerId: 'p' }, on)).toBe('admit');
	});
	it('never: switch off, not hosting, not playing, an AI agent, a blocked peer, a full room', () => {
		expect(autoAdmitVerdict({ peerId: 'p' }, { ...on, autoAdmit: false })).toBe('off');
		expect(autoAdmitVerdict({ peerId: 'p' }, { ...on, hosting: false })).toBe('not-host');
		expect(autoAdmitVerdict({ peerId: 'p' }, { ...on, playing: false })).toBe('not-playing');
		expect(autoAdmitVerdict({ peerId: 'p', kind: 'agent' }, on)).toBe('agent');
		expect(autoAdmitVerdict({ peerId: 'p' }, { ...on, heldOut: true })).toBe('held-out');
		expect(autoAdmitVerdict({ peerId: 'p' }, { ...on, full: true })).toBe('full');
	});
});

import { titleHintOnce, TITLE_HINT_KEY } from '../../src/lib/gameMenusHint.js';
import { safeStorage } from '../../src/lib/safeStorage.js';
describe('92 the title screen first-use hint', () => {
	it('shows once per device, with Try it when play is offered', () => {
		safeStorage.removeItem(TITLE_HINT_KEY);
		/** @type {any[]} */
		const shown = [];
		const ui = { show: (/** @type {string} */ id, /** @type {string} */ msg, /** @type {any[]} */ actions) => shown.push({ id, msg, labels: actions.map((a) => a.label) }), play: () => {} };
		expect(titleHintOnce(ui)).toBe(true);
		expect(titleHintOnce(ui)).toBe(false);
		expect(shown).toHaveLength(1);
		expect(shown[0].labels).toEqual(['Try it', 'Got it']);
		expect(shown[0].msg).toMatch(/exported games open on it/);
	});
});
