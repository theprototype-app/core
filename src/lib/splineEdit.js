// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import {
	globalScene,
	globalRenderer,
	TControls,
	lockedObjects,
	isVRMode,
	vrMenuHand
} from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { snapEnabled, snapSettings } from './snapping';
import {
	MIN_RADIUS,
	MAX_RADIUS,
	RADIUS_GAIN_METERS,
	RADIUS_GAIN_PIXELS,
	cloneSpline,
	insertSplinePoint,
	radiusFromDrag,
	removeSplinePoint,
	splineCurve
} from './splineTube';
import {
	commitSplineEdit,
	registerSplineRefresh,
	splineDataOf,
	splineObjectOf,
	streamSplineEdit
} from './splineTool';
import {
	controllerIndexFor,
	hapticPulse,
	registerNavSuppressor,
	registerPanelGroupProvider,
	registerVRFrameHook,
	registerVRTriggerHooks
} from './vrControls';
import { viewportHasKeys } from './keyScope'; // 36 U11
// 78 F4: the spline editor IS the Path editor — multi-select, a gizmo about the picked points'
// centroid (move / rotate / scale), Add points (a capture on the F5 stack), Delete, Select all
import { editingPathUuid, pathSelectedPoints } from './path/pathState.js';
import { pushCapture, popTopCapture, popCapture } from './path/captureAdapter.js';
import { isPathRecord, PATH_LINE_RADIUS } from './path/pathCore.js';
import { objectsGroup } from '../stores/sceneStore';

// 57.3/57.4: the spline EDIT session, built the same way mesh edit is — one
// object at a time, scene-root handles (never children of the object: they must
// not leak into GLTF sync), the object locked for peers while it is open, and
// every change funnelling through splineTool's write path so the record is what
// travels.
//
// Three handle families, one InstancedMesh each (all inside one scene-root
// group so the VR beam can terminate on them):
//   - POINT  (blue) one per control point; picking one seats the transform
//     gizmo on a proxy, exactly like a vertex handle
//   - RADIUS (amber) a smaller dot floating above its point; dragging it up or
//     down scales that point's radius (multiplicative, so the feel is the same
//     on a hair-thin and a fat tube — radiusFromDrag)
//   - MID    (dim) one per span; clicking one inserts a control point there
// Right-click a point handle to delete it.
//
// VR rides the GENERIC module hooks vrControls exposes (registerVRTriggerHooks
// / registerVRFrameHook / registerNavSuppressor / registerPanelGroupProvider —
// the seam the vrsleeve module established), so this feature adds no wiring to
// vrControls at all: point the pointer hand at a handle, hold the trigger to
// carry it, release to commit. On-device FEEL is the user's manual check.

/** uuid of the spline in edit mode @type {import('svelte/store').Writable<string|null>} */
export const splineEditObject = writable(null);
/** index of the selected control point, or -1 @type {import('svelte/store').Writable<number>} */
export const splineSelectedPoint = writable(-1);
/** live point count, for the toolbar readout @type {import('svelte/store').Writable<number>} */
export const splinePointCount = writable(0);
/** 78 F4: "Add points" armed — a click on the scene appends a point @type {import('svelte/store').Writable<boolean>} */
export const splineAddMode = writable(false);
/** 78 F4: the gizmo's mode while several points are picked @type {import('svelte/store').Writable<'translate'|'rotate'|'scale'>} */
export const splineGizmoMode = writable('translate');
const ADD_CAPTURE = 'path-add-points';

const POINT_COLOR = 0x2f81f7;
const POINT_SELECTED = 0xff4000;
const POINT_HOVER = 0xffa000;
const RADIUS_COLOR = 0xf59e0b;
const MID_COLOR = 0x9ca3af;
/** the radius dot floats this many point-radii above its control point */
const RADIUS_OFFSET = 1.8;

