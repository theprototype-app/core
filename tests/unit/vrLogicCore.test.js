// @ts-nocheck — plain fixtures; the module under test is typed
// 74 VH1: the logic panel's pure half (src/lib/vr/logicGraphCore.js) — sockets, card layout, the view
// transform, the laser hit test, wire connections and the wrist pad's fields.
import { describe, it, expect } from 'vitest';
import {
	nodeSockets,
	cardLayout,
	fitView,
	toCanvas,
	toGraph,
	zoomAt,
	hitGraph,
	connectionOf,
	edgeIdOf,
	edgesIntoSocket,
	padFields,
	stepNumber,
	parseNumber,
	cycleOption,
	cycleSwatch,
	fieldText,
	dropPoint,
	CARD_W,
	HEAD_H,
	ROW_H,
	MIN_SCALE,
	MAX_SCALE
} from '../../src/lib/vr/logicGraphCore.js';

const node = (id, type, x = 0, y = 0, data = {}) => ({ id, type, position: { x, y }, data: { type, ...data } });

describe('nodeSockets', () => {
	it('lists the declared sockets, then every handle an existing wire names', () => {
		const n = node('c', 'counter');
		const edges = [
			{ id: 'e1', source: 'k', target: 'c', targetHandle: 'pulse' },
			{ id: 'e2', source: 'x', target: 'c', targetHandle: 'mystery' },
			{ id: 'e3', source: 'c', target: 'h', sourceHandle: 'extra' }
		];
		const s = nodeSockets(n, { inputs: ['pulse', 'reset'], unnamedOut: true }, edges);
		expect(s.inputs.map((i) => i.id)).toEqual(['pulse', 'reset', 'mystery']);
		expect(s.outputs.map((o) => o.id)).toEqual([null, 'extra']);
	});
	it('a plain wire into a card with no plain input still draws one (a desktop graph never loses a wire)', () => {
		const s = nodeSockets(node('o', 'objectselector'), { inputs: [] }, [{ source: 'a', target: 'o' }]);
		expect(s.inputs).toEqual([{ id: null, label: '' }]);
	});
	it('labels come from the info map, never duplicated', () => {
		const s = nodeSockets(node('s', 'spawn'), { inputs: ['at', 'at', 'trigger'], labels: { at: 'offset' } }, []);
		expect(s.inputs).toEqual([
			{ id: 'at', label: 'offset' },
			{ id: 'trigger', label: 'trigger' }
		]);
	});
});

describe('cardLayout', () => {
	it('puts plain sockets on the title row and named ones a row each, outputs on the right edge', () => {
		const n = node('a', 'counter', 100, 50);
		const L = cardLayout(n, { inputs: [{ id: 'pulse', label: 'pulse' }, { id: 'reset', label: 'reset' }], outputs: [{ id: null, label: '' }] });
		expect(L.w).toBe(CARD_W);
		expect(L.h).toBe(HEAD_H + 2 * ROW_H + 8);
		expect(L.outputs[0]).toMatchObject({ id: null, x: 100 + CARD_W, y: 50 + HEAD_H / 2 });
		expect(L.inputs[0]).toMatchObject({ id: 'pulse', x: 100, y: 50 + HEAD_H + ROW_H / 2 });
		expect(L.inputs[1].y - L.inputs[0].y).toBe(ROW_H);
	});
	it('a note keeps its own size and has no sockets', () => {
		const L = cardLayout(node('n', 'note', 0, 0, { w: 300, h: 120 }), { inputs: [], outputs: [] });
		expect(L).toMatchObject({ kind: 'note', w: 300, h: 120, inputs: [], outputs: [] });
	});
});

