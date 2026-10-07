// VR controls — TERRAIN SCULPT IN THE HEADSET (37 R9). The desktop brush (terrainSculpt.js: raise / lower / smooth /
// flatten over the meshgeo channel, one snapshot + one undo entry per stroke, selection = lock) driven by the
// controllers instead of the mouse:
//   - the POINTER hand aims: its ray puts the brush ring on the terrain; the trigger held = a stroke
//   - the pointer hand's STICK sizes the brush: left/right = size, up/down = strength (a little tick at every
//     half metre / tenth); that hand's move/turn/teleport stand down while you sculpt, the other stick still
//     moves you (hooks.registerStickOwner)
//   - a label on the pointer hand says the tool and both numbers
//   - the radial opens on the Sculpt ring while a session is up: Raise · Lower · Smooth · Flatten · Done
//     (Back reaches the usual menu); Add ▸ Terrain starts one on the new terrain, Selected ▸ Sculpt terrain on
//     an existing one
// The tool and the two numbers are the desktop toolbar's own stores, so a desktop peer-of-yourself and the
// headset agree. Edit only: switching to Interact or leaving the session ends the session.
//
// Rides the K1 hook registries (trigger / frame / stick owner), registered on first use (the splineEdit pattern).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, editorMode, vrMenuHand, vrMenuOpen } from '../../stores/sceneStore';
import {
	sculptObject,
	sculptOp,
	sculptRadius,
	sculptStrength,
	enterSculpt,
	exitSculpt,
	beginStroke,
	strokeMove,
	endStroke,
	showCursorAt,
	hideCursor
} from '../terrainSculpt';
import { renderer } from './core.js';
import { hapticPulse } from './haptics.js';
import { controllerIndexFor, axesForSlot } from './input.js';
import { controllerRay } from './pointer.js';
import { vrHovered } from './panels.js';
import { registerVRFrameHook, registerVRTriggerHooks, registerStickOwner } from './hooks.js';
import { vrSculptActive } from './worldStores.js';

export const SCULPT_OPS = /** @type {const} */ (['raise', 'lower', 'smooth', 'flatten']);
export const RADIUS_MIN = 0.25;
export const RADIUS_MAX = 20;
export const STRENGTH_MIN = 0.05;
export const STRENGTH_MAX = 1;
const DEAD = 0.25;

let hooked = false;
/** @type {{index: number, last: number} | null} the trigger stroke in flight */
let stroke = null;
let lastFrame = 0;
let swallowAt = 0;
/** the suites' view */
const stats = { strokes: 0, moves: 0, ticks: 0 };

/** the pointer hand (the one that does not hold the menu) */
function pointerHand() {
	return get(vrMenuHand) === 'right' ? 'left' : 'right';
}
function pointerIndex() {
	return controllerIndexFor(pointerHand());
}
/** the sculpted object @returns {any} */
function target() {
	const uuid = get(sculptObject);
	return uuid ? get(objectsGroup)?.getObjectByProperty('uuid', uuid) : null;
}

function ensureHooks() {
	if (hooked) return;
	hooked = true;
	registerStickOwner(() => (get(vrSculptActive) && !get(vrMenuOpen) ? pointerHand() : null));
	registerVRTriggerHooks({
		start: (/** @type {number} */ i) => sculptTriggerStart(i),
		end: (/** @type {number} */ i) => sculptTriggerEnd(i),
		swallow: () => {
			const pending = swallowAt && Date.now() - swallowAt < 5000;
			swallowAt = 0;
			return !!pending;
		}
	});
	registerVRFrameHook(() => tickVRSculpt());
}

/** Start sculpting `uuid` in the headset (Add ▸ Terrain, Selected ▸ Sculpt terrain). @param {string} uuid */
export function startVRSculpt(uuid) {
	if (!uuid) return false;
	ensureHooks();
	if (get(sculptObject) !== uuid) {
		if (get(sculptObject)) exitSculpt();
		if (!enterSculpt(uuid)) return false;
	}
	vrSculptActive.set(true);
	vrMenuOpen.set(false);
	lastFrame = performance.now();
	return true;
}

/** Done: commit a stroke in flight and leave sculpt mode */
export function stopVRSculpt() {
	if (stroke) sculptTriggerEnd(stroke.index);
	stroke = null;
	if (get(sculptObject)) exitSculpt();
	vrSculptActive.set(false);
	hideLabel();
}

/** a sculpt-ring sector: pick the brush @param {string} op */
export function setVRSculptOp(op) {
	if (/** @type {readonly string[]} */ (SCULPT_OPS).includes(op)) sculptOp.set(/** @type {any} */ (op));
}

/** the pointed spot on the sculpted object @param {number} index @returns {any} */
function hitOf(index) {
	const object = target();
	if (!object || index < 0) return null;
	const hits = controllerRay(index).intersectObject(object, false);
	return hits.find((/** @type {any} */ h) => h.object === object) ?? null;
}

/** @param {number} index */
export function sculptTriggerStart(index) {
	if (!get(vrSculptActive) || stroke) return false;
	// the radial or a panel row under the ray owns this press
	if (get(vrMenuOpen) || get(vrHovered)) return false;
	const hit = hitOf(index);
	const uuid = get(sculptObject);
	if (!hit || !uuid) return false; // off the terrain: an ordinary press (a panel, a ping)
	swallowAt = Date.now();
	beginStroke(uuid);
	stroke = { index, last: performance.now() };
	stats.strokes++;
	brushAt(hit, 0.016);
	return true;
}

