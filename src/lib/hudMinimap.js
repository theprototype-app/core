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

/** the literal every `--accent` chain ends in, matching HudEditor's own `var(--accent,
 * #ef562f)` — the default dark theme does not DEFINE --accent (the ToolboxWindow rule),
 * so a token-only read resolves to the empty string and a canvas would paint nothing. */
const ACCENT_FALLBACK = '#ef562f';

const box = new THREE.Box3();
const here = new THREE.Vector3();
const fwd = new THREE.Vector3();

/** The theme's accent, resolved to a LITERAL — a canvas fillStyle cannot take `var()`. */
export function accentColor() {
	if (typeof window === 'undefined' || !document?.documentElement) return ACCENT_FALLBACK;
	const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
	return value || ACCENT_FALLBACK;
}

/**
 * A style colour resolved for the CANVAS. A bare token name goes through the theme (the
 * `paint()` rule in HudElement, except the answer must be a literal here); anything else
 * — a hex, an rgb(), a CSS keyword — is used as authored.
 * @param {any} value @param {string} fallback
 */
export function resolveHudColor(value, fallback) {
	const text = String(value ?? '').trim();
	if (!text) return fallback;
	if (!/^[a-z][a-z0-9-]*$/i.test(text)) return text;
	if (typeof window === 'undefined' || !document?.documentElement) return text;
	const token = getComputedStyle(document.documentElement).getPropertyValue('--' + text).trim();
	// no such token: it was a CSS keyword ('red', 'white') all along
	return token || text;
}

/**
 * F5 — THE ONE COLOUR RULE, and the whole point of exporting it is that there is exactly
 * one. Before this, SELF was drawn with the element tint (which fell back to a hardcoded
 * green whenever the authored colour was a token, i.e. always) while every OTHER peer got
 * `peerColor`: so A saw itself green and B saw A as hsl(hash(A)), and the two screens
 * disagreed about what colour A is. Now: SELF is the ACCENT on every screen, and every
 * other peer is their `peerColor`, which is a pure hash of the id and therefore computes
 * to the SAME string on every screen. A missing id is also "me" (offline, one dot).
 * @param {string|null|undefined} peerId @param {string|null|undefined} myId
 * @param {string} [accent] the resolved self colour, so a caller can override it
 */
export function minimapDotColor(peerId, myId, accent) {
	if (!peerId || peerId === myId) return accent || accentColor();
	return peerColor(peerId);
}

/**
 * F5 — a world heading as a CANVAS rotation. The projection below is `x -> px(x)`,
 * `z -> py(z)` with both scales POSITIVE, so canvas +x is world +x and canvas +y (which
 * grows DOWNWARD) is world +z — the ordinary top-down convention where -Z reads as north.
 * That makes the conversion one `atan2(z, x)` with NO sign flip and no quarter turn: a
 * heading of world +Z comes out at +PI/2, which is straight DOWN the screen. A 90-degree
 * error here is invisible on a symmetric scene, which is why it is its own function.
 * @param {number} fx world-x component of the forward vector
 * @param {number} fz world-z component
 */
export function facingAngle(fx, fz) {
	return Math.atan2(fz, fx);
}

/**
 * The canvas angle an Object3D faces. A camera — and a peer avatar, whose group is posed
 * straight off the peer's broadcast camera euler by `moveCamera` — looks down its LOCAL
 * -Z, so that is the vector rotated. Returns null when the heading is straight up or
 * down, where a top-down wedge would mean nothing.
 * @param {any} object
 */
export function mapAngleOf(object) {
	if (!object?.quaternion) return null;
	fwd.set(0, 0, -1).applyQuaternion(object.quaternion);
	return Math.hypot(fwd.x, fwd.z) < 1e-6 ? null : facingAngle(fwd.x, fwd.z);
}

/** What the last frame actually plotted — the colour and heading per id, so a suite can
 * assert the RENDER rather than re-deriving it. Written by `drawHudMinimap`.
 * @type {{ at: number, self: any, peers: any[] }} */
let lastFrame = { at: 0, self: null, peers: [] };

/** @returns {{ at: number, self: any, peers: any[] }} the last plotted frame */
export function lastMinimapFrame() {
	return lastFrame;
}

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
 * @param {string} [tint] override for the "me" colour; absent = the element's own style
 *   colour, and absent again = the theme accent
 */
export function drawHudMinimap(canvas, el, tint = '') {
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

	// F5: the heading WEDGE — a small arrow off the dot, in the dot's own colour so the
	// "which one is me" reading survives at 3px. Drawn in canvas space, where the angle is
	// already the rotation (see facingAngle).
	/** @param {number} x @param {number} z @param {string} color @param {number} r @param {number} angle */
	const wedge = (x, z, color, r, angle) => {
		ctx.save();
		ctx.translate(px(x), py(z));
		ctx.rotate(angle);
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(r + 5, 0);
		ctx.lineTo(r * 0.2, -r * 1.15);
		ctx.lineTo(r * 0.2, r * 1.15);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	};

	// B3's PUBLIC contract: any module publishing userData.play.markers lands here, which
	// is the generalisation of the dungeon's key/door dots
	for (const marker of playMarkers(scene)) dot(marker.x, marker.z, MARKER_COLORS[marker.kind] ?? '#ffffff', 3);

	if (el?.dots === false) {
		lastFrame = { at: Date.now(), self: null, peers: [] };
		return;
	}
	const myId = /** @type {any} */ (get(peers))?.peer?.id ?? null;
	// F5: the self colour is resolved ONCE and then every dot — mine and everyone else's —
	// goes through the same `minimapDotColor`, so there is one rule and no second branch to
	// drift out of step with it.
	const accent = resolveHudColor(tint || el?.style?.color, accentColor());
	const facing = el?.showFacing !== false;
	/** @type {any[]} */
	const plotted = [];

	// userdata is writable([]), which infers never[] - the documented annotate-it rule
	for (const user of /** @type {any[]} */ (get(userdata) ?? [])) {
		const id = user?.[0];
		if (!id || id === myId) continue;
		const avatar = scene?.getObjectByName(id);
		// parked avatars sit far above the scene (the DungeonMinimap rule)
		if (!avatar || avatar.position.y > 500) continue;
		const color = minimapDotColor(id, myId, accent);
		// a peer's heading is the group's own rotation, which `moveCamera` poses straight
		// off their broadcast camera euler — the same source as the position beside it
		const angle = facing ? mapAngleOf(avatar) : null;
		if (angle !== null) wedge(avatar.position.x, avatar.position.z, color, 3, angle);
		dot(avatar.position.x, avatar.position.z, color, 3);
		plotted.push({ id, color, angle, self: false, x: avatar.position.x, z: avatar.position.z });
	}

	const me = centreOf(true);
	const myColor = minimapDotColor(myId, myId, accent);
	// mine comes from the camera actually driving the view, whichever that is
	const myCam = /** @type {any} */ (get(playerCam) || get(globalCamera));
	let myAngle = null;
	if (facing && myCam) {
		myCam.getWorldDirection(fwd);
		myAngle = Math.hypot(fwd.x, fwd.z) < 1e-6 ? null : facingAngle(fwd.x, fwd.z);
	}
	if (myAngle !== null) wedge(me.x, me.z, myColor, 3.5, myAngle);
	dot(me.x, me.z, myColor, 3.5);
	lastFrame = {
		at: Date.now(),
		self: { id: myId, color: myColor, angle: myAngle, self: true, x: me.x, z: me.z },
		peers: plotted
	};
}
