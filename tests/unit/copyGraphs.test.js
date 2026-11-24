// @ts-nocheck — test glue
// 92-correct row 2: a spawned copy runs its template's event flow, with "this object" = the copy.
import { describe, expect, test } from 'vitest';
import { instanceGraphs, eventPart } from '../../src/lib/copyGraphs.js';
import { instanceKey, instanceBaseId, instanceOwnerOf, registerCopy, unregisterCopy, extraCopyList, extraCopyFrom, onCopiesChanged } from '../../src/lib/copyRegistry.js';

const T = 'aaaaaaaa-0000-4000-8000-000000000001';
const C = 'cccccccc-0000-4000-8000-000000000002';
const n = (id, type, data = {}, graph = T) => ({ id, type, data: { type, ...data }, __graph: graph });
const e = (id, source, target, targetHandle) => ({ id, source, target, ...(targetHandle ? { targetHandle } : {}) });

const nodes = [
	n('click', 'onclick'),
	n('latch', 'latch'),
	n('not', 'not'),
	n('vis', 'visibility'),
	n('sel', 'objectselector', { selected: T }),
	n('spin', 'spin'), // always on: not part of the event flow
	n('speed', 'number'), // feeds the event part a value
	n('scene1', 'onclick', {}, 'scene')
];
const edges = [e('e1', 'click', 'latch', 'set'), e('e2', 'latch', 'not'), e('e3', 'not', 'vis'), e('e4', 'vis', 'sel'), e('e5', 'speed', 'vis', 'speed')];

describe('instanceGraphs', () => {
	test('the event part, renamed and owned by the copy', () => {
		const out = instanceGraphs([{ uuid: C, from: T }], nodes, edges);
		const ids = out.nodes.map((x) => x.id).sort();
		expect(ids).toEqual([`${C}~click`, `${C}~latch`, `${C}~not`, `${C}~sel`, `${C}~speed`, `${C}~vis`].sort());
		expect(out.nodes.every((x) => x.__graph === C && x.__instanceFrom === T)).toBe(true);
		// "this object": the selector that named the template names the copy
		expect(out.nodes.find((x) => x.id === `${C}~sel`).data.selected).toBe(C);
		// the template's own node data is untouched
		expect(nodes.find((x) => x.id === 'sel').data.selected).toBe(T);
		expect(out.edges.map((x) => [x.source, x.target])).toContainEqual([`${C}~click`, `${C}~latch`]);
		expect(out.edges.find((x) => x.id === `${C}~e1`).targetHandle).toBe('set');
	});
	test('an always-on effect is not instanced (a copy that did not move before does not now)', () => {
		const out = instanceGraphs([{ uuid: C, from: T }], nodes, edges);
		expect(out.nodes.some((x) => x.id === `${C}~spin`)).toBe(false);
	});
	test('a template with no flow, the scene graph, or a copy of itself makes nothing', () => {
		expect(instanceGraphs([{ uuid: C, from: 'nope' }], nodes, edges).nodes).toEqual([]);
		expect(instanceGraphs([{ uuid: C, from: 'scene' }], nodes, edges).nodes).toEqual([]);
		expect(instanceGraphs([{ uuid: T, from: T }], nodes, edges).nodes).toEqual([]);
	});
	test('a graph with no event node has no event part', () => {
		expect(eventPart([n('spin', 'spin')], []).size).toBe(0);
	});
	test('ids', () => {
		expect(instanceBaseId(`${C}~click`)).toBe('click');
		expect(instanceBaseId(`${C}~beh#hit`)).toBe('beh#hit');
		expect(instanceBaseId('click')).toBe('click');
		expect(instanceOwnerOf(`${C}~click`)).toBe(C);
		expect(instanceOwnerOf('click')).toBe(null);
	});
	test('instanceKey changes only with copies whose template has a flow', () => {
		const graphs = new Set([T]);
		expect(instanceKey([{ uuid: C, from: 'x' }], graphs)).toBe('');
		expect(instanceKey([{ uuid: C, from: T }], graphs)).not.toBe('');
	});
});

describe('kit entity copies', () => {
	test('register / unregister notify once per microtask', async () => {
		let calls = 0;
		const off = onCopiesChanged(() => calls++);
		registerCopy('k1', T);
		registerCopy('k2', T);
		await Promise.resolve();
		expect(calls).toBe(1);
		expect(extraCopyFrom('k1')).toBe(T);
		expect(extraCopyList().map((c) => c.uuid)).toEqual(['k1', 'k2']);
		unregisterCopy('k1');
		unregisterCopy('k2');
		await Promise.resolve();
		expect(calls).toBe(2);
		expect(extraCopyList()).toEqual([]);
		off();
	});
});
