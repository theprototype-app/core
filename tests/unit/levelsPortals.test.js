// 93 LP1 / LP2 / LP3 / LP5 — portals, the loading screen, checkpoints, saved progress. The pure halves:
// the records at the boundary, the trigger box, where a portal goes, the loading bar's REAL progress and its
// never-flicker rule, the save's upgrades + its 256 KB cap, and the kit's checkpoint calls.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';
import { normalizePortal, normalizeCheckpoint, insideTrigger, portalGeometry, checkpointGeometry, BACK_TARGET } from '../../src/lib/gameLevels/objects.js';
import { portalTarget } from '../../src/lib/gameLevels/play.js';
import { normalizeLoading, loadingProgress, packTracker, withLoadingScreen, levelLoading, MIN_MS } from '../../src/lib/gameLevels/loading.js';
import { noteSceneLoaded, resetPreloads, packPathsOf } from '../../src/lib/gameLevels/preload.js';
import { upgradeSave, encodeSave, saveKey, SAVE_VERSION, SAVE_CAP } from '../../src/lib/gameLevels/save.js';
import { normalizeLevelsTable } from '../../src/lib/gameLevels/table.js';
import { setScenePhysics, scenePhysicsRestore } from '../../src/lib/scenePhysics.js';
import { customGeometryBuilders } from '../../src/lib/customGeometries.js';
import { kit, resetKit } from '../../src/lib/kit/runtime.js';
import spec from '../../src/lib/kit/levels.spec.js';

const table = normalizeLevelsTable({
	list: [
		{ id: 'one', name: 'One', scene: 'Meadow', spawn: 'Start' },
		{ id: 'two', name: 'Two', scene: 'Cave', goal: 'Find the key' }
	],
	keep: ['score', 'var:coins']
});

describe('93 LP1 — portal and checkpoint records', () => {
	it('normalizes a portal: unknown keys dropped, a fade by default, shown by default', () => {
		expect(normalizePortal({ level: 'two', evil: 1, transition: 'warp' })).toEqual({ level: 'two', transition: 'fade', show: true });
		expect(normalizePortal({ scene: 'Cave', spawn: 'Door', transition: 'iris', show: false })).toEqual({ scene: 'Cave', spawn: 'Door', transition: 'iris', show: false });
		expect(normalizeCheckpoint({ label: 'Halfway', x: 1 })).toEqual({ show: true, label: 'Halfway' });
	});
	it('both kinds are /create geometries, one material each (vertex colours survive autosave)', () => {
		expect(typeof customGeometryBuilders.Portal).toBe('function');
		expect(typeof customGeometryBuilders.Checkpoint).toBe('function');
		for (const g of [portalGeometry(), checkpointGeometry()]) {
			expect(g.getAttribute('color')).toBeTruthy();
			expect(g.groups.length).toBeLessThanOrEqual(1);
		}
	});
	it('the trigger box follows the object (moved, turned)', () => {
		const portal = new THREE.Mesh(portalGeometry());
		portal.position.set(10, 0, -4);
		portal.rotation.y = Math.PI / 2;
		portal.updateMatrixWorld(true);
		expect(insideTrigger(portal, 'portal', new THREE.Vector3(10, 1, -4))).toBe(true);
		expect(insideTrigger(portal, 'portal', new THREE.Vector3(10, 1, -4.85))).toBe(true); // along its width (now z)
		expect(insideTrigger(portal, 'portal', new THREE.Vector3(10.7, 1, -4))).toBe(false); // through its depth (now x)
		expect(insideTrigger(portal, 'portal', new THREE.Vector3(10, 3.2, -4))).toBe(false);
	});
	it('where a portal goes: a level row (its own spawn wins), a scene, Back with nowhere to go = nothing', () => {
		setScenePhysics({ levels: table });
		expect(portalTarget({ level: 'two' })).toMatchObject({ level: 'two', scene: 'Cave', spawn: '', title: 'Two', goal: 'Find the key' });
		expect(portalTarget({ level: 'one', spawn: 'Ledge' })).toMatchObject({ level: 'one', scene: 'Meadow', spawn: 'Ledge' });
		expect(portalTarget({ level: 'gone' })).toBeNull();
		expect(portalTarget({ scene: 'Cave' })).toMatchObject({ scene: 'Cave' });
		expect(portalTarget({ level: BACK_TARGET })).toBeNull();
		expect(portalTarget(null)).toBeNull();
		scenePhysicsRestore(null);
	});
});

