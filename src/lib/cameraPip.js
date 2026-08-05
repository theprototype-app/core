import { writable, derived, get } from 'svelte/store';
import { selectedObjects, objectsGroup, isVRMode } from '../stores/sceneStore';
import { isCameraObject, cameraSpec, aspectRatio } from './cameraObjects';
import { cameraPreview } from './cameraPreview';

// 16-Q4: the little live PREVIEW WINDOW that appears when you select a camera
// object — bottom-right, draggable, per-camera opt-out.
//
// It is NOT a second WebGL context (that would duplicate every texture and
// geometry on the GPU): Outline.svelte renders one extra SCISSORED viewport of the
// same renderer after the composer pass, into the rectangle this module publishes.
// So the DOM part is pure chrome — a frame, a title and a close button — and the
// pixels inside it come from the main render loop.

/** default window height in CSS px (width follows the camera's framing aspect) */
export const PIP_HEIGHT = 170;
const MARGIN = 16;
/** room for the round HUD buttons at the right edge (mic, chat) */
const HUD_CLEARANCE = 64;

/** user-dragged position, or null = auto-park bottom-right (kept per session)
 * @type {import('svelte/store').Writable<{x: number, y: number} | null>} */
export const pipPosition = writable(null);

/** the rect the renderer draws into, in CSS px from the top-left of the viewport
 * @type {import('svelte/store').Writable<{x: number, y: number, w: number, h: number} | null>} */
export const pipRect = writable(null);

/**
 * Which camera the window is showing: the selected camera object, unless it is
 * already filling the viewport as a full preview, VR is on, or that camera has its
 * `pip` flag off.
 *
 * Reads the selection SET, not `selectedObject` — the latter is STICKY (it keeps
 * the last object after a deselect so the open inspector still has something to
 * bind to), which left the window hanging around after you clicked empty space.
 * `objectsGroup` is in the dependency list because the `pip` flag lives on
 * userData: THREE trees are not reactive, so the poke that follows a settings
 * write is the only signal this derived store gets.
 */
export const pipTarget = derived(
	[selectedObjects, objectsGroup, cameraPreview, isVRMode],
	([set, group, preview, vr]) => {
		if (vr || !set?.length) return null;
		const uuid = set[set.length - 1]; // the primary of the set
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!isCameraObject(object)) return null;
		if (cameraSpec(object).pip === false) return null;
		if (preview?.uuid === uuid) return null; // you're already inside it
		return uuid;
	}
);

/** Window size for a camera's framing (16:9 unless it declares otherwise).
 * @param {any} object */
export function pipSize(object) {
	const ratio = aspectRatio(cameraSpec(object).aspect) || 16 / 9;
	const h = PIP_HEIGHT;
	return { w: Math.round(h * ratio), h };
}

/**
 * Where to park the window when the user hasn't dragged it: bottom-right, but
 * LEFT of an open side panel so the two never overlap.
 * @param {{w: number, h: number}} size
 * @param {{width: number, height: number}} viewport
 * @param {number} [panelWidth] width of an open right-side panel (0 = none)
 */
export function autoPosition(size, viewport, panelWidth = 0) {
	// the right edge keeps clear of the round HUD buttons (mic / chat) that live
	// there, so the parked window never sits under them
	const right = panelWidth ? MARGIN : HUD_CLEARANCE;
	return {
		x: Math.max(MARGIN, viewport.width - size.w - right - panelWidth),
		y: Math.max(MARGIN, viewport.height - size.h - MARGIN)
	};
}

/** Keep a dragged window fully on screen.
 * @param {{x: number, y: number}} pos @param {{w: number, h: number}} size
 * @param {{width: number, height: number}} viewport */
export function clampPosition(pos, size, viewport) {
	return {
		x: Math.min(Math.max(0, pos.x), Math.max(0, viewport.width - size.w)),
		y: Math.min(Math.max(0, pos.y), Math.max(0, viewport.height - size.h))
	};
}

/** Convert the DOM rect into the gl viewport three wants (y from the BOTTOM).
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {number} canvasHeight */
export function glRect(rect, canvasHeight) {
	return { x: rect.x, y: canvasHeight - (rect.y + rect.h), w: rect.w, h: rect.h };
}

export function resetPipPosition() {
	pipPosition.set(null);
}

/** test/debug view */
export function pipDebug() {
	return { target: get(pipTarget), rect: get(pipRect), position: get(pipPosition) };
}
