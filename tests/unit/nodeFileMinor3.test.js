// 2.0-n3c (roadmap 2.0 N4a, formatMinor 3): the three additive file fields and their 101 F2 scene rows —
// saved custom node definitions, a per-node `v`, the Convert to code marker.
import { describe, test, expect } from 'vitest';
import { normalizeNodeDefs, convertedFromOk, nodeVersionOk, SCENE_FIELD_RULES, MAX_NODE_DEFS, MAX_NODE_DEF_CODE } from '../../src/lib/sceneSchema.js';
import { cleanFlowNode } from '../../src/lib/flowClean.js';
import { stampNodeVersions } from '../../src/lib/nodes/index.js';
import { registryErrors } from '../../src/lib/nodes/registry.js';
import { planConvert } from '../../src/lib/nodes/convertCode.js';

const def = (/** @type {any} */ over = {}) => ({ id: 'd1', name: 'Wobble', params: [{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }], code: 'object.position.y = 1;', ...over });

describe('formatMinor 3: schema rows', () => {
	test('one row per new field', () => {
		expect(Object.keys(SCENE_FIELD_RULES).sort()).toEqual(['node.data.convertedFrom', 'node.v', 'nodeDefs']);
	});

	test('nodeDefs: whole entries pass verbatim, absent = nothing, not a list = one row', () => {
		expect(normalizeNodeDefs([def(), def({ id: 'd2', params: [{ key: 'mode', kind: 'select', options: ['a', 'b'] }] })])).toEqual({
			defs: [def(), def({ id: 'd2', params: [{ key: 'mode', kind: 'select', options: ['a', 'b'] }] })],
			dropped: []
		});
		expect(normalizeNodeDefs(undefined)).toEqual({ defs: [], dropped: [] });
		expect(normalizeNodeDefs({ nope: 1 }).dropped).toEqual([{ path: 'nodeDefs', reason: 'not a list' }]);
	});

	test('nodeDefs: a broken entry is dropped with its path; a broken param drops alone', () => {
		const { defs, dropped } = normalizeNodeDefs([
			def({ id: '../x' }),
			def({ id: 'ok', params: [{ key: 'speed', kind: 'range', min: NaN }, { key: '__proto__!', kind: 'range' }, { key: 'k', kind: 'eval' }] }),
			def({ id: 'ok' }),
			def({ id: 'big', code: 'x'.repeat(MAX_NODE_DEF_CODE + 1) }),
			null
		]);
		expect(defs.map((d) => d.id)).toEqual(['ok']);
		expect(defs[0].params).toEqual([{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }]);
		expect(dropped.map((d) => d.path)).toEqual(['nodeDefs[0]', 'nodeDefs[1].params[1]', 'nodeDefs[1].params[2]', 'nodeDefs[2]', 'nodeDefs[3]', 'nodeDefs[4]']);
	});

	test('nodeDefs: capped', () => {
		const many = Array.from({ length: MAX_NODE_DEFS + 5 }, (_, i) => def({ id: 'd' + i }));
		const { defs, dropped } = normalizeNodeDefs(many);
		expect(defs.length).toBe(MAX_NODE_DEFS);
		expect(dropped.length).toBe(5);
	});

	test('node.v: integer 1..1e6', () => {
		for (const ok of [1, 2, 1e6]) expect(nodeVersionOk(ok)).toBe(true);
		for (const bad of [0, -1, 1.5, '2', null, NaN, 1e7]) expect(nodeVersionOk(bad)).toBe(false);
	});

	test('convertedFrom: what Convert writes passes; broken shapes do not', () => {
		const g = { nodes: [{ id: 'm', type: 'math', position: { x: 0, y: 0 }, data: { op: 'mul' } }], edges: [] };
		const plan = /** @type {any} */ (planConvert(g, 'm'));
		expect(convertedFromOk(plan.add.nodes[0].data.convertedFrom)).toBe(true);
		const good = plan.add.nodes[0].data.convertedFrom;
		for (const bad of [null, [], { ...good, type: 'Math!' }, { ...good, code: 3 }, { ...good, data: [] }, { ...good, v: 0 }, { ...good, wired: 'a' }, { ...good, target: '' }, { ...good, data: JSON.parse('{"__proto__": {"x": 1}}') }])
			expect(convertedFromOk(bad)).toBe(false);
	});
});

describe('formatMinor 3: the node boundary (cleanFlowNode) keeps good fields, drops broken ones', () => {
	test('a node without the fields is the SAME object (every node today)', () => {
		const n = { id: 'a', type: 'math', position: { x: 0, y: 0 }, data: { op: 'add' } };
		expect(cleanFlowNode(n)).toBe(n);
		const v = { ...n, v: 3 };
		expect(cleanFlowNode(v)).toBe(v);
	});
	test('a broken v / marker is dropped, the node and its other data stay', () => {
		const n = { id: 'a', type: 'script', position: { x: 0, y: 0 }, v: 'x', data: { code: 'return {out: 1}', convertedFrom: { type: 'math' } } };
		const out = cleanFlowNode(n);
		expect(out.v).toBeUndefined();
		expect(out.data).toEqual({ code: 'return {out: 1}' });
		expect(n.data.convertedFrom).toEqual({ type: 'math' }); // the input is not mutated
	});
});

