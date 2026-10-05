// 36 F22 / S6 / S12 — THE Alt+click CYCLE'S FEEDBACK. While Alt is held the viewport previews
// what an Alt+click would select (a box around it and a small "2 of 4 · Fish" chip by the
// cursor); after the click the chip confirms the pick and a polite live region announces it
// for screen readers. LOCAL presentation only: never replicated, saved or undone. The
// preview box is a scene-root helper (golden rule 5), on the helper layer.
import * as THREE from 'three';
import { writable } from 'svelte/store';
import { markHelper } from './helperLayer';

/** The chip: null = hidden. `mode` 'preview' (Alt held) | 'picked' (after an Alt+click).
 * @type {import('svelte/store').Writable<{x: number, y: number, index: number, of: number, name: string, mode: 'preview' | 'picked'} | null>} */
export const pickCycleHint = writable(null);

/** What the live region says (S12): set on every Alt+click pick. @type {import('svelte/store').Writable<string>} */
export const pickCycleAnnouncement = writable('');

/** @type {any} */ let box = null;
/** @type {any} */ let boxScene = null;
/** @type {any} */ let hideTimer = null;

/** the name a person reads for a top-level object @param {any} target */
export function pickName(target) {
	return String(target?.name || target?.type || 'object');
}

/**
 * Show the preview: a box around `target` and the chip at (x, y) css px.
 * @param {any} scene the scene root @param {any} target @param {number} x @param {number} y
 * @param {number} index 0-based @param {number} of
 */
export function showPickPreview(scene, target, x, y, index, of) {
	clearTimeout(hideTimer);
	if (!target || !scene) return hidePickPreview();
	if (!box) {
		box = new THREE.BoxHelper(target, 0xffd166);
		box.name = 'pick-cycle-preview';
		box.material.depthTest = false;
		box.material.transparent = true;
		box.renderOrder = 999;
		box.raycast = () => {};
		markHelper(box);
	}
	if (boxScene !== scene) {
		box.parent?.remove(box);
		scene.add(box);
		boxScene = scene;
	}
	box.setFromObject(target);
	box.visible = true;
	pickCycleHint.set({ x, y, index, of, name: pickName(target), mode: 'preview' });
}

/** Hide the preview box and chip. */
export function hidePickPreview() {
	if (box) box.visible = false;
	pickCycleHint.set(null);
}

/**
 * After an Alt+click: the chip confirms "2 of 4 · Fish" for a moment and the live region
 * announces it. @param {any} target @param {number} x @param {number} y @param {number} index @param {number} of
 */
export function notePickCycled(target, x, y, index, of) {
	if (box) box.visible = false;
	const name = pickName(target);
	pickCycleHint.set({ x, y, index, of, name, mode: 'picked' });
	pickCycleAnnouncement.set('Selected ' + (index + 1) + ' of ' + of + ': ' + name);
	clearTimeout(hideTimer);
	hideTimer = setTimeout(() => pickCycleHint.set(null), 1600);
}

/** For the suite. */
export function pickPreviewDebug() {
	return { visible: !!box?.visible, inScene: !!box?.parent };
}
