import { describe, it, expect } from 'vitest';
import { fittingNodes, wireMenuRows, candidateInputs, candidateOutputs } from '../../src/lib/wireSearch.js';
import { canConnect } from '../../src/lib/flowSockets.js';
import { nodeCatalog, findNodeSpec } from '../../src/lib/nodeCatalog.js';
import { rankMatches, collectLeaves } from '../../src/lib/menuFilter.js';

// 78 F1: a wire dropped into space lists the nodes that fit it — exact type first, coercions
// second (canConnect's order), and nothing the editor would then refuse.
const end = (/** @type {string} */ type, /** @type {'source'|'target'} */ side, /** @type {string|null} */ handle = null, data = {}) => ({
	node: { id: 'from', type, data },
	handle,
	side
});
const fits = (/** @type {any} */ from) => fittingNodes(from, nodeCatalog, findNodeSpec);
const has = (/** @type {any[]} */ rows, /** @type {string} */ type, /** @type {string|null} */ handle) =>
	rows.find((r) => r.type === type && r.handle === handle);

describe('wire search: which nodes fit a dragged socket', () => {
	it('an event output (On Click): exact event inputs first, coercions after — never interleaved', () => {
		const rows = fits(end('onclick', 'source'));
		expect(rows.length).toBeGreaterThan(5);
		const firstCoercion = rows.findIndex((r) => r.fit === 1);
		expect(firstCoercion).toBeGreaterThan(0);
		expect(rows.slice(firstCoercion).every((r) => r.fit === 1)).toBe(true);
		expect(has(rows, 'counter', 'pulse')?.fit).toBe(0);
		expect(has(rows, 'latch', 'set')?.fit).toBe(0);
		// the Object Selector's effect channel takes an event (4.6) — a fit, but not an exact one
		expect(has(rows, 'objectselector', null)?.fit).toBe(1);
		// event -> number is a coercion
		expect(has(rows, 'math', 'a')?.fit).toBe(1);
	});

	it('the fit flag agrees with canConnect for every row (exact = same type, else a listed coercion)', () => {
		for (const from of [end('onclick', 'source'), end('number', 'source'), end('toggle', 'source'), end('vector3', 'source')]) {
			for (const r of fits(from)) {
				if (r.toType === 'any') continue; // a Flow Output takes any value
				expect(canConnect(r.fromType, r.toType)).toBe(true);
				expect(r.fit).toBe(r.fromType === r.toType ? 0 : 1);
			}
		}
	});

	it('an effect output (Spin) fits only the Object Selector', () => {
		const rows = fits(end('spin', 'source'));
		expect(rows.map((r) => r.type)).toEqual(['objectselector']);
		expect(rows[0].fit).toBe(0);
	});

	it('dragging FROM an input lists nodes whose output feeds it (Object Selector <- effects, events)', () => {
		const rows = fits(end('objectselector', 'target'));
		expect(has(rows, 'spin', null)?.fit).toBe(0);
		expect(has(rows, 'onclick', null)?.fit).toBe(1);
		// a Sequence feeds it through its step outputs, not a plain output it does not draw
		expect(has(rows, 'sequence', 'step1')).toBeTruthy();
		expect(has(rows, 'sequence', null)).toBeFalsy();
	});

	it('a number output reaches a boolean input only as a coercion; a colour reaches Set Color exactly', () => {
		expect(has(fits(end('number', 'source')), 'visibility', 'on')?.fit).toBe(1);
		expect(has(fits(end('number', 'source')), 'math', 'a')?.fit).toBe(0);
		expect(has(fits(end('colorpicker', 'source')), 'setcolor', 'color')?.fit).toBe(0);
	});

	it('several fitting sockets on one node become one row each; a single fit stays one plain row', () => {
		const rows = wireMenuRows(fits(end('onclick', 'source')));
		const counter = rows.filter((r) => r.type === 'counter');
		expect(counter.map((r) => r.handle)).toEqual(['pulse', 'reset']);
		expect(counter.every((r) => r.perHandle)).toBe(true);
		expect(rows.find((r) => r.type === 'travel')?.perHandle).toBe(false);
	});

	it('candidate sockets: the selector effect channel, range params, sequence steps', () => {
		expect(candidateInputs('objectselector', findNodeSpec('objectselector'))).toContain(null);
		expect(candidateInputs('spin', findNodeSpec('spin'))).toContain('speed');
		expect(candidateOutputs('sequence')).toEqual(['step1', 'step2', 'step3', 'step4']);
		expect(candidateOutputs('onenter')).toEqual([null, 'other']);
	});

	it('no from node = no rows', () => {
		expect(fittingNodes(/** @type {any} */ ({ node: null, handle: null, side: 'source' }), nodeCatalog, findNodeSpec)).toEqual([]);
	});
});

describe('menu filter: a typed query keeps the fit order inside one match rank', () => {
	it('exact rows beat coercions that match the query equally well; items without a fit are unchanged', () => {
		const leaves = collectLeaves([
			{ label: 'Converts', children: [{ label: 'Counter · a', fit: 1 }] },
			{ label: 'Fits', children: [{ label: 'Counter · z', fit: 0 }] }
		]);
		// alphabetical alone would put "· a" first
		expect(rankMatches(leaves, 'count').map((m) => m.item.label)).toEqual(['Counter · z', 'Counter · a']);
		const plain = collectLeaves([{ label: 'Beta' }, { label: 'Alpha' }]);
		expect(rankMatches(plain, 'a').map((m) => m.item.label)).toEqual(['Alpha', 'Beta']);
	});
});