/** @type {any} */ let edited = null;
/** @type {any} */ let group = null; // scene-root handle group
/** @type {any} */ let pointHandles = null;
/** @type {any} */ let radiusHandles = null;
/** @type {any} */ let midHandles = null;
/** @type {any} */ let proxy = null; // gizmo target for the selected point
/** @type {{pos: number[], radius: number}[]} */ let points = [];
let selected = -1;
let hovered = -1;
/** 78 F4: every picked point (the primary `selected` is one of them) @type {number[]} */
let picked = [];
/** 78 F4: a multi-point gizmo drag — the proxy's start matrix (inverted) + the points' start world positions @type {any} */
let dragStart = null;
/** {kind, index, startRadius, startY} — a desktop radius drag @type {any} */
let radiusDrag = null;
/** the record as it was when the current gesture started @type {any} */
let gestureBefore = null;
/** VR carry: {kind, index, controller, offset, startRadius, startY} @type {any} */
let vrCarry = null;
/** trailing-'select' swallow stamp (a VR pick just handled this trigger) */
let vrHandledAt = 0;
let vrRegistered = false;

const lastObjectMatrix = new THREE.Matrix4();
const tempMatrix = new THREE.Matrix4();
const tempVector = new THREE.Vector3();
const tempUp = new THREE.Vector3();
const tempScale = new THREE.Vector3();

/** handle scale: a fraction of the object's size, clamped like the vertex dots */
function handleSize() {
	const box = new THREE.Box3().setFromObject(edited);
	return THREE.MathUtils.clamp(box.getSize(tempVector).length() * 0.02, 0.02, 0.25);
}

/** @param {number} count @param {number} color @param {number} size @param {string} name */
function makeHandles(count, color, size, name) {
	const mesh = new THREE.InstancedMesh(
		new THREE.SphereGeometry(size, 8, 8),
		new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
		Math.max(count, 1)
	);
	mesh.count = count;
	mesh.renderOrder = 999;
	mesh.name = name;
	return mesh;
}

/** WORLD position of control point `index`. @param {number} index @param {any} target */
function pointWorld(index, target) {
	const point = points[index];
	if (!point) return target.set(0, 0, 0);
	return edited.localToWorld(target.set(point.pos[0], point.pos[1], point.pos[2]));
}

/** WORLD position of the radius dot for `index`. @param {number} index @param {any} target */
function radiusWorld(index, target) {
	const point = points[index];
	pointWorld(index, target);
	if (!point) return target;
	// offset along the object's own Y so the dot follows rotation/scale
	tempUp.set(0, 1, 0).transformDirection(edited.matrixWorld).normalize();
	edited.getWorldScale(tempScale);
	return target.addScaledVector(tempUp, point.radius * RADIUS_OFFSET * Math.abs(tempScale.y || 1));
}

function spanCount() {
	const closed = !!edited?.userData?.spline?.closed;
	return closed ? points.length : Math.max(points.length - 1, 0);
}

function refreshMatrices() {
	if (!edited || !group) return;
	for (let i = 0; i < points.length; i++) {
		pointWorld(i, tempVector);
		pointHandles.setMatrixAt(i, tempMatrix.makeTranslation(tempVector.x, tempVector.y, tempVector.z));
		radiusWorld(i, tempVector);
		radiusHandles.setMatrixAt(i, tempMatrix.makeTranslation(tempVector.x, tempVector.y, tempVector.z));
	}
	// ONE curve for all span markers — the insert marker sits on the CURVE, not
	// on the chord (a curved span's chord midpoint floats off the tube)
	const spans = spanCount();
	const curve = spans > 0 ? splineCurve({ points, closed: !!edited.userData?.spline?.closed }) : null;
	for (let i = 0; i < spans; i++) {
		if (curve) edited.localToWorld(curve.getPoint((i + 0.5) / spans, tempVector));
		else tempVector.set(0, 0, 0);
		midHandles.setMatrixAt(i, tempMatrix.makeTranslation(tempVector.x, tempVector.y, tempVector.z));
	}
	[pointHandles, radiusHandles, midHandles].forEach((mesh) => {
		mesh.instanceMatrix.needsUpdate = true;
		// three caches an InstancedMesh boundingSphere for its raycast pre-check
		// and never invalidates it on setMatrixAt (the D2 trap) — handles moved
		// outside the initial bounds would go unpickable
		mesh.boundingSphere = null;
		mesh.boundingBox = null;
	});
}

