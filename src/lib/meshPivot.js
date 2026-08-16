// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, globalCamera, globalRenderer, TControls, transformMode } from '../stores/sceneStore';
import { showToast, showInfoToast, dismissToastById } from '../stores/appStore';
import { proportionalAnchor } from './proportional';

// The mesh editor's CUSTOM TRANSFORM PIVOT — where the gizmo sits, and what
// rotate/scale turn around, in all three element modes.
//
// Without one the pivot is the selection's own centre, which is the right
// default and useless for the thing people actually want: rotating a face about
// a corner, scaling a row of vertices toward one end, spinning a ring about the
// axis of the hole it surrounds. So the pivot is placeable — from the current
// selection's centre, or by clicking a point on the mesh — and it is REMEMBERED
// per object, because re-placing it every time you re-enter the session would
// make it a gesture rather than a setting.
//
// LOCAL, never replicated, never saved into the scene. It is a working
// preference about how YOU are editing, in the same family as the gizmo space,
// the handle size and viewPrefs — two peers editing one mesh may reasonably want
// different pivots, and a pivot has no meaning at all to a peer who is not in a
// session. It is deliberately NOT `userData.origin`: that is 17-D's REPLICATED
// object pivot, which drives joints, flow Spin/Orbit and the export bake, so
// overloading it would silently change behaviour a long way from the mesh editor.
//
// Stored in OBJECT-LOCAL coordinates (the snapAnchor rule), so the pivot rides
// every later move, rotation and scale of the object for free.
//
// Imports THREE + the two stores + the proportional LEAF, and nothing from
// meshEdit/faceEdit — those import THIS, and the reverse edge would close a TDZ
// cycle (both sit inside the history import family).

const KEY = 'meshPivots';

/** localStorage is a per-DEVICE store, so an unbounded uuid map would grow
 * forever across scenes. Oldest entries fall off once past this. */
const MAX_STORED = 200;

/** @returns {Record<string, number[]>} */
function load() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
		const stored = raw ? JSON.parse(raw) : {};
		if (!stored || typeof stored !== 'object') return {};
		/** @type {Record<string, number[]>} */
		const clean = {};
		for (const [uuid, value] of Object.entries(stored)) {
			if (Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(n)))
				clean[uuid] = [value[0], value[1], value[2]];
		}
		return clean;
	} catch {
		return {};
	}
}

/** uuid -> the pivot's OBJECT-LOCAL [x, y, z]
 * @type {import('svelte/store').Writable<Record<string, number[]>>} */
export const meshPivots = writable(load());

/** armed pick mode: the next viewport click places the pivot (the
 * snapAnchorPicking shape — one click, and every exit path clears the toast)
 * @type {import('svelte/store').Writable<boolean>} */
export const meshPivotPicking = writable(false);

/** armed MOVE mode: the transform GIZMO re-points the pivot instead of moving
 * geometry — the mesh session's twin of 17-D's `pivotOnly` (multiTransform.js).
 * Mutually exclusive with the pick: arming either cancels the other, because
 * both answer "where does the pivot go" and two armed answers is one too many.
 * @type {import('svelte/store').Writable<boolean>} */
export const meshPivotMoving = writable(false);

meshPivots.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(value));
});

/** meshEdit/faceEdit register here so the gizmo re-seats the moment the pivot
 * moves, without this module importing either of them (the
 * registerGizmoPrefListener precedent). @type {(() => void)[]} */
const pivotListeners = [];
/** @param {() => void} fn */
export function registerMeshPivotListener(fn) {
	pivotListeners.push(fn);
}
function notifyPivotChanged() {
	pivotListeners.forEach((fn) => fn());
}

/**
 * The stored pivot of an object, as a FRESH object-local vector (callers mutate
 * what they get back), or null when the object has none.
 * @param {string|null|undefined} uuid @returns {any}
 */
export function meshPivotLocal(uuid) {
	if (!uuid) return null;
	const stored = get(meshPivots)[uuid];
	return stored ? new THREE.Vector3(stored[0], stored[1], stored[2]) : null;
}

