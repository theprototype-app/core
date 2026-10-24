// 64 D1: vector shapes in the headset, on the radial menu's own registry (no ring code edited):
//   Add ▸ Shapes ▸ Rectangle / Ellipse / Star / Polygon — 2 m ahead, upright, facing you
//   Selected ▸ Extrude (a vector shape) — steps the depth 0 -> 10 -> 25 -> 50 cm -> flat, one undo each
// A shape is an ordinary object, so the grip holds it like any other (grab, carry, two-hand scale).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalCamera, objectsGroup, selectedObject } from '../../stores/sceneStore';
import { registerVRMenuEntry } from '../vrRadialMenu';
import { placeVectorShape, vectorParamsOf, setVectorParams } from './vectorActions.js';

export const EXTRUDE_STEPS = [0, 0.1, 0.25, 0.5];

/** the next depth after `depth` in the cycle @param {number} depth */
export function nextExtrude(depth) {
	const i = EXTRUDE_STEPS.findIndex((d) => d > depth + 1e-6);
	return i < 0 ? 0 : EXTRUDE_STEPS[i];
}

/** place a shape 2 m ahead of the headset, at chest height @param {string} kind */
export function spawnVectorAhead(kind) {
	/** @type {any} */
	const camera = get(globalCamera);
	const group = /** @type {any} */ (get(objectsGroup));
	if (!camera || !group) return null;
	const eye = camera.getWorldPosition(new THREE.Vector3());
	const dir = camera.getWorldDirection(new THREE.Vector3());
	dir.y = 0;
	if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
	dir.normalize().multiplyScalar(2);
	// placeVectorShape stands the shape ON the point: put the point half a metre under the eye
	const world = eye.clone().add(dir).add(new THREE.Vector3(0, -1, 0));
	group.updateMatrixWorld(true);
	const local = group.worldToLocal(world);
	return placeVectorShape(kind, [local.x, local.y, local.z]);
}

const selectedVector = () => vectorParamsOf(get(selectedObject));

registerVRMenuEntry({ id: 'nav:vecshapes', group: 'add', label: 'Shapes', icon: 'pen-tool', order: 5.6, ring: 'vecshapes' });
[
	['rect', 'Rectangle', 'square'],
	['ellipse', 'Ellipse', 'circle'],
	['star', 'Star', 'star'],
	['polygon', 'Polygon', 'hexagon']
].forEach(([kind, label, icon], order) =>
	registerVRMenuEntry({ id: 'vec:add:' + kind, group: 'vecshapes', label, icon, order, closes: true, action: () => void spawnVectorAhead(kind) })
);
registerVRMenuEntry({
	id: 'vec:extrude',
	group: 'object',
	label: 'Extrude',
	icon: 'layers',
	order: 1.5,
	visible: () => !!selectedVector(),
	value: () => {
		const d = selectedVector()?.depth ?? 0;
		return d > 0 ? `${Math.round(d * 100)} cm` : 'flat';
	},
	action: () => {
		const object = /** @type {any} */ (get(selectedObject));
		const p = vectorParamsOf(object);
		if (p) setVectorParams(object.uuid, { depth: nextExtrude(p.depth ?? 0) });
	}
});
