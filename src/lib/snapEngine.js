// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { globalScene, globalCamera, globalRenderer, objectsGroup, TControls, selectedObjects } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { snapTargets } from './snapping';
import { sceneHits, hitWorldNormal } from './scenePick';
import { originWorld } from './objectOrigin';
import { readStoredFaces } from './meshTopology';
import { ensureBoundsTrees } from './bvhPicking';
import { setTransientPivot, registerPivotSnapAdjuster } from './multiTransform';

// 19-B P2: the element snap engine.
//
// While a gizmo TRANSLATE drag runs, a throttled CURSOR-based search raycasts
// the scene (via scenePick, dragged subtree excluded) and collects candidate
// points by the flags in `snapTargets` (vertex / face / surface / object).
// The best candidate within `radiusPx` screen pixels goes into
// `activeSnapCandidate`, and `applyElementSnap` world-shifts the dragged
// object so its ANCHOR lands on the candidate. Element snap OVERRIDES the
// grid steps while a candidate is live: TransformControls quantizes first,
// we reposition after — and because it re-derives its pose from its own drag
// start every pointermove, the correction never accumulates (the
// dropToSurface safety precedent). Losing the candidate pops the object back
// to the quantized pose.
//
// Axis-drag divergence: when the cursor ray misses (the pointer sits on a
// gizmo handle, not on scene geometry), ONE fallback ray goes through the
// dragged object's own projected screen point — it finds what the object
// approaches. Worst case element snap is inert on that drag, never wrong.
//
// Import graph note: this module may import multiTransform (nothing below
// multiTransform reaches back here) but multiTransform must NEVER import this
// module statically — snapEngine -> scenePick -> terrainSculpt ->
// objectActions -> multiTransform would close the cycle. The pivot hook (P3)
// therefore goes through a registration seam.

/** the live snap candidate, or null:
 * {type, point: THREE.Vector3, normal: THREE.Vector3|null, uuid, faceIndex?, px: number[]}
 * @type {import('svelte/store').Writable<any>} */
export const activeSnapCandidate = writable(null);

// 19-B P3: the TRANSIENT snap anchor — a picked point on the selected object,
// LOCAL-ONLY (never userData.origin, never replicated, never persisted; only
// the anchorMode PREFERENCE persists, in snapTargets). Resting shape below;
// 'picked' carries the object uuid + the point in that object's local frame.
/** @type {import('svelte/store').Writable<{mode: string, uuid: string|null, local: number[]|null}>} */
export const snapAnchor = writable({ mode: 'auto', uuid: null, local: null });
/** one-click pick mode: the next viewport click picks the anchor (Scene intercept) */
export const snapAnchorPicking = writable(false);

// ---- module state (declared above every subscriber — the TDZ rule) ---------
/** @type {number[]|null} last pointer position in CLIENT px (tracked by Scene while dragging) */
let pointerClient = null;
let lastSearchAt = 0;
/** @type {string[]} the dragged subtree, excluded from every search */
let dragExclude = [];
/** @type {{point: any, uuid: string}[]|null} object-target points cached at drag start */
let dragObjectPoints = null;
let dragActive = false;
/** P3, pivot drags only: the drag-start frame the pivot-path anchor is
 * evaluated in. The members re-derive AFTER the adjuster runs, so an anchor
 * read off the primary's live pose is one frame stale and double-counts the
 * pivot's own offset (measured: the picked point landed exactly one manual
 * pivot move off the candidate).
 * @type {{pivotPos: any, primaryBox: any, originOffset: any}|null} */
let pivotDragStart = null;
/** @type {any} scene-root candidate marker group */
let marker = null;
/** @type {any} */ let markerDot = null;
/** @type {any} */ let markerTick = null;
/** @type {any} scene-root face tint (P4) */ let faceTint = null;
/** P4 align-to-normal: the drag target's quaternion at drag START. Every
 * application recomputes from it (align × baseQuat), so nothing accumulates —
 * a per-frame multiply into the LIVE quaternion would spin the object.
 * @type {any} THREE.Quaternion | null */
let baseQuat = null;
/** whether the live pose carries an alignment (so losing the candidate knows to
 * put baseQuat back — a translate drag never rewrites rotation by itself) */
let alignApplied = false;
let started = false;

const SEARCH_INTERVAL_MS = 33;
const MARKER_NAME = 'snap-candidate-marker';
const FACE_TINT_NAME = 'snap-candidate-face';
const MARKER_COLOR = 0xffa02e;

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _proj = new THREE.Vector3();
const _box = new THREE.Box3();
const _anchor = new THREE.Vector3();
const _world = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _alignUp = new THREE.Vector3(0, 1, 0);
const _alignNormal = new THREE.Vector3();
const _alignQuat = new THREE.Quaternion();

