// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, viewMode, isVRMode } from '../stores/sceneStore';
import { viewPrefs } from './viewPrefs';

// Viewport view modes (V-2). LOCAL, per-viewer, never replicated.
//  - 'shaded'      : normal
//  - 'shaded-ao'   : normal + N8AO (the AO pass toggles itself off the store)
//  - 'wireframe'   : scene.overrideMaterial = a wireframe MeshBasicMaterial.
// A scene's authored LOOK (scenePost.js) is not one of these: it is scene data and
// renders in every mode but wireframe, for everyone, the way the environment preset
// does. The mode only decides this viewer's SHADING — and 'shaded-ao' yields when
// the scene sets its own ambient occlusion. A legacy 'custom' value (from the
// opt-in design this replaced) reads as 'shaded'.
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

/**
 * L4: the same gate, generalised to the WHOLE post stack.
 *
 * Deliberately CONSERVATIVE, and worth being honest about: the measured evidence
 * above is AO-specific, because that is where we hit it. But the failure is a
 * broken shader LINK on a driver we cannot interrogate, its symptom is a black or
 * frozen viewport with nothing in the console, and there is no way to tell in
 * advance which fullscreen pass will trip it. A viewer on such a build still sees
 * the scene in `shaded`; rendering nothing and saying nothing would be worse than
 * skipping the authored look and explaining once.
 */
export const postSupported = aoSupported;

/**
 * P6 — THE CAPABILITY GATE QUESTION, DECIDED: shader-driven MATERIALS are NOT gated
 * with fullscreen passes, and they stay separate deliberately.
 *
 * The measured evidence behind `postSupported` is about a fullscreen pass linking
 * broken on an old ANGLE/D3D11 stack, and three properties of that failure do not
 * transfer to a material:
 *  - BLAST RADIUS. A broken post pass takes the WHOLE viewport (black, or a frozen
 *    frame, with nothing in the console); a material that fails to compile affects the
 *    objects it drives, and `compileAndApply` already keeps the last good material and
 *    reports the error, so the scene is still there to look at.
 *  - WHERE THEY RUN. Post is skipped entirely in VR; materials are the only layer of
 *    the look that works in a headset. One gate would switch off the half that works.
 *  - WHO COMPILES. A material goes through three's own program path, which every other
 *    material in the app already uses — gating it would be gating three itself.
 * So the local switch for materials is `viewportOverrides.shaders` (a CHOICE) and the
 * capability gate stays post-only (a REFUSAL). If a driver is ever found that breaks
 * generated materials specifically, it wants its own gate and its own measurement.
 */

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
