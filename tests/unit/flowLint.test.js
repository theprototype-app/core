import { describe, it, expect } from 'vitest';
import { lintFlowGraph, lintFlowGraphs, isReversedTriggerEdge, SELECTOR_TRIGGERS } from '../../src/lib/flowLint.js';

// 78 F24 (research round 2): an Object Selector wired INTO On Click silently never fires —
// the runtime walks forward from the trigger to the selector. The lint names it and says how to fix it.
const node = (/** @type {string} */ id, /** @type {string} */ type, data = {}) => ({ id, type, data: { label: '', ...data } });
const edge = (
	/** @type {string} */ source,
	/** @type {string} */ target,
	/** @type {string | null} */ sourceHandle = null,
	/** @type {string | null} */ targetHandle = null
) => ({
	id: `e-${source}${sourceHandle ? '.' + sourceHandle : ''}-${target}${targetHandle ? '.' + targetHandle : ''}`,
	source,
	target,
	sourceHandle,
	targetHandle
});

describe('flowLint: reversed trigger wires', () => {
	const sel = node('sel', 'objectselector', { selected: 'box-uuid' });
	const click = node('click', 'onclick', { label: 'On Click' });

	it('flags Object Selector -> On Click and offers the reversed wire', () => {
		const found = lintFlowGraph([sel, click], [edge('sel', 'click')]);
		expect(found).toHaveLength(1);
		expect(found[0].code).toBe('reversed-trigger');
		expect(found[0].edgeId).toBe('e-sel-click');
		expect(found[0].message).toMatch(/Backwards wire.*On Click never fires/);
		expect(found[0].fix).toEqual({ kind: 'reverse', source: 'click', target: 'sel', sourceHandle: null, targetHandle: null });
	});

	it('the right way round (On Click -> Object Selector) is clean', () => {
		expect(lintFlowGraph([sel, click], [edge('click', 'sel')])).toEqual([]);
	});

	it('a selector into a declared object input (On Enter filter) is how a filter is wired, not a warning', () => {
		const enter = node('enter', 'onenter');
		expect(lintFlowGraph([sel, enter], [edge('sel', 'enter', null, 'filter')])).toEqual([]);
		// …but into the body of On Enter it is the same dead wire
		expect(lintFlowGraph([sel, enter], [edge('sel', 'enter')])).toHaveLength(1);
	});

	it('every trigger that finds its object through a selector is covered; other targets are not', () => {
		for (const type of SELECTOR_TRIGGERS) expect(isReversedTriggerEdge(edge('sel', 't'), sel, node('t', type))).toBe(true);
		expect(isReversedTriggerEdge(edge('sel', 'd'), sel, node('d', 'distance'))).toBe(false);
		expect(isReversedTriggerEdge(edge('n', 'click'), node('n', 'number'), click)).toBe(false);
	});

	it('the message uses the node name, falls back to its type, and skips group proxy edges', () => {
		const bare = node('c2', 'ongrab');
		expect(lintFlowGraph([sel, bare], [edge('sel', 'c2')])[0].message).toMatch(/feeds ongrab/);
		expect(lintFlowGraph([sel, click], [{ ...edge('sel', 'click'), data: { proxy: true } }])).toEqual([]);
	});

	it('lintFlowGraphs keys findings by graph and leaves clean graphs out', () => {
		const graphs = {
			scene: { nodes: [sel, click], edges: [edge('click', 'sel')] },
			'obj-1': { nodes: [sel, click], edges: [edge('sel', 'click')] }
		};
		const out = lintFlowGraphs(graphs);
		expect(Object.keys(out)).toEqual(['obj-1']);
		expect(out['obj-1'][0].edgeId).toBe('e-sel-click');
	});
});
