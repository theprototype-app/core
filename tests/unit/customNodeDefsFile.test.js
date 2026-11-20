// 2.0-n3c step 4: custom node definitions had NO save path (customNodeDefs was a session store), so a
// scene reloaded alone kept its instances and lost what they run. Counterfactual: on v1.68.0 there is no
// customNodeDefsSnapshot / customNodeDefsRestore and buildSessionPayload writes no `nodeDefs`.
import { describe, test, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { customNodeDefs } from '../../src/stores/flowStore.js';
import { customNodeDefsSnapshot, customNodeDefsRestore, applyNodeDef } from '../../src/lib/customNodes.js';

const def = (/** @type {string} */ id, code = 'object.position.y = 1;') => ({ id, name: 'N ' + id, params: [{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }], code });

describe('custom node definitions ride in the scene file', () => {
	beforeEach(() => customNodeDefs.set([]));
	test('no definitions = no field (a scene without one saves byte-identical)', () => {
		expect(customNodeDefsSnapshot()).toBeNull();
	});
	test('snapshot -> restore into an empty session brings every definition back', () => {
		applyNodeDef(def('a'));
		applyNodeDef(def('b'));
		const saved = JSON.parse(JSON.stringify(customNodeDefsSnapshot()));
		customNodeDefs.set([]);
		expect(customNodeDefsRestore(saved)).toEqual([]);
		expect(get(customNodeDefs).map((d) => d.id)).toEqual(['a', 'b']);
	});
	test('a load MERGES by id: the file wins for its ids, a room definition it lacks stays', () => {
		applyNodeDef(def('room'));
		applyNodeDef(def('a', 'old'));
		customNodeDefsRestore([def('a', 'new')]);
		const defs = get(customNodeDefs);
		expect(defs.map((d) => d.id).sort()).toEqual(['a', 'room']);
		expect(defs.find((d) => d.id === 'a')?.code).toBe('new');
	});
	test('only the definitions a saved node RUNS are saved (a module seed nobody uses is not scene data)', () => {
		applyNodeDef(def('mod-hello-bobble'));
		expect(customNodeDefsSnapshot({ scene: { nodes: [{ type: 'math', data: {} }] } })).toBeNull();
		applyNodeDef(def('mine'));
		const graphs = { scene: { nodes: [{ type: 'customnode', data: { defId: 'mine' } }] }, 'obj-1': { nodes: [{ type: 'customnode', data: { defId: 'mod-hello-bobble' } }] } };
		expect(customNodeDefsSnapshot(graphs)?.map((d) => d.id).sort()).toEqual(['mine', 'mod-hello-bobble']);
		expect(customNodeDefsSnapshot({ scene: { nodes: [{ type: 'customnode', data: { defId: 'mine' } }] } })?.map((d) => d.id)).toEqual(['mine']);
	});
	test('a broken entry is dropped and reported, the rest loads', () => {
		const dropped = customNodeDefsRestore([def('ok'), { id: 'x' }, 'nope']);
		expect(get(customNodeDefs).map((d) => d.id)).toEqual(['ok']);
		expect(dropped.map((d) => d.path)).toEqual(['nodeDefs[1]', 'nodeDefs[2]']);
	});
	test('an older file (no field) leaves the session alone', () => {
		applyNodeDef(def('room'));
		expect(customNodeDefsRestore(undefined)).toEqual([]);
		expect(get(customNodeDefs).map((d) => d.id)).toEqual(['room']);
	});
});
