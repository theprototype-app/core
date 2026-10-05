// VR controls — the shared base: the renderer handle, button edge state, the shared raycaster and temporaries, initVRControls.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';

/** @type {any} */ export let renderer = null;
/** @type {{menu?: boolean, squeeze?: boolean, stick?: boolean, trigger?: boolean, a?: boolean, mode?: boolean, x?: boolean, ping?: boolean}[]} */
export const previousButtons = [{}, {}];
export const raycaster = new THREE.Raycaster();
export const tempMatrix = new THREE.Matrix4();
export const tempVector = new THREE.Vector3();

/** @param {any} r */
export function initVRControls(r) {
	renderer = r;
}