function refreshColors() {
	for (let i = 0; i < points.length; i++)
		pointHandles.setColorAt(
			i,
			new THREE.Color(i === selected || picked.includes(i) ? POINT_SELECTED : i === hovered ? POINT_HOVER : POINT_COLOR)
		);
	if (pointHandles.instanceColor) pointHandles.instanceColor.needsUpdate = true;
}

/** Rebuild the handle instances from the live record (count may have changed). */
function rebuildHandles() {
	const data = splineDataOf(edited);
	if (!data) return;
	points = data.points;
	splinePointCount.set(points.length);
	const scene = get(globalScene);
	if (!scene) return;
	if (group) {
		scene.remove(group);
		disposeHandles();
	}
	const size = handleSize();
	group = new THREE.Group();
	group.userData.vrOverlay = false; // 31 K2: world handles, never drawn over the scene
	group.name = 'spline-handles';
	pointHandles = makeHandles(points.length, POINT_COLOR, size, 'spline-point-handles');
	radiusHandles = makeHandles(points.length, RADIUS_COLOR, size * 0.6, 'spline-radius-handles');
	midHandles = makeHandles(spanCount(), MID_COLOR, size * 0.45, 'spline-mid-handles');
	group.add(pointHandles, radiusHandles, midHandles);
	scene.add(group);
	if (selected >= points.length) selected = -1;
	picked = picked.filter((i) => i < points.length);
	if (selected >= 0 && !picked.includes(selected)) picked = [...picked, selected];
	splineSelectedPoint.set(selected);
	pathSelectedPoints.set([...picked]);
	refreshMatrices();
	refreshColors();
	if (selected >= 0) seatGizmo(selected);
}

function disposeHandles() {
	[pointHandles, radiusHandles, midHandles].forEach((mesh) => {
		mesh?.geometry?.dispose?.();
		mesh?.material?.dispose?.();
	});
	pointHandles = null;
	radiusHandles = null;
	midHandles = null;
	group = null;
}

/**
 * Enter the session. @param {string} uuid @returns {boolean}
 */
export function enterSplineEdit(uuid) {
	if (get(splineEditObject)) exitSplineEdit();
	const object = splineObjectOf(uuid);
	if (!splineDataOf(object)) {
		showToast('Only spline objects can be spline-edited — use the Draw ▸ Spline tool to make one');
		return false;
	}
	if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
		showToast('This object is locked by another peer');
		return false;
	}
	if (!get(globalScene)) return false;
	edited = object;
	edited.updateMatrixWorld();
	lastObjectMatrix.copy(edited.matrixWorld);
	selected = -1;
	hovered = -1;
	picked = [];
	rebuildHandles();
	if (isPathRecord(edited.userData.spline)) editingPathUuid.set(uuid);

	proxy = new THREE.Object3D();
	proxy.userData.isSplineProxy = true;
	get(globalScene).add(proxy);
	/** @type {any} */
	const controls = get(TControls);
	controls?.detach();

	// peers must not edit/select it meanwhile (same contract as mesh edit)
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'lock', uuid, peerId: peer.peer.id });

	splineEditObject.set(uuid);
	if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown, true);
	ensureVRHooks();
	return true;
}

