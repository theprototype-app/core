// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { globalScene, globalCamera, globalRenderer, objectsGroup, TControls } from '../stores/sceneStore';
import { snapTargets } from './snapping';
import { sceneHits, hitWorldNormal } from './scenePick';
import { originWorld } from './objectOrigin';
import { readStoredFaces } from './meshTopology';

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

// ---- module state (declared above every subscriber — the TDZ rule) ---------
/** @type {number[]|null} last pointer position in CLIENT px (tracked by Scene while dragging) */
let pointerClient = null;
let lastSearchAt = 0;
/** @type {string[]} the dragged subtree, excluded from every search */
let dragExclude = [];
/** @type {{point: any, uuid: string}[]|null} object-target points cached at drag start */
let dragObjectPoints = null;
let dragActive = false;
/** @type {any} scene-root candidate marker group */
let marker = null;
/** @type {any} */ let markerDot = null;
/** @type {any} */ let markerTick = null;
let started = false;

const SEARCH_INTERVAL_MS = 33;
const MARKER_NAME = 'snap-candidate-marker';
const MARKER_COLOR = 0xffa02e;

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _proj = new THREE.Vector3();
const _box = new THREE.Box3();
const _anchor = new THREE.Vector3();
const _world = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _corner = new THREE.Vector3();

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
	dragActive = true;
	dragExclude = excludeUuids ?? [];
	dragObjectPoints = null;
	lastSearchAt = 0;
	const targets = get(snapTargets);
	if (!targets.enabled || !targets.object) return;
	const group = get(objectsGroup);
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
	pointerClient = null;
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
 * triangle itself — centroid + plane normal.
 * @param {any} mesh @param {number} faceIndex @param {any} hit */
function faceCentroid(mesh, faceIndex, hit) {
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
	return centroid.divideScalar(count);
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
		const centroid = faceCentroid(hit.object, hit.faceIndex, hit);
		if (centroid)
			candidates.push({
				type: 'face',
				point: centroid,
				normal,
				uuid,
				faceIndex: hit.faceIndex,
				px: projectPx(centroid, camera, rect)
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
 * 'auto' (default): the candidate point CLAMPED to the object's world Box3 —
 * the nearest point on the box toward the target. The search is cursor-based
 * and anchor-independent, so this is not circular: computed once per frame
 * from the proposed pose, it converges. 'pivot': the object's own origin.
 * @param {any} object @param {any} candidate @returns {any} THREE.Vector3
 */
export function anchorWorldPoint(object, candidate) {
	const targets = get(snapTargets);
	if (targets.anchorMode === 'pivot') return originWorld(object, _anchor.set(0, 0, 0));
	_box.setFromObject(object);
	if (_box.isEmpty()) return object.getWorldPosition(_anchor);
	return _box.clampPoint(candidate.point, _anchor);
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
	if (!candidate || !target?.parent) return false;
	const anchor = anchorWorldPoint(primaryObject, candidate);
	_delta.copy(candidate.point).sub(anchor);
	if (_delta.lengthSq() < 1e-14) return true; // already there — still snapped
	target.getWorldPosition(_world).add(_delta);
	target.parent.updateMatrixWorld(true);
	target.position.copy(target.parent.worldToLocal(_world));
	target.updateMatrixWorld(true);
	return true;
}

/**
 * The Scene plain-branch hook: search (throttled — the last candidate holds
 * between searches) and apply, every objectChange of a translate drag.
 * Returns true when the pose was element-snapped this frame, so the caller
 * skips dropToSurface (they would fight over Y).
 * @param {any} object the gizmo's plain object
 * @returns {boolean}
 */
export function maybeSnapGizmo(object) {
	if (!dragActive || !object) return false;
	const targets = get(snapTargets);
	if (!targets.enabled) return false;
	if (!(targets.vertex || targets.edge || targets.face || targets.surface || targets.object))
		return false;
	/** @type {any} */
	const controls = get(TControls);
	if (!controls?.dragging || controls.mode !== 'translate') return false;
	const camera = get(globalCamera);
	if (!camera) return false;
	const now = performance.now();
	if (now - lastSearchAt >= SEARCH_INTERVAL_MS) {
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
	return applyElementSnap(object, object);
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

const _tickQuat = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** @param {any} candidate */
function updateMarker(candidate) {
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

/** Wire the engine once (Scene onMount): the marker follows the candidate. */
export function startSnapEngine() {
	if (started || typeof window === 'undefined') return;
	started = true;
	activeSnapCandidate.subscribe(updateMarker);
}
