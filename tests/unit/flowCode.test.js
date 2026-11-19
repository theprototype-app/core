// 2.0 N2 — the code view's round trip: graph -> code -> graph is exact on LOGIC (node ids, types,
// effective data = catalog defaults + the node's data, and every wire's source/handles/target) for
// the five N0 built-ins — math, compare, timer, latch, oscillate — plus the shapes the rules name:
// a named source handle, fan-in, a cycle (a forward reference), a sink nobody reads, a label binding.
import { describe, test, expect } from 'vitest';
import { graphToCode, codeOrder, printLiteral } from '../../src/lib/nodes/flowCode.js';
import { codeToGraph } from '../../src/lib/nodes/flowCodeParse.js';
import { findNodeSpec } from '../../src/lib/nodeCatalog.js';

const opts = {
	defaults: (/** @type {string} */ t) => findNodeSpec(t)?.defaults,
	defaultLabel: (/** @type {string} */ t) => findNodeSpec(t)?.label ?? ''
};

/** @param {any} o @returns {any} */
const sortKeys = (o) =>
	Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])) : o;

/** the logic of a graph, comparable: what the round trip promises to keep @param {{nodes: any[], edges: any[]}} g */
export function logicOf(g) {
	const nodes = g.nodes.filter((n) => n.type !== 'group' && n.type !== 'note');
	const ids = new Set(nodes.map((n) => n.id));
	return {
		nodes: nodes
			.map((n) => ({
				id: n.id,
				type: n.type,
				data: sortKeys({ label: opts.defaultLabel(n.type) || undefined, type: n.type, ...structuredClone(opts.defaults(n.type) ?? {}), ...n.data })
			}))
			.sort((a, b) => (a.id < b.id ? -1 : 1)),
		edges: g.edges
			.filter((e) => ids.has(e.source) && ids.has(e.target))
			.map((e) => [e.source, e.sourceHandle || '', e.target, e.targetHandle || ''].join('|'))
			.sort()
	};
}

/** @param {string} id @param {string} type @param {any} [data] */
const N = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, ...data } });
/** @param {string} s @param {string} t @param {string} [th] @param {string} [sh] */
const E = (s, t, th, sh) => ({ id: 'x-' + s + t + (th ?? ''), source: s, target: t, ...(sh ? { sourceHandle: sh } : {}), ...(th ? { targetHandle: th } : {}) });

const BUILT_INS = {
	// maths: two inputs, one at its default, one changed; fan-in from one source to both handles
	math: { nodes: [N('s', 'slider', { value: 7 }), N('m', 'math', { op: 'mul', b: 3 }), N('o', 'objectselector', { selected: 'Box' })], edges: [E('s', 'm', 'a'), E('s', 'm', 'b')] },
	// compare: value in, boolean out feeding an effect sink nobody reads
	compare: {
		nodes: [N('t', 'time'), N('c', 'compare', { op: 'gt', b: 2.5 }), N('v', 'visibility'), N('o', 'objectselector', { selected: 'Door' })],
		edges: [E('t', 'c', 'a'), E('c', 'v', 'on'), E('v', 'o')]
	},
	// timer: a trigger in from a named source handle (onclick.byMe), labelled node -> readable binding
	timer: {
		nodes: [N('k', 'onclick', { label: 'Front button' }), N('tm', 'timer', { duration: 4 }), N('h', 'hudtext', { element: 'score' })],
		edges: [E('k', 'tm', 'trigger', 'byMe'), E('tm', 'h', 'value')]
	},
	// latch: set and reset, and a CYCLE (the latch's output re-arms itself through a Not) = a forward reference
	latch: {
		nodes: [N('a', 'onclick'), N('l', 'latch', { initial: true }), N('n', 'not')],
		edges: [E('a', 'l', 'set'), E('n', 'l', 'reset'), E('l', 'n', 'a')]
	},
	// motion: oscillate driven by a slider into amplitude, two effect sinks into one selector (fan-in array)
	oscillate: {
		nodes: [N('s', 'slider', { value: 30 }), N('w', 'oscillate', { axis: 'y', period: 3 }), N('sp', 'spin'), N('o', 'objectselector', { selected: 'Fan' })],
		edges: [E('s', 'w', 'amplitude'), E('w', 'o'), E('sp', 'o')]
	}
};