describe('the view transform', () => {
	const area = { x: 0, y: 100, w: 1000, h: 600 };
	it('fits the cards, centred, capped at maxScale', () => {
		const v = fitView([{ x: 0, y: 0, w: 200, h: 100 }], area, { pad: 0, maxScale: 1.4 });
		expect(v.s).toBe(1.4);
		const c = toCanvas(v, 100, 50); // the cards' centre
		expect(c.x).toBeCloseTo(500);
		expect(c.y).toBeCloseTo(400);
	});
	it('shrinks a wide graph to fit, never below MIN_SCALE', () => {
		const v = fitView([{ x: 0, y: 0, w: 4000, h: 100 }], area, { pad: 0 });
		expect(v.s).toBeCloseTo(0.25);
		expect(fitView([{ x: 0, y: 0, w: 1e6, h: 1 }], area).s).toBe(MIN_SCALE);
	});
	it('toGraph inverts toCanvas; zoomAt keeps the point under the laser still', () => {
		const v = { s: 0.8, ox: 30, oy: -20 };
		const g = toGraph(v, ...Object.values(toCanvas(v, 123, -45)));
		expect(g.x).toBeCloseTo(123);
		expect(g.y).toBeCloseTo(-45);
		const z = zoomAt(v, 1.5, 400, 300);
		const before = toGraph(v, 400, 300);
		const after = toGraph(z, 400, 300);
		expect(after.x).toBeCloseTo(before.x);
		expect(after.y).toBeCloseTo(before.y);
		expect(zoomAt(v, 100, 0, 0).s).toBe(MAX_SCALE);
	});
	it('an empty graph centres graph (0, 0)', () => {
		const v = fitView([], area);
		expect(toCanvas(v, 0, 0)).toEqual({ x: 500, y: 400 });
	});
});

describe('hitGraph', () => {
	const a = cardLayout(node('a', 'number', 0, 0), { inputs: [], outputs: [{ id: null, label: '' }] });
	const b = cardLayout(node('b', 'spin', 300, 0), { inputs: [{ id: 'speed', label: 'speed' }], outputs: [{ id: null, label: '' }] });
	const v = { s: 1, ox: 0, oy: 0 };
	it('a socket wins within its radius, the nearest one', () => {
		expect(hitGraph([a, b], v, CARD_W + 10, HEAD_H / 2 + 5)).toMatchObject({ kind: 'socket', node: 'a', dir: 'out', id: null });
		expect(hitGraph([a, b], v, 300 - 6, HEAD_H + ROW_H / 2)).toMatchObject({ kind: 'socket', node: 'b', dir: 'in', id: 'speed' });
	});
	it('then the card body, then empty', () => {
		expect(hitGraph([a, b], v, 80, 40)).toEqual({ kind: 'node', node: 'a' });
		expect(hitGraph([a, b], v, 250, 300)).toEqual({ kind: 'empty' });
	});
	it('the topmost card wins where two overlap', () => {
		const c = cardLayout(node('c', 'number', 40, 10), { inputs: [], outputs: [] });
		expect(hitGraph([a, c], v, 90, 40)).toEqual({ kind: 'node', node: 'c' });
	});
	it('a note is grabbed by its title strip only; a card drawn over it wins', () => {
		const n = cardLayout(node('n', 'note', -50, -50, { w: 400, h: 300 }), { inputs: [], outputs: [] });
		expect(hitGraph([n, a], v, 80, 40)).toEqual({ kind: 'node', node: 'a' });
		expect(hitGraph([n, a], v, 300, -40)).toEqual({ kind: 'node', node: 'n' });
		expect(hitGraph([n, a], v, 300, 200)).toEqual({ kind: 'empty' });
	});
});

describe('wires', () => {
	it('either end may be the output; same-direction or same-card drops are nothing', () => {
		const out = { node: 'a', dir: 'out', id: null };
		const inp = { node: 'b', dir: 'in', id: 'speed' };
		const c = { source: 'a', sourceHandle: null, target: 'b', targetHandle: 'speed' };
		expect(connectionOf(out, inp)).toEqual(c);
		expect(connectionOf(inp, out)).toEqual(c);
		expect(connectionOf(out, { node: 'b', dir: 'out', id: null })).toBeNull();
		expect(connectionOf(out, { node: 'a', dir: 'in', id: 'x' })).toBeNull();
		expect(connectionOf(out, null)).toBeNull();
	});
	it('the edge id is the desktop makeEdge format', () => {
		expect(edgeIdOf({ source: 'a', sourceHandle: null, target: 'b', targetHandle: 'speed' })).toBe('e-a-b.speed');
		expect(edgeIdOf({ source: 'a', sourceHandle: 'point', target: 'b', targetHandle: null })).toBe('e-a.point-b');
	});
	it('edgesIntoSocket matches plain and named handles exactly', () => {
		const edges = [
			{ id: '1', target: 'b', targetHandle: 'speed' },
			{ id: '2', target: 'b' },
			{ id: '3', target: 'c', targetHandle: 'speed' }
		];
		expect(edgesIntoSocket(edges, 'b', 'speed').map((e) => e.id)).toEqual(['1']);
		expect(edgesIntoSocket(edges, 'b', null).map((e) => e.id)).toEqual(['2']);
	});
});

