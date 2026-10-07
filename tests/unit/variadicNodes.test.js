// @ts-nocheck — plain fixture graphs
// 37 (R6): variadic math/gate and the Switcher multiplexer — the pure half (folds, socket typing,
// the socket-removal plan) and the two readers it feeds (the connection check, the group IO list).
import { describe, it, expect } from 'vitest';
import {
	socketCount,
	variadicInputs,
	opFolds,
	foldMath,
	foldGate,
	dataSocketType,
	variadicSocketExists,
	socketRemovalPlan,
	switcherRadioIndex,
	MAX_SOCKETS
} from '../../src/lib/variadicNodes.js';
import { isValidFlowConnection, groupSocketType, resolvedInputType } from '../../src/lib/flowSockets.js';
import { computeGroupIO, edgeId, parentMap } from '../../src/lib/nodeGroups.js';

const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, ...data } });
const wire = (s, sh, t, th) => ({ id: edgeId(s, sh, t, th), source: s, ...(sh ? { sourceHandle: sh } : {}), target: t, ...(th ? { targetHandle: th } : {}) });

describe('socket counts', () => {
	it('defaults to 2 (every saved node), clamps to 2..8', () => {
		expect(socketCount({})).toBe(2);
		expect(socketCount({ sockets: 5 })).toBe(5);
		expect(socketCount({ sockets: 1 })).toBe(2);
		expect(socketCount({ sockets: 99 })).toBe(MAX_SOCKETS);
		expect(socketCount({ sockets: 'x' })).toBe(2);
		expect(variadicInputs({ sockets: 4 })).toEqual(['a', 'b', 'c', 'd']);
	});
	it('only the associative-ish ops fold', () => {
		expect(opFolds('math', 'add')).toBe(true);
		expect(opFolds('math', undefined)).toBe(true); // the default op
		expect(opFolds('math', 'pow')).toBe(false);
		expect(opFolds('gate', 'xor')).toBe(true);
		expect(opFolds('gate', 'not')).toBe(false);
		expect(opFolds('compare', 'gt')).toBe(false);
	});
});

describe('folds', () => {
	it('math folds left like a calculator', () => {
		expect(foldMath('add', [1, 2, 3, 4])).toBe(10);
		expect(foldMath('sub', [10, 1, 2])).toBe(7);
		expect(foldMath('mul', [2, 3, 4])).toBe(24);
		expect(foldMath('div', [24, 2, 3])).toBe(4);
		expect(foldMath('div', [5, 0, 3])).toBe(0); // the two-input rule: /0 reads 0, never Infinity
		expect(foldMath('min', [3, -1, 7])).toBe(-1);
		expect(foldMath('max', [3, -1, 7])).toBe(7);
	});
	it('gate folds: and = every, or = some, xor = odd parity', () => {
		expect(foldGate('and', [true, true, true])).toBe(true);
		expect(foldGate('and', [true, false, true])).toBe(false);
		expect(foldGate('or', [false, false, true])).toBe(true);
		expect(foldGate('xor', [true, true, true])).toBe(true);
		expect(foldGate('xor', [true, true, false])).toBe(false);
	});
});

