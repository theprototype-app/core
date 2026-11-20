// 2.0-n3c — Convert to code / Convert back as PLANS: same id, same sockets, every wire kept, the
// marker, and convert -> back returns the graph exactly (node, data, edges and their ids).
import { describe, test, expect } from 'vitest';
import { planConvert, planConvertBack, conversionState, isUnchangedConversion, CONVERTIBLE } from '../../src/lib/nodes/convertCode.js';
import { REFERENCE_TYPES } from '../../src/lib/nodes/reference.js';
import { scriptInputs, scriptOutputs, isScriptValue } from '../../src/lib/scriptIO.js';

const eid = (/** @type {string} */ s, /** @type {any} */ sh, /** @type {string} */ t, /** @type {any} */ th) => 'e-' + s + (sh ? '.' + sh : '') + '-' + t + (th ? '.' + th : '');
const edge = (/** @type {string} */ s, /** @type {any} */ sh, /** @type {string} */ t, /** @type {any} */ th) => ({ id: eid(s, sh, t, th), source: s, target: t, ...(sh ? { sourceHandle: sh } : {}), ...(th ? { targetHandle: th } : {}) });

/** apply a plan to a graph copy (what the applier + every peer end up holding) @param {any} graph @param {any} plan */
function apply(graph, plan) {
	const rmN = new Set(plan.remove.nodes.map((/** @type {any} */ n) => n.id));
	const rmE = new Set(plan.remove.edges.map((/** @type {any} */ e) => e.id));
	const nodes = graph.nodes.filter((/** @type {any} */ n) => !rmN.has(n.id)).concat(plan.add.nodes);
	const edges = graph.edges.filter((/** @type {any} */ e) => !rmE.has(e.id) && !rmN.has(e.source) && !rmN.has(e.target)).concat(plan.add.edges);
	return { nodes, edges };
}
const sortById = (/** @type {any[]} */ l) => [...l].sort((a, b) => (a.id < b.id ? -1 : 1));
const canon = (/** @type {any} */ g) => ({ nodes: sortById(g.nodes), edges: sortById(g.edges) });

function sample(/** @type {string} */ type, /** @type {any} */ data = {}) {
	return {
		nodes: [
			{ id: 'num', type: 'number', position: { x: 0, y: 0 }, data: { value: 2 } },
			{ id: 'key', type: 'keypress', position: { x: 0, y: 80 }, data: { key: 'KeyR' } },
			{ id: 'X', type, position: { x: 200, y: 0 }, data: { label: 'mine', ...data } },
			{ id: 'sink', type: 'hudtext', position: { x: 400, y: 0 }, data: { element: 'e1' } },
			{ id: 'sink2', type: 'math', position: { x: 400, y: 100 }, data: {} }
		],
		edges: [edge('num', null, 'X', type === 'random' ? 'seed' : type === 'select' ? 'index' : type === 'hudtext' ? 'value' : 'a'), ...(type === 'maprange' ? [] : [edge('key', null, 'X', type === 'random' ? 'reroll' : type === 'select' ? 'a' : 'b')]), edge('X', null, 'sink', 'value'), edge('X', null, 'sink2', 'b')]
	};
}