describe('the wrist pad', () => {
	const spawnSpec = {
		defaults: { x: 0, y: 3, z: 0, count: 1, maxAlive: 32, interval: 0, spread: 0.5 },
		params: [
			{ key: 'count', kind: 'range', min: 1, max: 20, step: 1, label: 'copies per fire' },
			{ key: 'spread', kind: 'range', min: 0, max: 5, step: 0.1 }
		]
	};
	it('params first (with their ranges and labels), then plain defaults the params do not name', () => {
		const f = padFields(node('s', 'spawn', 0, 0, { count: 4 }), spawnSpec);
		expect(f.map((x) => x.key)).toEqual(['count', 'spread', 'x', 'y', 'z', 'maxAlive', 'interval']);
		expect(f[0]).toMatchObject({ kind: 'number', label: 'copies per fire', value: 4, min: 1, max: 20, step: 1 });
		expect(f[2]).toMatchObject({ key: 'x', step: 1 });
	});
	it('selects, toggles, colours and short text; code / lists / points are left to the desktop', () => {
		const spec = {
			defaults: { mode: 'sin', on: false, color: '#ff4000', name: 'Gem', code: 'x', items: ['a'], points: [[0, 0, 0]] },
			params: [{ key: 'mode', kind: 'select', options: ['t', 'sin'] }]
		};
		const f = padFields(node('t', 'time'), spec);
		expect(f.map((x) => [x.key, x.kind])).toEqual([
			['mode', 'select'],
			['on', 'toggle'],
			['color', 'color'],
			['name', 'text']
		]);
	});
	it('a param fed by a wire is marked wired', () => {
		const f = padFields(node('s', 'spawn'), spawnSpec, [{ target: 's', targetHandle: 'count' }]);
		expect(f.find((x) => x.key === 'count').wired).toBe(true);
		expect(f.find((x) => x.key === 'spread').wired).toBe(false);
	});
	it('the Number node steps by its own step', () => {
		const f = padFields(node('n', 'number', 0, 0, { value: 2, step: 0.5 }), { defaults: { value: 1, step: 1 } });
		expect(f.find((x) => x.key === 'value').step).toBe(0.5);
	});
	it('steps clamp to the range and round to the step', () => {
		const field = { key: 'k', kind: 'number', label: 'k', value: 0.2, step: 0.1, min: 0, max: 1 };
		expect(stepNumber(field, 1)).toBe(0.3);
		expect(stepNumber(field, -1, true)).toBe(0);
		expect(stepNumber({ ...field, value: 0.95 }, 1)).toBe(1);
		expect(stepNumber({ key: 'k', kind: 'number', label: 'k', value: 7, step: 1 }, 1, true)).toBe(17);
	});
	it('typed numbers parse (comma decimals too), clamp, and refuse junk', () => {
		const field = { key: 'k', kind: 'number', label: 'k', value: 0, step: 1, min: 0, max: 10 };
		expect(parseNumber(field, '3,5')).toBe(3.5);
		expect(parseNumber(field, '99')).toBe(10);
		expect(parseNumber(field, 'abc')).toBeNull();
		expect(parseNumber(field, '  ')).toBeNull();
	});
	it('options and swatches cycle and wrap', () => {
		const field = { key: 'm', kind: 'select', label: 'm', value: 'sin', step: 1, options: ['t', 'sin', 'saw'] };
		expect(cycleOption(field, 1)).toBe('saw');
		expect(cycleOption({ ...field, value: 'saw' }, 1)).toBe('t');
		expect(cycleOption({ ...field, value: 't' }, -1)).toBe('saw');
		expect(cycleSwatch('#FFFFFF', 1)).toBe('#ff4000');
		expect(cycleSwatch('#123456', 1)).toBe('#ffffff');
		expect(cycleSwatch('#ffffff', -1)).toBe('#111111');
	});
	it('fieldText prints what the pad shows', () => {
		expect(fieldText({ key: 'a', kind: 'toggle', label: 'a', value: true, step: 1 })).toBe('On');
		expect(fieldText({ key: 'a', kind: 'number', label: 'a', value: 0.30000000000000004, step: 0.1 })).toBe('0.3');
	});
});

describe('dropPoint', () => {
	it('lands a new card centred in view, staggered so two adds do not stack', () => {
		const v = { s: 1, ox: 0, oy: 0 };
		const area = { x: 0, y: 0, w: 1000, h: 600 };
		const p0 = dropPoint(v, area, 0);
		const p1 = dropPoint(v, area, 1);
		expect(p0).toEqual({ x: 500 - CARD_W / 2, y: 270 });
		expect(p1.x - p0.x).toBe(24);
	});
});