/** Scene feeds the pointer while a gizmo drag runs (window pointermove — the
 * canvas swallows moves mid-gesture). CLIENT px; NDC is derived at search time.
 * @param {number} clientX @param {number} clientY */
export function setSnapPointer(clientX, clientY) {
	pointerClient = [clientX, clientY];
}

/** walk up to the objectsGroup child that contains a mesh (local copy — do not
 * import objectActions here, see the module header) @param {any} object */
function topLevelUuidOf(object) {
	const group = get(objectsGroup);
	let current = object;
	while (current?.parent && current.parent !== group) current = current.parent;
	return current?.parent === group ? current.uuid : null;
}

/** the 8 snap points of one object: its origin/pivot + world-bbox center + the
 * 6 bbox face centers @param {any} object */
function objectSnapPoints(object) {
	const points = [{ point: originWorld(object, new THREE.Vector3()), uuid: object.uuid }];
	const box = new THREE.Box3().setFromObject(object);
	if (box.isEmpty()) return points;
	const c = box.getCenter(new THREE.Vector3());
	points.push({ point: c.clone(), uuid: object.uuid });
	points.push({ point: new THREE.Vector3(box.min.x, c.y, c.z), uuid: object.uuid });
	points.push({ point: new THREE.Vector3(box.max.x, c.y, c.z), uuid: object.uuid });
	points.push({ point: new THREE.Vector3(c.x, box.min.y, c.z), uuid: object.uuid });
	points.push({ point: new THREE.Vector3(c.x, box.max.y, c.z), uuid: object.uuid });
	points.push({ point: new THREE.Vector3(c.x, c.y, box.min.z), uuid: object.uuid });
	points.push({ point: new THREE.Vector3(c.x, c.y, box.max.z), uuid: object.uuid });
	return points;
}

/**
 * A drag begins: remember the excluded subtree and cache the object-target
 * points ONCE (originWorld + bbox center + 6 face centers per non-excluded
 * top-level object — they do not move while WE drag).
 * @param {string[]} excludeUuids
 */
export function beginSnapDrag(excludeUuids) {
	// P4: a drag-start that arrives TWICE must not redefine the base pose.
	// three's TransformControls property setters dispatch BOTH `<prop>-changed`
	// AND `change`, so `controls.dragging = true` already starts the drag and can
	// align the object before a hand-dispatched dragging-changed arrives — and
	// re-capturing THAT as the base compounds the rotation by one more alignment
	// (measured: 60 degrees on a 30-degree ramp).
	const reentrant = dragActive;
	dragActive = true;
	dragExclude = excludeUuids ?? [];
	dragObjectPoints = null;
	pivotDragStart = null;
	lastSearchAt = 0;
	const group = get(objectsGroup);
	/** @type {any} */
	const controls = get(TControls);
	// P4 align-to-normal: the drag target's rotation BEFORE the gizmo moves
	// anything. Alignment is always recomputed from this, never from the live
	// quaternion, so repeated frames are idempotent and losing the candidate can
	// restore the pose exactly.
	if (!reentrant) {
		baseQuat = controls?.object?.quaternion ? controls.object.quaternion.clone() : null;
		alignApplied = false;
	}
	// a PIVOT drag captures its start frame (this runs from dragging-changed,
	// before the gizmo has moved anything): the pivot's seat, the primary's box
	// and the primary's origin offset — what the pivot-path anchor reads from
	if (controls?.object?.userData?.isMultiPivot && group) {
		const primaryUuid = dragExclude[dragExclude.length - 1];
		const primary = primaryUuid ? group.getObjectByProperty('uuid', primaryUuid) : null;
		if (primary) {
			primary.updateMatrixWorld(true);
			pivotDragStart = {
				pivotPos: controls.object.position.clone(),
				primaryBox: new THREE.Box3().setFromObject(primary),
				originOffset: originWorld(primary, new THREE.Vector3()).sub(controls.object.position)
			};
		}
	}
	const targets = get(snapTargets);
	if (!targets.enabled || !targets.object) return;
	if (!group) return;
	dragObjectPoints = [];
	for (const child of group.children) {
		if (dragExclude.some((uuid) => child.getObjectByProperty('uuid', uuid))) continue;
		dragObjectPoints.push(...objectSnapPoints(child));
	}
}

