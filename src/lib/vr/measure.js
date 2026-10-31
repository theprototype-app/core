// VR controls — MEASURE IN THE HEADSET (52 V1). The desktop Measure tool (measure.js: chains of points with a
// length per segment, the angle at every joint and a running total; a kept chain is a 48 B2 measurement ITEM in
// the object list, replicated and undoable) driven by the laser instead of the mouse:
//   - Tools ▸ Measure arms it (the trigger tool, beside Select / Box select / Draw); the pointer hand's laser
//     shows where the next point lands — the dashed preview segment and the snap marker follow it
//   - every trigger press puts a point down, SNAPPED through the snap engine's own search (vertex / edge / face,
//     the desktop tool's flags and bias) inside a 3° cone around the laser; a raw hit lands on the grid when
//     grid snapping is on (vrMeasureCore)
//   - a second press on the same spot (a double tap), or the ring's Keep, keeps the chain as a scene item; the
//     radial opens on the Measure ring while the tool is up: Keep · Undo point · Discard · Snap · Done
//   - Selected ▸ Edit measurement edits a kept item: a press near one of its points (by angle) picks it up, the
//     next puts it down (snapped), a press anywhere else adds a point at the end — measure.js's own edit step,
//     so one undo entry and one message per placed point, exactly as on the desktop
//   - the labels are troika text in the scene (VRMeasureLabels), facing you and the same size at any distance
// Hands: precise tools want a controller — a pinch while measuring says "pick up a controller" and does nothing.
// Edit only: Interact, leaving the headset or another trigger tool ends it (a chain of 2+ points is kept, the
// desktop ✓ rule). Rides the K1 hook registries, registered on first use (the vr/sculpt.js pattern).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { editorMode, vrMenuOpen, vrMenuHand, vrToolMode, isVRMode } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import {
	measureMode,
	measurement,
	measureHover,
	measureSnap,
	measureEditing,
	startMeasure,
	stopMeasure,
	addMeasurePoint,
	undoMeasurePoint,
	keepMeasurement,
	discardMeasurement,
	editMeasurement,
	removeEditPoint,
	measureEditStep,
	MEASURE_TARGETS,
	MEASURE_BIAS,
	RADIUS_MOUSE
} from '../measure';
import { measurementOf, worldPointsOf } from '../measureItems';
import { findSnapCandidate, activeSnapCandidate } from '../snapEngine';
import { sceneHits } from '../scenePick';
import { snapEnabled, snapSettings } from '../snapping';
import { drawMode, toggleDrawMode } from '../drawMode';
import {
	VR_SNAP_RADIUS_PX,
	rayCameraFov,
	snapToGrid,
	angularPick,
	isDoubleTap,
	coneBias
} from '../vrMeasureCore';
import { renderer } from './core.js';
import { hapticPulse } from './haptics.js';
import { controllerIndexFor } from './input.js';
import { controllerRay, beamTarget } from './pointer.js';
import { vrHovered } from './panels.js';
import { pushRing, activeRing } from '../vrRadialMenu';
import { registerVRFrameHook, registerVRTriggerHooks } from './hooks.js';
import { boxSelectEnd } from './tools.js';

const HOVER_INTERVAL_MS = 33;
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _plane = new THREE.Vector3();
const rayCam = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
const _fwd = new THREE.Vector3(0, 0, -1);
/** the desktop measure bias, scaled to the cone (a corner wins from as far out, relatively, as under the mouse) */
const VR_BIAS = coneBias(MEASURE_BIAS, RADIUS_MOUSE);

let hooked = false;
let swallowAt = 0;
let lastHoverAt = 0;
let lastHandToast = 0;
/** the last point a press put down — the double-tap rule reads it @type {{at: number, point: number[] | null}} */
let lastTap = { at: 0, point: null };
/** the suites' view */
const stats = { presses: 0, placed: 0, kept: 0, edits: 0, handRefusals: 0, hoverMs: 0, hovers: 0 };

/** the pointer hand (the one that does not hold the menu) */
function pointerHand() {
	return get(vrMenuHand) === 'right' ? 'left' : 'right';
}
function pointerIndex() {
	return controllerIndexFor(pointerHand());
}

/** is the VR measure tool up? (the trigger tool is Measure, in a headset) */
export function vrMeasureActive() {
	return get(vrToolMode) === 'measure' && !!renderer?.xr?.isPresenting;
}

/** a FRESH raycaster down a controller's laser (the shared one is reused every frame) @param {number} index */
function rayOf(index) {
	const shared = controllerRay(index);
	const ray = new THREE.Raycaster(shared.ray.origin.clone(), shared.ray.direction.clone());
	/** @type {any} */ (ray).camera = /** @type {any} */ (shared).camera;
	return ray;
}