export function exitSplineEdit() {
	if (!edited) return;
	const scene = get(globalScene);
	/** @type {any} */
	const controls = get(TControls);
	if (group) {
		scene?.remove(group);
		disposeHandles();
	}
	if (proxy) {
		if (controls && controls.object === proxy) controls.detach();
		scene?.remove(proxy);
	}
	/** @type {any} */
	const peer = get(peers);
	if (peer && edited) peer.send({ type: 'unlock', uuid: edited.uuid, peerId: peer.peer.id });
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown, true);
	edited = null;
	proxy = null;
	points = [];
	selected = -1;
	hovered = -1;
	picked = [];
	dragStart = null;
	popCapture(ADD_CAPTURE);
	pathSelectedPoints.set([]);
	editingPathUuid.set(null);
	radiusDrag = null;
	gestureBefore = null;
	vrCarry = null;
	splineSelectedPoint.set(-1);
	splinePointCount.set(0);
	splineEditObject.set(null);
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
	if (!viewportHasKeys(event)) return; // 36 U11: Esc in another pane is that pane's
	if (event.key === 'Escape') {
		// 78 F4: Esc pops the top capture (Add points) before it closes the editor
		if (popTopCapture()) return;
		exitSplineEdit();
		return;
	}
	if ((event.key === 'Delete' || event.key === 'Backspace') && picked.length) {
		event.preventDefault();
		event.stopPropagation();
		deletePoints(picked);
		return;
	}
	if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
		event.preventDefault();
		event.stopPropagation();
		selectPoints(points.map((_p, i) => i));
	}
}

// a remote edit (or an undo) swapped the record under us — regroup the handles
registerSplineRefresh((uuid) => {
	if (edited && edited.uuid === uuid) rebuildHandles();
});

/**
 * Per-frame: if the edited object moved (peer move, world-rig grab, animation)
 * re-pose the handles — they live at the scene root in WORLD space, so they do
 * not follow for free (the tickMeshEdit lesson).
 */
export function tickSplineEdit() {
	if (!edited || !group) return;
	edited.updateMatrixWorld();
	if (lastObjectMatrix.equals(edited.matrixWorld)) return;
	lastObjectMatrix.copy(edited.matrixWorld);
	refreshMatrices();
}

// ---- picking -------------------------------------------------------------

/**
 * Nearest handle under a ray. @param {any} raycaster
 * @returns {{kind: 'point'|'radius'|'mid', index: number, distance: number} | null}
 */
export function pickSplineHandle(raycaster) {
	if (!group) return null;
	/** @type {any} */
	let best = null;
	/** @type {['point'|'radius'|'mid', any][]} */
	const families = [
		['point', pointHandles],
		['radius', radiusHandles],
		['mid', midHandles]
	];
	for (const [kind, mesh] of families) {
		if (!mesh || !mesh.count) continue;
		const hits = raycaster.intersectObject(mesh);
		if (hits.length && (!best || hits[0].distance < best.distance))
			best = { kind, index: /** @type {number} */ (hits[0].instanceId), distance: hits[0].distance };
	}
	return best;
}

/** Seat the transform gizmo on control point `index` — or, with several points picked, on
 * their CENTROID in the chosen mode (78 F4). @param {number} index */
function seatGizmo(index) {
	if (!proxy) return;
	proxy.quaternion.identity();
	proxy.scale.set(1, 1, 1);
	if (picked.length > 1) {
		proxy.position.set(0, 0, 0);
		for (const i of picked) proxy.position.add(pointWorld(i, tempVector));
		proxy.position.multiplyScalar(1 / picked.length);
	} else {
		pointWorld(index, tempVector);
		proxy.position.copy(tempVector);
	}
	/** @type {any} */
	const controls = get(TControls);
	if (!controls) return;
	controls.setMode(picked.length > 1 ? get(splineGizmoMode) : 'translate');
	controls.attach(proxy);
}

/** 78 F4: the multi-point gizmo's mode @param {'translate'|'rotate'|'scale'} mode */
export function setSplineGizmoMode(mode) {
	splineGizmoMode.set(mode);
	if (picked.length > 1 && selected >= 0) seatGizmo(selected);
}

