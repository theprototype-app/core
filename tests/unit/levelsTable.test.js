// 93 LP0 — THE LEVELS TABLE: one table (the scene-settings singleton's `levels` block) that the
// editor panel, the Kit: Levels nodes (select / next / complete) and the agent's
// `game_setup {levels}` all read and write. 78 F19 lives here: nodes work with no module code.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { normalizeLevelsTable, levelRow, nextLevelId, rowForScene, kitLevelsDef, keepItems } from '../../src/lib/gameLevels/table.js';
import { scenePhysicsState_, setScenePhysics, scenePhysicsSnapshot, normalizeScenePhysics, scenePhysicsRestore } from '../../src/lib/scenePhysics.js';
import { kit, resetKit } from '../../src/lib/kit/runtime.js';
import { syncKitLevels, sceneLevelsTable } from '../../src/lib/gameLevels/runtime.js';

const TABLE = {
	list: [
		{ id: 'meadow', name: 'Meadow', scene: 'Meadow', goal: 'Find the key' },
		{ name: 'Cave', spawn: 'Cave entrance' },
		{ id: 'meadow', name: 'duplicate id is dropped' },
		{ name: '' }
	],
	keep: ['score', 'var:coins', 'bogus', 'score', 'inventory']
};

describe('93 LP0 — normalizeLevelsTable', () => {
	it('absent / empty is null (an old scene stays byte-identical)', () => {
		expect(normalizeLevelsTable(undefined)).toBe(null);
		expect(normalizeLevelsTable({})).toBe(null);
		expect(normalizeLevelsTable({ list: [] })).toBe(null);
		expect(normalizeScenePhysics({}).levels).toBeUndefined();
	});
	it('rows get stable ids, duplicates and nameless rows drop, keep is cleaned', () => {
		const t = /** @type {any} */ (normalizeLevelsTable(TABLE));
		expect(t.list.map((/** @type {any} */ r) => r.id)).toEqual(['meadow', 'cave']);
		expect(t.list[0]).toMatchObject({ id: 'meadow', name: 'Meadow', scene: 'Meadow', goal: 'Find the key' });
		expect(t.list[1]).toMatchObject({ id: 'cave', name: 'Cave', spawn: 'Cave entrance' });
		expect(t.keep).toEqual(['score', 'var:coins', 'inventory']);
		expect(t.unlock).toBe('all');
		expect(keepItems(t)).toEqual({ score: true, inventory: true, health: false, vars: ['coins'] });
	});
	it('order drives next; a scene finds its row', () => {
		const t = normalizeLevelsTable(TABLE);
		expect(nextLevelId(t, 'meadow')).toBe('cave');
		expect(nextLevelId(t, 'cave')).toBe(null);
		expect(levelRow(t, 'cave')?.name).toBe('Cave');
		expect(rowForScene(t, 'Meadow')?.id).toBe('meadow');
		expect(kitLevelsDef(t)).toMatchObject({ id: 'scene', unlock: 'all', list: [{ id: 'meadow', label: 'Meadow' }, { id: 'cave', label: 'Cave' }] });
	});
	it('rides the scene-settings singleton: saved, restored, absent = reset', () => {
		setScenePhysics({ levels: TABLE });
		expect(get(scenePhysicsState_).levels.list).toHaveLength(2);
		expect(scenePhysicsSnapshot()?.levels?.list).toHaveLength(2);
		scenePhysicsRestore({});
		expect(get(scenePhysicsState_).levels).toBeUndefined();
	});
});

describe('93 LP0 (78 F19) — the Kit: Levels nodes drive the scene table with no module code', () => {
	beforeEach(() => {
		resetKit();
		scenePhysicsRestore({});
	});
	it('the table defines kit.levels; Next / Go to level / Finish level work from nodes', () => {
		setScenePhysics({ levels: TABLE });
		syncKitLevels();
		const L = kit.impls.levels;
		expect(L.extra.table().map((/** @type {any} */ r) => r.id)).toEqual(['meadow', 'cave']);
		kit.runNodeAction('kit-levels-select', { level: 'meadow' }, { rid: 'node:a:1' });
		expect(L.current()).toBe('meadow');
		kit.runNodeAction('kit-levels-next', {}, { rid: 'node:b:2' });
		expect(L.current()).toBe('cave');
		expect(L.currentLabel()).toBe('Cave');
		const done = kit.runNodeAction('kit-levels-complete', { won: true, score: 5 }, { rid: 'node:c:3' });
		expect(done).toMatchObject({ ok: true });
	});
	it('an edit to the table (the agent, the panel) is what the nodes see next', () => {
		setScenePhysics({ levels: TABLE });
		syncKitLevels();
		setScenePhysics({ levels: { list: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }] } });
		syncKitLevels();
		expect(sceneLevelsTable()?.list.map((/** @type {any} */ r) => r.id)).toEqual(['one', 'two', 'three']);
		kit.runNodeAction('kit-levels-select', { level: 'two' }, { rid: 'node:a:4' });
		kit.runNodeAction('kit-levels-next', {}, { rid: 'node:b:5' });
		expect(kit.impls.levels.current()).toBe('three');
	});
	it('removing the table undefines it (the nodes refuse with a reason)', () => {
		setScenePhysics({ levels: TABLE });
		syncKitLevels();
		setScenePhysics({ levels: null });
		syncKitLevels();
		expect(kit.impls.levels.extra.table()).toEqual([]);
		expect(kit.runNodeAction('kit-levels-next', {}, { rid: 'node:z:9' })).toMatchObject({ ok: false });
	});
});
