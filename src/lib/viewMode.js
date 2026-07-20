// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, viewMode, isVRMode } from '../stores/sceneStore';

// Viewport view modes (V-2). LOCAL, per-viewer, never replicated.
//  - 'shaded'      : normal
//  - 'shaded-ao'   : normal + N8AO (the AO pass toggles itself off the store)
//  - 'wireframe'   : scene.overrideMaterial = a wireframe MeshBasicMaterial.
// Wireframe uses overrideMaterial (not a per-material sweep) so it stays LOCAL —
// a sweep would set `wireframe` on REPLICATED materials and any subsequent
// full-object resend would leak the local view mode to peers. VR never uses the
// override (the composer doesn't run in WebXR and overrideMaterial would hide the
// scene behind the flat wireframe); it's forced off while presenting.

/** @type {any} */
let wireMaterial = null;

function apply() {
	const scene = get(globalScene);
	if (!scene) return;
	const wire = get(viewMode) === 'wireframe' && !get(isVRMode);
	if (wire) {
		if (!wireMaterial)
			wireMaterial = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x9aa4b0 });
		scene.overrideMaterial = wireMaterial;
	} else if (scene.overrideMaterial === wireMaterial) {
		scene.overrideMaterial = null;
	}
	// the shadow catcher hides in wireframe — dynamic import keeps the graph
	// acyclic (environment statically imports wireframeActive from here)
	import('./environment').then((m) => m.applyEnvironment());
}

/** Whether the grid + shadow catcher should hide (wireframe renders them as junk). */
export function wireframeActive() {
	return get(viewMode) === 'wireframe' && !get(isVRMode);
}

let started = false;
export function startViewMode() {
	if (started || typeof window === 'undefined') return;
	started = true;
	viewMode.subscribe(() => apply());
	isVRMode.subscribe(() => apply());
	globalScene.subscribe(() => apply());
}