/** 78 F4: pick exactly these points (the toolbox, Ctrl+A, tests) @param {number[]} indices */
export function selectPoints(indices) {
	if (!edited) return false;
	picked = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < points.length);
	selected = picked.length ? picked[picked.length - 1] : -1;
	splineSelectedPoint.set(selected);
	pathSelectedPoints.set([...picked]);
	refreshColors();
	/** @type {any} */
	const controls = get(TControls);
	if (selected >= 0) seatGizmo(selected);
	else if (controls?.object === proxy) controls.detach();
	return true;
}

/** 78 F4: arm / disarm Add points (a capture on the F5 stack: Esc pops it first) @param {boolean} on */
export function setSplineAddMode(on) {
	if (!edited) return false;
	if (on) {
		pushCapture({ id: ADD_CAPTURE, label: 'Adding path points', hint: 'Click the scene to add points to the end · Esc to stop', onExit: () => splineAddMode.set(false) });
		splineAddMode.set(true);
	} else popCapture(ADD_CAPTURE);
	return true;
}

/** 78 F4: append a point where the ray meets the scene (or the ground) @param {any} raycaster */
export function addPointFromRay(raycaster) {
	if (!edited) return false;
	const group = get(objectsGroup);
	const hits = (group ? raycaster.intersectObjects(group.children, true) : []).filter(
		(/** @type {any} */ h) => h.object !== edited && !h.object.userData?.isSplineProxy
	);
	const at = hits[0]?.point ?? (raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3()) || null);
	if (!at) return false;
	const local = edited.worldToLocal(at.clone());
	const before = record();
	if (!before) return false;
	const after = cloneSpline(before);
	const radius = isPathRecord(before) ? PATH_LINE_RADIUS : (before.points[before.points.length - 1]?.radius ?? MIN_RADIUS);
	after.points.push({ pos: [local.x, local.y, local.z], radius });
	if (after.points.length > before.points.length && commitSplineEdit(edited.uuid, before, after)) {
		selected = after.points.length - 1;
		picked = [selected];
		rebuildHandles();
		return true;
	}
	return false;
}

/**
 * A left click while the session is open: select a point (seats the gizmo) or
 * insert one on a span marker. Radius dots are DRAG-only, so a click on one is
 * swallowed rather than falling through to object selection.
 * @param {any} raycaster @returns {boolean} whether the click was consumed
 */
export function splineEditClick(raycaster, additive = false) {
	const hit = pickSplineHandle(raycaster);
	if (!hit) {
		// 78 F4: Add points armed — the click on the scene is a new point at the end
		if (get(splineAddMode)) return addPointFromRay(raycaster);
		return false;
	}
	if (hit.kind === 'mid') {
		insertPointOnSpan(hit.index);
		return true;
	}
	if (hit.kind === 'radius') return true;
	// 78 F4: Ctrl / Shift toggles a point in or out of the pick; a plain click picks one
	if (additive) {
		picked = picked.includes(hit.index) ? picked.filter((i) => i !== hit.index) : [...picked, hit.index];
		selected = picked.length ? (picked.includes(hit.index) ? hit.index : picked[picked.length - 1]) : -1;
	} else {
		picked = [hit.index];
		selected = hit.index;
	}
	splineSelectedPoint.set(selected);
	pathSelectedPoints.set([...picked]);
	refreshColors();
	if (selected >= 0) seatGizmo(selected);
	else {
		/** @type {any} */
		const controls = get(TControls);
		if (controls?.object === proxy) controls.detach();
	}
	return true;
}

/** Hover tint from a ray (VR beam / future desktop hover). @param {number} index */
function setHovered(index) {
	if (index === hovered) return false;
	hovered = index;
	if (pointHandles) refreshColors();
	return true;
}

// ---- editing ops ---------------------------------------------------------

/** The live record, or null. */
function record() {
	return splineDataOf(edited);
}

/** Insert a control point in span `index` (the click target is its marker). @param {number} index */
export function insertPointOnSpan(index) {
	const before = record();
	if (!before) return false;
	const after = insertSplinePoint(before, index);
	if (after.points.length === before.points.length) return false;
	const ok = commitSplineEdit(edited.uuid, before, after);
	if (ok) {
		selected = index + 1; // the new point, ready to drag
		picked = [selected];
		splineSelectedPoint.set(selected);
		rebuildHandles();
	}
	return ok;
}

