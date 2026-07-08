import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { showToast } from '../stores/appStore';

// Two-click distance measuring. Local-only: measurements are a personal
// inspection tool and do not replicate.

export const measureMode = writable(false);
/** @type {import('svelte/store').Writable<{a: number[], b?: number[]} | null>} */
export const measurement = writable(null);

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planePoint = new THREE.Vector3();

export function toggleMeasure() {
	const on = !get(measureMode);
	measureMode.set(on);
	measurement.set(null);
	if (on) {
		showToast('Measure: click two points (Esc to stop)');
		window.addEventListener('keydown', onKeydown);
	} else {
		window.removeEventListener('keydown', onKeydown);
	}
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (event.key === 'Escape') toggleMeasure();
}

/**
 * Handle a viewport click while measuring. Objects first, ground plane fallback.
 * @param {THREE.Raycaster} raycaster @param {any} group - sceneObjects
 */
export function measureClick(raycaster, group) {
	let point = null;
	const hits = group ? raycaster.intersectObjects(group.children, true) : [];
	if (hits.length > 0) point = hits[0].point;
	else if (raycaster.ray.intersectPlane(groundPlane, planePoint)) point = planePoint;
	if (!point) return;

	measurement.update((current) =>
		!current || current.b ? { a: point.toArray() } : { a: current.a, b: point.toArray() }
	);
}
