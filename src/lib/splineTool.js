// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, selectedObject } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordObjectPresence, recordEntry, registerHistoryKind } from './history';
import { drawMode, drawTool, drawColor, drawSize } from './drawMode';
import {
	SPLINE_DEFAULTS,
	MAX_POINTS,
	MIN_RADIUS,
	MAX_RADIUS,
	buildSplineGeometry,
	cloneSpline,
	normalizeSpline,
	isSplineObject,
	splineCentroid
} from './splineTube';

// 57.2/57.3 (phase 57): the SPLINE half of the draw tool. Freehand paints a
// fixed-radius stroke as you drag (drawMode.js); a spline is PLACED click by
// click and stays editable forever, because the mesh carries its authoring
// record on `userData.spline` — which rides toJSON AND the GLTF extras (the
// __uuid/__localOnly precedent), so a late joiner can pick the same spline up
// and edit it. Only the RECORD travels (`splineedit`); every peer rebuilds the
// geometry from it deterministically (golden rule 8).
//
// This module owns placement + the write path (apply / broadcast / undo).
// splineEdit.js owns the handle session on top of it — the dependency runs one
// way (splineEdit -> splineTool) so nothing here has to know about VR.

/** Is a placement session running? @type {import('svelte/store').Writable<boolean>} */
export const splinePlacing = writable(false);
/** WORLD-space control points being placed (drives the toolbar readout)
 * @type {import('svelte/store').Writable<{pos: number[], radius: number}[]>} */
export const splineDraft = writable([]);
/** Close the loop on finish (toolbar toggle, also stored on the record) */
export const splineClosed = writable(false);

/** @type {any} scene-root preview: a live tube + the placed dots */
let preview = null;
/** @type {any} */ let previewMesh = null;
/** @type {any} */ let previewDots = null;

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeHit = new THREE.Vector3();

/** live-edit refresh subscribers (splineEdit re-poses its handles) @type {((uuid: string) => void)[]} */
const refreshHooks = [];
/** @param {(uuid: string) => void} fn @returns {() => void} */
export function registerSplineRefresh(fn) {
	refreshHooks.push(fn);
	return () => {
		const index = refreshHooks.indexOf(fn);
		if (index >= 0) refreshHooks.splice(index, 1);
	};
}
/** @param {string} uuid */
function fireRefresh(uuid) {
	refreshHooks.forEach((fn) => {
		try {
			fn(uuid);
		} catch (error) {
			console.log('spline refresh hook failed', error);
		}
	});
}

// leaving draw mode (Esc, Done, the toolbar toggle) drops a half-placed spline
drawMode.subscribe((on) => {
	if (!on && get(splinePlacing)) cancelSplinePlacement();
});

/** @param {string} uuid */
export function splineObjectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** The live record of a spline object (normalized), or null. @param {any} object */
export function splineDataOf(object) {
	return isSplineObject(object) ? normalizeSpline(object.userData.spline) : null;
}

// ---- 57.2 placement ------------------------------------------------------

/** Draw mode is armed AND the spline tool is the active one. */
export function splineToolActive() {
	return get(drawMode) && get(drawTool) === 'spline';
}

/**
 * Place one control point from a pointer/controller ray: the surface under it,
 * offset along the hit normal by the radius so the tube rests ON the surface
 * instead of half-sunk; the ground plane is the fallback canvas (same rule the
 * freehand stroke uses).
 * @param {any} raycaster @returns {boolean} whether a point was placed
 */
export function splinePlaceFromRay(raycaster) {
	const group = get(objectsGroup);
	const radius = Math.max(get(drawSize), MIN_RADIUS);
	const hits = group ? raycaster.intersectObjects(group.children, true) : [];
	if (hits[0]) {
		const normal = hits[0].face
			? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld)
			: new THREE.Vector3(0, 1, 0);
		return addSplinePoint(hits[0].point.clone().addScaledVector(normal, radius), radius);
	}
	if (raycaster.ray.intersectPlane(groundPlane, planeHit))
		return addSplinePoint(planeHit.clone().setY(planeHit.y + radius), radius);
	return false;
}

/** Append a WORLD-space control point. @param {any} point @param {number=} radius */
export function addSplinePoint(point, radius = get(drawSize)) {
	if (!point) return false;
	const draft = get(splineDraft);
	if (draft.length >= MAX_POINTS) {
		showToast('That is the most control points one spline can hold (' + MAX_POINTS + ')');
		return false;
	}
	splinePlacing.set(true);
	splineDraft.set([
		...draft,
		{ pos: [point.x, point.y, point.z], radius: Math.max(radius, MIN_RADIUS) }
	]);
	updatePreview();
	return true;
}

/** Drop the last placed point (toolbar / Backspace). */
export function undoSplinePoint() {
	const draft = get(splineDraft);
	if (!draft.length) return false;
	splineDraft.set(draft.slice(0, -1));
	updatePreview();
	return true;
}