/** A drag ends: clear the candidate, the highlight and the caches. */
export function endSnapDrag() {
	dragActive = false;
	dragExclude = [];
	dragObjectPoints = null;
	pivotDragStart = null;
	pointerClient = null;
	// P4: deliberately NO restore here — a drag that ENDS on a live candidate
	// keeps its aligned pose (that is the feature); the move broadcast and the
	// transform history entry already carry the rotation.
	baseQuat = null;
	alignApplied = false;
	if (get(activeSnapCandidate)) activeSnapCandidate.set(null);
}

/** project a world point to CLIENT px, or null when behind the camera
 * @param {any} point @param {any} camera @param {DOMRect} rect */
function projectPx(point, camera, rect) {
	_proj.copy(point).project(camera);
	if (_proj.z > 1 || _proj.z < -1) return null;
	return [rect.left + ((_proj.x + 1) / 2) * rect.width, rect.top + ((1 - _proj.y) / 2) * rect.height];
}

/** one triangle corner in WORLD space @param {any} mesh @param {number} triIndex @param {number} corner */
function triCornerWorld(mesh, triIndex, corner) {
	const geometry = mesh.geometry;
	const position = geometry?.attributes?.position;
	if (!position) return null;
	const at = triIndex * 3 + corner;
	const index = geometry.index ? geometry.index.getX(at) : at;
	if (index >= position.count) return null;
	return _corner.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld).clone();
}

/** the DISCRETE logical-face candidate for a hit: the stored-topology face
 * containing the hit triangle (readStoredFaces) when one exists, else the hit
 * triangle itself — centroid + the triangle list it was measured over (P4: the
 * face tint draws exactly those triangles, so it must not re-derive them).
 * @param {any} mesh @param {number} faceIndex
 * @returns {{centroid: any, tris: number[]}|null} */
function faceCentroid(mesh, faceIndex) {
	const faces = readStoredFaces(mesh.geometry);
	const tris = faces?.find((/** @type {number[]} */ f) => f.includes(faceIndex)) ?? [faceIndex];
	const centroid = new THREE.Vector3();
	let count = 0;
	for (const tri of tris) {
		for (let corner = 0; corner < 3; corner++) {
			const point = triCornerWorld(mesh, tri, corner);
			if (!point) continue;
			centroid.add(point);
			count++;
		}
	}
	if (!count) return null;
	return { centroid: centroid.divideScalar(count), tris };
}

/**
 * Pick the best candidate: screen-px distance plus a type bias (an exact-point
 * target beats the continuous surface at equal distance), rejected outside
 * radiusPx. PURE — the e2e suite drives it headlessly with synthetic lists.
 * @param {{type: string, px: number[]|null}[]} list
 * @param {number[]} cursorPx @param {number} radiusPx
 */
export function scoreCandidates(list, cursorPx, radiusPx) {
	/** @type {Record<string, number>} */
	const BIAS = { vertex: -8, edge: -5, face: -3, object: -3, surface: 0 };
	let best = null;
	let bestScore = Infinity;
	for (const candidate of list) {
		if (!candidate?.px) continue;
		const dist = Math.hypot(candidate.px[0] - cursorPx[0], candidate.px[1] - cursorPx[1]);
		if (dist > radiusPx) continue;
		const score = dist + (BIAS[candidate.type] ?? 0);
		// strict less-than: the first of two equal scores wins (stable build order)
		if (score < bestScore) {
			bestScore = score;
			best = candidate;
		}
	}
	return best;
}

/**
 * One candidate search: cursor ray first, anchor-projection fallback when it
 * misses. Writes `activeSnapCandidate` (null on no result) and returns it.
 * @param {any} camera @param {number[]|null} pointerNdc normalized device coords, or null
 * @param {string[]} excludeUuids
 */
