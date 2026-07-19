import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';

// Shadows on by default (V-1). threlte's <Canvas> already enables the shadow map
// (PCFSoft), and castShadow/receiveShadow are already replicated objectParameters
// + Inspector checkboxes — so "shadows by default" is purely about turning on the
// per-mesh FLAGS. Rather than touch every creation site (createGeometry, GLTF
// receive, explorerDrop, prefabs, sessions, animatedImports, history re-adds) we
// run ONE sweep keyed off the objectsGroup store: every already-fired
// `objectsGroup.update(v => v)` at those sites drives it, and it retrofits loaded
// scenes too. A module-level WeakSet marks meshes already defaulted so we never
// stomp a user's later opt-out — and nothing is written into userData, so the
// sweep leaves serialization untouched.

/** meshes we've already applied defaults to @type {WeakSet<any>} */
const seen = new WeakSet();

/** @param {any} group */
function sweep(group) {
	if (!group) return;
	group.traverse((/** @type {any} */ node) => {
		if (!node.isMesh || seen.has(node)) return;
		seen.add(node);
		// opt-out rides userData.shadow=false (survives toJSON + GLTF extras;
		// the bare castShadow flag does NOT survive GLTFExporter, which is why
		// the Inspector writes the userData flag alongside the bare flag)
		node.castShadow = node.userData?.shadow !== false;
		node.receiveShadow = true;
	});
}

let started = false;

export function startShadowDefaults() {
	if (started || typeof window === 'undefined') return;
	started = true;
	objectsGroup.subscribe((group) => sweep(group));
	sweep(get(objectsGroup));
}