/** Does this object carry a custom pivot? @param {string|null|undefined} uuid */
export function hasMeshPivot(uuid) {
	return !!uuid && !!get(meshPivots)[uuid];
}

/** @param {string} uuid @param {any} local a LOCAL-space Vector3 */
export function setMeshPivotLocal(uuid, local) {
	if (!uuid || !local) return false;
	meshPivots.update((value) => {
		const next = { ...value, [uuid]: [local.x, local.y, local.z] };
		const keys = Object.keys(next);
		if (keys.length > MAX_STORED) for (const old of keys.slice(0, keys.length - MAX_STORED)) delete next[old];
		return next;
	});
	notifyPivotChanged();
	return true;
}

/** @param {any} object the edited mesh @param {any} world a WORLD-space point */
export function setMeshPivotWorld(object, world) {
	if (!object || !world) return false;
	object.updateMatrixWorld(true);
	return setMeshPivotLocal(object.uuid, object.worldToLocal(world.clone()));
}

/** @param {string|null|undefined} uuid */
export function clearMeshPivot(uuid) {
	if (!uuid || !get(meshPivots)[uuid]) return false;
	meshPivots.update((value) => {
		const next = { ...value };
		delete next[uuid];
		return next;
	});
	notifyPivotChanged();
	return true;
}

/**
 * "Set pivot here" — the current selection's own centre, in whichever element
 * mode is open. Reuses the proportional-ring ANCHOR PROVIDERS: meshEdit and
 * faceEdit already publish "the world point of what is selected" there for
 * vertices / edges / faces, so this needs no fourth way of asking.
 * @param {'vertices'|'edges'|'faces'} mode @returns {boolean}
 */
export function setMeshPivotFromSelection(mode) {
	const anchor = proportionalAnchor(mode);
	if (!anchor?.point || !anchor.object) {
		showToast('Select something first, then Set pivot');
		return false;
	}
	const ok = setMeshPivotWorld(anchor.object, anchor.point);
	if (ok) showToast('Pivot set — rotate and scale now turn about it');
	return ok;
}

// ---- pick mode ---------------------------------------------------------------

/** the instruction toast: STICKY, so it holds while the user lines the click up
 * instead of timing out mid-aim (the snapAnchorPicking reasoning) */
const PICK_TOAST_ID = 'mesh-pivot-pick';

/** Arm pick mode. @returns {boolean} */
export function startMeshPivotPick() {
	cancelMeshPivotMove(); // the two placement modes are mutually exclusive
	meshPivotPicking.set(true);
	showInfoToast(
		PICK_TOAST_ID,
		'Click a point on the mesh to place the pivot — a nearby vertex wins (Esc cancels)',
		[],
		() => meshPivotPicking.set(false) // its own X leaves the mode too
	);
	return true;
}

/** Leave pick mode without picking (the button again, Esc, a miss, session exit). */
export function cancelMeshPivotPick() {
	dismissToastById(PICK_TOAST_ID);
	if (!get(meshPivotPicking)) return false;
	meshPivotPicking.set(false);
	return true;
}

/**
 * Escape while pick mode is armed drops the PICK, not the session — and the
 * answer travels on the EVENT, exactly as the knife's does. There are two
 * Escape handlers here (meshEdit's and faceEdit's window listeners) and a
 * one-shot store flag would be consumed by whichever ran first, leaving the
 * other to tear the session down anyway.
 * @param {any} event @returns {boolean} true when this handler owns the key
 */
export function escapeConsumedByPivotPick(event) {
	if (event?.defaultPrevented) return true; // another handler took it for the same reason
	if (!get(meshPivotPicking)) return false;
	cancelMeshPivotPick();
	showToast('Pivot pick cancelled');
	event?.preventDefault?.();
	return true;
}

/** world position of one corner of a mesh's triangle @param {any} mesh
 * @param {number} faceIndex @param {number} corner */
