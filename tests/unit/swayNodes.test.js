// 85 N5 — Wind Sway and Flowing Water: the pure maths, the deformer on the real vertexDeform
// registry (it COMPOSES with Body Wave on one mesh — fix-agenttest item 2), the flowing maps on the
// object's OWN material copy, and the park that keeps a save free of them.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { swayParams, gustAt, flowOffset, ANCHORS } from '../../src/lib/motion/swayCore.js';
import { applyWindSway, applyWaterFlow, pruneSwayNodes, resetSwayNodes, swayNodesDebug } from '../../src/lib/motion/swayNodes.js';
import { applyBodyWave, pruneBodyWaves } from '../../src/lib/motion/motionNodes.js';
import { deformersOf } from '../../src/lib/vertexDeform.js';
import { runParkHooks } from '../../src/lib/parkHooks.js';

const BOX = { min: [-0.1, 0, -0.1], max: [0.1, 2, 0.1] };

describe('swayCore', () => {
	it('a plant anchored at the bottom measures up from its foot and bends with the wind', () => {
		const p = swayParams({ mode: 'plant', anchor: 'bottom', strength: 0.2, gust: 0 }, BOX, [1, 0, 0], 10);
		expect(p.axis).toEqual([0, 1, 0]);
		expect(p.base).toBe(0);
		expect(p.len).toBe(2);
		expect(p.bend).toEqual([1, 0, 0]);
		expect(p.strength).toBeCloseTo(0.2);
		// wind straight up the stem has no sideways part: falls back to a side axis
		expect(swayParams({ gust: 0 }, BOX, [0, 1, 0], 0).bend).not.toEqual([0, 0, 0]);
	});
	it('a flag anchored left runs along +x and flaps along its thinnest axis', () => {
		const flag = { min: [0, 0, -0.01], max: [1.5, 1, 0.01] };
		const p = swayParams({ mode: 'flag', anchor: 'left', gust: 0 }, flag, [1, 0, 0], 3);
		expect(p.mode).toBe(1);
		expect(p.axis).toEqual([1, 0, 0]);
		expect(p.bend).toEqual([0, 0, 1]);
		// anchored at the top: the axis runs DOWN and the base is minus the top
		const t = swayParams({ anchor: 'top' }, BOX, [1, 0, 0], 0);
		expect(t.axis[1]).toBe(-1);
		expect(t.base).toBe(-2);
		expect(Object.keys(ANCHORS)).toContain('front');
	});
	it('gust and flow are pure of the clock and stay bounded', () => {
		expect(gustAt(123.4, 0.7)).toBe(gustAt(123.4, 0.7));
		expect(gustAt(5, 0)).toBe(1);
		for (let t = 0; t < 60; t += 0.7) {
			const g = gustAt(t, 1);
			expect(g).toBeGreaterThanOrEqual(0.4);
			expect(g).toBeLessThanOrEqual(1.6);
		}
		const [u, v] = flowOffset({ speed: 0.25, direction: 90 }, 86000.5);
		expect(u).toBeGreaterThanOrEqual(0);
		expect(u).toBeLessThan(1);
		expect(v).toBeCloseTo(0.125, 5);
	});
});

describe('swayNodes (THREE)', () => {
	it('wind sway attaches a deformer that composes with a Body Wave on the same mesh, and stands down', () => {
		resetSwayNodes();
		const plant = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 0.2), new THREE.MeshStandardMaterial());
		const original = plant.material;
		applyWindSway(plant, { strength: 0.3 }, 5, { key: 'ws|p' });
		applyBodyWave(plant, null, {}, 5, { key: 'bw|p' });
		expect(deformersOf(plant)).toEqual(['windsway:ws|p', 'bodywave:bw|p']);
		const shader = /** @type {any} */ ({ vertexShader: '#include <common>\nvoid main(){\n#include <begin_vertex>\n}', fragmentShader: '', uniforms: {} });
		plant.material.onBeforeCompile(shader, /** @type {any} */ (null));
		expect(shader.vertexShader).toContain('wsToRoot');
		expect(shader.vertexShader).toContain('bwToRoot');
		expect(shader.vertexShader.match(/uniform mat4 wsToRoot;/g)?.length).toBe(1);
		pruneSwayNodes(new Set());
		pruneBodyWaves(new Set());
		expect(plant.material).toBe(original);
	});
	it('flowing water scrolls its OWN copy of the maps; a shared material elsewhere does not flow; a save sees the authored maps', () => {
		resetSwayNodes();
		const normal = new THREE.Texture();
		const shared = new THREE.MeshStandardMaterial({ normalMap: normal });
		const pool = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), shared);
		const other = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shared);
		applyWaterFlow(pool, { speed: 0.5, direction: 0 }, 0.5, { key: 'wf|pool' });
		expect(pool.material).not.toBe(shared);
		expect(pool.material.normalMap).not.toBe(normal);
		expect(pool.material.normalMap?.offset.x).toBeCloseTo(0.25 * 1.3);
		expect(other.material.normalMap?.offset.x).toBe(0);
		expect(normal.offset.x).toBe(0);
		expect(swayNodesDebug()['wf|pool']).toEqual({ kind: 'waterflow', meshes: 1, flowing: 1 });
		const unpark = runParkHooks();
		expect(pool.material.normalMap).toBe(normal);
		unpark();
		expect(pool.material.normalMap).not.toBe(normal);
		pruneSwayNodes(new Set());
		expect(pool.material).toBe(shared);
		expect(shared.normalMap).toBe(normal);
	});
});
