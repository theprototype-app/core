// 36 U8: the touch action buttons' model — where buttons come from, the default layout, the
// saved-layout overlay, the prefs and the press edges. Pure parts, no browser.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	normalizeAction,
	resolveTouchControls,
	declareTouchActions,
	touchDeclarations,
	defaultTouchLayout,
	effectiveTouchLayout,
	coerceTouchLayout,
	saveTouchLayout,
	resetTouchLayout,
	savedLayoutFor,
	touchLayouts,
	touchWanted,
	coerceTouchPrefs,
	setTouchPrefs,
	touchPrefs,
	coerceTexture,
	setTouchTexture,
	clearTouchTexture,
	touchTextures,
	pressTouchAction,
	releaseAllTouchActions,
	touchHeld,
	keyLabel,
	MAX_BUTTONS,
	MAX_KEY_BUTTONS,
	TOUCH_SIZE_RANGE
} from '../../src/lib/touchActions.js';

const ids = (/** @type {{actions: {id: string}[]}} */ spec) => spec.actions.map((a) => a.id);

describe('actions', () => {
	it('a built-in id fills in from the catalog', () => {
		const a = normalizeAction('jump');
		expect(a).toMatchObject({ id: 'jump', label: 'Jump', icon: 'jump', keys: ['Space'], pointer: '' });
		expect(normalizeAction('fire')?.pointer).toBe('press');
		expect(normalizeAction('interact')?.pointer).toBe('tap');
	});
	it('a custom action needs something to do, and its keys are checked', () => {
		expect(normalizeAction({ id: 'nothing' })).toBeNull();
		expect(normalizeAction({ id: 'bad', keys: ['<script>'] })).toBeNull();
		const own = normalizeAction({ id: 'boost', label: 'Boost!', keys: ['KeyB', 'nope nope'] });
		expect(own).toMatchObject({ id: 'boost', label: 'Boost!', keys: ['KeyB'] });
		const fn = () => {};
		expect(normalizeAction({ id: 'throw', onPress: fn })?.onPress).toBe(fn);
	});
	it('overriding a built-in with a handler drops its default pointer press', () => {
		const a = normalizeAction({ id: 'fire', label: 'Throw', onPress: () => {} });
		expect(a?.pointer).toBe('');
		expect(a?.label).toBe('Throw');
		expect(a?.icon).toBe('fire');
	});
	it('key labels read like keys', () => {
		expect(keyLabel('KeyR')).toBe('R');
		expect(keyLabel('Digit3')).toBe('3');
		expect(keyLabel('ShiftLeft')).toBe('Shift');
		expect(keyLabel('Space')).toBe('Space');
	});
});