function triCornerWorld(mesh, faceIndex, corner) {
	const geometry = mesh?.geometry;
	const position = geometry?.attributes?.position;
	if (!position) return null;
	const at = geometry.index ? geometry.index.getX(faceIndex * 3 + corner) : faceIndex * 3 + corner;
	if (at == null || at >= position.count) return null;
	return mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(position, at));
}

/** @param {any} point @param {any} camera @param {any} rect @returns {number[]|null} */
function projectPx(point, camera, rect) {
	const ndc = point.clone().project(camera);
	if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return null;
	return [
		rect.left + ((ndc.x + 1) / 2) * rect.width,
		rect.top + ((1 - ndc.y) / 2) * rect.height
	];
}

/**
 * The one-click Scene intercept. Raycasts ONLY the edited mesh; a corner of the
 * hit triangle within ~14 screen px wins over the exact hit point, so placing
 * the pivot on a vertex needs no precision. A miss exits pick mode (the
 * measure/knife/snap-anchor idiom).
 * @param {any} object the mesh being edited @param {any} raycaster already aimed
 * @param {number[]} [clientPx] the click, CSS px @returns {boolean} whether a pivot was placed
 */
export function meshPivotClick(object, raycaster, clientPx) {
	meshPivotPicking.set(false);
	dismissToastById(PICK_TOAST_ID); // the mode is over, whatever the outcome
	if (!object) {
		showToast('Pivot: nothing is being edited (pick cancelled)');
		return false;
	}
	const hit = raycaster.intersectObject(object, false)[0];
	if (!hit) {
		showToast('Pivot: click landed off the mesh (pick cancelled)');
		return false;
	}
	let world = hit.point.clone();
	let kind = 'surface point';
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	const rect = renderer?.domElement?.getBoundingClientRect?.();
	if (hit.faceIndex != null && camera && rect && clientPx) {
		let best = null;
		let bestDist = 14; // screen px
		for (let corner = 0; corner < 3; corner++) {
			const point = triCornerWorld(object, hit.faceIndex, corner);
			if (!point) continue;
			const px = projectPx(point, camera, rect);
			if (!px) continue;
			const distance = Math.hypot(px[0] - clientPx[0], px[1] - clientPx[1]);
			if (distance < bestDist) {
				bestDist = distance;
				best = point;
			}
		}
		if (best) {
			world = best;
			kind = 'vertex';
		}
	}
	const ok = setMeshPivotWorld(object, world);
	if (ok) showToast(`Pivot placed (${kind}) — rotate and scale turn about it`);
	return ok;
}

// ---- move mode: place the pivot by DRAGGING THE GIZMO ------------------------
// The third way to place it, and the one the user asked for last ("free move of
// pivot by moving gizmo to set it"). Set-here needs a selection that already
// surrounds the point you want; Pick needs the point to be ON the mesh. Dragging
// the gizmo has neither constraint, and it is the same gesture as every other
// placement in the app.
//
// Modelled on 17-D's `pivotOnly` (multiTransform.js): the two gizmo hooks of
// each element mode early-return into a pivot-only path, so the drag NEVER opens
// a grab/gesture it would then have to unwind. One deliberate difference — that
// mode's drag end records history and writes the REPLICATED `userData.origin`,
// while this pivot is a local working preference, so a drag here records no undo
// entry and sends no message. Nothing about it is worth a peer's attention.
//
// Desktop only, implicitly: neither element mode seats a desktop gizmo in VR
// (its helper would render in-headset), so there is nothing to drag there.

/** the instruction toast — STICKY like the pick's: the mode outlives one drag */
const MOVE_TOAST_ID = 'mesh-pivot-move';

/** the transform mode the user was in before arming, restored on disarm.
 * Declared above the subscribers/functions that read it (the module-eval TDZ
 * rule this file's neighbours have been bitten by). @type {string|null} */
let modeBeforeMove = null;

/** Both halves of forcing a gizmo mode: the store the toolbar renders from AND
 * the live controls (a face gizmo never re-reads the store on its own).
 * @param {string} mode */
function setGizmoMode(mode) {
	transformMode.set(mode);
	/** @type {any} */
	const controls = get(TControls);
	controls?.setMode?.(mode);
}