describe('2.0-n3c Convert to code (plan)', () => {
	for (const type of REFERENCE_TYPES.filter((t) => t !== 'hudtext'))
		test(type + ': a Script value node, same id + socket names, wires kept, marker, back = exact', () => {
			const g = sample(type, type === 'math' ? { op: 'mul', a: 3 } : {});
			const plan = /** @type {any} */ (planConvert(g, 'X'));
			expect(plan.ok).toBe(true);
			const after = apply(g, plan);
			const script = after.nodes.find((/** @type {any} */ n) => n.id === 'X');
			expect(script.type).toBe('script');
			expect(isScriptValue(script.data)).toBe(true);
			expect(script.data.convertedFrom.type).toBe(type);
			expect(script.data.convertedFrom.v).toBe(1);
			expect(script.data.label).toBe('mine');
			expect(script.data.code).toMatch(new RegExp("^// convertedFrom: " + type + " "));
			expect(script.data.code).toContain('const params = ');
			const names = (scriptInputs(script.data) ?? []).map((s) => s.name);
			for (const e of g.edges.filter((e) => e.target === 'X')) expect(names).toContain(e.targetHandle);
			// every wire kept: into it unchanged, out of it from the named output
			expect(after.edges.filter((/** @type {any} */ e) => e.target === 'X').length).toBe(g.edges.filter((e) => e.target === 'X').length);
			const out = after.edges.filter((/** @type {any} */ e) => e.source === 'X');
			expect(out.map((/** @type {any} */ e) => e.sourceHandle)).toEqual([scriptOutputs(script.data)[0].name, scriptOutputs(script.data)[0].name]);
			for (const e of out) expect(e.id).toBe(eid(e.source, e.sourceHandle, e.target, e.targetHandle));
			expect(conversionState(script, after)).toBe('back');
			// back: the exact graph again
			const back = /** @type {any} */ (planConvertBack(after, 'X'));
			expect(back.ok).toBe(true);
			expect(canon(apply(after, back))).toEqual(canon(g));
		});

	test('every convertible type converts; other types are refused with the list', () => {
		for (const type of CONVERTIBLE) expect(planConvert(sample(type), 'X').ok).toBe(true);
		const r = /** @type {any} */ (planConvert(sample('latch'), 'X'));
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/math, compare/);
	});

	test('convert back is refused once the code (or a socket) was edited', () => {
		const g = sample('compare', { op: 'lt' });
		const after = apply(g, /** @type {any} */ (planConvert(g, 'X')));
		const script = after.nodes.find((/** @type {any} */ n) => n.id === 'X');
		const edited = { ...after, nodes: after.nodes.map((/** @type {any} */ n) => (n.id === 'X' ? { ...n, data: { ...n.data, code: n.data.code + '\n// mine now' } } : n)) };
		expect(isUnchangedConversion(edited.nodes.find((/** @type {any} */ n) => n.id === 'X'))).toBe(false);
		expect(conversionState(edited.nodes.find((/** @type {any} */ n) => n.id === 'X'), edited)).toBe('changed');
		expect(/** @type {any} */ (planConvertBack(edited, 'X')).error).toMatch(/edited/);
		const socketEdit = { ...script, data: { ...script.data, inputs: [...script.data.inputs, { name: 'z', type: 'number' }] } };
		expect(isUnchangedConversion(socketEdit)).toBe(false);
	});

	test('select keeps the slots it used (wired c) through convert and back', () => {
		const g = sample('select');
		g.edges.push(edge('num', null, 'X', 'c'));
		const after = apply(g, /** @type {any} */ (planConvert(g, 'X')));
		const script = after.nodes.find((/** @type {any} */ n) => n.id === 'X');
		expect((scriptInputs(script.data) ?? []).map((s) => s.name)).toEqual(['index', 'a', 'b', 'c']);
		expect(canon(apply(after, /** @type {any} */ (planConvertBack(after, 'X'))))).toEqual(canon(g));
	});

	test('math with 4 sockets declares c, d as raw (any) sockets', () => {
		const g = sample('math', { sockets: 4 });
		const script = apply(g, /** @type {any} */ (planConvert(g, 'X'))).nodes.find((/** @type {any} */ n) => n.id === 'X');
		expect(script.data.inputs.map((/** @type {any} */ s) => s.type)).toEqual(['number', 'number', 'any', 'any']);
	});

	test('HUD Text: a format script in front, its value / format wires moved, text -> format; back = exact', () => {
		const g = sample('hudtext', { element: 'score', format: 'Gems: {v}', decimals: 1 });
		g.edges.push(edge('key', null, 'X', 'format'));
		let n = 0;
		const plan = /** @type {any} */ (planConvert(g, 'X', { newId: () => 'S' + ++n }));
		expect(plan.ok).toBe(true);
		const after = apply(g, plan);
		const hud = after.nodes.find((/** @type {any} */ n) => n.id === 'X');
		expect(hud.type).toBe('hudtext');
		const s = after.nodes.find((/** @type {any} */ n) => n.id === 'S1');
		expect(s.type).toBe('script');
		expect(s.data.convertedFrom).toMatchObject({ type: 'hudtext', target: 'X' });
		expect(after.edges.filter((/** @type {any} */ e) => e.target === 'X').map((/** @type {any} */ e) => [e.source, e.sourceHandle, e.targetHandle])).toEqual([
			['key', undefined, 'b'],
			['S1', 'text', 'format']
		]);
		expect(after.edges.filter((/** @type {any} */ e) => e.target === 'S1').map((/** @type {any} */ e) => e.targetHandle).sort()).toEqual(['format', 'value']);
		expect(conversionState(hud, after)).toBe('back');
		expect(/** @type {any} */ (planConvert(after, 'X')).ok).toBe(false);
		for (const from of ['X', 'S1']) expect(canon(apply(after, /** @type {any} */ (planConvertBack(after, from))))).toEqual(canon(g));
	});

	test('a node feeding a group socket is refused (its output socket id would change)', () => {
		const g = sample('math');
		g.nodes.push({ id: 'G', type: 'group', position: { x: 0, y: 0 }, data: { children: ['X'], inputs: [], outputs: [{ key: 'k', name: 'out', type: 'number', from: ['X', null] }] } });
		expect(/** @type {any} */ (planConvert(g, 'X')).error).toMatch(/group/);
	});
});
