// @ts-nocheck — plain fixtures; the code under test is typed
// 40 F14: the scene render hooks are a CHAIN (lod.js wraps whatever hook was there before it,
// the water runtime wraps lod's or the other way round). A nested render (the water reflection
// pass renders the scene inside the outer render) must unwind EVERY link: before always calls
// the wrapped hook, so after must too, or the wrapped hook's depth leaks one per nested render
// and its pass is skipped forever (the Aquarium's LOD groups froze after their first frame).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { globalScene } from '../../src/stores/sceneStore';
import { registerLodPass, scanForLod } from '../../src/lib/lod.js';

/** A wrapped hook with the same depth rule as the water runtime's. */
function depthHook() {
	const h = { depth: 0, outer: 0 };
	h.before = () => {
		if (h.depth++ === 0) h.outer++;
	};
	h.after = () => {
		if (--h.depth < 0) h.depth = 0;
	};
	return h;
}

describe('scene render hook chain', () => {
	it('a nested render unwinds the hook lod.js wraps, and the LOD pass runs every frame', () => {
		const scene = new THREE.Scene();
		const inner = depthHook();
		scene.onBeforeRender = inner.before;
		scene.onAfterRender = inner.after;
		globalScene.set(scene);
		let passes = 0;
		registerLodPass({ before: () => passes++, after: () => {}, owns: () => false });
		scanForLod();
		expect(scene.onBeforeRender).not.toBe(inner.before); // lod wraps the old hook
		const cam = new THREE.PerspectiveCamera();
		cam.updateMatrixWorld();
		for (let frame = 0; frame < 5; frame++) {
			scene.onBeforeRender(null, scene, cam); // the frame
			scene.onBeforeRender(null, scene, cam); // a reflection pass inside it
			scene.onAfterRender(null, scene, cam);
			scene.onAfterRender(null, scene, cam);
		}
		expect(inner.depth).toBe(0);
		expect(inner.outer).toBe(5);
		expect(passes).toBe(5);
	});
});