/** Delete control point `index` (right-click). @param {number} index */
export function deletePoint(index) {
	const before = record();
	if (!before) return false;
	const after = removeSplinePoint(before, index);
	if (!after) {
		showToast('A spline needs at least two control points');
		return false;
	}
	if (selected === index) selected = -1;
	else if (selected > index) selected--;
	picked = picked.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
	const ok = commitSplineEdit(edited.uuid, before, after);
	if (ok) rebuildHandles();
	return ok;
}

/** 78 F4: delete several points as ONE undo step (keeps at least two) @param {number[]} indices */
export function deletePoints(indices) {
	const before = record();
	if (!before) return false;
	const drop = new Set(indices);
	const keep = before.points.filter((/** @type {any} */ _p, /** @type {number} */ i) => !drop.has(i));
	if (keep.length < 2) {
		showToast('A path needs at least two points');
		return false;
	}
	const after = cloneSpline(before);
	after.points = keep.map((/** @type {any} */ p) => ({ ...p, pos: [...p.pos] }));
	if (after.points.length < 3) after.closed = false;
	selected = -1;
	picked = [];
	const ok = commitSplineEdit(edited.uuid, before, after);
	if (ok) {
		/** @type {any} */
		const controls = get(TControls);
		if (controls?.object === proxy) controls.detach();
		rebuildHandles();
	}
	return ok;
}

/** Right-click while the session is open: delete the point under the ray.
 * @param {any} raycaster @returns {boolean} whether the click was consumed */
export function splineEditRightClick(raycaster) {
	const hit = pickSplineHandle(raycaster);
	if (!hit || hit.kind === 'mid') return false;
	return deletePoint(hit.index);
}

/** @param {number} index @param {number[]} localPos */
function withPointAt(index, localPos) {
	const data = cloneSpline(record());
	if (!data.points[index]) return null;
	data.points[index].pos = [...localPos];
	return data;
}

/** @param {number} index @param {number} radius */
function withRadiusAt(index, radius) {
	const data = cloneSpline(record());
	if (!data.points[index]) return null;
	data.points[index].radius = Math.min(Math.max(radius, MIN_RADIUS), MAX_RADIUS);
	return data;
}

// ---- desktop: gizmo drag on the selected point ---------------------------

/** Scene.svelte's gizmo `onchange` while the spline proxy is attached. */
export function onSplineProxyMoved() {
	if (!edited || selected < 0 || !proxy) return;
	// 78 F4: several points ride the gizmo's transform about their centroid, from where they
	// were when the drag started (absolute, so a rotate never accumulates error)
	if (picked.length > 1) {
		if (!dragStart) return; // attaching the gizmo fires a change without a drag
		proxy.updateMatrix();
		const delta = new THREE.Matrix4().multiplyMatrices(proxy.matrix, dragStart.inverse);
		const data = cloneSpline(record());
		picked.forEach((i, k) => {
			if (!data.points[i]) return;
			const world = dragStart.world[k].clone().applyMatrix4(delta);
			data.points[i].pos = edited.worldToLocal(world).toArray();
		});
		streamSplineEdit(edited.uuid, data);
		points = splineDataOf(edited)?.points ?? points;
		refreshMatrices();
		return;
	}
	const local = edited.worldToLocal(tempVector.copy(proxy.position));
	const current = points[selected];
	if (
		current &&
		Math.abs(current.pos[0] - local.x) < 1e-9 &&
		Math.abs(current.pos[1] - local.y) < 1e-9 &&
		Math.abs(current.pos[2] - local.z) < 1e-9
	)
		return; // attaching the gizmo fires a change without a move
	const next = withPointAt(selected, [local.x, local.y, local.z]);
	if (!next) return;
	streamSplineEdit(edited.uuid, next);
	points = splineDataOf(edited)?.points ?? points;
	refreshMatrices();
}

