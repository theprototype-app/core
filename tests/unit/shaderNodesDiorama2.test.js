// @ts-nocheck — graph fixtures built ad hoc (the checkJs rule for test fixtures)
// mcp-diorama2 (item 10): the GLSL expression node keeps the TYPE wired into a / b / c (vector inputs), and the
// three UV warps 73's shader design listed — Polar coordinates, Twirl, Rotate UV — compile into the surface IR.
import { describe, it, expect } from 'vitest';
import { compileShaderGraphToIR } from '../../src/lib/shaderCompile.js';
import { shaderNodeDef } from '../../src/lib/shaderCatalog.js';

const node = (id, type, data = {}) => ({ id, type, data });
const edge = (source, target, targetHandle, sourceHandle = 'out') => ({ id: source + '-' + target + targetHandle, source, target, sourceHandle, targetHandle });

describe('diorama2 shader nodes', () => {
	it('glsl: two colours wired into a and b stay vec3 — a * b is a vec3 expression, not their x parts', () => {
		const r = compileShaderGraphToIR({
			nodes: [node('c1', 'color', { value: '#ff8800' }), node('c2', 'color', { value: '#0088ff' }), node('g', 'glsl', { expression: 'a * b + c', type: 'vec3' }), node('s', 'surface')],
			edges: [edge('c1', 'g', 'a'), edge('c2', 'g', 'b'), edge('g', 's', 'albedo')]
		});
		expect(r.ok, String(r.errors)).toBe(true);
		const line = r.ir.body.split('\n').find((l) => l.includes('t_g ='));
		expect(line).toMatch(/^\s*vec3 t_g = \(\(t_c1\) \* \(t_c2\) \+ \(0\.0\)\);/);
	});

	it('glsl: a vec2 UV wired into a stays a vec2', () => {
		const r = compileShaderGraphToIR({
			nodes: [node('u', 'uv'), node('g', 'glsl', { expression: 'vec3(a, 0.0)', type: 'vec3' }), node('s', 'surface')],
			edges: [edge('u', 'g', 'a'), edge('g', 's', 'albedo')]
		});
		expect(r.ok, String(r.errors)).toBe(true);
		expect(r.ir.body).toMatch(/vec3 t_g = \(vec3\(\(t_u\), 0\.0\)\);/);
	});

	for (const [type, fn] of [['polarCoordinates', 'tpPolar'], ['twirl', 'tpTwirl'], ['rotateUV', 'tpRotateUv']]) {
		it(type + ': a UV warp that compiles into the surface (prelude once, USE_UV asked for), with its manual line', () => {
			const r = compileShaderGraphToIR({
				nodes: [node('w', type), node('n', 'noise'), node('s', 'surface')],
				edges: [edge('w', 'n', 'uv'), edge('n', 's', 'roughness')]
			});
			expect(r.ok, String(r.errors)).toBe(true);
			expect(r.ir.prelude.split('vec2 ' + fn + '(').length).toBe(2);
			expect(r.ir.body).toContain(fn + '(vUv');
			expect('USE_UV' in r.ir.defines).toBe(true);
			expect(shaderNodeDef(type)?.group).toBe('UV');
			expect(String(shaderNodeDef(type)?.doc).length).toBeGreaterThan(20);
		});
	}

	it('polar coordinates: radius and angle outputs are its two parts', () => {
		const r = compileShaderGraphToIR({
			nodes: [node('p', 'polarCoordinates'), node('s', 'surface')],
			edges: [edge('p', 's', 'roughness', 'angle'), edge('p', 's', 'metalness', 'radius')]
		});
		expect(r.ok, String(r.errors)).toBe(true);
		expect(r.ir.roughness).toBe('t_p.y');
		expect(r.ir.metalness).toBe('t_p.x');
	});

	it('rotate UV: Time wired into angle spins it on the shared clock', () => {
		const r = compileShaderGraphToIR({
			nodes: [node('t', 'time'), node('r', 'rotateUV', { rotation: 0.5 }), node('n', 'noise'), node('s', 'surface')],
			edges: [edge('t', 'r', 'angle'), edge('r', 'n', 'uv'), edge('n', 's', 'roughness')]
		});
		expect(r.ok, String(r.errors)).toBe(true);
		expect(r.ir.uniforms.some((u) => u.name === 'uShaderTime')).toBe(true);
		expect(r.ir.body).toMatch(/tpRotateUv\(vUv, [^,]+, t_t \+ /);
	});
});
