// 21-E7.6 — the game pack's MINIMAP: a top-down plot of the scene onto a 2D canvas.
//
// THE FORK, and it is the one decision in this file. The plan said "render-to-texture":
// point an orthographic camera down, render into a target, read it back. That is the
// expensive way round — `readRenderTargetPixels` is a synchronous GPU stall, and it would
// pay for a full scene render (shadows, post, the works) to produce a 180px thumbnail.
// `DungeonMinimap.svelte` already established the cheap way and has shipped for a long
// time: plot the geometry you care about with 2D canvas calls. So this is a top-down
// ORTHOGRAPHIC PROJECTION — the same maths — rasterised on the CPU by `fillRect`, which
// for ~50 objects is a fraction of a millisecond and needs no GL state at all.
//
// It is also the only version that can honour "follow userData.play.markers", since those
// are DATA a module publishes and not something in the scene to be photographed.
//
// TWO caps keep it honest: only the TOP-LEVEL children of objectsGroup are drawn (a group
// is one footprint, which is what a map wants), and no more than OBJECT_CAP of them. The
// caller refreshes at ~2Hz.
//
// Imported ONLY by `HudElement.svelte`, so it is a leaf of the import graph the way every
// component is — nothing in `src/lib` reaches it, and it can therefore afford to read the
// scene stores directly.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, objectsGroup, playerCam, globalCamera } from '../stores/sceneStore';
import { userdata, peers } from '../stores/appStore';
import { playMarkers } from './playSettings';
import { peerColor } from './lockControl';

/** the most scene objects one frame will plot. A minimap is a glance, not an inventory. */
const OBJECT_CAP = 200;

/** how often the caller should redraw, in ms. ~2Hz: the layer is real DOM and this is the
 * one HUD kind that does per-frame-shaped work, so it gets the `hudRuntime` discipline. */
export const MINIMAP_REFRESH_MS = 500;

/** marker colours by KIND — the DungeonMinimap table, so the two maps agree.
 * @type {Record<string, string>} */
const MARKER_COLORS = { key: '#ffc93d', door: '#39d0ff', goal: '#f472b6', spawn: '#4ade80' };

const box = new THREE.Box3();
const here = new THREE.Vector3();

/** Where the map is centred: me, or the world origin. @param {boolean} follow */
function centreOf(follow) {
	if (!follow) return { x: 0, z: 0 };
	// the PLAY camera while playing, else the editor camera — whichever is driving the view
	// playerCam is writable(false), not writable(null), so ?? would keep the 
	const cam = get(playerCam) || get(globalCamera);
	if (!cam) return { x: 0, z: 0 };
	/** @type {any} */ (cam).getWorldPosition(here);
	return { x: here.x, z: here.z };
}

/**
 * Draw one frame. Total function: a missing scene or a zero-sized canvas draws the
 * background and returns, so the caller never has to guard.
 * @param {HTMLCanvasElement} canvas @param {any} el the element (range/follow/shapes/dots)
 * @param {string} [tint] the resolved style colour, for the "me" dot
 */
export function drawHudMinimap(canvas, el, tint = '#4ade80') {
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	// the canvas is sized in CSS pixels by the caller; drawing in the same units keeps the
	// maths readable and a HUD minimap is not where anyone counts texels
	const w = canvas.width;
	const h = canvas.height;
	if (!w || !h) return;
	ctx.clearRect(0, 0, w, h);

	const range = Math.max(1, Number(el?.range ?? 40));
	const scale = Math.min(w, h) / range;
	const centre = centreOf(el?.follow !== false);
	/** world x/z -> canvas x/y. The projection, such as it is. */
	const px = (/** @type {number} */ x) => w / 2 + (x - centre.x) * scale;
	const py = (/** @type {number} */ z) => h / 2 + (z - centre.z) * scale;

	const scene = get(globalScene);
	if (el?.shapes !== false) {
		const group = get(objectsGroup);
		const children = /** @type {any[]} */ (group?.children ?? []).slice(0, OBJECT_CAP);
		ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
		for (const child of children) {
			if (!child.visible) continue;
			// setFromObject with precise=false (the default) walks each mesh's GEOMETRY
			// bounding box, not its vertices — so a 100k-triangle model costs one matrix
			// transform, which is what makes plotting affordable at all
			box.setFromObject(child);
			if (box.isEmpty()) continue;
			const x0 = px(box.min.x);
			const x1 = px(box.max.x);
			const y0 = py(box.min.z);
			const y1 = py(box.max.z);
			// a minimum of 2px, or a distant object flickers in and out of existence
			ctx.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
		}
	}

	/** @param {number} x @param {number} z @param {string} color @param {number} r */
	const dot = (x, z, color, r) => {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(px(x), py(z), r, 0, Math.PI * 2);
		ctx.fill();
	};

	// B3's PUBLIC contract: any module publishing userData.play.markers lands here, which
	// is the generalisation of the dungeon's key/door dots
	for (const marker of playMarkers(scene)) dot(marker.x, marker.z, MARKER_COLORS[marker.kind] ?? '#ffffff', 3);

	if (el?.dots === false) return;
	const myId = /** @type {any} */ (get(peers))?.peer?.id;
	// userdata is writable([]), which infers never[] - the documented annotate-it rule
	for (const user of /** @type {any[]} */ (get(userdata) ?? [])) {
		const id = user?.[0];
		if (!id || id === myId) continue;
		const avatar = scene?.getObjectByName(id);
		// parked avatars sit far above the scene (the DungeonMinimap rule)
		if (!avatar || avatar.position.y > 500) continue;
		dot(avatar.position.x, avatar.position.z, peerColor(id), 3);
	}
	const me = centreOf(true);
	dot(me.x, me.z, tint, 3.5);
}