describe('93 LP2 — the loading screen', () => {
	beforeEach(() => resetPreloads());
	it('normalizes a config: known keys only, colours validated, a bar by default', () => {
		const c = normalizeLoading({ preset: 'image', background: '#102030', textColor: 'red', tips: ['Jump!', '', 3], madeWith: true, bar: { style: 'thick', color: '#ff0' } });
		expect(c).toEqual({ preset: 'image', background: '#102030', bar: { style: 'thick', color: '#ff0' }, tips: ['Jump!'] });
		expect(normalizeLoading(null).preset).toBe('bar');
		expect(JSON.stringify(normalizeLoading({ madeWith: 'x', credit: 'Made with theprototype' }))).not.toMatch(/Made with/);
	});
	it('progress comes from real sources, in order: scene bytes, objects built, pack bytes', () => {
		const none = { loaded: 0, total: 0, pending: 0 };
		expect(loadingProgress({ preload: { bytes: 50, total: 100 }, job: null, built: false, packs: none })).toBeCloseTo(0.15);
		expect(loadingProgress({ preload: null, job: { done: 5, total: 10 }, built: false, packs: none })).toBeCloseTo(0.5);
		expect(loadingProgress({ preload: null, job: null, built: true, packs: { loaded: 300, total: 600, pending: 2 } })).toBeCloseTo(0.85);
		expect(loadingProgress({ preload: null, job: null, built: true, packs: none })).toBe(1);
	});
	it('the pack tracker counts a file that loadStates forgot as fully loaded', () => {
		const t = packTracker();
		expect(t.sample([{ url: 'a.glb', phase: 'fetching', loaded: 100, total: 400 }])).toEqual({ loaded: 100, total: 400, pending: 1 });
		expect(t.sample([])).toEqual({ loaded: 400, total: 400, pending: 0 });
	});
	it('finds the pack files a scene places (what the preload warms)', () => {
		const payload = { objects: [{ object: { userData: { packRef: { path: 'nature/tree.glb' } }, children: [{ userData: { animRef: { path: 'anim/walk.glb' } } }] } }] };
		expect(packPathsOf(payload).sort()).toEqual(['anim/walk.glb', 'nature/tree.glb']);
	});
	it('never flickers: a fast hop shows nothing, a slow one shows at least MIN_MS, a loaded scene skips it', async () => {
		/** @type {boolean[]} */
		const seen = [];
		const off = levelLoading.subscribe((s) => seen.push(s.active));
		expect(await withLoadingScreen('Fast', async () => true)).toBe(true);
		expect(seen.includes(true)).toBe(false);
		const t0 = Date.now();
		expect(await withLoadingScreen('Slow', () => new Promise((r) => setTimeout(() => r(true), 220)))).toBe(true);
		expect(seen.includes(true)).toBe(true);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(MIN_MS - 5);
		expect(get(levelLoading).active).toBe(false);
		// a second trip to a loaded scene: no screen even when slow
		seen.length = 0;
		noteSceneLoaded('Slow');
		await withLoadingScreen('Slow', () => new Promise((r) => setTimeout(() => r(true), 220)));
		expect(seen.includes(true)).toBe(false);
		off();
	});
});

describe('93 LP5 — saved progress', () => {
	const save = (/** @type {any} */ over = {}) => ({ v: 1, game: 'g', level: 'two', scene: 'Cave', point: { kind: 'checkpoint', name: 'CP', spawn: { position: [1, 0, 2], yaw: 0.5 } }, kept: { vars: { coins: 4, junk: 1 }, score: { total: 9, players: { a: 9 } } }, at: 5, ...over });
	it('a current save loads as it is (minus what the game no longer keeps)', () => {
		const { save: s, notes } = upgradeSave(save(), table);
		expect(s.level).toBe('two');
		expect(s.point.spawn).toEqual({ position: [1, 0, 2], yaw: 0.5 });
		expect(s.kept.vars).toEqual({ coins: 4 });
		expect(s.kept.score.total).toBe(9);
		expect(notes).toContain('variable "junk" is no longer kept');
	});
	it('a REMOVED level falls back to the first level, its checkpoint dropped', () => {
		const { save: s, notes } = upgradeSave(save({ level: 'bonus' }), table);
		expect(s.level).toBe('one');
		expect(s.scene).toBe('Meadow');
		expect(s.point).toBeNull();
		expect(notes.join(' ')).toMatch(/bonus/);
	});
	it('an old (v0) save upgrades; a newer one is not used; garbage is nothing', () => {
		const { save: s } = upgradeSave({ level: 'one', checkpoint: { name: 'CP', spawn: { position: [0, 1, 0] } }, vars: { coins: 2 } }, table);
		expect(s.v).toBe(SAVE_VERSION);
		expect(s.point.spawn.position).toEqual([0, 1, 0]);
		expect(s.kept.vars).toEqual({ coins: 2 });
		expect(upgradeSave({ v: SAVE_VERSION + 1, level: 'one' }, table).save).toBeNull();
		expect(upgradeSave('nope', table).save).toBeNull();
	});
	it('a save over 256 KB is refused with a sentence the author can act on', () => {
		expect(encodeSave(save()).ok).toBe(true);
		const huge = encodeSave(save({ kept: { vars: { blob: 'x'.repeat(SAVE_CAP) } } }));
		expect(huge.ok).toBe(false);
		expect(/** @type {any} */ (huge).reason).toMatch(/256 KB.*Keep fewer/);
		expect(saveKey('My Game!')).toBe('tp:levels-save:MyGame');
	});
});

describe('93 LP3 — the kit checkpoint calls', () => {
	beforeEach(() => resetKit());
	it('Back to checkpoint / New game / Last checkpoint reach the app host, and answer safely without one', () => {
		const names = spec.calls.map((c) => c.name);
		expect(names).toEqual(expect.arrayContaining(['respawn', 'newGame', 'checkpoint']));
		const levels = /** @type {any} */ (kit.impls.levels);
		levels.extra.attachProgress(null);
		expect(levels.respawn()).toBe(false);
		expect(levels.checkpoint()).toBe('');
		const calls = /** @type {string[]} */ ([]);
		levels.extra.attachProgress({ respawn: () => calls.push('r'), newGame: () => calls.push('n'), checkpoint: () => 'CP 2' });
		expect(kit.runNodeAction('kit-levels-respawn', {})).toBe(true);
		expect(kit.runNodeAction('kit-levels-newGame', {})).toBe(true);
		expect(kit.evalNodeValue('kit-levels-checkpoint', {})).toBe('CP 2');
		expect(calls).toEqual(['r', 'n']);
		levels.extra.attachProgress(null);
	});
});
