import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { TControls } from '../stores/sceneStore';

// Grid snapping for the transform gizmo: translate, rotate AND scale.
// Persisted in localStorage. "Snap to surface" is a future improvement.

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('snapSettings') : null;

export const snapEnabled = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('snapEnabled') === 'true'
);
// translate drags keep the object resting on whatever is underneath it
export const surfaceSnap = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('surfaceSnap') === 'true'
);
/** @type {import('svelte/store').Writable<{translate: number, rotateDeg: number, scale: number}>} */
export const snapSettings = writable(stored ? JSON.parse(stored) : { translate: 0.5, rotateDeg: 15, scale: 0.1 });

function apply() {
	/** @type {any} */
	const controls = get(TControls);
	if (!controls) return;
	if (get(snapEnabled)) {
		const settings = get(snapSettings);
		controls.setTranslationSnap(settings.translate);
		controls.setRotationSnap(THREE.MathUtils.degToRad(settings.rotateDeg));
		controls.setScaleSnap(settings.scale);
	} else {
		controls.setTranslationSnap(null);
		controls.setRotationSnap(null);
		controls.setScaleSnap(null);
	}
}

let started = false;

export function startSnapping() {
	if (started || typeof window === 'undefined') return;
	started = true;
	TControls.subscribe(apply);
	snapEnabled.subscribe((value) => {
		localStorage.setItem('snapEnabled', String(value));
		apply();
	});
	surfaceSnap.subscribe((value) => {
		localStorage.setItem('surfaceSnap', String(value));
	});
	snapSettings.subscribe((value) => {
		localStorage.setItem('snapSettings', JSON.stringify(value));
		apply();
	});
}

const DOWN = new THREE.Vector3(0, -1, 0);
const surfaceRaycaster = new THREE.Raycaster();

/**
 * Rest an object's bounding-box bottom on the first surface underneath it
 * (other scene objects, or the ground plane y=0 when nothing is hit).
 * Works in world space, so grouped objects behave too.
 * @param {any} object @param {any} group - the sceneObjects group
 * @returns {boolean} whether the position changed
 */
export function dropToSurface(object, group) {
	if (!object || !group) return false;
	const box = new THREE.Box3().setFromObject(object);
	if (box.isEmpty()) return false;
	const center = box.getCenter(new THREE.Vector3());

	surfaceRaycaster.set(new THREE.Vector3(center.x, box.max.y + 0.001, center.z), DOWN);
	// exclude the dragged object's own subtree from the targets
	const targets = group.children.filter(
		(child) => child !== object && !child.getObjectByProperty('uuid', object.uuid)
	);
	const hits = surfaceRaycaster
		.intersectObjects(targets, true)
		.filter((hit) => hit.object.visible && hit.point.y <= box.max.y + 0.001);

	const surfaceY = hits.length > 0 ? hits[0].point.y : 0;
	const worldPosition = object.getWorldPosition(new THREE.Vector3());
	const bottomOffset = box.min.y - worldPosition.y;
	const targetWorldY = surfaceY - bottomOffset;
	if (Math.abs(targetWorldY - worldPosition.y) < 1e-6) return false;

	worldPosition.y = targetWorldY;
	object.position.copy(object.parent.worldToLocal(worldPosition));
	return true;
}
