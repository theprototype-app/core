// 102b-play row 1: the author's touch layout travels in the scene (scenePhysics play.touch) and
// layers UNDER the player's own layout, item by item. Pure parts, no browser.
import { describe, it, expect } from 'vitest';
import { normalizeScenePhysics, scenePhysicsSnapshot, setScenePhysics, scenePhysicsRestore, scenePlay } from '../../src/lib/scenePhysics.js';
import { effectiveTouchLayout, defaultTouchLayout, resolveTouchControls } from '../../src/lib/touchActions.js';
import { get } from 'svelte/store';

const spec = resolveTouchControls({ declared: [{ owner: '', actions: [], preset: 'shooter', at: 0 }] });
const item = (x, y, size = 80) => ({ x, y, size, opacity: 0.7 });

describe('scene touch layout (play.touch)', () => {
	it('is absent by default, so a scene without one saves byte-identical', () => {
		expect('touch' in normalizeScenePhysics({}).play).toBe(false);
		expect('touch' in normalizeScenePhysics({ play: { touch: { v: 1, items: {} } } }).play).toBe(false);
		expect('touch' in normalizeScenePhysics({ play: { touch: 'junk' } }).play).toBe(false);
	});

	it('keeps a valid layout and clamps it with the device rules', () => {
		const p = normalizeScenePhysics({ play: { touch: { v: 1, items: { stick: { x: 2, y: 0.5, size: 999 }, 'bad id!': item(0.1, 0.1) } } } }).play;
		expect(p.touch).toEqual({ v: 1, items: { stick: { x: 1, y: 0.5, size: 200, opacity: 0.7 } } });
	});

	it('round-trips through set / snapshot / restore, and null clears it', () => {
		setScenePhysics({ play: { touch: { v: 1, items: { stick: item(0.2, 0.8) } } } });
		const snap = scenePhysicsSnapshot();
		expect(snap?.play.touch.items.stick.x).toBe(0.2);
		setScenePhysics({ play: { touch: null } });
		expect(get(scenePlay).touch).toBeUndefined();
		scenePhysicsRestore(snap);
		expect(get(scenePlay).touch?.items.stick.y).toBe(0.8);
		scenePhysicsRestore(null);
		expect(get(scenePlay).touch).toBeUndefined();
	});
});

describe('layering: player > author > default, per item', () => {
	const base = defaultTouchLayout(spec, 800, 600).items;
	const fire = 'btn:' + spec.actions[0].id;
	it('no author and no player = the default (unchanged)', () => {
		expect(effectiveTouchLayout(spec, null, 800, 600, null).items).toEqual(base);
		expect(effectiveTouchLayout(spec, null, 800, 600).items).toEqual(base);
	});
	it('the author layout replaces the default where it places an item', () => {
		const out = effectiveTouchLayout(spec, null, 800, 600, { v: 1, items: { stick: item(0.3, 0.7) } }).items;
		expect(out.stick).toEqual(item(0.3, 0.7));
		expect(out[fire]).toEqual(base[fire]);
	});
	it("the player's own item wins over the author's; the rest keeps the author's", () => {
		const author = { v: 1, items: { stick: item(0.3, 0.7), [fire]: item(0.9, 0.9) } };
		const player = { v: 1, items: { stick: item(0.1, 0.5) } };
		const out = effectiveTouchLayout(spec, /** @type {any} */ (player), 800, 600, /** @type {any} */ (author)).items;
		expect(out.stick).toEqual(item(0.1, 0.5));
		expect(out[fire]).toEqual(item(0.9, 0.9));
	});
	it('an author item for a control the scene no longer has is ignored', () => {
		const out = effectiveTouchLayout(spec, null, 800, 600, { v: 1, items: { 'btn:gone': item(0.5, 0.5) } }).items;
		expect(Object.keys(out).sort()).toEqual(Object.keys(base).sort());
	});
});