export function findSnapCandidate(camera, pointerNdc, excludeUuids) {
	const targets = get(snapTargets);
	/** @type {any} */
	const renderer = get(globalRenderer);
	const rect = renderer?.domElement?.getBoundingClientRect?.();
	if (!camera || !rect) {
		activeSnapCandidate.set(null);
		return null;
	}
	let hits = [];
	let referencePx = null;
	if (pointerNdc) {
		_ndc.set(pointerNdc[0], pointerNdc[1]);
		_raycaster.setFromCamera(_ndc, camera);
		hits = sceneHits(_raycaster, { excludeUuids });
		referencePx = [
			rect.left + ((pointerNdc[0] + 1) / 2) * rect.width,
			rect.top + ((1 - pointerNdc[1]) / 2) * rect.height
		];
	}
	if (!hits.length) {
		// ONE fallback ray through the dragged object's own projected point — the
		// cursor rides the gizmo handle on an axis drag and can miss the scene
		const group = get(objectsGroup);
		const primary = excludeUuids?.length
			? group?.getObjectByProperty('uuid', excludeUuids[0])
			: null;
		if (primary) {
			const anchorPx = projectPx(originWorld(primary, _world), camera, rect);
			if (anchorPx) {
				_ndc.set(
					((anchorPx[0] - rect.left) / rect.width) * 2 - 1,
					-((anchorPx[1] - rect.top) / rect.height) * 2 + 1
				);
				_raycaster.setFromCamera(_ndc, camera);
				hits = sceneHits(_raycaster, { excludeUuids });
				referencePx = anchorPx;
			}
		}
	}
	const hit = hits[0];
	if (!hit || !referencePx) {
		activeSnapCandidate.set(null);
		return null;
	}
	const uuid = topLevelUuidOf(hit.object);
	const normal = hitWorldNormal(hit);
	const candidates = [];
	if (targets.surface) {
		candidates.push({
			type: 'surface',
			point: hit.point.clone(),
			normal,
			uuid,
			faceIndex: hit.faceIndex ?? null,
			px: projectPx(hit.point, camera, rect)
		});
	}
	if (targets.face && hit.faceIndex != null && hit.object?.isMesh) {
		const face = faceCentroid(hit.object, hit.faceIndex);
		if (face)
			candidates.push({
				type: 'face',
				point: face.centroid,
				normal,
				uuid,
				faceIndex: hit.faceIndex,
				// P4, PRIVATE: the tint's source. `uuid` is the TOP-LEVEL object, so
				// the hit mesh (which may be nested) cannot be re-found from it.
				__mesh: hit.object,
				__tris: face.tris,
				px: projectPx(face.centroid, camera, rect)
			});
	}
	if (targets.vertex && hit.faceIndex != null && hit.object?.isMesh) {
		// the hit triangle's corners — the corner position IS the welded position,
		// so no whole-mesh welded map is needed; every vertex becomes reachable as
		// the hovered triangle changes
		for (let corner = 0; corner < 3; corner++) {
			const point = triCornerWorld(hit.object, hit.faceIndex, corner);
			if (!point) continue;
			candidates.push({
				type: 'vertex',
				point,
				normal,
				uuid,
				faceIndex: hit.faceIndex,
				px: projectPx(point, camera, rect)
			});
		}
	}
	if (targets.object && dragObjectPoints) {
		for (const entry of dragObjectPoints) {
			candidates.push({
				type: 'object',
				point: entry.point,
				normal: null,
				uuid: entry.uuid,
				px: projectPx(entry.point, camera, rect)
			});
		}
	}
	const best = scoreCandidates(candidates, referencePx, targets.radiusPx);
	activeSnapCandidate.set(best ?? null);
	return best;
}

/**
 * The anchor: where on the dragged object the candidate should land.
 * A PICKED anchor (P3) wins: the stored local point on its object, followed
 * live through matrixWorld. Otherwise the preference: 'auto' (default) is the
 * candidate point CLAMPED to the object's world Box3 — the nearest point on
 * the box toward the target; the search is cursor-based and
 * anchor-independent, so this is not circular: computed once per frame from
 * the proposed pose, it converges. 'pivot': the object's own origin.
 * @param {any} object @param {any} candidate @returns {any} THREE.Vector3
 */
export function anchorWorldPoint(object, candidate) {
	const anchor = get(snapAnchor);
	if (anchor.mode === 'picked' && anchor.uuid && anchor.local) {
		const picked =
			object?.uuid === anchor.uuid
				? object
				: get(objectsGroup)?.getObjectByProperty('uuid', anchor.uuid);
		if (picked) {
			picked.updateMatrixWorld(true);
			return _anchor.fromArray(anchor.local).applyMatrix4(picked.matrixWorld);
		}
	}
	const targets = get(snapTargets);
	if (targets.anchorMode === 'pivot') return originWorld(object, _anchor.set(0, 0, 0));
	_box.setFromObject(object);
	if (_box.isEmpty()) return object.getWorldPosition(_anchor);
	return _box.clampPoint(candidate.point, _anchor);
}

/**
 * P4: rotate the drag target so its +Y maps onto the candidate normal, gated on
 * `snapTargets.alignNormal`. IDEMPOTENT — always `align × baseQuat`, never a
 * multiply into the live quaternion, so any number of frames on one candidate
 * gives the same pose. A candidate without a normal (vertex/object targets) or
 * no candidate at all restores baseQuat, because a translate drag rewrites only
 * the position and would otherwise leave the rotation stranded.
 * @param {any} target @param {any} candidate the live candidate, or null
 */
