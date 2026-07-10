import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, editorCam, playerCam } from '../stores/sceneStore';

// Large scenes used to clip: cameras default to far=2000 and environment fog
// ends at a few hundred units. Watch the scene bounds (throttled) and grow the
// camera far planes + fog reach to fit. Far only grows — never shrinks mid-
// session (avoids pop while editing).

const BASE_FAR = 5000;
const FAR_CAP = 200000;

let radius = 0;
let lastCheck = 0;

/** Current scene bounding-sphere radius (0 = empty) */
export function sceneRadius() {
	return radius;
}

function measure() {
	const group = get(objectsGroup);
	if (!group || group.children.length === 0) {
		radius = 0;
		return;
	}
	const box = new THREE.Box3().setFromObject(group);
	if (!isFinite(box.min.x)) {
		radius = 0;
		return;
	}
	// reach from the WORLD ORIGIN (where cameras orbit), not just content size:
	// a small object placed far away must still extend the far plane
	const sphere = box.getBoundingSphere(new THREE.Sphere());
	radius = sphere.center.length() + sphere.radius;
}

/** @param {any} camera */
function applyFar(camera) {
	if (!camera) return;
	const needed = Math.min(Math.max(BASE_FAR, radius * 6), FAR_CAP);
	if (camera.far < needed) {
		camera.far = needed;
		camera.updateProjectionMatrix();
	}
}

let started = false;

/** One sweep: measure + fit cameras (+ fog when the size changed) */
export function refreshSceneBounds() {
	const before = radius;
	measure();
	applyFar(get(editorCam));
	applyFar(get(playerCam));
	// fog reach follows the scene size (environment reads sceneRadius)
	if (Math.abs(radius - before) > 1)
		import('./environment').then((m) => m.applyEnvironment());
}

export function startSceneBounds() {
	if (started || typeof window === 'undefined') return;
	started = true;
	// plain interval: immune to event-ordering, cheap at this cadence
	setInterval(refreshSceneBounds, 2500);
}