/** Number of points placed so far (test/debug view). */
export function splineDraftCount() {
	return get(splineDraft).length;
}

/** The record a finish would build right now (also drives the preview). */
function draftRecord() {
	return normalizeSpline({
		points: get(splineDraft),
		color: get(drawColor),
		closed: get(splineClosed),
		radialSegments: SPLINE_DEFAULTS.radialSegments,
		segmentsPerSpan: SPLINE_DEFAULTS.segmentsPerSpan
	});
}

function updatePreview() {
	const scene = get(globalScene);
	if (!scene) return;
	const draft = get(splineDraft);
	if (!preview) {
		preview = new THREE.Group();
		preview.name = 'spline-preview';
		previewMesh = new THREE.Mesh(
			new THREE.BufferGeometry(),
			new THREE.MeshBasicMaterial({ color: get(drawColor), transparent: true, opacity: 0.75 })
		);
		previewMesh.name = 'spline-preview-tube';
		previewDots = new THREE.InstancedMesh(
			new THREE.SphereGeometry(1, 8, 6),
			new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }),
			MAX_POINTS
		);
		previewDots.renderOrder = 999;
		previewDots.name = 'spline-preview-dots';
		preview.add(previewMesh, previewDots);
		scene.add(preview);
	}
	previewMesh.material.color.set(get(drawColor));
	const record = draftRecord();
	const geometry = draft.length >= 2 ? buildSplineGeometry(record) : null;
	previewMesh.geometry.dispose();
	previewMesh.geometry = geometry ?? new THREE.BufferGeometry();
	previewMesh.visible = !!geometry;
	// dots mark the placed points (a single point has no tube yet — it must
	// still be visible, else the first click looks like it did nothing)
	previewDots.count = draft.length;
	const matrix = new THREE.Matrix4();
	draft.forEach((point, index) => {
		const scale = Math.max(point.radius * 1.6, 0.02);
		matrix.makeScale(scale, scale, scale).setPosition(point.pos[0], point.pos[1], point.pos[2]);
		previewDots.setMatrixAt(index, matrix);
	});
	previewDots.instanceMatrix.needsUpdate = true;
	previewDots.boundingSphere = null;
}

function disposePreview() {
	if (!preview) return;
	preview.parent?.remove(preview);
	previewMesh?.geometry?.dispose?.();
	previewMesh?.material?.dispose?.();
	previewDots?.geometry?.dispose?.();
	previewDots?.material?.dispose?.();
	preview = null;
	previewMesh = null;
	previewDots = null;
}

/** Abandon the placement session (Esc / leaving draw mode). */
export function cancelSplinePlacement() {
	splineDraft.set([]);
	splinePlacing.set(false);
	disposePreview();
}

/**
 * Finish placement: one mesh named "Spline" in objectsGroup carrying its
 * record, replicated + undoable exactly like any created object.
 * @returns {any | null} the mesh, or null when there was nothing to build
 */
export function finishSpline() {
	const draft = get(splineDraft);
	const record = draftRecord();
	if (draft.length < 2) {
		if (draft.length) showToast('A spline needs at least two points');
		cancelSplinePlacement();
		return null;
	}
	const group = get(objectsGroup);
	if (!group) return null;
	// points were placed in REAL space (the preview lives at the scene root);
	// the mesh lands in objectsGroup, which may sit under a grabbed/scaled world
	// rig (71) — convert, then re-seat the record around the centroid so the
	// object's own origin (and therefore the gizmo pivot) is sane
	group.updateMatrixWorld(true);
	const local = record.points.map((point) => ({
		pos: group.worldToLocal(new THREE.Vector3(point.pos[0], point.pos[1], point.pos[2])),
		radius: point.radius
	}));
	const center = splineCentroid({ points: local.map((p) => ({ pos: p.pos.toArray(), radius: p.radius })) });
	const spline = normalizeSpline({
		...record,
		points: local.map((p) => ({ pos: p.pos.sub(center).toArray(), radius: p.radius }))
	});
	cancelSplinePlacement();
	const mesh = createSplineMesh(spline, center);
	if (!mesh) return null;
	group.add(mesh);
	objectsGroup.update((value) => value);
	recordObjectPresence('create', mesh);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'object', element: mesh.toJSON() });
	showToast('Spline created — right-click it ▸ Edit spline to reshape it');
	return mesh;
}

/**
 * A standalone spline mesh from a record (no scene side effects). @param {any} spline
 * @param {any=} position objectsGroup-local origin
 */
export function createSplineMesh(spline, position = null) {
	const data = normalizeSpline(spline);
	const geometry = buildSplineGeometry(data);
	if (!geometry) return null;
	const mesh = new THREE.Mesh(
		geometry,
		new THREE.MeshStandardMaterial({ color: data.color, roughness: 0.6, metalness: 0 })
	);
	mesh.name = 'Spline';
	mesh.userData.spline = data;
	if (position) mesh.position.copy(position);
	return mesh;
}