function applyAlignToNormal(target, candidate) {
	if (!target) return;
	const normal = get(snapTargets).alignNormal ? candidate?.normal : null;
	if (!normal) {
		if (alignApplied && baseQuat) {
			target.quaternion.copy(baseQuat);
			target.updateMatrixWorld(true);
		}
		alignApplied = false;
		return;
	}
	if (!baseQuat) return;
	_alignNormal.copy(normal);
	if (_alignNormal.lengthSq() < 1e-12) return;
	_alignNormal.normalize();
	_alignQuat.setFromUnitVectors(_alignUp, _alignNormal);
	target.quaternion.copy(_alignQuat).multiply(baseQuat);
	target.updateMatrixWorld(true);
	alignApplied = true;
}

/**
 * World-shift the PROPOSED gizmo pose so the anchor lands on the live
 * candidate (parent-frame corrected, the dropToSurface idiom).
 * @param {any} target the object the gizmo drives (the object itself, or the pivot)
 * @param {any} primaryObject the object the anchor is evaluated on
 * @returns {boolean} whether a candidate was applied
 */
export function applyElementSnap(target, primaryObject) {
	const candidate = get(activeSnapCandidate);
	if (!candidate || !target?.parent) {
		applyAlignToNormal(target, null);
		return false;
	}
	// rotation FIRST: the 'auto' anchor clamps to the object's world box, which
	// the alignment reshapes — anchoring on the pre-rotation box would aim at a
	// point the object no longer has there
	applyAlignToNormal(target, candidate);
	const anchor = anchorWorldPoint(primaryObject, candidate);
	_delta.copy(candidate.point).sub(anchor);
	if (_delta.lengthSq() < 1e-14) return true; // already there — still snapped
	target.getWorldPosition(_world).add(_delta);
	target.parent.updateMatrixWorld(true);
	target.position.copy(target.parent.worldToLocal(_world));
	target.updateMatrixWorld(true);
	return true;
}

/** the shared drag gates: an active translate drag with element snapping on */
function snapGatesOpen() {
	if (!dragActive) return false;
	const targets = get(snapTargets);
	if (!targets.enabled) return false;
	if (!(targets.vertex || targets.edge || targets.face || targets.surface || targets.object))
		return false;
	/** @type {any} */
	const controls = get(TControls);
	if (!controls?.dragging || controls.mode !== 'translate') return false;
	return true;
}

/** run the throttled search — the last candidate holds between searches */
function runThrottledSearch() {
	const camera = get(globalCamera);
	if (!camera) return;
	const now = performance.now();
	if (now - lastSearchAt < SEARCH_INTERVAL_MS) return;
	lastSearchAt = now;
	/** @type {any} */
	const renderer = get(globalRenderer);
	const rect = renderer?.domElement?.getBoundingClientRect?.();
	let ndc = null;
	if (pointerClient && rect?.width && rect?.height) {
		ndc = [
			((pointerClient[0] - rect.left) / rect.width) * 2 - 1,
			-((pointerClient[1] - rect.top) / rect.height) * 2 + 1
		];
	}
	findSnapCandidate(camera, ndc, dragExclude);
}

/**
 * The Scene plain-branch hook: search + apply, every objectChange of a
 * translate drag. Returns true when the pose was element-snapped this frame,
 * so the caller skips dropToSurface (they would fight over Y).
 * @param {any} object the gizmo's plain object
 * @returns {boolean}
 */
export function maybeSnapGizmo(object) {
	if (!object || !snapGatesOpen()) return false;
	runThrottledSearch();
	return applyElementSnap(object, object);
}

const _boxProposed = new THREE.Box3();
const _pivotShift = new THREE.Vector3();

/**
 * The multiTransform hook (P3, registered through the seam — see the module
 * header): adjust the PIVOT before the member delta is computed, so the set
 * re-derives from the snapped pose the same frame. The anchor is evaluated in
 * the PIVOT's frame — the members still sit at LAST frame's pose here, so an
 * anchor read off the primary's live matrix double-counts the pivot's own
 * offset. A picked anchor IS the pivot (it is seated on the picked point and
 * rides rigidly); 'pivot' mode is the primary's origin at its drag-start
 * offset from the pivot; 'auto' clamps to the primary's box TRANSLATED by the
 * pivot's delta (a translate drag only translates it).
 * @param {any} pivot @param {any} primary
 */
