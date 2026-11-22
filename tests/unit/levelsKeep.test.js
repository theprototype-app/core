// 93 LP4 — the keep-across-levels list: what a hop carries. No list = the whole game state (21-F fork 3,
// unchanged); a list = only what it names; the kit score survives the load's kit reset; a module's own
// kept state (61's inventory) plugs in by name.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { captureKept, shapeCarriedGame, keptVarNames, registerKeptState, restoreOwnKept } from '../../src/lib/gameLevels/keep.js';
import { normalizeLevelsTable } from '../../src/lib/gameLevels/table.js';
import { kit, resetKit } from '../../src/lib/kit/runtime.js';
import { setScenePhysics, scenePhysicsRestore, scenePhysicsState_ } from '../../src/lib/scenePhysics.js';
import { levelsTravelCarry } from '../../src/lib/gameLevels/travel.js';
import { gameStateRestore, setGameVar, gameState } from '../../src/lib/gameState.js';

const T = (/** @type {any} */ keep) => normalizeLevelsTable({ list: [{ name: 'One', scene: 'One' }, { name: 'Two', scene: 'Two' }], keep });

describe('93 LP4 — keep list, pure', () => {
	it('no list carries everything (byte-identical to before); a list carries only what it names', () => {
		const game = { state: 'playing', round: 2, vars: { coins: 7, keys: 1, inventory: ['map'], timer: 30 }, varsAt: { coins: 1 } };
		expect(shapeCarriedGame(game, T([]))).toBe(game);
		const shaped = shapeCarriedGame(game, T(['var:coins', 'inventory']));
		expect(shaped.vars).toEqual({ coins: 7, inventory: ['map'] });
		expect(shaped.state).toBe('playing');
		expect(shaped.varsAt).toBeUndefined();
		expect(keptVarNames(T(['health', 'var:keys']))).toEqual(['keys', 'health']);
	});
	it('captures the kit score only when kept', () => {
		const score = { total: 12, players: { a: 5, b: 7 } };
		expect(captureKept(T(['var:coins']), { vars: { coins: 3 }, score }).score).toBeUndefined();
		expect(captureKept(T(['score']), { vars: {}, score })).toEqual({ vars: {}, score: { total: 12, players: { a: 5, b: 7 } } });
	});
	it('a module registers its own kept state under a keep name (inventory)', () => {
		let bag = ['sword'];
		const off = registerKeptState('inventory', { capture: () => [...bag], restore: (v) => (bag = v) });
		const kept = captureKept(T(['inventory']), { vars: {} });
		expect(kept.own).toEqual({ inventory: ['sword'] });
		bag = [];
		restoreOwnKept(kept);
		expect(bag).toEqual(['sword']);
		off();
	});
});

describe('93 LP4 — a hop through the travel carry', () => {
	beforeEach(() => {
		resetKit();
		scenePhysicsRestore({});
		gameStateRestore(null);
	});
	it('the score survives the load\'s kit reset; the table rides into a scene that has none', () => {
		setScenePhysics({ levels: T(['score', 'var:coins']) });
		kit.impls.score.add(9);
		setGameVar('coins', 4);
		setGameVar('timer', 30);
		const captured = levelsTravelCarry.capture();
		// the hop: the target scene has no table, the kit resets with the scene
		scenePhysicsRestore({});
		resetKit();
		expect(kit.impls.score.total()).toBe(0);
		const carried = levelsTravelCarry.shapeGame({ ...get(gameState) }, captured);
		expect(carried.vars).toEqual({ coins: 4 });
		levelsTravelCarry.restore(captured);
		expect(kit.impls.score.total()).toBe(9);
		expect(get(scenePhysicsState_).levels?.list.map((/** @type {any} */ r) => r.id)).toEqual(['one', 'two']);
		// kept score is not zeroed by the next level's new round
		expect(kit.doc()?.slices?.score?.autoReset).toBe(false);
	});
	it('a scene with its own table keeps its own', () => {
		setScenePhysics({ levels: T(['score']) });
		const captured = levelsTravelCarry.capture();
		setScenePhysics({ levels: { list: [{ name: 'Elsewhere' }] } });
		levelsTravelCarry.restore(captured);
		expect(get(scenePhysicsState_).levels?.list.map((/** @type {any} */ r) => r.id)).toEqual(['elsewhere']);
	});
});
