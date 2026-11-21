// VR controls — 102 M6: PAINT ON MESHES IN THE HEADSET. The desktop brush (meshPaint.js: colour, roughness,
// metalness, emission; hardness / flow / opacity / eraser / mirror X; vertex colours on a mesh without usable UVs)
// driven by a controller, the VR sculpt brush's recipe (vr/sculpt.js, 37 R9 / 52 V3):
//   - the POINTER hand aims: its ray puts the brush ring on the object; the trigger held = a stroke
//   - its STICK sizes the brush (left / right) and sets the flow (up / down), a tick at every step; that hand's
//     move / turn stand down while painting (registerStickOwner), the other stick still moves you
//   - a label on the pointer hand says the channel, the size and the flow
//   - the radial opens on the Paint ring while a session is up: Colour · Roughness · Metalness · Glow · Eraser ·
//     Mirror X · Done (Back reaches the usual menu); Selected ▸ Paint starts one
// The settings are the desktop panel's own stores, so the panel and the headset agree, and a stroke is the
// desktop's: one commit, one undo entry, the same live wire. Edit mode only. A tracked hand asks for a controller
// (52 rules: precise tools are controller tools).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, editorMode, vrMenuHand, vrMenuOpen } from '../../stores/sceneStore';
import { renderer } from './core.js';
import { hapticPulse } from './haptics.js';
import { controllerIndexFor, axesForSlot } from './input.js';
import { controllerRay } from './pointer.js';
import { vrHovered } from './panels.js';
import { registerVRFrameHook, registerVRTriggerHooks, registerStickOwner } from './hooks.js';
import { controllerRequired } from './handInput.js';
import { vrPaintActive } from './worldStores.js';
import { uvBrushSize, meshWithUvs } from '../uvEditor';
import { paintChannel, paintFlow, paintErase, paintMirror } from '../meshPaintPrefs';
import { beginStroke, strokeTo, endStroke, cancelStroke, localHit, showRing, hideRing, worldNormal, ringRadius, slotOfHit } from '../meshPaint';
import { channelOf } from '../meshPaintCore.js';

export const SIZE_MIN = 1;
export const SIZE_MAX = 128;
export const FLOW_MIN = 0.05;
export const FLOW_MAX = 1;
const DEAD = 0.25;

let hooked = false;
/** @type {string | null} the painted object */
let paintUuid = null;
/** @type {{index: number} | null} the trigger stroke in flight */
let stroke = null;
let lastFrame = 0;
let swallowAt = 0;
const stats = { strokes: 0, moves: 0, ticks: 0, refusals: 0 };

function pointerHand() {
	return get(vrMenuHand) === 'right' ? 'left' : 'right';
}
function pointerIndex() {
	return controllerIndexFor(pointerHand());
}
/** the painted mesh (a group resolves to its textured child, the UV editor's rule) @returns {any} */
function target() {
	const object = paintUuid ? get(objectsGroup)?.getObjectByProperty('uuid', paintUuid) : null;
	return object ? meshWithUvs(object) : null;
}

function ensureHooks() {
	if (hooked) return;
	hooked = true;
	registerStickOwner(() => (get(vrPaintActive) && !get(vrMenuOpen) ? pointerHand() : null));
	registerVRTriggerHooks({
		start: (/** @type {number} */ i) => paintTriggerStart(i),
		end: (/** @type {number} */ i) => paintTriggerEnd(i),
		swallow: () => {
			const pending = swallowAt && Date.now() - swallowAt < 5000;
			swallowAt = 0;
			return !!pending;
		}
	});
	registerVRFrameHook(() => tickVRPaint());
}

/** Start painting `uuid` in the headset (Selected ▸ Paint). @param {string} uuid */
export function startVRPaint(uuid) {
	if (!uuid) return false;
	ensureHooks();
	paintUuid = uuid;
	if (!target()?.geometry) {
		paintUuid = null;
		return false;
	}
	vrPaintActive.set(true);
	vrMenuOpen.set(false);
	lastFrame = performance.now();
	return true;
}

/** Done: commit a stroke in flight and leave the session */
export function stopVRPaint() {
	if (stroke) paintTriggerEnd(stroke.index);
	stroke = null;
	paintUuid = null;
	vrPaintActive.set(false);
	hideRing();
	hideLabel();
}

/** a Paint-ring sector: pick the channel @param {string} ch */
export function setVRPaintChannel(ch) {
	if (['color', 'roughness', 'metalness', 'emissive'].includes(ch)) paintChannel.set(/** @type {any} */ (ch));
}

/** @param {number} index */
function hitOf(index) {
	const mesh = target();
	if (!mesh || index < 0) return null;
	return controllerRay(index).intersectObject(mesh, false)[0] ?? null;
}

/** @param {number} index */
export function paintTriggerStart(index) {
	if (!get(vrPaintActive) || stroke) return false;
	if (get(vrMenuOpen) || get(vrHovered)) return false;
	const hit = hitOf(index);
	const mesh = target();
	if (!hit || !mesh) return false; // off the object: an ordinary press (a panel, a ping)
	swallowAt = Date.now();
	if (controllerRequired('paint', index)) {
		stats.refusals++;
		return true;
	}
	const h = localHit(mesh, hit);
	stroke = { index };
	stats.strokes++;
	hapticPulse(0.3, 16, pointerHand(), true);
	void beginStroke({ uuid: mesh.uuid, slot: slotOfHit(mesh, hit, 0), sp: 'obj', at: h.local, normal: h.normal }).then((ok) => {
		if (!ok && stroke?.index === index) stroke = null;
	});
	return true;
}

