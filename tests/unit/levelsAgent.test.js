// 93 — the agent's game_setup {portal, checkpoint, loading} planners (gameLevels/agentCore.js): what a call
// writes on the record, what it refuses, and the loading screen on the ONE Levels table.
import { describe, it, expect } from 'vitest';
import { planPortalRecord, planCheckpointRecord, planLevelObjectPlace, planLoading, describePortal } from '../../src/lib/gameLevels/agentCore.js';
import { normalizeLevelsTable } from '../../src/lib/gameLevels/table.js';
import { normalizePortal, BACK_TARGET } from '../../src/lib/gameLevels/objects.js';

const table = normalizeLevelsTable({ list: [{ name: 'Meadow', scene: 'Meadow' }, { name: 'Cave', scene: 'Cave', spawn: 'Entrance' }], keep: ['score'] });

describe('planPortalRecord', () => {
	it('a level by id or by name (any case) resolves to the row id and clears a stale scene', () => {
		expect(planPortalRecord({ level: 'cave' }, table)).toEqual({ patch: { level: 'cave', scene: null }, warnings: [] });
		expect(planPortalRecord({ level: 'CAVE' }, table)).toEqual({ patch: { level: 'cave', scene: null }, warnings: [] });
	});
	it('refuses an unknown level (naming the ids), a level with no table, and level + scene together', () => {
		expect(planPortalRecord({ level: 'Lava' }, table)).toEqual({ error: expect.stringContaining('meadow, cave') });
		expect(planPortalRecord({ level: 'cave' }, null)).toEqual({ error: expect.stringContaining('set_levels first') });
		expect(planPortalRecord({ level: 'cave', scene: 'Other' }, table)).toEqual({ error: expect.stringContaining('level OR scene') });
	});
	it('back: true targets where the player came from and drops scene / spawn', () => {
		expect(planPortalRecord({ back: true }, null)).toEqual({ patch: { level: BACK_TARGET, scene: null, spawn: null }, warnings: [] });
		expect(planPortalRecord({ back: true, level: 'cave' }, table)).toEqual({ error: expect.stringContaining('back: true') });
	});
	it('scene / spawn, transition, show and its own loading screen', () => {
		const p = planPortalRecord({ scene: 'Cave', spawn: 'Entrance', transition: 'iris', show: false, loading: { preset: 'logo', junk: 1 } }, null);
		expect(p).toEqual({ patch: { scene: 'Cave', spawn: 'Entrance', transition: 'iris', show: false, loading: { preset: 'logo', bar: { style: 'thin' } } }, warnings: [] });
		expect(planPortalRecord({ transition: 'wipe' }, null)).toEqual({ error: expect.stringContaining('fade | iris | card | none') });
	});
	it('a written patch normalizes into a record the portal runtime reads', () => {
		const p = /** @type {any} */ (planPortalRecord({ level: 'Cave', transition: 'card' }, table));
		const rec = normalizePortal({ ...normalizePortal({}), ...p.patch, scene: undefined });
		expect(rec).toEqual({ level: 'cave', transition: 'card', show: true });
		expect(describePortal(rec, table)).toBe('Walking through it goes to level Cave (card).');
		expect(describePortal(normalizePortal({}), table)).toContain('goes nowhere yet');
	});
});

describe('planCheckpointRecord / planLevelObjectPlace', () => {
	it('label and show; null clears the label', () => {
		expect(planCheckpointRecord({ label: ' Bridge ', show: false })).toEqual({ patch: { label: 'Bridge', show: false } });
		expect(planCheckpointRecord({ label: null })).toEqual({ patch: { label: null } });
	});
	it('a new one needs position or at; yaw turns it', () => {
		expect(planLevelObjectPlace({})).toEqual({ error: expect.stringContaining('position') });
		expect(planLevelObjectPlace({ position: [1, 2] })).toEqual({ error: expect.stringContaining('three numbers') });
		expect(planLevelObjectPlace({ position: [1, 0, 2], yaw: 1.5, name: 'To the cave' })).toEqual({ spec: { position: [1, 0, 2], rotation: [0, 1.5, 0], name: 'To the cave' } });
		expect(planLevelObjectPlace({ at: { ping: 'latest' }, face_user: true })).toEqual({ spec: { at: { ping: 'latest' }, face_user: true } });
	});
});

describe('planLoading', () => {
	it('needs a Levels table', () => {
		expect(planLoading({ preset: 'bar' }, null)).toEqual({ error: expect.stringContaining('set_levels first') });
	});
	it('merges into the table (fields left out stay), refuses an unknown preset, clear removes it', () => {
		const one = /** @type {any} */ (planLoading({ preset: 'image', image: 'https://example.com/a.png', tips: ['Jump with Space'] }, table)).table;
		expect(one.loading).toEqual({ preset: 'image', image: 'https://example.com/a.png', bar: { style: 'thin' }, tips: ['Jump with Space'] });
		expect(one.list).toEqual(table?.list);
		const two = /** @type {any} */ (planLoading({ title: 'Loading the cave' }, one)).table;
		expect(two.loading).toMatchObject({ preset: 'image', tips: ['Jump with Space'], title: 'Loading the cave' });
		expect(planLoading({ preset: 'spinner' }, table)).toEqual({ error: expect.stringContaining('fade | bar') });
		expect(/** @type {any} */ (planLoading({ clear: true }, two)).table.loading).toBeUndefined();
	});
});