/** is this slot's input a tracked HAND (no controller in it)? @param {number} index */
function isHandInput(index) {
	const session = renderer?.xr?.getSession?.();
	const hand = renderer?.xr?.getController(index)?.userData?.handedness;
	const source = session && hand ? [...session.inputSources].find((s) => s.handedness === hand) : null;
	return !!source?.hand;
}

/**
 * Where a laser measures to: the best snap candidate inside the cone, else the object surface under the
 * ray, else the ground plane — a raw point lands on the grid when grid snapping is on.
 * @param {any} ray a THREE.Raycaster @param {{publish?: boolean}} [opts] publish = move the snap marker
 * @returns {{point: number[], snap: string} | null}
 */
export function resolveVRMeasurePoint(ray, opts = {}) {
	if (get(measureSnap)) {
		const rect = renderer?.domElement?.getBoundingClientRect?.();
		if (rect && rect.width && rect.height) {
			// the virtual camera: at the controller, looking down the laser (roll does not matter — the
			// cone is round), its fov set so the engine's px radius is the angular cone
			rayCam.fov = rayCameraFov(rect.height);
			rayCam.aspect = rect.width / rect.height;
			rayCam.updateProjectionMatrix();
			rayCam.position.copy(ray.ray.origin);
			rayCam.quaternion.setFromUnitVectors(_fwd, ray.ray.direction);
			rayCam.updateMatrixWorld(true);
			const before = get(activeSnapCandidate);
			/** @type {any} */
			const candidate = findSnapCandidate(rayCam, [0, 0], [], {
				targets: { ...MEASURE_TARGETS, radiusPx: VR_SNAP_RADIUS_PX },
				bias: VR_BIAS
			});
			if (opts.publish === false && get(activeSnapCandidate) !== before) activeSnapCandidate.set(before);
			if (candidate?.point) return { point: candidate.point.toArray(), snap: candidate.type };
		} else if (opts.publish !== false) activeSnapCandidate.set(null);
	}
	const step = get(snapEnabled) ? Number(get(snapSettings)?.translate) || 0 : 0;
	const hit = sceneHits(ray)[0];
	if (hit) return snapToGrid(hit.point.toArray(), step, '');
	if (ray.ray.intersectPlane(groundPlane, _plane)) return snapToGrid(_plane.toArray(), step, 'ground');
	return null;
}

function ensureHooks() {
	if (hooked) return;
	hooked = true;
	registerVRTriggerHooks({
		start: (/** @type {number} */ i) => measureTriggerStart(i),
		swallow: () => {
			const pending = swallowAt && Date.now() - swallowAt < 5000;
			swallowAt = 0;
			return !!pending;
		}
	});
	registerVRFrameHook(() => tickVRMeasure());
}

/** Tools ▸ Measure: arm the laser tool (and the desktop tool's state under it). */
export function startVRMeasure() {
	ensureHooks();
	if (get(drawMode)) toggleDrawMode();
	boxSelectEnd(true);
	vrToolMode.set('measure');
	if (!get(measureMode)) startMeasure();
	vrMenuOpen.set(false);
	lastTap = { at: 0, point: null };
	return true;
}

/** Done / another tool / Interact / leaving the headset: a chain of 2+ points is KEPT (the desktop ✓);
 * `keep: false` drops it (Discard then Done). An edit session simply ends (its points are saved). */
export function stopVRMeasure(opts = {}) {
	if (get(measureMode)) stopMeasure(opts);
	measureHover.set(null);
	activeSnapCandidate.set(null);
	if (get(vrToolMode) === 'measure') vrToolMode.set('select');
	lastTap = { at: 0, point: null };
}

/** Selected ▸ Edit measurement: edit a kept item's points from the headset @param {string} uuid */
export function editVRMeasurement(uuid) {
	ensureHooks();
	if (get(drawMode)) toggleDrawMode();
	boxSelectEnd(true);
	if (!editMeasurement(uuid)) return false;
	vrToolMode.set('measure');
	vrMenuOpen.set(false);
	return true;
}

/** the ring's Keep: the chain becomes a scene item and a fresh one starts */
export function vrKeepMeasurement() {
	if (get(measureEditing)) {
		stopVRMeasure();
		return true;
	}
	const kept = keepMeasurement();
	if (kept) {
		stats.kept++;
		hapticPulse(0.5, 40, pointerHand());
	}
	lastTap = { at: 0, point: null };
	return kept;
}