/** @param {number} index */
export function paintTriggerEnd(index) {
	if (!stroke || (index >= 0 && index !== stroke.index)) return false;
	stroke = null;
	endStroke(); // ONE commit + ONE undo entry, the desktop stroke's own
	return true;
}

/** stick -> size (x) and flow (y, up = more); a tick at every 8 px / tenth @param {number} x @param {number} y @param {number} dt */
export function adjustBrush(x, y, dt) {
	let ticked = false;
	if (Math.abs(x) > DEAD) {
		const s0 = get(uvBrushSize);
		const s = Math.round(THREE.MathUtils.clamp(s0 * Math.exp(x * dt * 1.4), SIZE_MIN, SIZE_MAX));
		if (s !== s0) uvBrushSize.set(s);
		if (Math.floor(s0 / 8) !== Math.floor(s / 8)) ticked = true;
	}
	if (Math.abs(y) > DEAD) {
		const f0 = get(paintFlow);
		const f = THREE.MathUtils.clamp(f0 - y * dt * 0.7, FLOW_MIN, FLOW_MAX);
		paintFlow.set(Math.round(f * 1000) / 1000);
		if (Math.floor(f0 * 10 + 1e-6) !== Math.floor(f * 10 + 1e-6)) ticked = true;
	}
	if (ticked) {
		stats.ticks++;
		hapticPulse(0.1, 10, pointerHand());
	}
	return ticked;
}

/** per frame: the ring follows the pointer, a held trigger paints, the stick sizes */
export function tickVRPaint() {
	if (!get(vrPaintActive)) return;
	const now = performance.now();
	const dt = Math.min((now - lastFrame) / 1000, 0.1);
	lastFrame = now;
	const mesh = target();
	if (!mesh || !renderer?.xr?.getSession?.() || get(editorMode) === 'interact') {
		if (stroke) cancelStroke();
		stroke = null;
		stopVRPaint();
		return;
	}
	const index = stroke ? stroke.index : pointerIndex();
	const hit = get(vrMenuOpen) ? null : hitOf(index);
	if (hit) {
		showRing(hit.point, worldNormal(hit), ringRadius(mesh, slotOfHit(mesh, hit, 0), hit));
		if (stroke) {
			strokeTo(localHit(mesh, hit).local);
			stats.moves++;
		}
	} else hideRing();
	if (!get(vrMenuOpen)) {
		const axes = axesForSlot(pointerIndex());
		adjustBrush(axes[2] ?? 0, axes[3] ?? 0, dt);
	}
	updateLabel();
}

/** what the hand label says @returns {string} */
export function paintLabelText() {
	const ch = channelOf(get(paintChannel)).label;
	const what = get(paintErase) ? 'Erase ' + ch.toLowerCase() : ch;
	return what + (get(paintMirror) ? ' (mirror)' : '') + ' · ' + get(uvBrushSize) + ' px · ' + Math.round(get(paintFlow) * 100) + '%';
}

/** @type {any} */ let label = null;
/** @type {any} */ let labelCanvas = null;
let labelText = '';

function updateLabel() {
	if (typeof document === 'undefined' || !renderer?.xr) return;
	if (!label) {
		labelCanvas = document.createElement('canvas');
		labelCanvas.width = 320;
		labelCanvas.height = 80;
		const texture = new THREE.CanvasTexture(labelCanvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		label = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.0225), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: true }));
		label.name = 'vr-paint-label';
		label.position.set(0, 0.03, 0.07);
		label.rotation.set(-1.0, 0, 0);
		label.renderOrder = 996;
	}
	const index = pointerIndex();
	label.visible = index >= 0;
	if (index < 0) return;
	const controller = renderer.xr.getController(index);
	if (label.parent !== controller) controller.add(label);
	const text = paintLabelText();
	if (text === labelText) return;
	labelText = text;
	const ctx = labelCanvas.getContext('2d');
	if (!ctx) return;
	ctx.clearRect(0, 0, 320, 80);
	ctx.fillStyle = 'rgba(17, 24, 39, 0.88)';
	ctx.beginPath();
	if (ctx.roundRect) ctx.roundRect(4, 4, 312, 72, 18);
	else ctx.rect(4, 4, 312, 72);
	ctx.fill();
	ctx.fillStyle = '#f3f4f6';
	ctx.font = '600 28px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(text.length > 26 ? text.slice(0, 25) + '…' : text, 160, 41);
	label.material.map.needsUpdate = true;
}

function hideLabel() {
	if (label) label.visible = false;
}

/** the suites' view */
export function vrPaintDebug() {
	return { active: get(vrPaintActive), uuid: paintUuid, stroking: !!stroke, label: labelText, channel: get(paintChannel), size: get(uvBrushSize), flow: get(paintFlow), ...stats };
}
