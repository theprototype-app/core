// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EMITTER_DEFAULTS } from './fluidEmitterCore.js';

// 36-fb F23: the "Fluid" create item (Add ▸ Water ▸ Fluid) — a small spout whose mouth is the
// object's origin, pouring along its local -Y. A LEAF over three: geometries.svelte.js calls
// these from the replicated /create, so every peer builds the same spout with the same stamp
// (deterministic, no extra message), exactly like the Fluid tank.

/** `/create FluidEmitter` — a pipe rising from the mouth, with a lip */
export function fluidEmitterGeometry() {
	const pipe = new THREE.CylinderGeometry(0.04, 0.05, 0.24, 14, 1, true).translate(0, 0.13, 0);
	const lip = new THREE.TorusGeometry(0.05, 0.012, 8, 18).rotateX(Math.PI / 2).translate(0, 0.012, 0);
	const cap = new THREE.CylinderGeometry(0.06, 0.06, 0.03, 14).translate(0, 0.26, 0);
	const merged = mergeGeometries([pipe.toNonIndexed(), lip.toNonIndexed(), cap.toNonIndexed()], false);
	[pipe, lip, cap].forEach((g) => g.dispose());
	merged.computeVertexNormals();
	return merged;
}

/**
 * Stamp a fresh emitter: the fluid settings, a metal look, no shadow, no physics (a spout is
 * scenery — it must not tumble away when a sim starts).
 * @param {any} object
 */
export function stampFluidEmitter(object) {
	object.name = 'Fluid emitter';
	object.userData.fluidEmitter = JSON.parse(JSON.stringify(EMITTER_DEFAULTS));
	const m = object.material;
	m.color?.set('#8fa3b3');
	if ('roughness' in m) m.roughness = 0.35;
	if ('metalness' in m) m.metalness = 0.7;
	m.side = THREE.DoubleSide;
	object.castShadow = false;
	object.userData.shadow = false;
}
