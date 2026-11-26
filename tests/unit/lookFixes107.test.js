// @ts-nocheck — fixtures built ad hoc
// 107-look-fixes: the shader graph diagnostics (dangling nodes, an unwired output, GLSL expression problems per node) and
// the history rollback a failed multi-op edit_mesh call uses (every entry since the mark taken back, none left behind).
import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$lib/geometries.svelte', async () => (await import('./helpers/geometriesStub.js')).geometriesStub());

const { shaderGraphDiagnostics } = await import('../../src/lib/ai/lookToolsCore.js');
const { glslExpressionProblem } = await import('../../src/lib/shaderCode.js');
const cat = await import('../../src/lib/shaderCatalog.js');
const history = await import('../../src/lib/history.js');

const diag = (graph) => shaderGraphDiagnostics(graph, (k) => cat.shaderNodeDef(k), { output: 'surface', expressionProblem: glslExpressionProblem });
const n = (id, type, data = {}) => ({ id, type, data });
const e = (source, target, targetHandle) => ({ id: source + '-' + target, source, target, targetHandle });

describe('107 shaderGraphDiagnostics', () => {
	it('a clean graph says nothing', () => {
		const d = diag({ nodes: [n('c', 'color'), n('out', 'surface')], edges: [e('c', 'out', 'emissive')] });
		expect(d).toEqual({ errors: [], warnings: [], dangling: [] });
	});
	it('names a node whose result reaches no output, with its label', () => {
		const d = diag({ nodes: [n('c', 'color'), n('x', 'float', { label: 'Spare' }), n('out', 'surface')], edges: [e('c', 'out', 'emissive')] });
		expect(d.dangling).toEqual([{ node: 'x', type: 'float', label: 'Spare' }]);
		expect(d.warnings.join(' ')).toMatch(/x \(float\)/);
	});
	it('a node feeding a dangling node is dangling too; one feeding the output is not', () => {
		const d = diag({ nodes: [n('a', 'float'), n('b', 'sin'), n('c', 'color'), n('out', 'surface')], edges: [e('a', 'b', 'a'), e('c', 'out', 'albedo')] });
		expect(d.dangling.map((x) => x.node).sort()).toEqual(['a', 'b']);
	});
	it('says when nothing is wired into the output, or there is none', () => {
		expect(diag({ nodes: [n('out', 'surface')], edges: [] }).warnings[0]).toMatch(/nothing is wired into the surface/);
		expect(diag({ nodes: [n('c', 'color')], edges: [] }).warnings[0]).toMatch(/no surface output/);
	});
	it('an invalid expression is an error naming its node, dangling or not', () => {
		for (const bad of ['a +* b', 'a +', '', 'sin(a', 'a; discard']) {
			const d = diag({ nodes: [n('g', 'glsl', { expression: bad }), n('out', 'surface')], edges: [] });
			expect(d.errors.length, bad).toBe(1);
			expect(d.errors[0]).toMatch(/node "g"/);
		}
	});
	it('a good expression passes; an unknown name is a warning, a swizzle and built-ins are not', () => {
		const ok = diag({ nodes: [n('g', 'glsl', { expression: 'mix(a, b, smoothstep(0.0, 1.0, c)) * vec3(1.0).x + sin(uShaderTime)' }), n('out', 'surface')], edges: [e('g', 'out', 'roughness')] });
		expect(ok.errors).toEqual([]);
		expect(ok.warnings).toEqual([]);
		const warn = diag({ nodes: [n('g', 'glsl', { expression: 'a * wobble' }), n('out', 'surface')], edges: [e('g', 'out', 'roughness')] });
		expect(warn.errors).toEqual([]);
		expect(warn.warnings[0]).toMatch(/`wobble`/);
	});
});

describe('107 history rollbackTo', () => {
	const seen = [];
	history.registerHistoryKind('t107', (entry, state) => {
		seen.push(entry.id + ':' + state);
		return true;
	});
	it('inside a batch: takes back the entries since the mark, newest first, and leaves the earlier ones', () => {
		seen.length = 0;
		history.beginHistoryBatch();
		history.recordEntry({ kind: 't107', id: 1, before: 'b', after: 'a' });
		const mark = history.historyMark();
		history.recordEntry({ kind: 't107', id: 2, before: 'b', after: 'a' });
		history.recordEntry({ kind: 't107', id: 3, before: 'b', after: 'a' });
		expect(history.rollbackTo(mark)).toBe(true);
		expect(seen).toEqual(['3:b', '2:b']);
		const depth = get(history.undoStack).length;
		history.endHistoryBatch('t');
		const top = get(history.undoStack).at(-1);
		expect(get(history.undoStack).length).toBe(depth + 1);
		expect(top.entries.map((x) => x.id)).toEqual([1]);
	});
	it('a batch with nothing left after the rollback commits no step', () => {
		history.beginHistoryBatch();
		const mark = history.historyMark();
		history.recordEntry({ kind: 't107', id: 4, before: 'b', after: 'a' });
		history.rollbackTo(mark);
		const depth = get(history.undoStack).length;
		history.endHistoryBatch('t');
		expect(get(history.undoStack).length).toBe(depth);
	});
	it('outside a batch: pops the entries off the undo stack', () => {
		seen.length = 0;
		const depth = get(history.undoStack).length;
		const mark = history.historyMark();
		history.recordEntry({ kind: 't107', id: 5, before: 'b', after: 'a' });
		history.recordEntry({ kind: 't107', id: 6, before: 'b', after: 'a' });
		expect(history.rollbackTo(mark)).toBe(true);
		expect(seen).toEqual(['6:b', '5:b']);
		expect(get(history.undoStack).length).toBe(depth);
	});
	it('refuses when a different batch opened under the mark', () => {
		const mark = history.historyMark();
		history.beginHistoryBatch();
		history.recordEntry({ kind: 't107', id: 7, before: 'b', after: 'a' });
		expect(history.rollbackTo(mark)).toBe(false);
		history.endHistoryBatch('t');
	});
});

describe('107 setPayloadTransform keeps the stored tiling in step', async () => {
	const { setPayloadTransform } = await import('../../src/lib/ai/lookToolsCore.js');
	const payload = () => ({
		materials: [{ uuid: 'm0', map: 't0', userData: { texTransform: { repeat: [2, 2], offset: [0, 0], rotation: 0 } } }, { uuid: 'm1', map: 't0' }],
		textures: [{ uuid: 't0', repeat: [2, 2] }],
		images: []
	});
	it('writes userData.texTransform on the slot it tiled, and gives a shared texture its own copy', () => {
		const p = payload();
		let n = 0;
		setPayloadTransform(p, 0, { tiling: [5, 5], errors: [] }, undefined, () => 'new' + n++);
		expect(p.materials[0].userData.texTransform).toEqual({ repeat: [5, 5], offset: [0, 0], rotation: 0 });
		expect(p.materials[0].map).toBe('new0');
		expect(p.materials[1].map).toBe('t0');
		expect(p.textures.find((t) => t.uuid === 't0').repeat).toEqual([2, 2]);
	});
	it('back to 1 x 1 drops the stored copy', () => {
		const p = payload();
		setPayloadTransform(p, 0, { tiling: [1, 1], errors: [] }, undefined, () => 'x');
		expect(p.materials[0].userData.texTransform).toBeUndefined();
	});
});