describe('socket typing', () => {
	it('a gate extra socket is boolean, a math one number — on the card AND through a group', () => {
		const g = node('g', 'gate', { sockets: 4 });
		expect(resolvedInputType(g, 'd')).toBe('boolean');
		expect(groupSocketType(g, 'd', 'in')).toBe('boolean');
		expect(resolvedInputType(node('m', 'math', { sockets: 3 }), 'c')).toBe('number');
	});
	it('a switcher types its item sockets and its value output by vtype; index is a number', () => {
		const sw = node('s', 'switcher', { items: ['a', 'b', 'c'], vtype: 'vector3' });
		expect(dataSocketType(sw, 'in2', 'input')).toBe('vector3');
		expect(dataSocketType(sw, 'index', 'input')).toBe('number');
		expect(dataSocketType(sw, 'value', 'output')).toBe('vector3');
		expect(dataSocketType(sw, null, 'output')).toBe(null); // the unnamed output stays the static 'number'
		expect(groupSocketType(sw, 'value', 'out')).toBe('vector3');
		expect(dataSocketType(node('s2', 'switcher', {}), 'in0', 'input')).toBe('number'); // the default
	});
	it('the connection check follows the vtype (refuses what the type cannot carry)', () => {
		const nodes = [node('v', 'vector3'), node('t', 'toggle'), node('s', 'switcher', { vtype: 'boolean', items: ['x', 'y'] }), node('o', 'objectselector')];
		expect(isValidFlowConnection(wire('t', null, 's', 'in0'), nodes)).toBe(true);
		expect(isValidFlowConnection(wire('v', null, 's', 'in0'), nodes)).toBe(false);
		// a boolean value output may feed a number input (the coercion row), not an object one
		const more = [...nodes, node('n', 'math')];
		expect(isValidFlowConnection(wire('s', 'value', 'n', 'a'), more)).toBe(true);
		expect(isValidFlowConnection(wire('s', 'value', 'o', null), more)).toBe(false);
		// the unnamed output is still the INDEX (a number), whatever vtype says
		expect(isValidFlowConnection(wire('s', null, 'n', 'a'), more)).toBe(true);
	});
	it('a removed socket no longer exists; every other node and handle does', () => {
		expect(variadicSocketExists(node('m', 'math', { sockets: 3 }), 'c', 'in')).toBe(true);
		expect(variadicSocketExists(node('m', 'math', { sockets: 3 }), 'd', 'in')).toBe(false);
		expect(variadicSocketExists(node('s', 'switcher', { items: ['a', 'b'] }), 'in2', 'in')).toBe(false);
		expect(variadicSocketExists(node('s', 'switcher', { items: ['a', 'b'] }), 'index', 'in')).toBe(true);
		expect(variadicSocketExists(node('x', 'counter'), 'zzz', 'in')).toBe(true);
	});
	it('the radio index reads legacy `shape` saves and clamps', () => {
		expect(switcherRadioIndex({ shape: 'pyramid' })).toBe(1);
		expect(switcherRadioIndex({ items: ['a', 'b'], index: 9 })).toBe(1);
		expect(switcherRadioIndex({ items: ['a', 'b'], index: -3 })).toBe(0);
	});
});

