// @ts-nocheck — plain fixtures; the code under test is typed
// 101 L1a guard: three r186's WebGPU compileAsync opens the scene render bracket
// (scene.onBeforeRender) and never closes it. lod.js counts that bracket, so after one such
// compile every later frame reads as NESTED and the LOD pass never runs again (roadmap 100 spike:
// frozen LOD -> pack pieces serialize in full -> saves throw). The seam's compileAsync closes
// exactly what the call left open. Driven against the REAL lod.js hooks.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { globalScene } from '../../src/stores/sceneStore';
import { registerLodPass, scanForLod } from '../../src/lib/lod.js';
import { compileAsync, watchSceneBracket } from '../../src/lib/render/compile.js';

const cam = new THREE.PerspectiveCamera();
cam.updateMatrixWorld();

/** a fresh scene with lod.js's hooks installed and a pass counter @returns {{ scene: any, passes: () => number }} */
function lodScene() {
	const scene = new THREE.Scene();
	globalScene.set(scene);
	let n = 0;
	registerLodPass({ before: () => n++, after: () => {}, owns: () => false });
	scanForLod();
	return { scene, passes: () => n };
}

/** one ordinary frame: three's render() brackets the scene hooks */
function frame(scene) {
	scene.onBeforeRender(null, scene, cam, null);
	scene.onAfterRender(null, scene, cam, null);
}

/** three r186 WebGPURenderer.compileAsync's shape: opens the bracket on targetScene, never closes it */
const webgpuLike = {
	compileAsync(object, camera, targetScene) {
		(targetScene ?? object).onBeforeRender(this, object, camera, null);
		return Promise.resolve();
	}
};

describe('render seam compileAsync (101 L1a)', () => {
	it('COUNTERFACTUAL: the raw WebGPU-style compile freezes the LOD pass', async () => {
		const { scene, passes } = lodScene();
		await webgpuLike.compileAsync(new THREE.Group(), cam, scene);
		const before = passes();
		for (let i = 0; i < 3; i++) frame(scene);
		expect(passes() - before).toBe(0); // every frame reads as nested: LOD never swaps again
	});

	it('through the seam the bracket is closed and the LOD pass runs every frame', async () => {
		const { scene, passes } = lodScene();
		const lodBefore = scene.onBeforeRender;
		const lodAfter = scene.onAfterRender;
		const r = await compileAsync(webgpuLike, new THREE.Group(), cam, scene);
		expect(r.closed).toBe(1);
		expect(scene.onBeforeRender).toBe(lodBefore); // lod.js's own hooks are back, untouched
		expect(scene.onAfterRender).toBe(lodAfter);
		const before = passes();
		for (let i = 0; i < 3; i++) frame(scene);
		expect(passes() - before).toBe(3);
	});

	it('a renderer that brackets correctly, or never touches the hooks (WebGL), is left alone', async () => {
		const { scene, passes } = lodScene();
		const bracketed = {
			compileAsync(o, c, t) {
				t.onBeforeRender(this, o, c, null);
				t.onAfterRender(this, o, c, null);
				return Promise.resolve();
			}
		};
		expect((await compileAsync(bracketed, new THREE.Group(), cam, scene)).closed).toBe(0);
		const webgl = { compileAsync: () => Promise.resolve() };
		expect((await compileAsync(webgl, new THREE.Group(), cam, scene)).closed).toBe(0);
		const before = passes();
		frame(scene);
		expect(passes() - before).toBe(1);
	});

	it('frames drawn while the compile is pending do not confuse the count', async () => {
		const { scene, passes } = lodScene();
		let resolve;
		const slow = {
			compileAsync(o, c, t) {
				t.onBeforeRender(this, o, c, null);
				return new Promise((r) => (resolve = r));
			}
		};
		const p = compileAsync(slow, new THREE.Group(), cam, scene);
		frame(scene); // the main loop keeps drawing (nested under the open compile: no pass)
		frame(scene);
		resolve();
		expect((await p).closed).toBe(1);
		const before = passes();
		frame(scene);
		expect(passes() - before).toBe(1);
	});

	it('a compile that rejects still closes the bracket, then rejects', async () => {
		const { scene, passes } = lodScene();
		const failing = {
			compileAsync(o, c, t) {
				t.onBeforeRender(this, o, c, null);
				return Promise.reject(new Error('device lost'));
			}
		};
		await expect(compileAsync(failing, new THREE.Group(), cam, scene)).rejects.toThrow('device lost');
		const before = passes();
		frame(scene);
		expect(passes() - before).toBe(1);
	});

	it('no compileAsync on the renderer = nothing to do; the hooks go back as they were', async () => {
		expect(await compileAsync(null, {}, cam)).toEqual({ closed: 0 });
		expect(await compileAsync({}, {}, cam)).toEqual({ closed: 0 });
		const scene = new THREE.Scene(); // prototype hooks only
		const w = watchSceneBracket(scene);
		scene.onBeforeRender();
		w.release();
		expect(w.open()).toBe(1);
		expect(Object.prototype.hasOwnProperty.call(scene, 'onBeforeRender')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(scene, 'onAfterRender')).toBe(false);
	});

	it('a hook replaced during the compile (lod.js re-installing) is not clobbered', () => {
		const scene = new THREE.Scene();
		const w = watchSceneBracket(scene);
		const mine = () => {};
		scene.onBeforeRender = mine;
		w.release();
		expect(scene.onBeforeRender).toBe(mine);
	});
});
