// 50-window (C2) — A PICTURE OF THE SCENE, NOT OF THE EDITOR.
//
// A checkpoint / session thumbnail is one fresh frame on the LIVE renderer (sessions.js
// `viewportThumbnail`), which is the right camera and the right look — and, until this file,
// also the editor's scaffolding: the transform gizmo on the selection, the grid, light and
// camera helpers, the pivot dot, the sculpt ring… so a timeline of checkpoints read as a
// timeline of whatever happened to be selected.
//
// `withCleanView(scene, camera, fn)` runs ONE synchronous render with all of it stood down and
// puts every bit back exactly as it was, in a `finally`:
//   · the camera's HELPER_LAYER (light/camera helpers and their pick proxies) is switched off;
//   · camera MARKERS hop off layer 0 (helperLayer's own `withMarkersHidden`);
//   · at the scene root only what a GAME draws stays visible — the replicated objects (or the
//     rig that holds them), the environment rig, module content and the render-time stand-ins
//     the content needs (kit instancing batches, LOD holders, terrain scatter, fluid, bursts);
//     the same "what a game draws" split budgetMeter's `rootsOf` makes. Everything else at the
//     root — grid, gizmo, edit handles, pins, snap previews, selection shells — is the
//     editor's and is hidden for the one render;
//   · the TransformControls gizmo is hidden by identity as well, wherever threlte parented it.
// `visible` is a LOCAL flag on a scene-root helper (they never serialise) and the render is
// synchronous, so nothing replicates and no frame ever shows the hidden state. The selection
// OUTLINE is a postprocessing pass and a plain `renderer.render` never draws it.
//
// A leaf: sceneStore + helperLayer + name constants. No THREE import.
import { get } from 'svelte/store';
import { objectsGroup, TControls } from '../stores/sceneStore';
import { HELPER_LAYER, withMarkersHidden } from './helperLayer';
import { ENV_ROOT } from './environment';
import { moduleGroupList } from './moduleContent';
import { MODULE_WORLD_ROOT } from './moduleWorld';

/** scene-root content that is not the objects group: names a game draws */
// ('kit-entities' = kit/entityApp's KIT_ENTITY_GROUP, spelled out: that module is the kit runtime, not a leaf)
const CONTENT_ROOTS = new Set([ENV_ROOT, MODULE_WORLD_ROOT, 'kit-entities', 'kit-instancing-root', 'lod-group-holders', 'terrain-scatter', 'Fluid (visual)']);

/** is this scene-root child something the GAME draws? @param {any} child @param {Set<any>} keep */
export function isContentRoot(child, keep) {
	if (keep.has(child)) return true;
	const name = String(child?.name ?? '');
	if (CONTENT_ROOTS.has(name) || name.startsWith('effects-burst-')) return true;
	if (child?.userData?.terrainScatterOf) return true;
	return false;
}

/** the scene-root ancestor of `node` (or null when it is not under `scene`) @param {any} scene @param {any} node */
function rootChildOf(scene, node) {
	let n = node;
	while (n && n.parent && n.parent !== scene) n = n.parent;
	return n && n.parent === scene ? n : null;
}

/**
 * Run `fn` (one synchronous render + read) with the editor's scaffolding hidden.
 * @template T @param {any} scene @param {any} camera @param {() => T} fn @returns {T}
 */
export function withCleanView(scene, camera, fn) {
	if (!scene?.children) return fn();
	/** scene-root children that hold content (the objects group may sit inside a rig) */
	const keep = new Set();
	const group = get(objectsGroup);
	const holder = rootChildOf(scene, group);
	if (holder) keep.add(holder);
	try {
		for (const entry of moduleGroupList()) {
			const root = scene.getObjectByName?.(entry.name);
			const top = root ? rootChildOf(scene, root) : null;
			if (top) keep.add(top);
		}
	} catch {
		/* module content not started (a bare page) */
	}
	/** @type {{node: any, visible: boolean}[]} */
	const hidden = [];
	const hide = (/** @type {any} */ node) => {
		if (!node || node.visible === false) return;
		hidden.push({ node, visible: node.visible });
		node.visible = false;
	};
	for (const child of [...scene.children]) if (!isContentRoot(child, keep)) hide(child);
	// the grid by name, wherever it hangs (extensions/Grid.svelte)
	hide(scene.getObjectByName?.('editor-grid'));
	// the gizmo, by identity: threlte may parent it inside a kept rig
	/** @type {any} */
	const controls = get(TControls);
	if (controls) {
		try {
			hide(typeof controls.getHelper === 'function' ? controls.getHelper() : null);
		} catch {
			/* an older TransformControls has no helper object */
		}
		if (controls.isObject3D) hide(controls);
	}
	const layers = camera?.layers;
	const helperLayerOn = !!layers?.isEnabled?.(HELPER_LAYER);
	if (helperLayerOn) layers.disable(HELPER_LAYER);
	try {
		return withMarkersHidden(fn);
	} finally {
		if (helperLayerOn) layers.enable(HELPER_LAYER);
		for (const { node, visible } of hidden) node.visible = visible;
	}
}
