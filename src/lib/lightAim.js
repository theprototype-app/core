// 24-E1: "Aim at… ▸ Pick in viewport" — a ONE-SHOT world-point pick for a light. The
// snap engine's anchor pick is the pattern (a capture-phase pointer listener on the
// canvas, `sceneHits` for the surface, Esc cancels), but that one is tied to the
// selected object's own surface; a light aims at ANYTHING, so this asks the whole
// replicated scene and hands the point back. The caller (the Inspector) does the
// write — lookAt + the `move` broadcast + history — so this stays a picker.
import { writable, get } from 'svelte/store';
import * as THREE from 'three';
import { globalCamera, globalRenderer } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { sceneHits } from './scenePick';

/** uuid of the light being aimed, or null (drives the Inspector button state) */
export const lightAimPicking = writable(/** @type {string | null} */ (null));

/** @type {(() => void) | null} */
let teardown = null;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** Stop an armed pick (Esc, ✕, selection change). */
export function cancelLightAimPick() {
	teardown?.();
	teardown = null;
	lightAimPicking.set(null);
}

/**
 * Arm a pick for `uuid`; `onPoint` receives the world point of the next click on a
 * scene surface. Returns false when there is no canvas to listen on.
 * @param {string} uuid @param {(point: THREE.Vector3) => void} onPoint
 */
export function startLightAimPick(uuid, onPoint) {
	cancelLightAimPick();
	/** @type {any} */
	const canvas = get(globalRenderer)?.domElement;
	if (!canvas) return false;
	lightAimPicking.set(uuid);
	showToast('Click a surface in the viewport to aim the light at it (Esc cancels)');
	/** @param {PointerEvent} e */
	const onDown = (e) => {
		if (e.button !== 0 || e.target !== canvas) return;
		/** @type {any} */
		const camera = get(globalCamera);
		if (!camera) return;
		const rect = canvas.getBoundingClientRect();
		ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		raycaster.setFromCamera(ndc, camera);
		const hit = sceneHits(raycaster, { excludeUuids: [uuid] })[0];
		e.preventDefault();
		e.stopPropagation();
		if (!hit) {
			showToast('Nothing under the cursor — click an object to aim at it');
			return;
		}
		cancelLightAimPick();
		onPoint(hit.point.clone());
	};
	/** @param {KeyboardEvent} e */
	const onKey = (e) => {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		e.stopPropagation();
		cancelLightAimPick();
	};
	window.addEventListener('pointerdown', onDown, true);
	window.addEventListener('keydown', onKey, true);
	teardown = () => {
		window.removeEventListener('pointerdown', onDown, true);
		window.removeEventListener('keydown', onKey, true);
	};
	return true;
}