function adjustPivotForSnap(pivot, primary) {
	if (!pivot || !primary || !snapGatesOpen()) return;
	runThrottledSearch();
	const candidate = get(activeSnapCandidate);
	if (!candidate || !pivot.parent) {
		applyAlignToNormal(pivot, null);
		return;
	}
	// P4: the PIVOT takes the alignment — the members re-derive their own
	// rotation about it through deltaMatrix, which is what makes a set turn
	// together instead of each object spinning in place
	applyAlignToNormal(pivot, candidate);
	const anchor = get(snapAnchor);
	const targets = get(snapTargets);
	if (anchor.mode === 'picked' && anchor.uuid && anchor.local) {
		_anchor.copy(pivot.position);
	} else if (targets.anchorMode === 'pivot' && pivotDragStart) {
		_anchor.copy(pivot.position).add(pivotDragStart.originOffset);
	} else if (pivotDragStart) {
		_pivotShift.copy(pivot.position).sub(pivotDragStart.pivotPos);
		_boxProposed.copy(pivotDragStart.primaryBox).translate(_pivotShift);
		_boxProposed.clampPoint(candidate.point, _anchor);
	} else {
		_anchor.copy(pivot.position);
	}
	_delta.copy(candidate.point).sub(_anchor);
	if (_delta.lengthSq() < 1e-14) return;
	pivot.getWorldPosition(_world).add(_delta);
	pivot.parent.updateMatrixWorld(true);
	pivot.position.copy(pivot.parent.worldToLocal(_world));
	pivot.updateMatrixWorld(true);
}

// ---- candidate highlight ----------------------------------------------------
// A scene-root marker (never inside objectsGroup — it must not enter GLTF sync):
// an accent dot for every candidate, plus a short normal tick for face/surface
// so align-to-normal has visible meaning. Rebuilt on candidate CHANGE (search
// cadence, not per frame); the dot is sized by camera distance at rebuild so it
// stays readable at any zoom.

function ensureMarker() {
	if (marker) return marker;
	const scene = get(globalScene);
	if (!scene) return null;
	marker = new THREE.Group();
	marker.name = MARKER_NAME;
	markerDot = new THREE.Mesh(
		new THREE.SphereGeometry(1, 12, 8),
		new THREE.MeshBasicMaterial({ color: MARKER_COLOR, depthTest: false, transparent: true, opacity: 0.9 })
	);
	markerDot.renderOrder = 999;
	const tickGeometry = new THREE.BufferGeometry().setFromPoints([
		new THREE.Vector3(0, 0, 0),
		new THREE.Vector3(0, 1, 0)
	]);
	markerTick = new THREE.Line(
		tickGeometry,
		new THREE.LineBasicMaterial({ color: MARKER_COLOR, depthTest: false, transparent: true, opacity: 0.9 })
	);
	markerTick.renderOrder = 999;
	marker.add(markerDot);
	marker.add(markerTick);
	marker.visible = false;
	scene.add(marker);
	return marker;
}

/** P4: the face TINT — a scene-root overlay mesh over the logical face's own
 * triangles (the face-edit-hover pattern), so a Face candidate shows WHICH face
 * it means instead of one dot in the middle of it. `depthWrite: false` is the
 * face-overlay convention: it loses the postprocessing passes (the documented
 * trap), which is the right trade for a transient drag overlay. */
function ensureFaceTint() {
	if (faceTint) return faceTint;
	const scene = get(globalScene);
	if (!scene) return null;
	faceTint = new THREE.Mesh(
		new THREE.BufferGeometry(),
		new THREE.MeshBasicMaterial({
			color: MARKER_COLOR,
			transparent: true,
			opacity: 0.35,
			depthTest: false,
			depthWrite: false,
			side: THREE.DoubleSide
		})
	);
	faceTint.name = FACE_TINT_NAME;
	faceTint.renderOrder = 998;
	faceTint.frustumCulled = false; // world-space verts, no meaningful local bounds
	faceTint.visible = false;
	scene.add(faceTint);
	return faceTint;
}

/** Rebuild the tint from the candidate's own triangles, in WORLD space. Runs on
 * candidate CHANGE (the search cadence), never per frame. @param {any} candidate */
