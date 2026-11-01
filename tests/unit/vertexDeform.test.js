// @ts-nocheck — plain fixtures; the module under test is typed
// fix-agenttest item 2: stacked vertex deformers share ONE material clone and inject each
// chunk once — Body Wave + Jiggle on one object used to redefine bwToRoot and break the program.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { addDeformer, removeDeformer, deformersOf, hasDeformer } from '../../src/lib/vertexDeform.js';
import { JIGGLE_VERTEX, JIGGLE_UNIFORMS_DECL } from '../../src/lib/sim/jiggleCore.js';
import { WAVE_DECL, WAVE_VERTEX } from '../../src/lib/motion/motionNodes.js';

const SPECS = {
	bodywave: () => ({
		kind: 'bodywave', prefix: 'bw', key: 'bodywave1', decl: WAVE_DECL, vertex: WAVE_VERTEX,
		uniforms: { bwToRoot: { value: new THREE.Matrix4() }, bwFromRoot: { value: new THREE.Matrix3() }, bwAxis: { value: new THREE.Vector3() }, bwSide: { value: new THREE.Vector3() }, bwRange: { value: new THREE.Vector2() }, bwShape: { value: new THREE.Vector4() }, bwDrive: { value: new THREE.Vector3() } }
	}),
	jiggle: () => ({
		kind: 'jiggle', prefix: 'j', key: 'jiggle1', decl: JIGGLE_UNIFORMS_DECL, vertex: JIGGLE_VERTEX,
		uniforms: { jOffset: { value: new THREE.Vector3() }, jPivot: { value: new THREE.Vector3() }, jRadius: { value: 1 }, jFalloff: { value: 1.5 }, jWobble: { value: 0 } }
	})
};

/** run the material's hook on three's real standard vertex shader */
function compiled(material) {
	const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
	material.onBeforeCompile(shader, null);
	return shader;
}

/** every `uniform <type> <name>;` declared more than once */
function redefinitions(source) {
	const seen = new Map();
	for (const m of source.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
	return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

const PAIRS = [['bodywave', 'jiggle'], ['jiggle', 'bodywave'], ['bodywave', 'bodywave'], ['jiggle', 'jiggle']];

describe('vertexDeform', () => {
	for (const [a, b] of PAIRS) {
		it(`${a} + ${b} on one mesh: one clone, each chunk once, both deform`, () => {
			const original = new THREE.MeshStandardMaterial({ color: 0x336699 });
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original);
			const sa = SPECS[a]();
			const sb = SPECS[b]();
			const c1 = addDeformer(mesh, a + ':1', sa);
			const c2 = addDeformer(mesh, b + ':2', sb);
			expect(c1).toBe(c2); // the second deformer joins the clone, it does not wrap it
			expect(mesh.material).toBe(c1);
			expect(c1.uuid).toBe(original.uuid);
			expect(deformersOf(mesh)).toEqual([a + ':1', b + ':2']);
			const shader = compiled(mesh.material);
			expect(redefinitions(shader.vertexShader)).toEqual([]);
			expect(shader.vertexShader.match(/#include <begin_vertex>/g)?.length).toBe(1);
			// both bodies of code are in, and their uniforms are the callers' own objects
			const firstName = Object.keys(sa.uniforms)[0];
			expect(shader.uniforms[firstName]).toBe(sa.uniforms[firstName]);
			const second = Object.keys(sb.uniforms)[0];
			const secondName = a === b ? second + '_1' : second;
			expect(shader.uniforms[secondName]).toBe(sb.uniforms[second]);
			// a distinct program per stack
			expect(mesh.material.customProgramCacheKey()).toContain(a === b ? sa.key + '|' + sb.key + '_1' : sa.key + '|' + sb.key);

			// one out: the other keeps deforming, recompiled without it
			removeDeformer(mesh, a + ':1');
			expect(mesh.material).toBe(c1);
			expect(hasDeformer(mesh, b + ':2')).toBe(true);
			expect(redefinitions(compiled(mesh.material).vertexShader)).toEqual([]);
			// the last out puts the original back, with an edit made meanwhile carried over
			mesh.material.color.setHex(0xff0000);
			removeDeformer(mesh, b + ':2');
			expect(mesh.material).toBe(original);
			expect(original.color.getHex()).toBe(0xff0000);
			expect(compiled(original).vertexShader).toBe(THREE.ShaderLib.standard.vertexShader);
		});
	}

	it('a material swapped under the clone carries its deformers onto the new one', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
		addDeformer(mesh, 'jiggle:x', SPECS.jiggle());
		const swapped = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
		mesh.material = swapped; // an Inspector edit
		expect(hasDeformer(mesh, 'jiggle:x')).toBe(false);
		addDeformer(mesh, 'bodywave:y', SPECS.bodywave()); // the wave re-wraps
		expect(deformersOf(mesh)).toEqual(['jiggle:x', 'bodywave:y']);
		expect(redefinitions(compiled(mesh.material).vertexShader)).toEqual([]);
		removeDeformer(mesh, 'jiggle:x');
		removeDeformer(mesh, 'bodywave:y');
		expect(mesh.material).toBe(swapped);
	});

	it('a multi-material mesh is refused', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
		expect(addDeformer(mesh, 'j', SPECS.jiggle())).toBeNull();
	});
});
