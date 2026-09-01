import { get } from 'svelte/store';
import { globalRenderer } from '../stores/sceneStore';

// W9: WHERE THE VIEWPORT IS, in client (CSS pixel) coordinates.
//
// The canvas used to be the whole window, so a dozen call sites mapped a pointer to
// NDC with `window.innerWidth/innerHeight` and were right by accident. W9 makes the
// bottom dock a LAYOUT REGION — the canvas shrinks to the space above it — and every
// one of those sites is then wrong by exactly the dock height: a drop lands below the
// cursor, a knife cut is drawn in a different space from the mesh it cuts, a vertex
// handle draws ~1.4x too large.
//
// Reading the renderer's own element is correct in BOTH modes: with the pref off (or
// the dock closed) the canvas IS the window and the rect equals it, so these call
// sites are unconditional — there is no mode to branch on, which is the whole point.
//
// A deliberate LEAF: `svelte/store` + `sceneStore` and nothing else. faceEdit.js and
// meshEdit.js are in the history-cycle family, so anything they import must not be
// able to reach back into `history` (the TDZ-cycle rule).
//
// NOT the frame the HUD uses. `HudLayer`/`hudDocs`/`hudViewportDrag` measure against
// the WINDOW, and an element's anchor offsets are PERSISTED in that frame — moving
// them onto the canvas would be a data migration of every saved HUD, so the HUD frame
// stays the window on purpose.

/** @typedef {{left: number, top: number, width: number, height: number}} Rect */

/**
 * The viewport canvas in client coordinates. Falls back to the window before the
 * renderer exists (module init, an early pointermove, SSR) — which is the same answer
 * the canvas gives once it mounts, since it fills the window minus the dock.
 * @returns {Rect}
 */
export function canvasRect() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const element = renderer?.domElement;
	if (element?.getBoundingClientRect) {
		const rect = element.getBoundingClientRect();
		// a canvas mid-teardown can measure 0x0; the window is a better guess than a
		// division by zero
		if (rect.width > 0 && rect.height > 0) return rect;
	}
	const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
	const height = typeof window !== 'undefined' ? window.innerHeight : 800;
	return { left: 0, top: 0, width, height };
}

/**
 * Client pixels -> normalized device coordinates for a camera raycast.
 * @param {number} clientX @param {number} clientY
 * @returns {{x: number, y: number}}
 */
export function ndcFromClient(clientX, clientY) {
	const rect = canvasRect();
	return {
		x: ((clientX - rect.left) / rect.width) * 2 - 1,
		y: -((clientY - rect.top) / rect.height) * 2 + 1
	};
}

/** The viewport's centre in client pixels — "the middle of the view" for a control
 * that carries no pointer position of its own.
 * @returns {{x: number, y: number}} */
export function canvasCenter() {
	const rect = canvasRect();
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
