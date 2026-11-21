// 102b-papercuts (scout row 18): real distance and height fog
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { fogKindOf, fogDensityOf, heightFogOf, heightFogParams, fogKindPatch, fogFactorAt } from '../../src/lib/fogModes.js';
import { HEIGHT_FOG, setHeightFog } from '../../src/lib/fogModes.js';
import { installHeightFog } from '../../src/lib/fogShader.js';
import { mergeFogPatch } from '../../src/lib/fogReach.js';

describe('fog kinds', () => {
	it('a fog with no kind is the linear fog every older document has', () => {
		const old = { color: '#fff', near: 1, far: 50 };
		expect(fogKindOf(old)).toBe('linear');
		expect(heightFogOf(old)).toBe(null);
		expect(heightFogParams(old)).toEqual([0, 0, 0, 0]);
		expect(heightFogParams(null)).toEqual([0, 0, 0, 0]);
		expect(fogKindOf({ kind: 'nonsense' })).toBe('linear');
	});
	it('switching kind fills in what the new kind needs and keeps near / far', () => {
		const fog = { color: '#fff', near: 1, far: 50 };
		const d = mergeFogPatch(fog, fogKindPatch(fog, 'distance'));
		expect(d).toMatchObject({ kind: 'distance', density: 0.02, near: 1, far: 50 });
		const h = mergeFogPatch(d, fogKindPatch(d, 'height'));
		expect(h).toMatchObject({ kind: 'height', density: 0.02, base: 0, thickness: 6, near: 1, far: 50 });
		expect(fogKindOf(mergeFogPatch(h, fogKindPatch(h, 'linear')))).toBe('linear');
	});
	it('values are clamped', () => {
		expect(fogDensityOf({ density: -1 })).toBe(0.02);
		expect(fogDensityOf({ density: 5 })).toBe(1);
		expect(heightFogOf({ kind: 'height', base: 'x', thickness: 0 })).toEqual({ base: 0, thickness: 6 });
		expect(heightFogParams({ kind: 'height', base: 2, thickness: 4 })).toEqual([2, 0.25, 1, 0]);
	});
});

describe('fogFactorAt (the shader maths)', () => {
	const ground = { kind: 'height', density: 0.1, base: 0, thickness: 2 };
	it('distance fog thickens with distance', () => {
		const f = { kind: 'distance', density: 0.05 };
		expect(fogFactorAt(f, 10, 0, 0)).toBeLessThan(fogFactorAt(f, 40, 0, 0));
		expect(fogFactorAt(f, 0, 0, 0)).toBe(0);
	});
	it('height fog: on the ground it fogs, high up the same distance barely does', () => {
		const low = fogFactorAt(ground, 30, 0.5, 0.5);
		const high = fogFactorAt(ground, 30, 20, 20);
		expect(low).toBeGreaterThan(0.8);
		expect(high).toBeLessThan(0.01);
	});
	it('looking down into it fogs more than looking across above it', () => {
		expect(fogFactorAt(ground, 30, 10, 0)).toBeGreaterThan(fogFactorAt(ground, 30, 10, 10));
	});
	it('linear fog is smoothstep(near, far), as three', () => {
		expect(fogFactorAt({ near: 10, far: 20 }, 15, 0, 0)).toBeCloseTo(0.5);
	});
});

describe('the shader patch', () => {
	it('three\'s fog chunks carry the layer; the stock branches are still there', () => {
		expect(THREE.ShaderChunk.fog_fragment).not.toContain('fogHeight'); // nothing until a height fog asks
		expect(installHeightFog()).toBe(true);
		expect(installHeightFog()).toBe(false); // once
		expect(THREE.ShaderChunk.fog_fragment).toContain('fogHeight.z > 0.5');
		expect(THREE.ShaderChunk.fog_fragment).toContain('smoothstep( fogNear, fogFar, vFogDepth )');
		expect(THREE.ShaderChunk.fog_vertex).toContain('vFogWorldY');
		expect(THREE.ShaderChunk.fog_pars_fragment).toContain('uniform vec4 fogHeight;');
	});
	it('every built-in material shares ONE uniform value (a clone passes it by reference)', () => {
		const lib = /** @type {any} */ (THREE.ShaderLib);
		expect(lib.standard.uniforms.fogHeight.value).toBe(HEIGHT_FOG);
		expect(lib.physical.uniforms.fogHeight.value).toBe(HEIGHT_FOG);
		expect(lib.basic.uniforms.fogHeight.value).toBe(HEIGHT_FOG);
		expect(THREE.UniformsUtils.clone(lib.standard.uniforms).fogHeight.value).toBe(HEIGHT_FOG);
		setHeightFog([1, 0.5, 1, 0]);
		expect(Array.from(HEIGHT_FOG)).toEqual([1, 0.5, 1, 0]);
		setHeightFog([0, 0, 0, 0]);
	});
	it('the world height the vertex chunk reconstructs is right for a turned, moved camera', () => {
		const cam = new THREE.PerspectiveCamera();
		cam.position.set(3, 7, -2);
		cam.rotation.set(-0.4, 1.1, 0.2);
		cam.updateMatrixWorld();
		const view = cam.matrixWorldInverse;
		const p = new THREE.Vector3(5, 1.5, 8);
		const mv = p.clone().applyMatrix4(view);
		const e = view.elements; // column-major, as GLSL
		const col1 = new THREE.Vector3(e[4], e[5], e[6]);
		const t = new THREE.Vector3(e[12], e[13], e[14]);
		expect(col1.dot(mv.clone().sub(t))).toBeCloseTo(1.5, 5);
	});
});
