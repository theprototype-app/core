// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, viewMode, isVRMode } from '../stores/sceneStore';
import { viewPrefs } from './viewPrefs';

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
			wireMaterial = new THREE.MeshBasicMaterial({ wireframe: true, color: get(viewPrefs).wireColor });
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

/**
 * The Chromium major version, for the AO capability gate (Outline.svelte).
 *
 * Prefers `navigator.userAgentData.brands` over the UA STRING deliberately: the UA
 * string is what DevTools DEVICE EMULATION overrides, and its canned presets carry
 * a much older Chrome version — a desktop Chrome 151 with emulation left on
 * reported "126", failed the >=151 gate and switched AO off with a confusing
 * toast. The brand list is the modern structured source; the regex stays as the
 * fallback for engines without it. 0 = unknown, treated as capable.
 */
export function chromiumMajor() {
	if (typeof navigator === 'undefined') return 0;
	const brands = /** @type {any} */ (navigator).userAgentData?.brands ?? [];
	const brand = brands.find((/** @type {any} */ b) => /Google Chrome|Chromium/i.test(b.brand));
	if (brand) return Number(brand.version) || 0;
	return Number(navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/)?.[1] ?? 0);
}

/**
 * three r185 + Chromium <=150 (ANGLE D3D11): any shader program FIRST COMPILED
 * while the N8AO pass is enabled links broken — meshes created after boot render
 * invisible, and with AO on from boot the whole scene goes black. 151 fixed that on
 * the desktop. Mobile GPUs are a separate stack where the same class of breakage
 * still appears, so coarse-pointer devices merely DEFAULT to 'shaded'
 * (sceneStore.defaultViewMode) instead of being locked out here.
 */
export function aoSupported() {
	const major = chromiumMajor();
	return major === 0 || major >= 151;
}

let started = false;
export function startViewMode() {
	if (started || typeof window === 'undefined') return;
	started = true;
	viewMode.subscribe(() => apply());
	isVRMode.subscribe(() => apply());
	globalScene.subscribe(() => apply());
	// 18-A: the override material is a singleton, so a colour change is a live
	// write — no rebuild, and nothing to do when wireframe isn't the active mode.
	viewPrefs.subscribe((prefs) => wireMaterial?.color.set(prefs.wireColor));
}
