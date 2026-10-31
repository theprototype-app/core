import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { showToast } from '../stores/appStore';
import { globalCamera, globalRenderer, gizmoSuppressed, lockedObjects } from '../stores/sceneStore';
import { viewportHasKeys } from './keyScope'; // 36 U11
import { safeStorage } from './safeStorage';
import { findSnapCandidate, activeSnapCandidate } from './snapEngine';
import { sceneHits } from './scenePick';
import { selectObject } from './objectActions';
import { canEditObject } from './objectPermissions';
import { nameOf } from './lockControl';
import { nearestScreenPoint } from './measureCore';
import { createMeasurement, measurementOf, worldPointsOf, localPointsOf, commitMeasureEdit } from './measureItems';

// The Measure tool.
//
// 47 M1: a measurement is a CHAIN of points (click, click, click …) with a length per segment,
// the angle at every joint and a running total; the arithmetic is the `measureCore` leaf. Each
// click SNAPS through the snap engine's own candidate search — vertex / edge / face / surface —
// with this tool's flags laid over the drag snapping's (which ship all OFF), so measuring a box
// corner to corner reads the box's size and not wherever the cursor happened to land.
//
// 48 B2: a chain you keep (✓, Enter, a double click) becomes a SCENE ITEM — an object in the
// object list, saved and replicated like a stroke (measureItems.js). The 47 LOCAL pins are gone.
// Tab on a selected measurement EDITS it: a click near one of its points picks that point up, the
// next click puts it down — resolved through the SAME snapping as drawing — and a click anywhere
// else adds a point at the end. Every placed point is one undo entry and one message.

export const measureMode = writable(false);
/** the chain being drawn: world points + what each one snapped to ('' = a raw hit)
 * @type {import('svelte/store').Writable<{points: number[][], snaps: string[]} | null>} */
export const measurement = writable(null);
/** where the next click would land (desktop hover; null on touch / off the canvas)
 * @type {import('svelte/store').Writable<{point: number[], snap: string} | null>} */
export const measureHover = writable(null);
/** LOCAL pref: snap measure clicks to vertices / edges / faces (default on) */
export const measureSnap = writable(readSnapPref());
/** 48 B2: the measurement item being edited (Tab), and the point picked up (-1 = none)
 * @type {import('svelte/store').Writable<{uuid: string, active: number} | null>} */
export const measureEditing = writable(null);

function readSnapPref() {
	try {
		return typeof localStorage === 'undefined' || safeStorage.getItem('measure:snap') !== 'false';
	} catch {
		return true;
	}
}
measureSnap.subscribe((on) => {
	try {
		if (typeof localStorage !== 'undefined') safeStorage.setItem('measure:snap', String(on));
	} catch {
		/* private window: the pref simply does not persist */
	}
});

/** the measure tool's own snap flags (the drag snapping's prefs are left alone). No `surface`
 * candidate: the raw hit under the ray IS the fallback, and as a candidate at 0 px it would beat
 * a corner a few pixels away. */
export const MEASURE_TARGETS = { vertex: true, edge: true, face: true, surface: false, object: false };
/** a corner wins from anywhere inside the radius; an edge over a face centre */
export const MEASURE_BIAS = { vertex: -16, edge: -6, face: -2 };
/** screen radius a candidate may sit from the pointer — a fingertip covers more than a cursor */
export const RADIUS_MOUSE = 18;
const RADIUS_TOUCH = 36;
/** 48 B2: how close (css px) an edit click must land to a point to pick it up */
const HANDLE_MOUSE = 14;
const HANDLE_TOUCH = 28;
const HOVER_INTERVAL_MS = 33;
/** a second click this soon and this close keeps the chain (the spline tool's double click) */
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 6;

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planePoint = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _proj = new THREE.Vector3();
let lastHoverAt = 0;
let lastClick = { at: 0, px: [0, 0] };

export function toggleMeasure() {
	if (get(measureMode)) stopMeasure();
	else startMeasure();
}