describe('2.0 N2: graph -> code -> graph for the five N0 built-ins', () => {
	for (const [name, graph] of Object.entries(BUILT_INS)) {
		test(name + ' round-trips exactly on logic', () => {
			const { code, lineOf, nodeAt } = graphToCode(graph, opts);
			const back = codeToGraph(code, opts);
			expect(logicOf(back)).toEqual(logicOf(graph));
			// every node has a line and the map runs both ways
			for (const n of graph.nodes) expect(nodeAt[lineOf[n.id]]).toBe(n.id);
			// and the code says it in the shape the design page shows
			expect(code).toContain('export default flow(({');
			expect(code.split('\n')[lineOf[graph.nodes[0].id] - 1]).toMatch(new RegExp('// #' + graph.nodes[0].id + '$'));
		});
	}
	test('the shapes read the way the design page says', () => {
		const t = graphToCode(BUILT_INS.timer, opts).code;
		expect(t).toContain("const frontButton = onclick({ label: 'Front button' }); // #k");
		expect(t).toContain('timer({ duration: 4 }, { trigger: frontButton.byMe }); // #tm');
		const m = graphToCode(BUILT_INS.math, opts).code;
		expect(m).toMatch(/math\(\{ op: 'mul', b: 3 \}, \{ a: slider1, b: slider1 \}\)/);
		const o = graphToCode(BUILT_INS.oscillate, opts).code;
		expect(o).toMatch(/objectselector\(\{ selected: 'Fan' \}, \{ in: \[oscillate1, spin1\] \}\); \/\/ #o/);
		const l = graphToCode(BUILT_INS.latch, opts).code;
		expect(l).toMatch(/const latch1 = latch\(\{ initial: true \}, \{ set: onclick1, reset: not1 \}\); \/\/ #l/);
	});
	test('sources first; a cycle keeps graph order', () => {
		const g = { nodes: [N('b', 'not'), N('a', 'time')], edges: [E('a', 'b', 'a')] };
		expect(codeOrder(g.nodes, g.edges).map((n) => n.id)).toEqual(['a', 'b']);
		const c = BUILT_INS.latch;
		expect(codeOrder(c.nodes, c.edges).map((n) => n.id)).toEqual(['a', 'l', 'n']);
	});
	test('group frames and notes are not logic', () => {
		const g = { nodes: [N('g', 'group', { label: 'Doors' }), N('t', 'time', {}), N('x', 'note', { text: 'hi' })], edges: [] };
		const { code } = graphToCode(g, opts);
		expect(code).not.toContain('#g');
		expect(code).not.toContain('#x');
		expect(codeToGraph(code, opts).nodes.map((n) => n.id)).toEqual(['t']);
	});
	test('an odd type, odd handles and odd strings survive', () => {
		const g = {
			nodes: [N('p', 'mod-thing', { "it's": 'a "q"\n' }), N('q', 'math', { label: 'class' })],
			edges: [E('p', 'q', 'a-b', 'out-1')]
		};
		const { code } = graphToCode(g, opts);
		expect(code).toContain("use('mod-thing')");
		expect(logicOf(codeToGraph(code, opts))).toEqual(logicOf(g));
	});
	test('the parser refuses anything that is not a declaration (nothing is executed)', () => {
		expect(() => codeToGraph('export default flow(({ math }) => { math(globalThis.x); });', opts)).toThrow();
		expect(() => codeToGraph('export default flow(({ math }) => { fetch("/x"); });', opts)).not.toThrow(); // a call shape, but…
		expect(codeToGraph('export default flow(({ math }) => { fetch("/x"); });', opts).nodes[0].type).toBe('fetch'); // …only ever DATA
		expect(() => codeToGraph('export default flow(() => { const a = 1; });', opts)).toThrow();
	});
	test('literals print as JS and read back', () => {
		expect(printLiteral({ a: [1, -2, 'x'], 'b-c': null, d: { e: true } })).toBe("{ a: [1, -2, 'x'], 'b-c': null, d: { e: true } }");
	});
});

describe('2.0 N2: the codeView flag', () => {
	test('ships off; on is per browser (flag:codeView)', async () => {
		const { safeStorage } = await import('../../src/lib/safeStorage');
		safeStorage.removeItem('flag:codeView');
		const { codeViewFlag, codeViewOn, CODE_VIEW_KEY } = await import('../../src/lib/nodes/codeViewFlag.js');
		expect(codeViewOn()).toBe(false);
		codeViewFlag.set(true);
		expect(safeStorage.getItem(CODE_VIEW_KEY)).toBe('1');
		codeViewFlag.set(false);
		expect(safeStorage.getItem(CODE_VIEW_KEY)).toBeNull();
	});
});
