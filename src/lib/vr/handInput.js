// VR controls — 52-browser (H): LIGHT HAND TRACKING. The user's rule (roadmap 52, 2026-10-21): every tool
// is full on controllers; a TRACKED HAND browses and places — a pinch IS the trigger (the session's
// select / selectstart / selectend, which the headset fires for a pinch), a pinch held while the hand moves
// is the drag (the Asset Browser's pinch-drag puts the ghost down where the pinch lets go) — and a PRECISE
// tool (a sculpt / paint brush, measuring with snapping, dragging a vertex or a face) answers a pinch with
// "Pick up a controller" instead of doing something a fingertip cannot aim.
//
// `controllerRequired(tool, slot)` is the one gate: true (and the note shown at that hand) when the slot's
// input is a tracked hand, false for a controller. Siblings call it at the top of their trigger path
// (52-measure's snap measure, 52-paint's brushes) — the note, its wording and its look stay one thing.
//
// The note is one canvas chip (one draw call) that rides the hand that pinched for a few seconds, drawn over
// the scene like the panels. LOCAL; nothing here replicates.
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { globalScene, globalRenderer } from '../../stores/sceneStore';
import { overlayPanel } from '../vrPanelOverlay';
import { registerVRFrameHook } from './hooks.js';

const NOTE_MS = 2600;
const CHIP_PX = { w: 640, h: 128 };
const CHIP_M = { w: 0.16, h: 0.032 };

/** the note on show: {text, hand, until} or null (the suites read it) @type {import('svelte/store').Writable<any>} */
export const vrHandNote = writable(null);

/** the input source of a hand (by handedness), or null @param {string | null | undefined} hand */
function sourceOf(hand) {
	const r = /** @type {any} */ (get(globalRenderer));
	const session = r?.xr?.getSession?.();
	if (!session || !hand) return null;
	for (const s of session.inputSources) if (s.handedness === hand) return s;
	return null;
}

/** the handedness of controller slot `index` @param {number} index @returns {string | null} */
function handOfSlot(index) {
	const r = /** @type {any} */ (get(globalRenderer));
	return r?.xr?.getController(index)?.userData?.handedness ?? null;
}

/** Is that hand a TRACKED HAND (no controller in it)? @param {string | number | null | undefined} handOrSlot */
export function isTrackedHand(handOrSlot) {
	const hand = typeof handOrSlot === 'number' ? handOfSlot(handOrSlot) : handOrSlot;
	return !!sourceOf(hand)?.hand;
}

/**
 * The precise-tool gate: a tracked hand gets "Pick up a controller to <tool>" at that hand and TRUE (the
 * caller stands down and should swallow the press); a controller gets false. `slot` = the controller slot
 * (or a handedness) that pressed.
 * @param {string} tool e.g. 'sculpt' · 'measure with snapping' · 'move a vertex'
 * @param {number | string} slot
 * @returns {boolean}
 */
export function controllerRequired(tool, slot) {
	if (!isTrackedHand(slot)) return false;
	const hand = typeof slot === 'number' ? handOfSlot(slot) : slot;
	showHandNote(`Pick up a controller to ${tool}`, hand);
	return true;
}

/** @type {any} */ let chip = null;
/** @type {HTMLCanvasElement | null} */ let canvas = null;
/** @type {any} */ let texture = null;
let hooked = false;
let drawn = '';

function ensureChip() {
	if (chip || typeof document === 'undefined') return chip;
	canvas = document.createElement('canvas');
	canvas.width = CHIP_PX.w;
	canvas.height = CHIP_PX.h;
	texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	chip = new THREE.Mesh(
		new THREE.PlaneGeometry(CHIP_M.w, CHIP_M.h),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false })
	);
	chip.name = 'vr-hand-note';
	chip.visible = false;
	overlayPanel(chip);
	return chip;
}

/** @param {string} text */
function paint(text) {
	if (text === drawn || !canvas) return;
	drawn = text;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	if (!g) return;
	const { w, h } = CHIP_PX;
	g.clearRect(0, 0, w, h);
	g.beginPath();
	g.roundRect?.(4, 4, w - 8, h - 8, 40) ?? g.rect(4, 4, w - 8, h - 8);
	// tokens-ok: a canvas cannot read var() — the headset-panel literal exception
	g.fillStyle = 'rgba(17, 21, 28, 0.94)';
	g.fill();
	g.lineWidth = 4;
	g.strokeStyle = '#fbbf24'; // tokens-ok: the warn ink as a literal (canvas)
	g.stroke();
	g.fillStyle = '#f1f4f8'; // tokens-ok
	g.font = '600 40px system-ui, sans-serif';
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillText(text, w / 2, h / 2 + 2, w - 48);
	texture.needsUpdate = true;
}

/** Show a short note at a hand (any feature may). @param {string} text @param {string | null} hand */
export function showHandNote(text, hand) {
	ensureChip();
	if (!hooked) {
		hooked = true;
		registerVRFrameHook(frame);
	}
	vrHandNote.set({ text, hand, until: Date.now() + NOTE_MS });
}

/** where a hand is (its controller group follows the tracked hand's target ray) @param {string} hand */
function handPosition(hand) {
	const r = /** @type {any} */ (get(globalRenderer));
	if (!r?.xr) return null;
	for (const i of [0, 1]) {
		const c = r.xr.getController(i);
		if (c?.userData?.handedness === hand) {
			c.updateMatrixWorld(true);
			return c.getWorldPosition(new THREE.Vector3());
		}
	}
	return null;
}

function frame() {
	if (!chip) return;
	const note = get(vrHandNote);
	const r = /** @type {any} */ (get(globalRenderer));
	if (!note || Date.now() > note.until || !r?.xr?.isPresenting) {
		chip.visible = false;
		if (note && Date.now() > note.until) vrHandNote.set(null);
		return;
	}
	const scene = /** @type {any} */ (get(globalScene));
	if (scene && chip.parent !== scene) scene.add(chip);
	const at = handPosition(note.hand);
	const cam = r.xr.getCamera();
	const head = cam.getWorldPosition(new THREE.Vector3());
	if (!at) {
		chip.visible = false;
		return;
	}
	paint(note.text);
	// just above the hand, a little toward the eyes, facing them
	chip.position.copy(at).add(new THREE.Vector3(0, 0.07, 0)).lerp(head, 0.15);
	chip.lookAt(head);
	chip.visible = true;
}

/** the suites' view */
export function handInputDebug() {
	const r = /** @type {any} */ (get(globalRenderer));
	const session = r?.xr?.getSession?.();
	return {
		note: get(vrHandNote),
		chipVisible: !!chip?.visible,
		sources: session ? Array.from(session.inputSources).map((/** @type {any} */ s) => s.handedness + ':' + (s.hand ? 'hand' : 'controller')) : []
	};
}