/** the ring's Undo point: the last point of the chain being drawn (or, editing, the picked/last point) */
export function vrUndoMeasurePoint() {
	if (get(measureEditing)) return removeEditPoint();
	undoMeasurePoint();
	lastTap = { at: 0, point: null };
	return true;
}

/** the ring's Discard */
export function vrDiscardMeasurement() {
	discardMeasurement();
	lastTap = { at: 0, point: null };
}

/** @param {number} index */
export function measureTriggerStart(index) {
	if (!vrMeasureActive() || index < 0) return false;
	// the radial or a panel under the laser owns this press
	if (get(vrMenuOpen) || get(vrHovered)) return false;
	if (beamTarget(controllerRay(index)).panel) return false;
	stats.presses++;
	swallowAt = Date.now();
	if (isHandInput(index)) {
		stats.handRefusals++;
		if (Date.now() - lastHandToast > 4000) {
			lastHandToast = Date.now();
			showToast('Measure: pick up a controller — hand tracking browses and places, measuring needs the laser');
		}
		return true;
	}
	const ray = rayOf(index);
	if (get(measureEditing)) {
		const object = measurementOf(/** @type {any} */ (get(measureEditing)).uuid);
		const editing = get(measureEditing);
		const near =
			object && editing && editing.active < 0
				? angularPick(ray.ray.origin.toArray(), ray.ray.direction.toArray(), worldPointsOf(object))
				: -1;
		const step = measureEditStep(near, () => resolveVRMeasurePoint(ray, { publish: false }));
		if (step) {
			stats.edits++;
			hapticPulse(step === 'picked' ? 0.25 : 0.4, 25, index === pointerIndex() ? pointerHand() : undefined);
		}
		return true;
	}
	const hit = resolveVRMeasurePoint(ray, { publish: false });
	if (!hit) return true;
	const now = performance.now();
	const handDistance = ray.ray.origin.distanceTo(new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]));
	if ((get(measurement)?.points.length ?? 0) >= 2 && isDoubleTap(lastTap, now, hit.point, handDistance)) {
		vrKeepMeasurement();
		return true;
	}
	addMeasurePoint(hit.point, hit.snap);
	lastTap = { at: now, point: hit.point };
	stats.placed++;
	// a corner / edge / face snap clicks harder than a raw point: you feel what you got
	hapticPulse(hit.snap && hit.snap !== 'ground' ? 0.45 : 0.25, 22);
	return true;
}

/** per frame: the preview follows the pointer laser (throttled), the tool ends with its context */
export function tickVRMeasure() {
	if (get(vrToolMode) !== 'measure') return;
	if (!renderer?.xr?.getSession?.() || get(editorMode) === 'interact' || !get(measureMode)) {
		stopVRMeasure();
		return;
	}
	const now = performance.now();
	if (now - lastHoverAt < HOVER_INTERVAL_MS) return;
	lastHoverAt = now;
	if (get(vrMenuOpen) || get(vrHovered)) {
		if (get(measureHover)) measureHover.set(null);
		if (get(activeSnapCandidate)) activeSnapCandidate.set(null);
		return;
	}
	const index = pointerIndex();
	if (index < 0 || isHandInput(index)) return;
	const t0 = performance.now();
	const ray = rayOf(index);
	measureHover.set(beamTarget(ray).panel ? null : resolveVRMeasurePoint(ray));
	stats.hoverMs += performance.now() - t0;
	stats.hovers++;
}

/** the suites' view */
export function vrMeasureDebug() {
	const editing = get(measureEditing);
	return {
		active: vrMeasureActive(),
		tool: get(vrToolMode),
		mode: get(measureMode),
		points: get(measurement)?.points.map((p) => [...p]) ?? [],
		snaps: get(measurement)?.snaps ?? [],
		hover: get(measureHover),
		editing: editing ? { ...editing } : null,
		ring: get(activeRing),
		...stats,
		hoverAvgMs: stats.hovers ? stats.hoverMs / stats.hovers : 0
	};
}

// the tool follows the trigger-tool choice: picking Select / Box / Draw (or leaving the headset) ends it.
// Declared LAST (the TDZ rule: a subscriber runs synchronously at subscribe time).
vrToolMode.subscribe((tool) => {
	if (tool !== 'measure' && get(measureMode) && (get(isVRMode) || renderer?.xr?.isPresenting)) stopVRMeasure();
});
// the radial opens on the Measure ring while the tool is up (Back reaches the usual menu) — the sculpt ring's rule
vrMenuOpen.subscribe((open) => {
	if (open && get(vrToolMode) === 'measure' && get(measureMode) && get(activeRing) === 'root') pushRing('measure');
});