/** Scene.svelte's `dragging-changed` for the spline proxy. @param {boolean} dragging */
export function onSplineProxyDragChanged(dragging) {
	if (!edited || selected < 0) return;
	if (dragging) {
		gestureBefore = cloneSpline(record());
		if (picked.length > 1 && proxy) {
			proxy.updateMatrix();
			dragStart = {
				inverse: new THREE.Matrix4().copy(proxy.matrix).invert(),
				world: picked.map((i) => pointWorld(i, new THREE.Vector3()).clone())
			};
		}
		return;
	}
	dragStart = null;
	if (!gestureBefore) return;
	const after = record();
	commitSplineEdit(edited.uuid, gestureBefore, after);
	gestureBefore = null;
	rebuildHandles();
}

// ---- desktop: radius drag (no gizmo — vertical pointer motion) -----------

/**
 * Pointer-down on a radius dot starts the drag (the caller pauses orbit).
 * @param {any} raycaster @param {number} clientY @returns {boolean}
 */
export function beginRadiusDrag(raycaster, clientY) {
	const hit = pickSplineHandle(raycaster);
	if (!hit || hit.kind !== 'radius') return false;
	const point = points[hit.index];
	if (!point) return false;
	selected = hit.index;
	splineSelectedPoint.set(selected);
	refreshColors();
	seatGizmo(selected);
	gestureBefore = cloneSpline(record());
	radiusDrag = { index: hit.index, startRadius: point.radius, startY: clientY };
	return true;
}

/** Pointer-move while a radius drag is active (up = thicker). @param {number} clientY */
export function radiusDragMove(clientY) {
	if (!radiusDrag || !edited) return;
	const radius = radiusFromDrag(
		radiusDrag.startRadius,
		radiusDrag.startY - clientY,
		RADIUS_GAIN_PIXELS
	);
	const next = withRadiusAt(radiusDrag.index, radius);
	if (!next) return;
	streamSplineEdit(edited.uuid, next);
	points = splineDataOf(edited)?.points ?? points;
	refreshMatrices();
}

/** Pointer-up: final broadcast + ONE undo entry for the whole drag. */
export function endRadiusDrag() {
	if (!radiusDrag) return false;
	radiusDrag = null;
	if (edited && gestureBefore) commitSplineEdit(edited.uuid, gestureBefore, record());
	gestureBefore = null;
	rebuildHandles();
	return true;
}

/** Is a radius drag in progress? (Scene routing / tests) */
export function radiusDragActive() {
	return !!radiusDrag;
}

// ---- 57.4 VR: carry a handle with the trigger ----------------------------

/** the pointer hand (the one that is NOT holding the radial menu) */
function pointerIndex() {
	return controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
}

/** @param {number} index */
function controllerRay(index) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!renderer?.xr) return null;
	const controller = renderer.xr.getController(index);
	if (!controller) return null;
	const matrix = new THREE.Matrix4().identity().extractRotation(controller.matrixWorld);
	const raycaster = new THREE.Raycaster();
	raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	raycaster.ray.direction.set(0, 0, -1).applyMatrix4(matrix);
	return raycaster;
}

/** @param {number} index */
function controllerPosition(index) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const controller = renderer?.xr?.getController?.(index);
	return controller ? controller.getWorldPosition(new THREE.Vector3()) : null;
}

/** Trigger PRESS: pick a handle and start carrying it. @param {number} index */
export function vrSplineTriggerStart(index) {
	if (!edited || !get(isVRMode) || vrCarry) return false;
	const hand = index >= 0 ? index : pointerIndex();
	const ray = controllerRay(hand);
	if (!ray) return false;
	const hit = pickSplineHandle(ray);
	if (!hit) return false;
	vrHandledAt = Date.now();
	if (hit.kind === 'mid') {
		insertPointOnSpan(hit.index);
		hapticPulse(0.4, 40);
		return true;
	}
	const position = controllerPosition(hand);
	if (!position) return false;
	selected = hit.index;
	splineSelectedPoint.set(selected);
	refreshColors();
	gestureBefore = cloneSpline(record());
	if (hit.kind === 'radius') {
		vrCarry = {
			kind: 'radius',
			index: hit.index,
			hand,
			startRadius: points[hit.index].radius,
			startY: position.y
		};
	} else {
		vrCarry = {
			kind: 'point',
			index: hit.index,
			hand,
			offset: pointWorld(hit.index, new THREE.Vector3()).sub(position)
		};
	}
	hapticPulse(0.3, 30);
	return true;
}