/** @param {number} index */
export function sculptTriggerEnd(index) {
	if (!stroke || (index >= 0 && index !== stroke.index)) return false;
	stroke = null;
	endStroke(); // ONE snapshot + ONE undo entry, the desktop stroke's own commit
	return true;
}

/** @param {any} hit @param {number} dt */
function brushAt(hit, dt) {
	const object = target();
	const uuid = get(sculptObject);
	if (!object || !uuid) return;
	const local = object.worldToLocal(hit.point.clone());
	strokeMove(uuid, local.x, local.z, dt, local.y);
	stats.moves++;
}

/** stick -> size (x) and strength (y, up = stronger); a tick at every half metre / tenth @param {number} x @param {number} y @param {number} dt */
export function adjustBrush(x, y, dt) {
	let ticked = false;
	if (Math.abs(x) > DEAD) {
		const r0 = get(sculptRadius);
		const r = THREE.MathUtils.clamp(r0 * Math.exp(x * dt * 1.4), RADIUS_MIN, RADIUS_MAX);
		sculptRadius.set(Math.round(r * 100) / 100);
		if (Math.floor(r0 * 2) !== Math.floor(r * 2)) ticked = true;
	}
	if (Math.abs(y) > DEAD) {
		const s0 = get(sculptStrength);
		const s = THREE.MathUtils.clamp(s0 - y * dt * 0.7, STRENGTH_MIN, STRENGTH_MAX);
		sculptStrength.set(Math.round(s * 1000) / 1000);
		if (Math.floor(s0 * 10 + 1e-6) !== Math.floor(s * 10 + 1e-6)) ticked = true;
	}
	if (ticked) {
		stats.ticks++;
		hapticPulse(0.1, 10, pointerHand());
	}
	return ticked;
}

/** per frame: the ring follows the pointer, a held trigger brushes, the stick sizes */
export function tickVRSculpt() {
	if (!get(vrSculptActive)) return;
	const now = performance.now();
	const dt = Math.min((now - lastFrame) / 1000, 0.1);
	lastFrame = now;
	// the session ended elsewhere (desktop Done, a scene clear, Interact, leaving the headset)
	if (!get(sculptObject) || !renderer?.xr?.getSession?.() || get(editorMode) === 'interact') {
		stopVRSculpt();
		return;
	}
	const index = stroke ? stroke.index : pointerIndex();
	const hit = get(vrMenuOpen) ? null : hitOf(index);
	if (hit) {
		const n = hit.face?.normal ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
		showCursorAt(hit.point, n);
		if (stroke) brushAt(hit, dt);
	} else hideCursor();
	if (!get(vrMenuOpen)) {
		const axes = axesForSlot(pointerIndex());
		adjustBrush(axes[2] ?? 0, axes[3] ?? 0, dt);
	}
	updateLabel();
}

/** the suites' view */
export function vrSculptDebug() {
	return {
		active: get(vrSculptActive),
		uuid: get(sculptObject),
		op: get(sculptOp),
		radius: get(sculptRadius),
		strength: get(sculptStrength),
		stroking: !!stroke,
		label: labelText,
		labelHand: label?.parent?.userData?.handedness ?? null,
		...stats
	};
}

// ---- the brush label on the pointer hand ----------------------------------------------------------------
/** @type {any} */ let label = null;
/** @type {any} */ let labelCanvas = null;
let labelText = '';

const OP_LABEL = { raise: 'Raise', lower: 'Lower', smooth: 'Smooth', flatten: 'Flatten' };

function updateLabel() {
	if (typeof document === 'undefined' || !renderer?.xr) return;
	if (!label) {
		labelCanvas = document.createElement('canvas');
		labelCanvas.width = 320;
		labelCanvas.height = 80;
		const texture = new THREE.CanvasTexture(labelCanvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		label = new THREE.Mesh(
			new THREE.PlaneGeometry(0.09, 0.0225),
			new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: true })
		);
		label.name = 'vr-sculpt-label';
		// on the back of the controller, tilted up toward the eyes (the mode label's place on the other hand)
		label.position.set(0, 0.03, 0.07);
		label.rotation.set(-1.0, 0, 0);
		label.renderOrder = 996;
	}
	const index = pointerIndex();
	label.visible = index >= 0;
	if (index < 0) return;
	const controller = renderer.xr.getController(index);
	if (label.parent !== controller) controller.add(label);
	const op = /** @type {keyof typeof OP_LABEL} */ (get(sculptOp));
	const text = (OP_LABEL[op] ?? op) + ' · ' + get(sculptRadius).toFixed(1) + ' m · ' + Math.round(get(sculptStrength) * 100) + '%';
	if (text === labelText) return;
	labelText = text;
	const ctx = labelCanvas.getContext('2d');
	if (!ctx) return;
	ctx.clearRect(0, 0, 320, 80);
	ctx.fillStyle = 'rgba(17, 24, 39, 0.88)';
	ctx.beginPath();
	ctx.roundRect?.(4, 4, 312, 72, 18);
	if (!ctx.roundRect) ctx.rect(4, 4, 312, 72);
	ctx.fill();
	ctx.fillStyle = '#5fd0ff'; // the brush ring's colour (terrainSculpt's cursor)
	ctx.font = 'bold 30px sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, 160, 42);
	label.material.map.needsUpdate = true;
}

function hideLabel() {
	if (label) {
		label.visible = false;
		label.parent?.remove(label);
	}
	labelText = '';
}