export function startMeasure() {
	if (get(measureMode)) return;
	measureMode.set(true);
	measurement.set(null);
	showToast('Measure: click points — ✓ or Enter keeps the measurement, Backspace removes the last point, Esc cancels');
	// CAPTURE phase: a key this tool answers (Backspace, Delete, Enter, Tab) must not ALSO reach
	// the shortcut registry, which would delete the selection or enter Edit Mesh
	window.addEventListener('keydown', onKeydown, true);
}

/**
 * Leave the tool. `keep` (✓, the default) keeps a chain of 2+ points as a scene item; Esc passes
 * false and the draft is dropped. Leaving an EDIT session ends it (its points are already saved).
 * @param {{keep?: boolean}} [opts]
 */
export function stopMeasure(opts = {}) {
	if (!get(measureMode)) return;
	const editing = get(measureEditing);
	if (editing) {
		finishEdit(editing.uuid);
	} else if (opts.keep !== false) {
		const current = get(measurement);
		if (current && current.points.length >= 2) keepChain(current.points, true);
	}
	measureMode.set(false);
	measurement.set(null);
	measureHover.set(null);
	activeSnapCandidate.set(null);
	window.removeEventListener('keydown', onKeydown, true);
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (!viewportHasKeys(event)) return; // 36 U11: Esc in another pane is that pane's
	const editing = get(measureEditing);
	let used = true;
	if (event.key === 'Escape') {
		if (editing && editing.active >= 0) measureEditing.set({ ...editing, active: -1 }); // drop the pick first
		else stopMeasure({ keep: false });
	} else if (event.key === 'Enter') {
		if (editing) stopMeasure();
		else keepMeasurement();
	} else if (event.key === 'Tab' && editing) {
		stopMeasure();
	} else if (event.key === 'Backspace' || (event.key === 'Delete' && editing)) {
		if (editing) removeEditPoint();
		else undoMeasurePoint();
	} else used = false;
	if (used) {
		event.preventDefault();
		event.stopPropagation();
	}
}

/** client px -> NDC against the renderer canvas, or null @param {number[]} clientPx */
function ndcOf(clientPx) {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const rect = renderer?.domElement?.getBoundingClientRect?.();
	if (!rect || !rect.width || !rect.height) return null;
	return [((clientPx[0] - rect.left) / rect.width) * 2 - 1, -((clientPx[1] - rect.top) / rect.height) * 2 + 1];
}

/** world points -> client px (null behind the camera) @param {number[][]} points */
function screenOf(points) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	const rect = renderer?.domElement?.getBoundingClientRect?.();
	if (!camera || !rect) return points.map(() => null);
	return points.map((p) => {
		_proj.set(p[0], p[1], p[2]).project(camera);
		if (_proj.z >= 1 || _proj.z <= -1) return null;
		return [rect.left + ((_proj.x + 1) / 2) * rect.width, rect.top + ((1 - _proj.y) / 2) * rect.height];
	});
}

/**
 * Where a click at `clientPx` measures from: the best snap candidate within reach, else the
 * object surface under the ray, else the ground plane.
 * @param {THREE.Raycaster|null} raycaster aimed through the pointer (built here when null)
 * @param {number[]|null} clientPx @param {{touch?: boolean, publish?: boolean}} [opts]
 * @returns {{point: number[], snap: string} | null}
 */
export function resolveMeasurePoint(raycaster, clientPx, opts = {}) {
	const camera = get(globalCamera);
	const ndc = clientPx ? ndcOf(clientPx) : null;
	if (!raycaster) {
		if (!camera || !ndc) return null;
		_ndc.set(ndc[0], ndc[1]);
		_raycaster.setFromCamera(_ndc, /** @type {any} */ (camera));
		raycaster = _raycaster;
	}
	if (get(measureSnap) && camera && ndc) {
		const radiusPx = opts.touch ? RADIUS_TOUCH : RADIUS_MOUSE;
		const before = get(activeSnapCandidate);
		/** @type {any} the scored candidate (scoreCandidates' JSDoc names only the fields it reads) */
		const candidate = findSnapCandidate(camera, ndc, [], { targets: { ...MEASURE_TARGETS, radiusPx }, bias: MEASURE_BIAS });
		// the search publishes its marker; a click resolves silently and leaves the hover's
		if (opts.publish === false && get(activeSnapCandidate) !== before) activeSnapCandidate.set(before);
		if (candidate?.point) return { point: candidate.point.toArray(), snap: candidate.type };
	}
	const hit = sceneHits(raycaster)[0];
	if (hit) return { point: hit.point.toArray(), snap: '' };
	if (raycaster.ray.intersectPlane(groundPlane, planePoint)) return { point: planePoint.toArray(), snap: 'ground' };
	return null;
}

