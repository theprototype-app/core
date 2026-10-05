import { describe, it, expect } from 'vitest';
import {
	tabMatches,
	findTab,
	isDirty,
	reconcileExternal,
	reloadTab,
	nextActiveAfterClose,
	parseCheck,
	parseGraphJson,
	graphJson,
	scriptFileName
} from '../../src/lib/codeTabs.js';

// 36-code: the code workspace's tab model, parse check and B6 graph-JSON validation — the
// parts that are easy to get subtly wrong, with no store, DOM or peer.

/** @param {any} over @returns {any} */
const tab = (over) => ({ id: 't', kind: 'node', title: 'x', lang: 'js', code: 'a', saved: 'a', ...over });

describe('identity', () => {
	it('a node tab is its node in its graph', () => {
		const t = tab({ nodeId: 'n1', graphId: 'scene' });
		expect(tabMatches(t, { kind: 'node', nodeId: 'n1' })).toBe(true);
		expect(tabMatches(t, { kind: 'node', nodeId: 'n1', graphId: 'obj' })).toBe(false);
		expect(tabMatches(t, { kind: 'behaviour', nodeId: 'n1' })).toBe(false);
	});
	it('a file tab is found by its item, else by the hash it holds now', () => {
		const t = tab({ kind: 'file', itemId: 'i1', hash: 'h2' });
		expect(tabMatches(t, { kind: 'file', itemId: 'i1', hash: 'zzz' })).toBe(true);
		expect(tabMatches(t, { kind: 'file', hash: 'h2' })).toBe(true);
		// a peer's copy: no local item, the bytes decide
		const peer = tab({ kind: 'file', itemId: null, hash: 'h2' });
		expect(tabMatches(peer, { kind: 'file', itemId: 'i9', hash: 'h2' })).toBe(true);
		expect(tabMatches(peer, { kind: 'file', hash: 'old' })).toBe(false);
	});
	it('module and graph tabs', () => {
		expect(tabMatches(tab({ kind: 'module', moduleId: 'm', name: 'a.js' }), { kind: 'module', moduleId: 'm', name: 'a.js' })).toBe(true);
		expect(tabMatches(tab({ kind: 'module', moduleId: 'm', name: 'a.js' }), { kind: 'module', moduleId: 'm', name: 'b.js' })).toBe(false);
		expect(tabMatches(tab({ kind: 'graph' }), { kind: 'graph', graphId: 'scene' })).toBe(true);
		expect(findTab([tab({ id: 'a', kind: 'graph', graphId: 'u1' })], { kind: 'graph', graphId: 'u1' })?.id).toBe('a');
		expect(findTab([], { kind: 'graph' })).toBe(null);
	});
});

describe('the external-edit rule', () => {
	it('a clean tab follows its source', () => {
		const t = reconcileExternal(tab({ code: 'a', saved: 'a' }), 'b');
		expect(t.code).toBe('b');
		expect(t.saved).toBe('b');
		expect(isDirty(t)).toBe(false);
	});
	it('a dirty tab keeps the user text and goes stale', () => {
		const t = reconcileExternal(tab({ code: 'mine', saved: 'a' }), 'theirs');
		expect(t.code).toBe('mine');
		expect(t.stale).toBe(true);
		expect(t.external).toBe('theirs');
		const back = reloadTab(t);
		expect(back.code).toBe('theirs');
		expect(back.stale).toBe(false);
		expect(isDirty(back)).toBe(false);
	});
	it('an echo of our own save is not an external edit', () => {
		const t = tab({ code: 'b', saved: 'a' });
		const after = reconcileExternal(t, 'b');
		expect(after.saved).toBe('b');
		expect(after.stale).toBe(false);
		expect(reconcileExternal(tab({}), 'a')).toEqual(tab({}));
	});
	it('a read-only tab is never dirty', () => {
		expect(isDirty(tab({ readOnly: true, code: 'x', saved: 'y' }))).toBe(false);
	});
});

describe('closing', () => {
	const tabs = [tab({ id: 'a' }), tab({ id: 'b' }), tab({ id: 'c' })];
	it('the right neighbour, else the left, else none', () => {
		expect(nextActiveAfterClose(tabs, 'b', 'b')).toBe('c');
		expect(nextActiveAfterClose(tabs, 'c', 'c')).toBe('b');
		expect(nextActiveAfterClose([tabs[0]], 'a', 'a')).toBe(null);
		expect(nextActiveAfterClose(tabs, 'a', 'c')).toBe('c');
	});
});

describe('the parse check', () => {
	it('a script body may return at top level', () => {
		expect(parseCheck('return { out: inputs.a * 2 };', 'script')).toBe(null);
		expect(parseCheck('object.position.x = time;', 'script')).toBe(null);
	});
	it('names the line of a syntax error', () => {
		const e = parseCheck('const a = 1;\nconst b = ;\n', 'script');
		expect(e?.line).toBe(2);
		expect(e?.message).toMatch(/Unexpected/);
		expect(e?.message).not.toMatch(/\(\d+:\d+\)/);
	});
	it('a behaviour is a module', () => {
		expect(parseCheck('export default behaviour({ on: {} });', 'behaviour')).toBe(null);
		expect(parseCheck('export default behaviour({ on: {} });', 'script')?.message).toMatch(/import|export/);
		expect(parseCheck('export default behaviour({ on: { start() { } } );', 'behaviour')?.line).toBe(1);
	});
	it('JSON errors carry a line', () => {
		expect(parseCheck('{"a": 1}', 'json')).toBe(null);
		const e = parseCheck('{\n  "a": 1,\n  "b": \n}', 'json');
		expect(e).not.toBe(null);
		expect(e?.line).toBeGreaterThanOrEqual(3);
	});
});

