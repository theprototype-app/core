// @ts-nocheck — plain fixture graphs
// 36 U11 / N1: groups and notes are a VIEW over a graph whose wires never change.
import { describe, it, expect } from 'vitest';
import {
	parentMap,
	descendantsOf,
	representative,
	computeGroupIO,
	graphView,
	makeGroup,
	copyPayload,
	instantiatePayload,
	arrange,
	frameRect,
	edgeId,
	ioHandle,
	parseIoHandle,
	pathTo,
	GROUP_IN,
	GROUP_OUT,
	isEditorOnly
} from '../../src/lib/nodeGroups.js';

const n = (id, x = 0, y = 0, extra = {}) => ({ id, type: 'number', position: { x, y }, data: { label: id.toUpperCase() }, ...extra });
const e = (s, sh, t, th) => ({ id: edgeId(s, sh, t, th), source: s, sourceHandle: sh, target: t, targetHandle: th });
const ser = (x) => JSON.parse(JSON.stringify(x));

// C -> A.in   A.out -> B.in   B.out -> D
const base = () => {
	const nodes = [n('c', 0, 0), n('a', 200, 0), n('b', 400, 0), n('d', 600, 0)];
	const edges = [e('c', null, 'a', 'in'), e('a', 'out', 'b', 'in'), e('b', 'out', 'd', null)];
	return { nodes, edges };
};

describe('groups (N1)', () => {
	it('a group lists the wires that cross its boundary as named sockets', () => {
		const { nodes, edges } = base();
		const g = makeGroup(nodes, edges, ['a', 'b'], 'g');
		expect(g.type).toBe('group');
		expect(g.data.children).toEqual(['a', 'b']);
		expect(g.data.inputs).toEqual([{ key: 'a|in', name: 'in', type: 'any', to: ['a', 'in'] }]);
		expect(g.data.outputs).toEqual([{ key: 'b|out', name: 'out', type: 'any', from: ['b', 'out'] }]);
	});

	it('at the top level the members are hidden and their wires re-route to the group', () => {
		const { nodes, edges } = base();
		const g = makeGroup(nodes, edges, ['a', 'b'], 'g');
		const all = [...nodes, g];
		const view = graphView(all, edges, null);
		expect([...view.visible].sort()).toEqual(['c', 'd', 'g']);
		const pairs = view.proxies.map((p) => [p.source, p.sourceHandle, p.target, p.targetHandle]);
		expect(pairs).toContainEqual(['c', null, 'g', ioHandle('i', 'a', 'in')]);
		expect(pairs).toContainEqual(['g', ioHandle('o', 'b', 'out'), 'd', null]);
		expect(pairs.length).toBe(2); // a->b is inside the collapsed group: not drawn
		expect(view.direct.size).toBe(0);
	});

	it('inside the group, boundary wires run to the two pseudo-nodes', () => {
		const { nodes, edges } = base();
		const g = makeGroup(nodes, edges, ['a', 'b'], 'g');
		const view = graphView([...nodes, g], edges, 'g');
		expect([...view.visible].sort()).toEqual(['a', 'b']);
		const pairs = view.proxies.map((p) => [p.source, p.sourceHandle, p.target, p.targetHandle]);
		expect(pairs).toContainEqual([GROUP_IN, ioHandle('i', 'a', 'in'), 'a', 'in']);
		expect(pairs).toContainEqual(['b', 'out', GROUP_OUT, ioHandle('o', 'b', 'out')]);
		expect(view.direct.has(edgeId('a', 'out', 'b', 'in'))).toBe(true);
	});

	it('a socket handle round-trips to the inner endpoint it stands for', () => {
		expect(parseIoHandle(ioHandle('i', 'node-1', 'speed'))).toEqual({ dir: 'i', node: 'node-1', socket: 'speed' });
		expect(parseIoHandle(ioHandle('o', 'n2', null))).toEqual({ dir: 'o', node: 'n2', socket: null });
		expect(parseIoHandle('speed')).toBe(null);
	});

	it('nested groups: an outer group is represented by itself, inner nodes by their group', () => {
		const { nodes, edges } = base();
		const g = makeGroup(nodes, edges, ['a', 'b'], 'g');
		const all1 = [...nodes, g];
		const g2 = makeGroup(all1, edges, ['g', 'c'], 'g2');
		const all = [...all1, g2];
		const parents = parentMap(all);
		expect(representative(parents, 'a', null)).toBe('g2');
		expect(representative(parents, 'a', 'g2')).toBe('g');
		expect(representative(parents, 'a', 'g')).toBe('a');
		expect(representative(parents, 'd', 'g')).toBe(null);
		expect(pathTo(parents, 'g')).toEqual(['g2', 'g']);
		expect([...descendantsOf(parents, 'g2')].sort()).toEqual(['a', 'b', 'c', 'g']);
		// the outer group's IO names the DEEP endpoint (b inside g inside g2)
		expect(g2.data.outputs.map((o) => o.from)).toEqual([['b', 'out']]);
		expect(g2.data.inputs).toEqual([]); // c moved inside with a
		const top = graphView(all, edges, null);
		expect([...top.visible].sort()).toEqual(['d', 'g2']);
		expect(top.proxies.map((p) => [p.source, p.sourceHandle, p.target])).toEqual([['g2', ioHandle('o', 'b', 'out'), 'd']]);
		const mid = graphView(all, edges, 'g2');
		expect([...mid.visible].sort()).toEqual(['c', 'g']);
		const pairs = mid.proxies.map((p) => [p.source, p.sourceHandle, p.target, p.targetHandle]);
		expect(pairs).toContainEqual(['c', null, 'g', ioHandle('i', 'a', 'in')]);
		expect(pairs).toContainEqual(['g', ioHandle('o', 'b', 'out'), GROUP_OUT, ioHandle('o', 'b', 'out')]);
	});

	it('IO reconcile keeps renamed sockets and their order, adds new crossings, drops dead ones', () => {
		const { nodes, edges } = base();
		const g = makeGroup(nodes, edges, ['a', 'b'], 'g');
		g.data.inputs[0].name = 'Power';
		const more = [...edges, e('d', 'x', 'a', 'gain')];
		const io = computeGroupIO([...nodes, g], more, g);
		expect(io.inputs.map((i) => i.name)).toEqual(['Power', 'gain']);
		// the wire into a.in goes away: the socket STAYS (an unconnected socket is kept)
		const fewer = more.filter((x) => x.target !== 'a' || x.targetHandle !== 'in');
		expect(computeGroupIO([...nodes, g], fewer, g).inputs.map((i) => i.key)).toEqual(['a|in', 'a|gain']);
		// the inner node leaves the graph: its socket is dropped
		const noA = nodes.filter((x) => x.id !== 'a');
		const noAEdges = fewer.filter((x) => x.source !== 'a' && x.target !== 'a'); // a delete takes its wires
		expect(computeGroupIO([...noA, g], noAEdges, g).inputs).toEqual([]);
	});

	it('a corrupt document (cycle, double parent) still resolves deterministically', () => {
		const a = { id: 'g1', type: 'group', position: { x: 0, y: 0 }, data: { children: ['g2', 'x'] } };
		const b = { id: 'g2', type: 'group', position: { x: 0, y: 0 }, data: { children: ['g1', 'x'] } };
		const parents = parentMap([a, b, n('x')]);
		expect(parents.get('x')).toBe('g1'); // first group by id wins
		expect(parents.has('g1') && parents.has('g2')).toBe(false); // the cycle is broken
	});

	it('a graph without groups or notes is drawn exactly as stored', () => {
		const { nodes, edges } = base();
		const view = graphView(nodes, edges, null);
		expect([...view.visible].sort()).toEqual(['a', 'b', 'c', 'd']);
		expect(view.proxies).toEqual([]);
		expect(view.direct.size).toBe(3);
		expect(nodes.some(isEditorOnly)).toBe(false);
	});
});