/** is a mesh-session gizmo actually seated right now? (the thing to drag) */
function gizmoSeated() {
	/** @type {any} */
	const controls = get(TControls);
	const data = controls?.object?.userData;
	return !!(data?.isVertexProxy || data?.isFaceProxy);
}

/**
 * Arm move mode. FORCES translate for its duration — the pivot is a POINT, and
 * a point has no rotation and no scale, so leaving rotate armed would offer
 * handles that cannot mean anything. The mode the user had is put back on
 * disarm.
 * @returns {boolean}
 */
export function startMeshPivotMove() {
	cancelMeshPivotPick(); // mutually exclusive (see meshPivotMoving)
	if (get(meshPivotMoving)) return false;
	modeBeforeMove = get(transformMode);
	meshPivotMoving.set(true);
	setGizmoMode('translate');
	notifyPivotChanged(); // re-seat in whichever element mode is open
	showInfoToast(
		MOVE_TOAST_ID,
		'Drag the gizmo to place the pivot — nothing else moves (Esc leaves)',
		[],
		() => cancelMeshPivotMove() // its own X leaves the mode too
	);
	// the gizmo IS the control here, so say so when there is none rather than
	// leaving the button looking dead (no selection / gizmo switched off / VR)
	if (!gizmoSeated())
		showToast('Move pivot: no gizmo is seated — select something in the mesh first');
	return true;
}

/** Leave move mode (the button again, Esc, session exit). @returns {boolean} */
export function cancelMeshPivotMove() {
	dismissToastById(MOVE_TOAST_ID);
	if (!get(meshPivotMoving)) return false;
	meshPivotMoving.set(false);
	setMeshPivotPreview(null);
	if (modeBeforeMove) setGizmoMode(modeBeforeMove);
	modeBeforeMove = null;
	notifyPivotChanged(); // re-seat with the restored mode
	return true;
}

/** The toolbox button: one control, on and off. @returns {boolean} */
export function toggleMeshPivotMove() {
	return get(meshPivotMoving) ? cancelMeshPivotMove() : startMeshPivotMove();
}

/**
 * Drag end in move mode: wherever the gizmo ended up BECOMES the pivot. Goes
 * through `setMeshPivotWorld`, so it persists, re-seats the gizmo and moves the
 * marker by the same path every other placement uses — and, like them, records
 * nothing and sends nothing. The mode STAYS armed (17-D's rule: a re-seat is not
 * a new selection, and pressing the button must not cancel itself).
 * @param {any} object the edited mesh @param {any} worldPos the proxy's position
 * @returns {boolean}
 */
export function commitMeshPivotDrag(object, worldPos) {
	setMeshPivotPreview(null); // the stored pivot takes over from the live preview
	const ok = setMeshPivotWorld(object, worldPos);
	if (ok) showToast('Pivot moved — rotate and scale turn about it');
	return ok;
}

/**
 * Escape while move mode is armed disarms it and KEEPS the session, on the same
 * event-verdict contract as the pick.
 *
 * ORDER: the pick is asked first, this second, in all three window handlers. The
 * two modes are mutually exclusive, so at most one of them can ever consume the
 * key and the order cannot change an outcome — it is fixed only so every handler
 * agrees. Both return false when nothing is armed, which is what lets the next
 * Escape reach "leave the session".
 * @param {any} event @returns {boolean} true when this handler owns the key
 */
export function escapeConsumedByPivotMove(event) {
	if (event?.defaultPrevented) return true; // another handler took it for the same reason
	if (!get(meshPivotMoving)) return false;
	cancelMeshPivotMove();
	showToast('Move pivot off');
	event?.preventDefault?.();
	return true;
}

// ---- the marker --------------------------------------------------------------
// A SCENE-ROOT helper, never a child of the edited mesh: objectsGroup is the
// replicated, serialized tree, and an editor helper parked in there is written
// into every save (the edit-overlay leak, see editOverlays.js). raycast is
// stubbed so it can never swallow a pick — the proportionalRing/sculpt recipe.