// ---- write path: apply / broadcast / undo --------------------------------

/**
 * Rebuild a spline object from a record. The ONE place geometry is swapped —
 * remote `splineedit`, undo/redo replay and every local edit funnel through it,
 * so a peer can never end up with geometry its record doesn't describe.
 * Never re-broadcasts (receiver rule 1).
 * @param {string} uuid @param {any} spline @returns {boolean}
 */
export function applySplineEdit(uuid, spline) {
	const object = splineObjectOf(uuid);
	if (!object) return false;
	const data = normalizeSpline(spline);
	const geometry = buildSplineGeometry(data);
	if (!geometry) return false;
	object.geometry?.dispose?.();
	object.geometry = geometry;
	object.userData.spline = data;
	if (object.material && !Array.isArray(object.material)) object.material.color?.set?.(data.color);
	objectsGroup.update((value) => value);
	selectedObject.update((value) => value); // keep the Spline inspector rows live
	fireRefresh(uuid);
	return true;
}

let lastSent = 0;

/**
 * Live preview of an in-progress gesture: apply locally + a throttled send
 * (~12/s), no history. The record is tiny (a handful of numbers per point), so
 * unlike meshgeo it needs no raw-bytes wire format.
 * @param {string} uuid @param {any} spline @param {boolean=} force
 */
export function streamSplineEdit(uuid, spline, force = false) {
	if (!applySplineEdit(uuid, spline)) return false;
	const now = Date.now();
	if (!force && now - lastSent < 80) return true;
	lastSent = now;
	broadcastSpline(uuid, spline);
	return true;
}

/** @param {string} uuid @param {any} spline */
function broadcastSpline(uuid, spline) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'splineedit', uuid, spline: normalizeSpline(spline) });
}

/**
 * Commit an edit: apply + unthrottled broadcast + ONE undo entry holding the
 * whole before/after record (a spline is small enough that per-point diffing
 * would only buy bugs).
 * @param {string} uuid @param {any} before @param {any} after @returns {boolean}
 */
export function commitSplineEdit(uuid, before, after) {
	const next = normalizeSpline(after);
	if (!applySplineEdit(uuid, next)) return false;
	broadcastSpline(uuid, next);
	const previous = cloneSpline(before);
	if (JSON.stringify(previous) !== JSON.stringify(cloneSpline(next)))
		recordEntry({ kind: 'spline', uuid, before: previous, after: cloneSpline(next) });
	return true;
}

// undo/redo replays a whole record through the same apply + broadcast path
registerHistoryKind('spline', (entry, state) => {
	if (!applySplineEdit(entry.uuid, state)) {
		showToast('Cannot undo/redo: that spline no longer exists');
		return false;
	}
	broadcastSpline(entry.uuid, state);
	return true;
});

// ---- 57.5 Properties-panel edits ----------------------------------------

/** @param {string} uuid @param {(data: any) => any} mutate @returns {boolean} */
function editRecord(uuid, mutate) {
	const object = splineObjectOf(uuid);
	const before = splineDataOf(object);
	if (!before) return false;
	return commitSplineEdit(uuid, before, mutate(cloneSpline(before)));
}

/** @param {string} uuid @param {string} color */
export function setSplineColor(uuid, color) {
	return editRecord(uuid, (data) => ({ ...data, color }));
}

/** Set EVERY control point to one radius. @param {string} uuid @param {number} radius */
export function setSplineRadiusAll(uuid, radius) {
	const value = Math.min(Math.max(radius, MIN_RADIUS), MAX_RADIUS);
	return editRecord(uuid, (data) => ({
		...data,
		points: data.points.map((/** @type {any} */ p) => ({ ...p, radius: value }))
	}));
}

/** Scale every radius (keeps the taper). @param {string} uuid @param {number} factor */
export function scaleSplineRadii(uuid, factor) {
	return editRecord(uuid, (data) => ({
		...data,
		points: data.points.map((/** @type {any} */ p) => ({
			...p,
			radius: Math.min(Math.max(p.radius * factor, MIN_RADIUS), MAX_RADIUS)
		}))
	}));
}

/** @param {string} uuid @param {boolean} closed */
export function setSplineClosed(uuid, closed) {
	return editRecord(uuid, (data) => ({ ...data, closed }));
}

/** Tube resolution: sides around the sweep. @param {string} uuid @param {number} sides */
export function setSplineSides(uuid, sides) {
	return editRecord(uuid, (data) => ({ ...data, radialSegments: sides }));
}

/** Samples per span — how smoothly the curve is followed. @param {string} uuid @param {number} per */
export function setSplineSmoothness(uuid, per) {
	return editRecord(uuid, (data) => ({ ...data, segmentsPerSpan: per }));
}