describe('copy / paste / duplicate', () => {
	it('copies a group with its members and only the inner wires, then remaps every id', () => {
		const { nodes, edges } = base();
		const g = makeGroup(nodes, edges, ['a', 'b'], 'g');
		const all = [...nodes, g];
		const payload = copyPayload(all, edges, ['g'], ser, ser);
		expect(payload.nodes.map((x) => x.id).sort()).toEqual(['a', 'b', 'g']);
		expect(payload.edges.map((x) => x.id)).toEqual([edgeId('a', 'out', 'b', 'in')]);
		let k = 0;
		const out = instantiatePayload(payload, () => 'n' + ++k, { at: { x: 1000, y: 500 } });
		const ng = out.nodes.find((x) => x.type === 'group');
		const na = out.idMap.a;
		const nb = out.idMap.b;
		expect(ng.data.children.sort()).toEqual([na, nb].sort());
		expect(ng.data.inputs[0].to).toEqual([na, 'in']);
		expect(ng.data.inputs[0].key).toBe(na + '|in');
		expect(out.edges[0]).toMatchObject({ id: edgeId(na, 'out', nb, 'in'), source: na, target: nb });
		// the group (the only top-level node) lands at the paste point
		expect(ng.position).toEqual({ x: 1000, y: 500 });
		// nothing of the original survives in the copy
		expect(JSON.stringify({ nodes: out.nodes, edges: out.edges })).not.toMatch(/"(a|b|g)"/);
	});

	it('a frame note keeps its frame across a copy', () => {
		const note = { id: 'note', type: 'note', position: { x: 0, y: 0 }, data: { title: 'T', text: '', color: 'yellow', frame: ['a'] } };
		const payload = copyPayload([n('a'), note], [], ['note', 'a'], ser, ser);
		const out = instantiatePayload(payload, (() => { let i = 0; return () => 'z' + ++i; })(), { offset: { x: 30, y: 30 } });
		const nn = out.nodes.find((x) => x.type === 'note');
		expect(nn.data.frame).toEqual([out.idMap.a]);
		expect(nn.position).toEqual({ x: 30, y: 30 });
	});
});

describe('align / distribute / frame', () => {
	const a = n('a', 10, 100);
	const b = n('b', 50, 0);
	const c = n('c', 300, 30);
	it('column lines up left edges, row top edges', () => {
		expect(arrange([a, b], 'column')).toEqual([
			{ id: 'a', x: 10, y: 100 },
			{ id: 'b', x: 10, y: 0 }
		]);
		expect(arrange([a, b], 'row').map((p) => p.y)).toEqual([0, 0]);
	});
	it('distribute spaces the middle node evenly and keeps the ends', () => {
		const out = arrange([a, b, c], 'distributeH');
		expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
		expect(out[0].x).toBe(10);
		expect(out[2].x).toBe(300);
		// equal gaps: (300+150 - 10 - 3*150) / 2 = -5 → b at 10+150-5
		expect(out[1].x).toBe(155);
		expect(arrange([a, b], 'distributeH')).toEqual([]);
	});
	it('a frame wraps its members with padding and a title strip', () => {
		expect(frameRect([n('a', 0, 0), n('b', 200, 100)])).toEqual({ x: -24, y: -58, w: 398, h: 242 });
	});
});
