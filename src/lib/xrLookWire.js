// 72 LK3 — what carries the scene's look to xrLook.js. Not in Outline.svelte, which owns the desktop
// stack: Scene.svelte unmounts Outline in a headset (`!$isVRMode || $vrPostEnabled`), and this has
// to be listening exactly then. xrLook.js itself loads at the first session, off the boot graph.
//
// What it carries ignores this machine's post gates: those are about affording a fullscreen pass, and
// there is none. Personal AO is not a look, hence mode 'shaded'.
import { get } from 'svelte/store';
import { POST_SCENE_KEY, postStacks, lookOverride, postEnabledLocal, resolvedDoc, effectivePostStack } from './scenePost';
import { cameraPreview } from './cameraPreview';

/**
 * @param {any} renderer @param {any} scene
 * @returns {() => void} stop listening
 */
export function installXrLook(renderer, scene) {
	/** @type {typeof import('./xrLook.js') | null} */
	let module = null;
	async function push() {
		if (!renderer.xr.isPresenting && !module) return;
		module ??= await import('./xrLook.js');
		const through = get(cameraPreview)?.uuid ?? null;
		module.syncXrLook(
			renderer,
			scene,
			effectivePostStack({
				stack: resolvedDoc(POST_SCENE_KEY),
				cameraStack: /** @type {any} */ (through ? resolvedDoc(through) : null),
				mode: 'shaded',
				localEnabled: get(postEnabledLocal)
			})
		);
	}
	renderer.xr.addEventListener('sessionstart', push);
	renderer.xr.addEventListener('sessionend', push);
	const stops = [postStacks, lookOverride, postEnabledLocal, cameraPreview].map((s) => /** @type {any} */ (s).subscribe(() => push()));
	return () => {
		renderer.xr.removeEventListener('sessionstart', push);
		renderer.xr.removeEventListener('sessionend', push);
		for (const stop of stops) stop();
	};
}