describe('B6: graph JSON', () => {
	const current = {
		nodes: [
			{ id: 'a', type: 'time', position: { x: 0, y: 0 }, data: { type: 'time' } },
			{ id: 'b', type: 'spin', position: { x: 200, y: 0 }, data: { type: 'spin' } }
		],
		edges: [{ id: 'e-a-b', source: 'a', target: 'b' }]
	};
	it('round-trips unchanged', () => {
		const r = parseGraphJson(graphJson(current), current);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.changed).toBe(false);
		expect(r.removedNodes).toEqual([]);
		expect(JSON.stringify({ nodes: r.nodes, edges: r.edges })).toBe(JSON.stringify(current));
	});
	it('reports removals and keeps a known node position when one is omitted', () => {
		const text = JSON.stringify({ nodes: [{ id: 'a', type: 'time', data: { type: 'time' } }], edges: [] });
		const r = parseGraphJson(text, current);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.removedNodes).toEqual(['b']);
		expect(r.removedEdges).toEqual(['e-a-b']);
		expect(r.nodes[0].position).toEqual({ x: 0, y: 0 });
		expect(r.changed).toBe(true);
	});
	it('a new node with no position takes a slot below the graph', () => {
		const text = JSON.stringify({ nodes: [...current.nodes, { id: 'c', type: 'time' }], edges: current.edges });
		const r = parseGraphJson(text, current);
		expect(r.ok && r.nodes[2].position.y).toBeGreaterThan(0);
		expect(r.ok && r.nodes[2].data).toEqual({});
	});
	it('invalid JSON never applies', () => {
		const r = parseGraphJson('{"nodes": [', current);
		expect(r.ok).toBe(false);
	});
	it('refuses shape errors with a reason', () => {
		/** @param {any} doc */
		const bad = (doc) => {
			const r = parseGraphJson(JSON.stringify(doc, null, 2), current);
			return r.ok ? '' : r.error.message;
		};
		expect(bad([])).toMatch(/Expected an object/);
		expect(bad({ nodes: [{ type: 'x' }] })).toMatch(/needs a string "id"/);
		expect(bad({ nodes: [{ id: 'q' }] })).toMatch(/needs a string "type"/);
		expect(bad({ nodes: [{ id: 'q', type: 'x' }, { id: 'q', type: 'y' }] })).toMatch(/share the id/);
		expect(bad({ nodes: [{ id: 'q', type: 'x', position: { x: 'a', y: 1 } }] })).toMatch(/position/);
		expect(bad({ nodes: [{ id: 'q', type: 'x', data: [] }] })).toMatch(/data/);
		expect(bad({ nodes: [{ id: 'q', type: 'x' }], edges: [{ id: 'e', source: 'q', target: 'zz' }] })).toMatch(/no node "zz"/);
		expect(bad({ nodes: [{ id: 'q', type: 'x' }], edges: {} })).toMatch(/edges/);
	});
	it('a refusal names the line of the offending entry', () => {
		const text = graphJson({ nodes: [...current.nodes, { id: 'zz', type: 'time', position: { x: 0, y: 0 }, data: {} }], edges: [{ id: 'e9', source: 'zz', target: 'nope' }] });
		const r = parseGraphJson(text, current);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(text.split('\n')[r.error.line - 1]).toContain('"e9"');
	});
});

describe('script file names', () => {
	it('end in .js and lose path characters', () => {
		expect(scriptFileName('wobble')).toBe('wobble.js');
		expect(scriptFileName('a/b.JS')).toBe('a-b.JS');
		expect(scriptFileName('')).toBe('script.js');
	});
});

describe('JSON error lines on engines that name no position', () => {
	it('a trailing comma and a missing value', () => {
		// V8 points at the `}` after the comma (line 3); the pattern fallback at the comma (2)
		expect([2, 3]).toContain(parseCheck('{\n  "a": 1,\n}', 'json')?.line);
		expect(parseCheck('{\n  "a": 1,\n  "b": \n}', 'json')?.line).toBe(4);
	});
});

describe("G1's OpenCodeRequest shape", () => {
	it('a string ref becomes the object form', async () => {
		const { normalizeCodeRequest } = await import('../../src/lib/codeTabs.js');
		expect(normalizeCodeRequest({ source: 'script', ref: 'n1', graphId: 'u1' }).ref).toEqual({ nodeId: 'n1', graphId: 'u1' });
		expect(normalizeCodeRequest({ source: 'behaviour', ref: 'n2' }).ref).toEqual({ nodeId: 'n2' });
		expect(normalizeCodeRequest({ source: 'module', ref: 'towers/levels.js', readonly: true }).ref).toEqual({ moduleId: 'towers', name: 'levels.js' });
		expect(normalizeCodeRequest({ source: 'module', ref: 'towers' }).ref).toEqual({ moduleId: 'towers' });
		expect(normalizeCodeRequest({ source: 'customnode', ref: 'def-1' }).ref).toEqual({ defId: 'def-1' });
		expect(normalizeCodeRequest({ source: 'script', ref: { itemId: 'i' } }).ref).toEqual({ itemId: 'i' });
		expect(normalizeCodeRequest({ source: 'graph', ref: {}, graphId: 'g' }).ref).toEqual({ graphId: 'g' });
	});
});