/**
 * A viewport click (or tap) while measuring: add a point to the chain. A quick second click on
 * the same spot keeps the chain instead (the spline tool's double click). While EDITING an item
 * the click picks up / puts down / adds a point (editClick).
 * @param {THREE.Raycaster} raycaster @param {any} _group unused (kept for the Scene call)
 * @param {number[]} [clientPx] @param {{touch?: boolean}} [opts]
 */
export function measureClick(raycaster, _group, clientPx, opts = {}) {
	if (get(measureEditing)) {
		editClick(raycaster, clientPx ?? null, opts);
		return;
	}
	const now = performance.now();
	if (clientPx && now - lastClick.at < DOUBLE_CLICK_MS &&
		Math.hypot(clientPx[0] - lastClick.px[0], clientPx[1] - lastClick.px[1]) < DOUBLE_CLICK_PX &&
		(get(measurement)?.points.length ?? 0) >= 2) {
		lastClick = { at: 0, px: [0, 0] };
		keepMeasurement();
		return;
	}
	if (clientPx) lastClick = { at: now, px: [clientPx[0], clientPx[1]] };
	const hit = resolveMeasurePoint(raycaster, clientPx ?? null, { touch: opts.touch, publish: false });
	if (!hit) return;
	addMeasurePoint(hit.point, hit.snap);
}

/** @param {number[]} point @param {string} [snap] */
export function addMeasurePoint(point, snap = '') {
	measurement.update((current) => ({
		points: [...(current?.points ?? []), [point[0], point[1], point[2]]],
		snaps: [...(current?.snaps ?? []), snap]
	}));
}

/** desktop hover: where the next click would land (throttled; publishes the snap marker)
 * @param {number[]} clientPx @param {boolean} onCanvas */
export function measureHoverAt(clientPx, onCanvas) {
	if (!get(measureMode)) return;
	if (!onCanvas) {
		if (get(measureHover)) measureHover.set(null);
		if (get(activeSnapCandidate)) activeSnapCandidate.set(null);
		return;
	}
	const now = performance.now();
	if (now - lastHoverAt < HOVER_INTERVAL_MS) return;
	lastHoverAt = now;
	measureHover.set(resolveMeasurePoint(null, clientPx));
}

export function undoMeasurePoint() {
	measurement.update((current) => {
		if (!current || current.points.length <= 1) return null;
		return { points: current.points.slice(0, -1), snaps: current.snaps.slice(0, -1) };
	});
}

/** @param {number[][]} points @param {boolean} [closing] the tool is closing (✓) */
function keepChain(points, closing = false) {
	const item = createMeasurement(points);
	if (item)
		showToast(
			closing
				? 'Measurement kept — it is in the object list; select it and press Tab to edit its points'
				: 'Measurement kept — click to start the next one'
		);
	return item;
}

/** Keep the current chain as a scene item and start a fresh one (Enter, Keep, a double click).
 * @returns {boolean} whether there was a chain (2+ points) to keep */
export function keepMeasurement() {
	const current = get(measurement);
	if (!current || current.points.length < 2) {
		showToast('Measure: click two points first');
		return false;
	}
	keepChain(current.points);
	measurement.set(null);
	return true;
}

/** Drop the chain being drawn (the toolbox's Discard). */
export function discardMeasurement() {
	measurement.set(null);
}

// ---- 48 B2: editing a kept measurement (Tab) ---------------------------------------------

/**
 * Edit a measurement item's points. The item stays selected (its lock), with no gizmo (a press
 * on it would move the whole item instead of picking a point).
 * @param {string} uuid @returns {boolean}
 */
