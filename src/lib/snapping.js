import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { TControls } from '../stores/sceneStore';

// Grid snapping for the transform gizmo: translate, rotate AND scale.
// Persisted in localStorage. "Snap to surface" is a future improvement.

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('snapSettings') : null;

export const snapEnabled = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('snapEnabled') === 'true'
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
	snapSettings.subscribe((value) => {
		localStorage.setItem('snapSettings', JSON.stringify(value));
		apply();
	});
}
