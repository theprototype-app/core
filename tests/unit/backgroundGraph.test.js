// 65 M2 — the BACKGROUND shader domain: catalog + compiler, no browser (both modules are
// pure). The GLSL itself is compiled for real by tests/e2e/background-glsl.test.cjs
// (glslangValidator) and rendered by tests/e2e/background-layer.test.cjs.
import { describe, it, expect } from 'vitest';
import {
	compileBackgroundGraphToIR,
	compileShaderGraphToIR,
	BACKGROUND_BUILTIN_UNIFORMS
} from '../../src/lib/shaderCompile.js';
import {
	shaderNodeDef,
	shaderNodeDefs,
	outputNodeFor,
	stageForDomain,
	BACKGROUND_OUTPUT_NODE
} from '../../src/lib/shaderCatalog.js';

let seq = 0;
const node = (type, data = {}) => ({
	id: type + '_' + ++seq,
	type,
	data,
	position: { x: 0, y: 0 }
});
const edge = (from, to, targetHandle, sourceHandle = 'out') => ({
	id: 'e' + ++seq,
	source: from.id,
	sourceHandle,
	target: to.id,
	targetHandle
});
/** count whole-word occurrences of a GLSL function DEFINITION */
const defs = (glsl, name) =>
	(glsl.match(new RegExp('\\b(?:float|vec2|vec3|vec4) ' + name + '\\(', 'g')) ?? []).length;

describe('background domain plumbing', () => {
	it('names its terminal and stage', () => {
		expect(outputNodeFor('background')).toBe(BACKGROUND_OUTPUT_NODE);
		expect(outputNodeFor('post')).toBe('postOutput');
		expect(outputNodeFor('surface')).toBe('surface');
		expect(stageForDomain('background')).toBe('background');
		expect(stageForDomain('surface')).toBe('fragment');
	});
	it('documents every new node', () => {
		for (const key of [
			'fbm',
			'domainWarp',
			'meshGradient',
			'blobs',
			'smoothMin',
			'grain',
			'rotateUv',
			'pointer',
			'scroll',
			'aspectUv',
			BACKGROUND_OUTPUT_NODE
		])
			expect(shaderNodeDef(key)?.doc?.length ?? 0, key).toBeGreaterThan(12);
		expect(shaderNodeDefs().filter((d) => !d.doc)).toEqual([]);
	});
});

