import { describe, it, expect } from 'vitest';
import { describeNodeTypes, paramsOf, MAX_TYPES } from '../../src/lib/ai/nodeTypesCore.js';

// 86 T1 (= 85 R9): describe_node_types over fake catalog tables (flowTools.js wires the real ones)
const SPECS = /** @type {Record<string, any>} */ ({
	latch: { type: 'latch', label: 'Latch', defaults: { initial: false }, inputs: ['set', 'reset', 'toggle'], params: [{ key: 'perRound', kind: 'toggle', label: 'reset each round' }] },
	time: { type: 'time', label: 'Time', defaults: { mode: 'sin', rate: 1 }, params: [{ key: 'mode', kind: 'select', options: ['t', 'sin'] }, { key: 'rate', kind: 'number', step: 0.1 }] },
	pathpatrol: { type: 'pathpatrol', label: 'Path patrol', defaults: { points: [], speed: 1, mode: 'loop' } },
	onclap: { type: 'onclap', label: 'On Clap', defaults: {} }
});
const INPUTS = /** @type {Record<string, {name: string, type: string}[]>} */ ({ latch: [{ name: 'set', type: 'event' }, { name: 'reset', type: 'event' }, { name: 'toggle', type: 'event' }] });
const SRC = {
	vocabulary: [
		{ group: 'Logic', types: ['latch'] },
		{ group: 'Input', types: ['time'] },
		{ group: 'Animation', types: ['pathpatrol'] },
		{ group: 'Triggers', types: ['onclap'] }
	],
	spec: (/** @type {string} */ t) => SPECS[t] ?? null,
	doc: (/** @type {string} */ t) => (t === 'latch' ? 'Remembers on/off.' : ''),
	inputs: (/** @type {string} */ t) => INPUTS[t] ?? [],
	output: (/** @type {string} */ t) => ({ latch: 'boolean', time: 'number', onclap: 'event' })[t] ?? 'effect',
	namedOutputs: (/** @type {string} */ t) => (t === 'onclap' ? [{ name: 'point', type: 'vector3' }, { name: 'byMe', type: 'boolean' }] : []),
	match: (/** @type {any} */ raw) => {
		const flat = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
		return Object.keys(SPECS).find((t) => t === flat) ?? null;
	}
};

describe('86 T1 describe_node_types', () => {
	it('no arguments: just the names by group (small)', () => {
		const r = describeNodeTypes({}, SRC);
		expect(r.groups).toEqual({ Logic: ['latch'], Input: ['time'], Animation: ['pathpatrol'], Triggers: ['onclap'] });
		expect(r.next).toMatch(/types/);
	});
	it('a group: its types with one-line docs; an unknown group names the real ones', () => {
		expect(describeNodeTypes({ group: 'logic' }, SRC)).toMatchObject({ group: 'Logic', types: [{ type: 'latch', doc: 'Remembers on/off.' }] });
		expect(describeNodeTypes({ group: 'Nope' }, SRC).error).toMatch(/Logic, Input, Animation, Triggers/);
	});
	it('types: inputs, output, named outputs, params with types and defaults', () => {
		const r = describeNodeTypes({ types: ['latch', 'onclap', 'time', 'pathpatrol'] }, SRC);
		const [latch, onclap, time, patrol] = r.types;
		expect(latch).toMatchObject({ type: 'latch', label: 'Latch', group: 'Logic', doc: 'Remembers on/off.', output: 'boolean' });
		expect(latch.inputs.map((/** @type {any} */ i) => i.name)).toEqual(['set', 'reset', 'toggle']);
		expect(latch.params).toEqual([
			{ key: 'perRound', type: 'boolean', label: 'reset each round' },
			{ key: 'initial', type: 'boolean', default: false }
		]);
		expect(onclap.namedOutputs).toEqual([{ name: 'point', type: 'vector3' }, { name: 'byMe', type: 'boolean' }]);
		expect(time.params).toEqual([
			{ key: 'mode', type: 'choice', default: 'sin', options: ['t', 'sin'] },
			{ key: 'rate', type: 'number', default: 1 }
		]);
		// a default the editor draws no row for still shows (Path patrol's waypoints)
		expect(patrol.params.find((/** @type {any} */ p) => p.key === 'points')).toEqual({ key: 'points', type: 'array', default: [] });
		expect(r.wiring).toMatch(/fromHandle only for namedOutputs/);
	});
	it('near-misses resolve and say so; unknown names do not fail the call', () => {
		const r = describeNodeTypes({ types: ['Latch', 'teleporter'] }, SRC);
		expect(r.types.map((/** @type {any} */ c) => c.type)).toEqual(['latch']);
		expect(r.resolved).toEqual({ Latch: 'latch' });
		expect(r.unknown).toEqual(['teleporter']);
	});
	it('a type outside the vocabulary (excluded / physics gated off) is unknown, not described', () => {
		const r = describeNodeTypes({ types: ['latch'] }, { ...SRC, vocabulary: [{ group: 'Input', types: ['time'] }] });
		expect(r.types).toEqual([]);
		expect(r.unknown).toEqual(['latch']);
	});
	it('caps a call at MAX_TYPES cards and says how to get the rest', () => {
		const r = describeNodeTypes({ types: Array.from({ length: MAX_TYPES + 5 }, () => 'latch') }, SRC);
		expect(r.types.length).toBe(1); // duplicates collapse
		expect(r.note).toMatch(String(MAX_TYPES));
	});
	it('paramsOf skips legacy params and the label default', () => {
		expect(paramsOf({ defaults: { label: 'x', a: 1 }, params: [{ key: 'old', kind: 'number', legacy: true }] })).toEqual([{ key: 'a', type: 'number', default: 1 }]);
		expect(paramsOf({ defaults: { c: '#ff0000' } })).toEqual([{ key: 'c', type: 'color', default: '#ff0000' }]);
	});
});
