import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';

// Large scenes used to clip: watch the scene bounds (throttled) and hand the
// radius to cameraClip (123), which fits the far plane, pairs it with the
// orbit maxDistance, and applies the user's near/far preference; fog reach
// follows the same radius.

let radius = 0;

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

let started = false;

/** One sweep: measure + fit cameras (near/far + orbit clamp) + fog */
export function refreshSceneBounds() {
	const before = radius;
	measure();
	// cameraClip owns near/far + the orbit maxDistance pairing (123); dynamic
	// import keeps the module graph acyclic (cameraClip reads sceneRadius here)
	import('./cameraClip').then((m) => m.applyCameraClip());
	// fog reach follows the scene size (environment reads sceneRadius)
	if (Math.abs(radius - before) > 1)
		import('./environment').then((m) => m.applyEnvironment());
}

export function startSceneBounds() {
	if (started || typeof window === 'undefined') return;
	started = true;
	refreshSceneBounds(); // apply the clip prefs once on boot
	// plain interval: immune to event-ordering, cheap at this cadence
	setInterval(refreshSceneBounds, 2500);
}