/** Trigger RELEASE: commit the carry as ONE undo entry. */
export function vrSplineTriggerEnd() {
	if (!vrCarry) return false;
	vrCarry = null;
	vrHandledAt = Date.now();
	if (edited && gestureBefore) commitSplineEdit(edited.uuid, gestureBefore, record());
	gestureBefore = null;
	rebuildHandles();
	hapticPulse(0.3, 30);
	return true;
}

/** Did a VR pick just consume this trigger? (swallows the trailing 'select') */
export function vrSplineSwallowed() {
	return Date.now() - vrHandledAt < 250;
}

/** Is a VR carry running? (nav suppression / tests) */
export function vrSplineCarryActive() {
	return !!vrCarry;
}

/** Per-frame VR work: the carried handle rides the controller; else hover tint. */
export function tickVRSpline() {
	if (!edited || !get(isVRMode)) return;
	if (vrCarry) {
		const position = controllerPosition(vrCarry.hand);
		if (!position) return;
		if (vrCarry.kind === 'radius') {
			const next = withRadiusAt(
				vrCarry.index,
				radiusFromDrag(vrCarry.startRadius, position.y - vrCarry.startY, RADIUS_GAIN_METERS)
			);
			if (next) streamSplineEdit(edited.uuid, next);
		} else {
			const world = position.add(vrCarry.offset);
			const local = edited.worldToLocal(world);
			const step = get(snapEnabled) ? get(snapSettings).translate : 0;
			if (step > 0) {
				local.x = Math.round(local.x / step) * step;
				local.y = Math.round(local.y / step) * step;
				local.z = Math.round(local.z / step) * step;
			}
			const next = withPointAt(vrCarry.index, [local.x, local.y, local.z]);
			if (next) streamSplineEdit(edited.uuid, next);
		}
		points = splineDataOf(edited)?.points ?? points;
		refreshMatrices();
		return;
	}
	const hand = pointerIndex();
	const ray = hand >= 0 ? controllerRay(hand) : null;
	const hit = ray ? pickSplineHandle(ray) : null;
	if (setHovered(hit && hit.kind === 'point' ? hit.index : -1) && hit) hapticPulse(0.1, 12);
}

/** Register the generic VR hooks once (the vrsleeve pattern: they no-op with no
 * session open, so registering on first entry is enough). */
function ensureVRHooks() {
	if (vrRegistered) return;
	vrRegistered = true;
	registerNavSuppressor(() => !!vrCarry);
	registerPanelGroupProvider(() => (get(splineEditObject) ? group : null));
	registerVRTriggerHooks({
		start: (/** @type {number} */ i) => vrSplineTriggerStart(i),
		end: () => vrSplineTriggerEnd(),
		swallow: () => vrSplineSwallowed()
	});
	registerVRFrameHook(() => tickVRSpline());
}

/** test/debug view of the session */
export function splineEditDebug() {
	return {
		uuid: edited?.uuid ?? null,
		points: points.length,
		spans: spanCount(),
		selected,
		picked: [...picked],
		addMode: get(splineAddMode),
		hovered,
		radiusDrag: !!radiusDrag,
		vrCarry: vrCarry ? vrCarry.kind : null,
		handles: group
			? {
					point: pointHandles?.count ?? 0,
					radius: radiusHandles?.count ?? 0,
					mid: midHandles?.count ?? 0
				}
			: null
	};
}
