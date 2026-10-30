import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

// LIGHTS IN THE AUTOSAVE (fix-agenttest item 1). The autosave scene goes through a GLTF
// round trip, and glTF only knows KHR_lights_punctual: a Hemisphere, Ambient or RectArea
// light was written as an EMPTY node and came back as a plain Object3D — the light was
// gone after every Restore, with nothing said beyond a console warning on each save. Even
// the punctual three lost their shadow settings, decay and (directional/spot) direction.
// So every light rides BESIDE the snapshot as its own toJSON and REPLACES its GLTF twin on
// restore, the multiMaterial / animated-rig shape for the same reason. A leaf: three only.

// RectAreaLight renders black on Standard/Physical materials until the uniforms lib
// initializes — once per session is enough (79). Shared by createLight and every restore.
let rectAreaReady = false;
export function ensureRectAreaUniforms() {
	if (rectAreaReady) return;
	rectAreaReady = true;
	RectAreaLightUniformsLib.init();
}

/**
 * Take KHR_lights_punctual out of an exporter whose lights travel in the sidecar: its
 * output is replaced on restore anyway, and it warns on EVERY save (unsupported types,
 * a scene-root target "direction may be lost"). Identified by the extension NAME, which
 * survives minification where the class name does not; every built-in plugin constructor
 * only stores the writer, so probing with a stub is side-effect free.
 * @template T @param {T} exporter @returns {T}
 */
export function withoutPunctualLights(exporter) {
	const ex = /** @type {any} */ (exporter);
	for (const callback of [...(ex.pluginCallbacks ?? [])]) {
		let name = '';
		try {
			name = callback({})?.name ?? '';
		} catch {
			/* not a built-in shape: leave it registered */
		}
		if (name === 'KHR_lights_punctual') ex.unregister(callback);
	}
	return exporter;
}

/**
 * The lights under `root` as `{uuid, element}` — the light ALONE (clone(false)): its
 * children are already in the GLTF snapshot and move across to the restored light.
 * @param {any} root @param {(node: any) => boolean} [skip]
 * @returns {{uuid: string, element: any}[]}
 */
export function lightsSnapshot(root, skip = () => false) {
	/** @type {{uuid: string, element: any}[]} */
	const out = [];
	root?.traverse?.((/** @type {any} */ node) => {
		if (node === root || !node.isLight || skip(node)) return;
		const copy = node.clone(false);
		copy.uuid = node.uuid;
		out.push({ uuid: node.uuid, element: copy.toJSON() });
	});
	return out;
}

/**
 * Put each saved light in place of its GLTF twin (matched by the restored uuid), keeping
 * the twin's place in the tree and its children. Returns the replaced twins so the caller
 * can dispose of them.
 * @param {any} root @param {{uuid: string, element: any}[]} entries
 * @param {(error: unknown) => void} [onError]
 * @returns {any[]}
 */
export function restoreLights(root, entries, onError = () => {}) {
	/** @type {any[]} */
	const replaced = [];
	if (!root || !Array.isArray(entries) || !entries.length) return replaced;
	const loader = new THREE.ObjectLoader();
	for (const entry of entries) {
		const twin = root.getObjectByProperty('uuid', entry?.uuid);
		if (!twin || twin === root) continue;
		/** @type {any} */
		let light;
		try {
			light = loader.parse(entry.element);
		} catch (error) {
			onError(error);
			continue;
		}
		if (!light?.isLight) continue;
		if (light.isRectAreaLight) ensureRectAreaUniforms();
		light.uuid = entry.uuid;
		// the GLTF twin carries the parked pose and the latest userData (extras); the
		// sidecar is the light itself
		light.position.copy(twin.position);
		light.quaternion.copy(twin.quaternion);
		light.scale.copy(twin.scale);
		light.visible = twin.visible;
		const parent = twin.parent ?? root;
		const index = parent.children.indexOf(twin);
		for (const child of [...twin.children]) light.add(child);
		parent.remove(twin);
		parent.add(light);
		// keep the sibling order (the object list draws it)
		const at = parent.children.indexOf(light);
		if (index >= 0 && at !== index) {
			parent.children.splice(at, 1);
			parent.children.splice(index, 0, light);
		}
		replaced.push(twin);
	}
	return replaced;
}