export function editMeasurement(uuid) {
	const object = measurementOf(uuid);
	if (!object) return false;
	const lock = get(lockedObjects).find((l) => l[1] === uuid);
	if (lock) {
		showToast('Locked by ' + nameOf(lock[0]));
		return false;
	}
	if (!canEditObject(object)) {
		showToast('You can view this measurement but not edit it');
		return false;
	}
	if (get(measureMode)) stopMeasure();
	gizmoSuppressed.set(true);
	selectObject(uuid);
	measurement.set(null);
	measureEditing.set({ uuid, active: -1 });
	measureMode.set(true);
	window.addEventListener('keydown', onKeydown, true);
	showToast('Editing the measurement: click a point to pick it up, click again to place it (it snaps); click elsewhere to add a point. Backspace removes, Tab or Esc finishes');
	return true;
}

/** Tab on a selection: edit it when it is a measurement, finish when it is the one being edited.
 * @param {string} uuid @returns {boolean} whether the key was a measurement's */
export function toggleMeasureEdit(uuid) {
	const editing = get(measureEditing);
	if (editing) {
		stopMeasure();
		return true;
	}
	return editMeasurement(uuid);
}

/** @param {string} uuid */
function finishEdit(uuid) {
	measureEditing.set(null);
	gizmoSuppressed.set(false);
	if (measurementOf(uuid)) selectObject(uuid); // the gizmo comes back on the item
}

/**
 * One click while editing.
 * @param {THREE.Raycaster} raycaster @param {number[] | null} clientPx @param {{touch?: boolean}} opts
 */
function editClick(raycaster, clientPx, opts) {
	const editing = get(measureEditing);
	const object = editing ? measurementOf(editing.uuid) : null;
	if (!editing || !object) return;
	const near =
		editing.active < 0 && clientPx
			? nearestScreenPoint(screenOf(worldPointsOf(object)), clientPx, opts.touch ? HANDLE_TOUCH : HANDLE_MOUSE)
			: -1;
	measureEditStep(near, () => resolveMeasurePoint(raycaster, clientPx, { touch: opts.touch, publish: false }));
}

/**
 * One edit step on the measurement being edited — the half the desktop click and the VR trigger
 * share (52 V1). With no point picked up, `near` (a point the press landed on, or -1) picks one up;
 * otherwise the resolved point puts the picked one down, or is added at the end of the chain. One
 * undo entry and one message per placed point.
 * @param {number} near @param {() => ({point: number[]} | null)} resolve
 * @returns {'picked'|'placed'|'added'|null}
 */
export function measureEditStep(near, resolve) {
	const editing = get(measureEditing);
	const object = editing ? measurementOf(editing.uuid) : null;
	if (!editing || !object) return null;
	if (editing.active < 0 && near >= 0) {
		measureEditing.set({ ...editing, active: near });
		return 'picked';
	}
	const hit = resolve();
	if (!hit) return null;
	const next = worldPointsOf(object).map((p) => [...p]);
	if (editing.active >= 0) next[editing.active] = hit.point;
	else next.push(hit.point);
	const before = object.userData.measure;
	commitMeasureEdit(editing.uuid, before, { points: localPointsOf(object, next) });
	measureEditing.set({ ...editing, active: -1 });
	return editing.active >= 0 ? 'placed' : 'added';
}

/** Backspace / Delete while editing: remove the picked point (else the last), never below two. */
export function removeEditPoint() {
	const editing = get(measureEditing);
	const object = editing ? measurementOf(editing.uuid) : null;
	if (!editing || !object) return false;
	const points = object.userData.measure.points;
	if (points.length <= 2) {
		showToast('A measurement keeps at least two points — delete the item to remove it');
		return false;
	}
	const index = editing.active >= 0 ? editing.active : points.length - 1;
	commitMeasureEdit(editing.uuid, object.userData.measure, { points: points.filter((/** @type {any} */ _, /** @type {number} */ i) => i !== index) });
	measureEditing.set({ ...editing, active: -1 });
	return true;
}

/** label screen positions, published by MeasureOverlay from threlte's RENDER stage (a private
 * rAF projects last frame's camera — the note-marker jiggle) and drawn by MeasureLabels
 * @type {import('svelte/store').Writable<{key: string, kind: string, text: string, x: number, y: number, item: boolean, hidden?: boolean}[]>} */
export const measureLabelViews = writable([]);