describe('compileBackgroundGraphToIR', () => {
	it('refuses a graph with no output, and one with nothing wired', () => {
		expect(compileBackgroundGraphToIR({ nodes: [node('color')], edges: [] }).ok).toBe(false);
		const r = compileBackgroundGraphToIR({ nodes: [node(BACKGROUND_OUTPUT_NODE)], edges: [] });
		expect(r.ok).toBe(false);
		expect(r.errors?.[0]).toMatch(/colour/);
	});

	it('compiles the smallest graph into a whole fragment shader', () => {
		const c = node('color', { value: '#ff0000' });
		const out = node(BACKGROUND_OUTPUT_NODE);
		const r = compileBackgroundGraphToIR({ nodes: [c, out], edges: [edge(c, out, 'color')] });
		expect(r.ok).toBe(true);
		const f = r.ir?.fragment ?? '';
		expect(f).toMatch(/varying vec2 vUv;/);
		expect(f).toMatch(/void main\(\)/);
		expect(f).toMatch(/gl_FragColor = vec4\(/);
		expect(f).toMatch(/#include <colorspace_fragment>/);
		// opaque unless alpha is wired
		expect(f).toMatch(/clamp\(1\.0, 0\.0, 1\.0\)/);
		expect(r.ir?.usesPointer).toBe(false);
	});

	it('declares the layer uniforms exactly once (the material owns them)', () => {
		const p = node('pointer');
		const t = node('time');
		const b = node('blobs');
		const out = node(BACKGROUND_OUTPUT_NODE);
		const r = compileBackgroundGraphToIR({
			nodes: [p, t, b, out],
			edges: [edge(p, b, 'attract', 'position'), edge(b, out, 'color', 'mask')]
		});
		expect(r.ok, String(r.errors)).toBe(true);
		const f = r.ir?.fragment ?? '';
		for (const name of BACKGROUND_BUILTIN_UNIFORMS)
			expect(
				f.split('uniform ').filter((s) => s.match(new RegExp('^\\w+ ' + name + ';'))).length,
				name
			).toBe(1);
		expect(r.ir?.usesPointer).toBe(true);
		expect(r.ir?.usesClock).toBe(true);
		expect(r.ir?.uniforms.some((u) => u.name === 'uShaderTime')).toBe(false);
	});

	it('hoists a shared prelude ONCE when a graph holds the helper and its users', () => {
		const n = node('noise');
		const f = node('fbm');
		const w = node('domainWarp');
		const g = node('grain');
		const add1 = node('add');
		const add2 = node('add');
		const out = node(BACKGROUND_OUTPUT_NODE);
		const r = compileBackgroundGraphToIR({
			nodes: [n, f, w, g, add1, add2, out],
			edges: [
				edge(w, f, 'uv'),
				edge(n, add1, 'a'),
				edge(f, add1, 'b'),
				edge(add1, add2, 'a'),
				edge(g, add2, 'b'),
				edge(add2, out, 'color')
			]
		});
		expect(r.ok, String(r.errors)).toBe(true);
		const glsl = r.ir?.fragment ?? '';
		expect(defs(glsl, 'tpHash21')).toBe(1);
		expect(defs(glsl, 'tpFbm')).toBe(1);
		expect(defs(glsl, 'tpWarp')).toBe(1);
		// the helper comes BEFORE its users
		expect(glsl.indexOf('float tpHash21(')).toBeLessThan(glsl.indexOf('float tpFbm('));
		expect(glsl.indexOf('float tpFbm(')).toBeLessThan(glsl.indexOf('vec2 tpWarp('));
		// the device-budget knob is a guarded define, so the layer can lower it
		expect(glsl).toMatch(/#ifndef TP_OCTAVE_CAP/);
	});

	it('refuses a surface-only node by name', () => {
		const nrm = node('normal');
		const out = node(BACKGROUND_OUTPUT_NODE);
		const r = compileBackgroundGraphToIR({ nodes: [nrm, out], edges: [edge(nrm, out, 'color')] });
		expect(r.ok).toBe(false);
		expect(r.errors?.[0]).toMatch(/only works in the surface stage, not in background/);
	});

	it('keeps background inputs out of the other domains', () => {
		const p = node('pointer');
		const s = node('surface');
		const r = compileShaderGraphToIR({ nodes: [p, s], edges: [edge(p, s, 'albedo', 'position')] });
		expect(r.ok).toBe(false);
		expect(r.errors?.[0]).toMatch(/background stage/);
	});

	it('lets the new pattern nodes drive an ordinary SURFACE too', () => {
		const f = node('fbm');
		const m = node('meshGradient');
		const mul = node('multiply');
		const s = node('surface');
		const r = compileShaderGraphToIR({
			nodes: [f, m, mul, s],
			edges: [edge(m, mul, 'a'), edge(f, mul, 'b'), edge(mul, s, 'albedo')]
		});
		expect(r.ok, String(r.errors)).toBe(true);
		expect(defs(r.ir.prelude, 'tpHash21')).toBe(1);
	});

	it('the Bayer node reads the pixel grid in a background', () => {
		const b = node('bayer');
		const out = node(BACKGROUND_OUTPUT_NODE);
		const r = compileBackgroundGraphToIR({ nodes: [b, out], edges: [edge(b, out, 'color')] });
		expect(r.ok, String(r.errors)).toBe(true);
		expect(r.ir?.fragment).toMatch(/tpBayer4\(gl_FragCoord\.xy/);
	});
});