/** @type {any} */ let marker = null;
/** the object whose pivot the marker is currently showing @type {any} */ let markerObject = null;
/** a WORLD point the marker shows INSTEAD of the stored pivot, while a move
 * drag is live. Nothing is written to the store until the drag ends: a write
 * mid-drag notifies the listeners, which re-seat the gizmo — under the pointer
 * that is a fight, and the proxy would jump back on every frame. @type {any} */
let previewWorld = null;

/**
 * Show the marker at a point that is not (yet) the stored pivot — the live
 * feedback of a move drag, and the only way the FIRST pivot on an object is
 * visible at all before it is committed. Null drops the preview.
 * @param {any} world THREE.Vector3 | null
 */
export function setMeshPivotPreview(world) {
	previewWorld = world ? world.clone() : null;
	if (markerObject) refreshMeshPivotMarker(markerObject);
}

/** @param {any} scene */
function ensureMarker(scene) {
	if (marker) {
		if (!marker.parent) scene.add(marker);
		return marker;
	}
	marker = new THREE.Group();
	marker.name = 'mesh-pivot-marker';
	// deliberately NOT the snap anchor's look (a small solid dot + a normal tick):
	// a violet open octahedron reads as "a point things turn around" and cannot be
	// mistaken for it when both are on screen at once
	const core = new THREE.Mesh(
		new THREE.OctahedronGeometry(1, 0),
		new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.85, depthTest: false })
	);
	core.name = 'mesh-pivot-core';
	const cage = new THREE.LineSegments(
		new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1.9, 0)),
		new THREE.LineBasicMaterial({ color: 0xf5d0fe, transparent: true, opacity: 0.9, depthTest: false })
	);
	cage.name = 'mesh-pivot-cage';
	marker.add(core, cage);
	marker.renderOrder = 998;
	marker.traverse((/** @type {any} */ node) => {
		node.raycast = () => {}; // a viewport helper must never be a pick target
	});
	scene.add(marker);
	return marker;
}

/**
 * Show (or hide) the marker for an object's pivot. Idempotent — session enter,
 * every pivot change and the per-frame tick all go through it.
 * @param {any} object the edited mesh, or null to hide
 */
export function refreshMeshPivotMarker(object) {
	markerObject = object ?? null;
	const local = object ? meshPivotLocal(object.uuid) : null;
	const preview = object ? previewWorld : null;
	if (!local && !preview) {
		if (marker) marker.visible = false;
		return;
	}
	const scene = get(globalScene);
	if (!scene) return;
	const group = ensureMarker(scene);
	group.visible = true;
	object.updateMatrixWorld(true);
	// a live drag wins: it IS where the pivot is about to be
	group.position.copy(preview ?? object.localToWorld(local));
	// SCREEN-constant size: a world-size marker vanishes on a large mesh and
	// swallows a small one (the vertex-handle lesson, one helper down)
	const camera = get(globalCamera);
	const distance = camera ? camera.getWorldPosition(new THREE.Vector3()).distanceTo(group.position) : 10;
	group.scale.setScalar(Math.max(distance * 0.008, 0.012));
}

/** Per-frame: the marker follows the object AND the camera (its size is a screen
 * size, so an orbit changes it even though nothing moved). Called from Scene's
 * task next to tickMeshEdit. */
export function tickMeshPivotMarker() {
	if (!markerObject || !marker?.visible) return;
	refreshMeshPivotMarker(markerObject);
}

/** Hide + free the marker — session exit. */
export function disposeMeshPivotMarker() {
	markerObject = null;
	previewWorld = null;
	if (!marker) return;
	marker.traverse((/** @type {any} */ node) => {
		node.geometry?.dispose?.();
		node.material?.dispose?.();
	});
	marker.parent?.remove(marker);
	marker = null;
}

/** the marker's world position, or null — tests/debug */
export function meshPivotMarkerDebug() {
	return marker?.visible ? { position: marker.position.toArray(), scale: marker.scale.x } : null;
}