describe('where buttons come from', () => {
	it('nothing declared and no controller: explore, no buttons', () => {
		const spec = resolveTouchControls({});
		expect(spec).toMatchObject({ stick: true, look: true, preset: 'explore' });
		expect(spec.actions).toEqual([]);
	});
	it('a walking Character Controller means a jump', () => {
		const spec = resolveTouchControls({ walk: true });
		expect(spec.preset).toBe('platformer');
		expect(ids(spec)).toEqual(['jump']);
	});
	it('fly mode means up and down', () => {
		expect(ids(resolveTouchControls({ fly: true }))).toEqual(['up', 'down']);
	});
	it('Key Press nodes become key buttons — never the movement keys, never a key already covered', () => {
		const spec = resolveTouchControls({ walk: true, keyCodes: ['KeyW', 'Space', 'KeyR', 'KeyR', 'ArrowUp', 'KeyF'] });
		expect(ids(spec)).toEqual(['jump', 'key:KeyR', 'key:KeyF']);
		expect(spec.actions[1].label).toBe('R');
	});
	it('key buttons are capped', () => {
		const codes = 'BCFGHIJKLMNOP'.split('').map((c) => 'Key' + c);
		const spec = resolveTouchControls({ keyCodes: codes });
		expect(spec.actions.length).toBe(MAX_KEY_BUTTONS);
	});
	it('a declaration wins over the scene, and its preset frames it', () => {
		const declared = [{ owner: 'tt', actions: [/** @type {any} */ (normalizeAction({ id: 'fire', label: 'Throw', onPress: () => {} }, 'tt'))], preset: 'toss', at: 1 }];
		const spec = resolveTouchControls({ declared, walk: true, keyCodes: ['KeyR'] });
		expect(spec.stick).toBe(false);
		expect(spec.preset).toBe('toss');
		expect(ids(spec)).toEqual(['fire']);
		expect(spec.actions[0].label).toBe('Throw');
	});
	it('the shooter preset brings fire and jump', () => {
		const spec = resolveTouchControls({ declared: [{ owner: 'm', actions: [], preset: 'shooter', at: 1 }] });
		expect(ids(spec)).toEqual(['fire', 'jump']);
		expect(spec.stick && spec.look).toBe(true);
	});
	it('37: the drive preset steers with the stick, has no look drag, and puts the first pedal under the right thumb', () => {
		const pedals = [
			{ id: 'gas', label: 'Gas', icon: 'gas', keys: ['KeyW'] },
			{ id: 'brake', label: 'Brake', icon: 'brake', keys: ['KeyS'] }
		].map((a) => /** @type {any} */ (normalizeAction(a, 'race')));
		const spec = resolveTouchControls({ declared: [{ owner: 'race', actions: pedals, preset: 'drive', at: 1 }] });
		expect(spec.preset).toBe('drive');
		expect(spec.stick).toBe(true);
		expect(spec.look).toBe(false);
		// movement keys are fine as a DECLARED action (only scene-implied keys skip them)
		expect(ids(spec)).toEqual(['gas', 'brake']);
		expect(spec.actions[0].keys).toEqual(['KeyW']);
		const l = defaultTouchLayout(spec, 390, 844);
		expect(l.items['btn:gas'].x).toBeGreaterThan(0.7);
		expect(l.items['btn:gas'].size).toBeGreaterThan(l.items['btn:brake'].size);
		expect(l.items.stick.x).toBeLessThan(0.3);
	});
	it('an explicit stick/look flag beats the preset', () => {
		const spec = resolveTouchControls({ declared: [{ owner: 'm', actions: [], preset: 'platformer', stick: false, look: false, at: 1 }] });
		expect(spec.stick).toBe(false);
		expect(spec.look).toBe(false);
	});
	it('declareTouchActions replaces per owner and off() removes it', () => {
		touchDeclarations.set([]);
		declareTouchActions('a', ['jump']);
		const off = declareTouchActions('a', ['fire', 'reload'], { preset: 'shooter' });
		expect(get(touchDeclarations).length).toBe(1);
		expect(get(touchDeclarations)[0].actions.map((x) => x.id)).toEqual(['fire', 'reload']);
		off();
		expect(get(touchDeclarations)).toEqual([]);
	});
	it('never more than MAX_BUTTONS', () => {
		const many = Array.from({ length: 20 }, (_, i) => ({ id: 'k' + i, keys: ['KeyA'] }));
		touchDeclarations.set([]);
		declareTouchActions('m', many);
		expect(get(touchDeclarations)[0].actions.length).toBe(MAX_BUTTONS);
		touchDeclarations.set([]);
	});
});

describe('layout', () => {
	const spec = resolveTouchControls({ declared: [{ owner: 'm', actions: [], preset: 'shooter', at: 1 }] });
	it('the default puts the stick bottom-left and the primary bottom-right, all on screen', () => {
		const l = defaultTouchLayout(spec, 390, 844);
		expect(l.items.stick.x).toBeLessThan(0.5);
		expect(l.items.stick.y).toBeGreaterThan(0.6);
		expect(l.items['btn:fire'].x).toBeGreaterThan(0.6);
		expect(l.items['btn:fire'].size).toBeGreaterThan(l.items['btn:jump'].size);
		for (const item of Object.values(l.items)) {
			expect(item.x).toBeGreaterThanOrEqual(0);
			expect(item.x).toBeLessThanOrEqual(1);
		}
	});
	it('buttons on the arc do not overlap', () => {
		const big = resolveTouchControls({ declared: [{ owner: 'm', actions: ['jump', 'fire', 'crouch', 'reload', 'sprint'].map((i) => /** @type {any} */ (normalizeAction(i))), preset: 'custom', at: 1 }] });
		const W = 900;
		const H = 700;
		const l = defaultTouchLayout(big, W, H);
		const btns = Object.entries(l.items).filter(([k]) => k.startsWith('btn:')).map(([, v]) => v);
		for (let i = 0; i < btns.length; i++)
			for (let j = i + 1; j < btns.length; j++) {
				const d = Math.hypot((btns[i].x - btns[j].x) * W, (btns[i].y - btns[j].y) * H);
				expect(d).toBeGreaterThanOrEqual((btns[i].size + btns[j].size) / 2);
			}
	});
	it('a saved layout overlays item by item; a new action gets its default slot', () => {
		const saved = coerceTouchLayout({ items: { 'btn:fire': { x: 0.5, y: 0.5, size: 100, opacity: 0.4 } } });
		const l = effectiveTouchLayout(spec, saved, 390, 844);
		expect(l.items['btn:fire']).toMatchObject({ x: 0.5, y: 0.5, size: 100, opacity: 0.4 });
		expect(l.items['btn:jump']).toEqual(defaultTouchLayout(spec, 390, 844).items['btn:jump']);
	});
	it('coerce clamps junk', () => {
		const l = coerceTouchLayout({ items: { stick: { x: 4, y: -1, size: 9999, opacity: 7 }, '../x': { x: 0, y: 0, size: 50 }, b: { x: 'a' } } });
		expect(l?.items.stick).toEqual({ x: 1, y: 0, size: TOUCH_SIZE_RANGE.max, opacity: 1 });
		expect(Object.keys(l?.items ?? {})).toEqual(['stick']);
		expect(coerceTouchLayout(null)).toBeNull();
	});
	it('per-game beats global; reset falls back', () => {
		touchLayouts.set({ global: null, games: {} });
		const L = (/** @type {number} */ x) => ({ v: /** @type {1} */ (1), items: { stick: { x, y: 0.5, size: 128, opacity: 0.7 } } });
		saveTouchLayout(L(0.1), 'global', 'g1');
		saveTouchLayout(L(0.2), 'game', 'g1');
		expect(savedLayoutFor(get(touchLayouts), 'g1')?.items.stick.x).toBe(0.2);
		expect(savedLayoutFor(get(touchLayouts), 'other')?.items.stick.x).toBe(0.1);
		resetTouchLayout('game', 'g1');
		expect(savedLayoutFor(get(touchLayouts), 'g1')?.items.stick.x).toBe(0.1);
		resetTouchLayout('global', 'g1');
		expect(savedLayoutFor(get(touchLayouts), 'g1')).toBeNull();
	});
});