describe('formatMinor 3: per-node v', () => {
	test('stamped only above 1, never over a node that has one', () => {
		const graphs = { scene: { nodes: [{ type: 'math' }, { type: 'spin' }, { type: 'spin', v: 1 }] } };
		stampNodeVersions(graphs, (t) => (t === 'spin' ? 2 : 1));
		expect(graphs.scene.nodes).toEqual([{ type: 'math' }, { type: 'spin', v: 2 }, { type: 'spin', v: 1 }]);
	});
	test('every core definition is v 1 today, so a save is byte-identical', () => {
		const graphs = { scene: { nodes: [{ type: 'math' }, { type: 'latch' }, { type: 'hudtext' }] } };
		expect(stampNodeVersions(structuredClone(graphs))).toEqual(graphs);
	});
	test('a definition v must be an integer >= 1 (the build check)', () => {
		const whole = { type: 'probe', label: 'Probe', defaults: {}, sockets: { out: 'number' }, card: 'NumberNode', eval: () => 1 };
		expect(registryErrors([{ group: 'P', nodes: [/** @type {any} */ ({ ...whole, v: 2 })] }])).toEqual([]);
		expect(registryErrors([{ group: 'P', nodes: [/** @type {any} */ ({ ...whole, v: 0 })] }]).join()).toMatch(/v must be/);
	});
});

describe('formatMinor 3: v heals through a resync snapshot', () => {
	test('a node we already hold takes the snapshot v, so the nodesync hashes converge', async () => {
		const { restoreGraphs, flowGraphs } = await import('../../src/stores/flowStore.js');
		const { applyNodesSnapshot, graphHash } = await import('../../src/lib/nodesHandler.js');
		const { get } = await import('svelte/store');
		const node = { id: 'n2', type: 'number', position: { x: 0, y: 0 }, data: { type: 'number', value: 4 } };
		restoreGraphs({ scene: { nodes: [node], edges: [] } });
		const without = graphHash();
		applyNodesSnapshot([], [], { scene: { nodes: [{ ...node, v: 2 }], edges: [] } });
		expect(get(flowGraphs).scene.nodes[0].v).toBe(2);
		expect(graphHash()).not.toBe(without);
		restoreGraphs({ scene: { nodes: [{ ...node, v: 2 }], edges: [] } });
		const fresh = graphHash();
		restoreGraphs({ scene: { nodes: [node], edges: [] } });
		applyNodesSnapshot([], [], { scene: { nodes: [{ ...node, v: 2 }], edges: [] } });
		expect(graphHash()).toBe(fresh);
	});
});

describe('a load that changed a node type converges', () => {
	test('a peer holding the built-in takes the snapshot\'s script whole (type and data)', async () => {
		const { restoreGraphs, flowGraphs } = await import('../../src/stores/flowStore.js');
		const { applyNodesSnapshot, graphHash } = await import('../../src/lib/nodesHandler.js');
		const { get } = await import('svelte/store');
		const builtin = { id: 'm', type: 'math', position: { x: 0, y: 0 }, data: { type: 'math', op: 'mul', a: 0, b: 0 } };
		const script = { id: 'm', type: 'script', position: { x: 0, y: 0 }, data: { type: 'script', code: 'return { out: 1 };', outputs: [{ name: 'out', type: 'number' }] } };
		restoreGraphs({ scene: { nodes: [script], edges: [] } });
		const want = graphHash();
		restoreGraphs({ scene: { nodes: [builtin], edges: [] } });
		applyNodesSnapshot([], [], { scene: { nodes: [script], edges: [] } });
		const n = get(flowGraphs).scene.nodes[0];
		expect(n.type).toBe('script');
		expect(n.data.op).toBeUndefined();
		expect(graphHash()).toBe(want);
	});
});

describe('a merged node gets data.type the way a restored one does', () => {
	test('a file node without data.type hashes the same on the loader and on a peer that merged it', async () => {
		const { restoreGraphs } = await import('../../src/stores/flowStore.js');
		const { applyNodesSnapshot, graphHash } = await import('../../src/lib/nodesHandler.js');
		const raw = { id: 'q', type: 'number', position: { x: 0, y: 0 }, data: { value: 2 } };
		restoreGraphs({ scene: { nodes: [raw], edges: [] } });
		const loader = graphHash();
		restoreGraphs({ scene: { nodes: [], edges: [] } });
		applyNodesSnapshot([], [], { scene: { nodes: [raw], edges: [] } });
		expect(graphHash()).toBe(loader);
		restoreGraphs({ scene: { nodes: [{ ...raw, type: 'math', data: { type: 'math', op: 'add' } }], edges: [] } });
		applyNodesSnapshot([], [], { scene: { nodes: [raw], edges: [] } });
		expect(graphHash()).toBe(loader);
	});
});