describe('the socket-removal plan', () => {
	const fixture = () => {
		const m = node('m', 'math', { op: 'add', sockets: 4, a: 1, b: 2 });
		const nodes = [node('n1', 'number'), node('n2', 'number'), node('n3', 'number'), node('n4', 'number'), m];
		const edges = [wire('n1', null, 'm', 'a'), wire('n2', null, 'm', 'b'), wire('n3', null, 'm', 'c'), wire('n4', null, 'm', 'd')];
		return { m, nodes, edges };
	};
	it('removing b deletes its wire and moves c->b, d->c under canonical ids', () => {
		const { m, nodes, edges } = fixture();
		const plan = socketRemovalPlan(m, nodes, edges, 1, edgeId);
		expect(plan.data.sockets).toBe(3);
		expect(plan.deleteEdges.map((e) => e.targetHandle).sort()).toEqual(['b', 'c', 'd']);
		expect(plan.createEdges.map((e) => [e.source, e.targetHandle])).toEqual([['n3', 'b'], ['n4', 'c']]);
		expect(plan.createEdges.every((e) => e.id === edgeId(e.source, e.sourceHandle, e.target, e.targetHandle))).toBe(true);
		// b had a manual value; the socket moving into it (c) has none, so it takes the default
		expect(plan.data.b).toBe(0);
	});
	it('removing a moves b\'s manual value into a', () => {
		const { m, nodes, edges } = fixture();
		const plan = socketRemovalPlan(m, nodes, edges, 0, edgeId);
		expect(plan.data.a).toBe(2);
		expect(plan.data.b).toBe(0);
	});
	it('never goes below 2 sockets, refuses an out-of-range index and a non-variadic node', () => {
		const m = node('m', 'math', { sockets: 2 });
		expect(socketRemovalPlan(m, [m], [], 0, edgeId)).toBe(null);
		expect(socketRemovalPlan(node('m', 'math', { sockets: 3 }), [], [], 5, edgeId)).toBe(null);
		expect(socketRemovalPlan(node('c', 'compare'), [], [], 0, edgeId)).toBe(null);
	});
	it('a switcher keeps its radio on the same ITEM when an earlier one goes', () => {
		const sw = node('s', 'switcher', { items: ['x', 'y', 'z'], index: 2 });
		const plan = socketRemovalPlan(sw, [sw], [wire('n', null, 's', 'in2')], 0, edgeId);
		expect(plan.data.items).toEqual(['y', 'z']);
		expect(plan.data.index).toBe(1);
		expect(plan.data.shape).toBe('z');
		expect(plan.createEdges[0].targetHandle).toBe('in1');
		// removing the SELECTED item falls back to the first
		expect(socketRemovalPlan(sw, [sw], [], 2, edgeId).data.index).toBe(0);
	});
	it('rewrites a group IO list the same way, keeping a name the user typed', () => {
		const { m, nodes, edges } = fixture();
		const group = node('g', 'group', {
			children: ['m'],
			inputs: [
				{ key: 'm|a', name: 'a', type: 'number', to: ['m', 'a'] },
				{ key: 'm|b', name: 'b', type: 'number', to: ['m', 'b'] },
				{ key: 'm|c', name: 'Speed', type: 'number', to: ['m', 'c'] },
				{ key: 'm|d', name: 'd', type: 'number', to: ['m', 'd'] }
			]
		});
		const plan = socketRemovalPlan(m, [...nodes, group], edges, 1, edgeId);
		expect(plan.groups).toHaveLength(1);
		const after = plan.groups[0].after.inputs;
		expect(after.map((io) => io.key)).toEqual(['m|a', 'm|b', 'm|c']);
		expect(after.map((io) => io.name)).toEqual(['a', 'Speed', 'c']);
		expect(after[1].to).toEqual(['m', 'b']);
	});
});

describe('groups round-trip variadic sockets', () => {
	it('a group around a 5-input gate exposes 5 boolean sockets; dropping one drops its entry', () => {
		const sources = ['t1', 't2', 't3', 't4', 't5'].map((id) => node(id, 'toggle'));
		const g = node('gate', 'gate', { op: 'or', sockets: 5 });
		const edges = sources.map((s, i) => wire(s.id, null, 'gate', 'abcde'[i]));
		const group = node('grp', 'group', { children: ['gate'], inputs: [], outputs: [] });
		const nodes = [...sources, g, group];
		const io = computeGroupIO(nodes, edges, group, { parents: parentMap(nodes), typeOf: groupSocketType });
		expect(io.inputs.map((x) => [x.name, x.type])).toEqual([['a', 'boolean'], ['b', 'boolean'], ['c', 'boolean'], ['d', 'boolean'], ['e', 'boolean']]);
		// the node shrank to 4 sockets and the wire into `e` went: without the existence check the
		// stale `e` entry would be KEPT (an unwired group socket is kept on purpose)
		const shrunk = [...sources, { ...g, data: { ...g.data, sockets: 4 } }, { ...group, data: { ...group.data, inputs: io.inputs } }];
		const kept = computeGroupIO(shrunk, edges.slice(0, 4), shrunk[6], { parents: parentMap(shrunk), typeOf: groupSocketType });
		expect(kept.inputs.map((x) => x.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
		const pruned = computeGroupIO(shrunk, edges.slice(0, 4), shrunk[6], { parents: parentMap(shrunk), typeOf: groupSocketType, socketExists: variadicSocketExists });
		expect(pruned.inputs.map((x) => x.name)).toEqual(['a', 'b', 'c', 'd']);
	});
});