function updateFaceTint(candidate) {
	if (!candidate || candidate.type !== 'face' || !candidate.__mesh || !candidate.__tris?.length) {
		if (faceTint) faceTint.visible = false;
		return;
	}
	/** @type {number[]} */
	const positions = [];
	for (const tri of candidate.__tris) {
		/** @type {number[]} */
		const corners = [];
		for (let corner = 0; corner < 3; corner++) {
			const point = triCornerWorld(candidate.__mesh, tri, corner);
			if (!point) break;
			corners.push(point.x, point.y, point.z);
		}
		if (corners.length === 9) positions.push(...corners); // whole triangles only
	}
	const tint = ensureFaceTint();
	if (!tint) return;
	if (positions.length < 9) {
		tint.visible = false;
		return;
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	const previous = tint.geometry;
	tint.geometry = geometry;
	previous?.dispose?.();
	tint.visible = true;
}

const _tickQuat = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** @param {any} candidate */
function updateMarker(candidate) {
	updateFaceTint(candidate);
	if (!candidate) {
		if (marker) marker.visible = false;
		return;
	}
	const group = ensureMarker();
	if (!group) return;
	group.visible = true;
	group.position.copy(candidate.point);
	const camera = get(globalCamera);
	const distance = camera ? camera.getWorldPosition(_world).distanceTo(candidate.point) : 10;
	markerDot.scale.setScalar(Math.max(distance * 0.006, 0.01));
	if (candidate.normal && (candidate.type === 'face' || candidate.type === 'surface')) {
		markerTick.visible = true;
		_tickQuat.setFromUnitVectors(_up, candidate.normal);
		markerTick.quaternion.copy(_tickQuat);
		markerTick.scale.setScalar(Math.max(distance * 0.03, 0.05));
	} else {
		markerTick.visible = false;
	}
}

// ---- the snap anchor (P3) ---------------------------------------------------

/**
 * Arm pick mode from the UI. Deliberately always offered — the toast explains
 * when the selection does not fit (the meshEdit "always offered, toast when
 * nothing is picked" rule) — but it needs exactly one selected object, because
 * the anchor is a point ON the thing that drags.
 * @returns {boolean}
 */
export function startSnapAnchorPick() {
	const selection = get(selectedObjects);
	if (selection.length !== 1) {
		showToast('Select exactly one object to pick its snap origin');
		return false;
	}
	snapAnchorPicking.set(true);
	showToast('Click a point on the selected object — a nearby vertex wins (Esc cancels)');
	return true;
}

/**
 * The one-click Scene intercept (the measureClick shape): raycast ONLY the
 * selected object's subtree; the nearest hit-triangle corner within ~14px
 * becomes a VERTEX anchor (the corner's position IS the welded position),
 * anything else a FACE anchor at the exact local hit point. Re-seats the
 * gizmo there through setTransientPivot — pivotOnly stays false, so nothing
 * can reach userData.origin. A miss exits pick mode (the measure/knife idiom).
 * @param {any} raycaster already aimed @param {number[]} [clientPx] the click, CSS px
 * @returns {boolean} whether an anchor was picked
 */
export function snapAnchorClick(raycaster, clientPx) {
	snapAnchorPicking.set(false);
	const selection = get(selectedObjects);
	const uuid = selection[selection.length - 1];
	const object = uuid ? get(objectsGroup)?.getObjectByProperty('uuid', uuid) : null;
	if (!object) {
		showToast('Snap origin: no selected object (pick cancelled)');
		return false;
	}
	ensureBoundsTrees(object, []);
	const hit = raycaster.intersectObject(object, true)[0];
	if (!hit) {
		showToast('Snap origin: click landed off the object (pick cancelled)');
		return false;
	}
	let anchorWorld = hit.point.clone();
	let kind = 'face point';
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	const rect = renderer?.domElement?.getBoundingClientRect?.();
	if (hit.faceIndex != null && hit.object?.isMesh && camera && rect && clientPx) {
		let best = null;
		let bestDist = 14; // screen px — a corner within reach wins over the hit point
		for (let corner = 0; corner < 3; corner++) {
			const point = triCornerWorld(hit.object, hit.faceIndex, corner);
			if (!point) continue;
			const px = projectPx(point, camera, rect);
			if (!px) continue;
			const dist = Math.hypot(px[0] - clientPx[0], px[1] - clientPx[1]);
			if (dist < bestDist) {
				bestDist = dist;
				best = point;
			}
		}
		if (best) {
			anchorWorld = best;
			kind = 'vertex';
		}
	}
	// stored LOCAL to the selected TOP-LEVEL object — the thing that drags —
	// so the anchor rides every later move of it
	object.updateMatrixWorld(true);
	const local = anchorWorld.clone().applyMatrix4(object.matrixWorld.clone().invert());
	snapAnchor.set({ mode: 'picked', uuid: object.uuid, local: local.toArray() });
	setTransientPivot(anchorWorld);
	showToast(`Snap origin picked (${kind}) — drags snap this point; ✕ in Snapping clears it`);
	return true;
}

/** Drop the picked anchor: the gizmo re-seats through setTransientPivot(null),
 * which keeps pivotOnly and always leaves a gizmo attached. */
export function clearSnapAnchor() {
	snapAnchorPicking.set(false);
	if (get(snapAnchor).mode !== 'picked') return;
	snapAnchor.set({ mode: 'auto', uuid: null, local: null });
	setTransientPivot(null);
}

// ---- anchor viz ---------------------------------------------------------------
// A scene-root marker (sphere + 3-axis cross) at the picked anchor, followed
// per frame from Scene's useTask — scene-root markers don't follow for free
// (the tickMeshEdit lesson).

/** @type {any} */ let anchorMarker = null;
/** @type {any} */ let anchorDot = null;
const ANCHOR_COLOR = 0x59c8ff;

function ensureAnchorMarker() {
	if (anchorMarker) return anchorMarker;
	const scene = get(globalScene);
	if (!scene) return null;
	anchorMarker = new THREE.Group();
	anchorMarker.name = 'snap-anchor-marker';
	anchorDot = new THREE.Mesh(
		new THREE.SphereGeometry(1, 12, 8),
		new THREE.MeshBasicMaterial({ color: ANCHOR_COLOR, depthTest: false, transparent: true, opacity: 0.9 })
	);
	anchorDot.renderOrder = 999;
	const crossGeometry = new THREE.BufferGeometry().setFromPoints([
		new THREE.Vector3(-2.4, 0, 0),
		new THREE.Vector3(2.4, 0, 0),
		new THREE.Vector3(0, -2.4, 0),
		new THREE.Vector3(0, 2.4, 0),
		new THREE.Vector3(0, 0, -2.4),
		new THREE.Vector3(0, 0, 2.4)
	]);
	const cross = new THREE.LineSegments(
		crossGeometry,
		new THREE.LineBasicMaterial({ color: ANCHOR_COLOR, depthTest: false, transparent: true, opacity: 0.9 })
	);
	cross.renderOrder = 999;
	anchorDot.add(cross); // the cross rides the dot's camera-distance scale
	anchorMarker.add(anchorDot);
	anchorMarker.visible = false;
	scene.add(anchorMarker);
	return anchorMarker;
}

const _anchorFollow = new THREE.Vector3();

/** Per-frame follow (Scene's useTask): the marker sits on the picked anchor. */
export function updateSnapAnchor() {
	const anchor = get(snapAnchor);
	if (anchor.mode !== 'picked' || !anchor.uuid || !anchor.local) {
		if (anchorMarker) anchorMarker.visible = false;
		return;
	}
	const object = get(objectsGroup)?.getObjectByProperty('uuid', anchor.uuid);
	if (!object) {
		if (anchorMarker) anchorMarker.visible = false;
		return;
	}
	const marker = ensureAnchorMarker();
	if (!marker) return;
	marker.visible = true;
	marker.position.fromArray(anchor.local).applyMatrix4(object.matrixWorld);
	const camera = get(globalCamera);
	const distance = camera ? camera.getWorldPosition(_anchorFollow).distanceTo(marker.position) : 10;
	anchorDot.scale.setScalar(Math.max(distance * 0.005, 0.01));
}

// ---- lifecycle ----------------------------------------------------------------

/** @type {string|null} */ let lastPrimaryUuid = null;

/** @param {KeyboardEvent} event */
function onSnapKeydown(event) {
	if (event.key !== 'Escape' || !get(snapAnchorPicking)) return;
	// direct CAPTURE listener: panel chrome swallows delegated/bubbled keys
	event.preventDefault();
	event.stopPropagation();
	snapAnchorPicking.set(false);
	showToast('Snap origin pick cancelled');
}

/** Wire the engine once (Scene onMount): the candidate marker, the anchor
 * lifecycle (cleared on primary-selection change — never persisted per
 * object), Esc for pick mode, and the multiTransform pivot adjuster. */
export function startSnapEngine() {
	if (started || typeof window === 'undefined') return;
	started = true;
	activeSnapCandidate.subscribe(updateMarker);
	registerPivotSnapAdjuster(adjustPivotForSnap);
	window.addEventListener('keydown', onSnapKeydown, true);
	selectedObjects.subscribe((uuids) => {
		const primary = uuids?.length ? uuids[uuids.length - 1] : null;
		if (primary === lastPrimaryUuid) return;
		lastPrimaryUuid = primary;
		// the anchor is a per-pick aid: a new primary drops it (the transient
		// pivot itself is cleared by attachMultiPivot's fresh-selection branch)
		if (get(snapAnchor).mode === 'picked') snapAnchor.set({ mode: 'auto', uuid: null, local: null });
		if (get(snapAnchorPicking)) snapAnchorPicking.set(false);
	});
}