describe('prefs and visibility', () => {
	it('Auto = coarse pointer OR a touch seen; Always/Never are absolute', () => {
		expect(touchWanted('auto', false, false)).toBe(false);
		expect(touchWanted('auto', true, false)).toBe(true);
		expect(touchWanted('auto', false, true)).toBe(true);
		expect(touchWanted('always', false, false)).toBe(true);
		expect(touchWanted('never', true, true)).toBe(false);
	});
	it('prefs coerce and persist', () => {
		expect(coerceTouchPrefs({ visibility: 'sometimes', haptics: 'yes' })).toEqual({ visibility: 'auto', showInEdit: false, haptics: true, scope: 'game' });
		setTouchPrefs({ visibility: 'never' });
		expect(get(touchPrefs).visibility).toBe('never');
		setTouchPrefs({ visibility: 'auto' });
	});
});

describe('textures', () => {
	const png = 'data:image/png;base64,iVBORw0KGgo=';
	it('only image data URLs, a hex tint and a clamped scale survive', () => {
		expect(coerceTexture({ released: 'https://evil/x.png', pressed: png, tint: 'red', scale: 9 })).toEqual({ pressed: png, scale: 1.6 });
		expect(coerceTexture({ tint: '#ff00aa' })).toEqual({ tint: '#ff00aa' });
		expect(coerceTexture({})).toBeNull();
	});
	it('set merges, clear removes', () => {
		setTouchTexture('jump', { released: png });
		setTouchTexture('jump', { tint: '#112233' });
		expect(get(touchTextures).jump).toEqual({ released: png, tint: '#112233' });
		setTouchTexture('jump', { released: undefined });
		expect(get(touchTextures).jump).toEqual({ tint: '#112233' });
		clearTouchTexture('jump');
		expect(get(touchTextures).jump).toBeUndefined();
	});
});

describe('presses', () => {
	beforeEach(() => releaseAllTouchActions());
	it('one press per edge, handlers run once, release-all quiets everything', () => {
		let down = 0;
		let up = 0;
		const a = /** @type {any} */ (normalizeAction({ id: 'go', onPress: () => down++, onRelease: () => up++ }));
		pressTouchAction(a, true);
		pressTouchAction(a, true);
		expect(down).toBe(1);
		expect(get(touchHeld)).toEqual(['go']);
		releaseAllTouchActions();
		expect(up).toBe(1);
		expect(get(touchHeld)).toEqual([]);
		pressTouchAction(a, false);
		expect(up).toBe(1);
	});
	it('a throwing handler does not strand the button down', () => {
		const a = /** @type {any} */ (normalizeAction({ id: 'boom', onPress: () => { throw new Error('x'); } }));
		pressTouchAction(a, true);
		expect(get(touchHeld)).toEqual(['boom']);
		pressTouchAction(a, false);
		expect(get(touchHeld)).toEqual([]);
	});
});
