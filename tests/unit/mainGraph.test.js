// @ts-nocheck — partial fixtures (rows/graphs with only the fields under test)
// 36 (G1 phase 5): the Main graph migration (src/lib/mainGraph.js).
import { describe, test, expect } from 'vitest';
import { ensureMainGraph } from '../../src/lib/mainGraph.js';

const golf = () => ({
	scene: { nodes: [{ id: 'h1', type: 'hudtext', position: { x: 100, y: 40 }, data: {} }, { id: 'g1', type: 'golfinfo', position: { x: 300, y: 10 }, data: {} }], edges: [{ id: 'e', source: 'g1', target: 'h1' }] },
	'obj-1': { nodes: [{ id: 'o1', type: 'spin', position: { x: 0, y: 0 }, data: {} }], edges: [] },
	'obj-empty': { nodes: [], edges: [] }
});

describe('ensureMainGraph', () => {
	test('an old scene gains a code link per module and a link per object graph with nodes, left of the graph', () => {
		const { graphs, added } = ensureMainGraph(golf(), { modules: ['minigolf', { id: 'health' }] });
		expect(added).toEqual(['main-mod-minigolf', 'main-mod-health', 'main-obj-obj-1']);
		const main = graphs.scene.nodes;
		expect(main.slice(0, 3).map((n) => [n.type, n.data.module ?? n.data.flowUuid, n.data.main])).toEqual([
			['coderef', 'minigolf', 1],
			['coderef', 'health', 1],
			['objectflow', 'obj-1', 1]
		]);
		expect(main[0].position).toEqual({ x: 100 - 320, y: 10 });
		expect(main[1].position.y).toBe(120);
		expect(graphs.scene.edges).toHaveLength(1);
		expect(graphs['obj-1'].nodes.map((n) => n.id)).toEqual(['o1']); // object graphs untouched
	});
	test('idempotent: a migrated scene is returned unchanged (same object)', () => {
		const once = ensureMainGraph(golf(), { modules: ['minigolf'] }).graphs;
		const twice = ensureMainGraph(once, { modules: ['minigolf'] });
		expect(twice.added).toEqual([]);
		expect(twice.graphs).toBe(once);
	});
	test('a G1-authored Main graph (any data.main node) is left alone', () => {
		const g = golf();
		g.scene.nodes.push({ id: 'b', type: 'behaviour', position: { x: 0, y: 0 }, data: { main: 1 } });
		expect(ensureMainGraph(g, { modules: ['minigolf'] }).added).toEqual([]);
	});
	test('existing links are respected (a coderef for the module, an embed of the object graph)', () => {
		const g = golf();
		g.scene.nodes.push({ id: 'c', type: 'coderef', data: { module: 'minigolf' } }, { id: 'f', type: 'objectflow', data: { flowUuid: 'obj-1' } });
		expect(ensureMainGraph(g, { modules: ['minigolf'] }).added).toEqual([]);
	});
	test('nothing hidden = nothing added; no graphs + modules = a Main graph is created', () => {
		expect(ensureMainGraph({ scene: { nodes: [], edges: [] } }, {}).added).toEqual([]);
		const r = ensureMainGraph(null, { modules: ['towers'] });
		expect(r.graphs.scene.nodes.map((n) => n.id)).toEqual(['main-mod-towers']);
		expect(r.graphs.scene.nodes[0].position).toEqual({ x: 0, y: 0 });
	});
});
