import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { globalScene, objectsGroup, TControls, selectedObjects } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordTransformSet } from './history';
import { suspendAnimation, resumeAnimation } from './flowRuntime';
// physics is reached DYNAMICALLY: a static import would close the cycle
// multiTransform -> physics -> lockControl -> objectActions -> multiTransform
// (the vite-dev TDZ trap; Rollup tolerates it, the dev server 500s)

// Multi-select transforms (phase 13). TransformControls drives ONE object, so
// a hidden pivot Group sits at the selection centroid and the gizmo attaches
// to it. Members are NEVER reparented — while the pivot moves, their world
// matrices are recomputed from the pivot's delta every objectChange. That
// keeps them in objectsGroup the whole time (object list, sync and raycasts
// stay untouched). Drag end broadcasts one final move and records one history
// entry per member (`transformSet` batch — same kind physics restore uses).

// 17-D1 follow-up: the pivot is also the selection's ORIGIN, and the properties
// panel drives it. Two things ride on that:
//  * the panel's Transform rows show the PIVOT for a multi-selection (one
//    well-defined number instead of a dash per axis) and edits move the set as a
//    rigid body — the same delta math a gizmo drag uses, so typing can never
//    collapse a selection onto one plane the way an absolute per-object write did.
//  * "Move origin" mode (`pivotOnly`) re-points the gizmo WITHOUT moving objects,
//    so the next rotate/scale happens about the place the user chose. That is a
//    local editing aid: it is neither replicated nor undoable, exactly like the
//    gizmo's own position.
const PIVOT_NAME = 'multi-select-pivot';

/** @type {any} */ let pivot = null;
/** @type {any[]} */ let dragMembers = [];
/** @type {any} */ let pivotStartInverse = null;
let lastLiveSend = 0;
/** @type {any} */ let customOrigin = null; // user-placed origin; null = centroid

/** "Move origin" mode: the gizmo and the panel's rows move the PIVOT only */
export const pivotOnly = writable(false);
/** the live pivot pose for the panel to render: {pos, rot, scale} | null */
/** @type {import('svelte/store').Writable<any>} */
export const pivotPose = writable(null);

export function multiPivot() {
	return pivot;
}

/** whether the origin was placed by hand (so a re-seat must not recentre it) */
export function hasCustomOrigin() {
	return !!customOrigin;
}

function publishPivotPose() {
	pivotPose.set(
		pivot
			? {
					pos: pivot.position.toArray(),
					rot: [pivot.rotation.x, pivot.rotation.y, pivot.rotation.z],
					scale: pivot.scale.toArray()
				}
			: null
	);
}

/** Place the origin by hand (panel rows / gizmo in origin mode) @param {number[]} pos */
export function setPivotOrigin(pos) {
	if (!pivot) return;
	pivot.position.fromArray(pos);
	customOrigin = pivot.position.clone();
	publishPivotPose();
}

/** Back to the selection centroid */
export function resetPivotOrigin() {
	customOrigin = null;
	attachMultiPivot(get(selectedObjects));
}

/**
 * Move/rotate/scale the whole selection about the pivot, from OUTSIDE a gizmo
 * drag (the panel's numeric rows). `mutate` receives the pivot; every member is
 * then re-derived from the pivot's delta exactly as `onObjectChange` does, and
 * each one's `move` is broadcast. History is the caller's business — the panel
 * seals one `transformSet` per gesture.
 * @param {(pivot: any) => void} mutate
 * @returns {boolean} whether anything moved
 */
export function applyPivotTransform(mutate) {
	const group = get(objectsGroup);
	const members = get(selectedObjects)
		.map((uuid) => group?.getObjectByProperty('uuid', uuid))
		.filter(Boolean);
	if (!pivot || members.length < 2) return false;
	pivot.updateMatrixWorld(true);
	const startInverse = pivot.matrixWorld.clone().invert();
	const starts = members.map((member) => {
		member.updateMatrixWorld(true);
		return { object: member, startWorld: member.matrixWorld.clone() };
	});
	mutate(pivot);
	pivot.updateMatrixWorld(true);
	const delta = new THREE.Matrix4().multiplyMatrices(pivot.matrixWorld, startInverse);
	/** @type {any} */
	const peer = get(peers);
	const world = new THREE.Matrix4();
	const inverse = new THREE.Matrix4();
	for (const entry of starts) {
		world.multiplyMatrices(delta, entry.startWorld);
		entry.object.parent.updateMatrixWorld(true);
		inverse.copy(entry.object.parent.matrixWorld).invert();
		world.premultiply(inverse);
		world.decompose(entry.object.position, entry.object.quaternion, entry.object.scale);
		if (peer)
			peer.send({
				type: 'move',
				uuid: entry.object.uuid,
				pos: entry.object.position.toArray(),
				rot: [entry.object.rotation.x, entry.object.rotation.y, entry.object.rotation.z],
				scale: entry.object.scale.toArray()
			});
	}
	// the origin travels with the set it just moved
	if (customOrigin) customOrigin.copy(pivot.position);
	publishPivotPose();
	objectsGroup.update((value) => value);
	return true;
}

/**
 * Place (or replace) the pivot for the current selection set.
 * @param {string[]} uuids
 * @param {boolean} [keepOrigin] re-seat WITHOUT recentring — the panel passes
 *   this after its own edits so a hand-placed origin (and one the user is
 *   working from) survives; a fresh SELECTION always recentres and clears both
 *   the custom origin and origin mode, so neither lingers invisibly.
 */
export function attachMultiPivot(uuids, keepOrigin = false) {
	if (!keepOrigin) {
		customOrigin = null;
		pivotOnly.set(false);
	}
	const scene = get(globalScene);
	const group = get(objectsGroup);
	/** @type {any} */
	const controls = get(TControls);
	if (!scene || !group || !controls) return null;
	releaseMultiPivot();
	const objects = uuids
		.map((uuid) => group.getObjectByProperty('uuid', uuid))
		.filter(Boolean);
	if (objects.length < 2) return null;
	pivot = new THREE.Group();
	pivot.name = PIVOT_NAME;
	pivot.userData.isMultiPivot = true;
	const centroid = new THREE.Vector3();
	const world = new THREE.Vector3();
	objects.forEach((object) => centroid.add(object.getWorldPosition(world)));
	centroid.divideScalar(objects.length);
	// a hand-placed origin outlives the re-seat that follows every panel edit
	pivot.position.copy(keepOrigin && customOrigin ? customOrigin : centroid);
	scene.add(pivot);
	controls.attach(pivot);
	publishPivotPose();
	return pivot;
}

/** Detach the gizmo from the pivot and drop it */
export function releaseMultiPivot() {
	if (!pivot) return;
	/** @type {any} */
	const controls = get(TControls);
	if (controls?.object === pivot) controls.detach();
	pivot.parent?.remove(pivot);
	pivot = null;
	dragMembers = [];
	pivotStartInverse = null;
	pivotPose.set(null);
}

function onDraggingChanged(/** @type {any} */ event) {
	/** @type {any} */
	const controls = get(TControls);
	const object = controls?.object;
	if (!object?.userData?.isMultiPivot) return;
	// origin mode: the drag re-points the gizmo only — no members, no history
	if (get(pivotOnly)) {
		if (!event.value) {
			customOrigin = pivot.position.clone();
			publishPivotPose();
		}
		return;
	}
	const group = get(objectsGroup);
	if (event.value) {
		// capture start matrices; park animated members at their base first
		pivot.updateMatrixWorld(true);
		pivotStartInverse = pivot.matrixWorld.clone().invert();
		dragMembers = get(selectedObjects)
			.map((uuid) => group?.getObjectByProperty('uuid', uuid))
			.filter(Boolean)
			.map((member) => {
				suspendAnimation(member.uuid);
				// P-A: mid-sim, grabbed dynamic bodies follow the pivot kinematically
				import('./physics').then((m) => m.holdBody(member.uuid));
				member.updateMatrixWorld(true);
				return {
					object: member,
					startWorld: member.matrixWorld.clone(),
					before: {
						pos: member.position.toArray(),
						rot: member.rotation.toArray(),
						scale: member.scale.toArray()
					}
				};
			});
	} else if (dragMembers.length) {
		/** @type {any} */
		const peer = get(peers);
		const set = [];
		for (const entry of dragMembers) {
			resumeAnimation(entry.object.uuid);
			import('./physics').then((m) => m.releaseBody(entry.object.uuid));
			const after = {
				pos: entry.object.position.toArray(),
				rot: entry.object.rotation.toArray(),
				scale: entry.object.scale.toArray()
			};
			if (JSON.stringify(entry.before) !== JSON.stringify(after))
				set.push({ uuid: entry.object.uuid, before: entry.before, after });
			if (peer)
				peer.send({
					type: 'move',
					uuid: entry.object.uuid,
					pos: after.pos,
					rot: after.rot,
					scale: after.scale
				});
		}
		// one undo step restores every member (existing transformSet kind)
		recordTransformSet(set);
		dragMembers = [];
		pivotStartInverse = null;
		objectsGroup.update((value) => value);
	}
}

const deltaMatrix = new THREE.Matrix4();
const memberWorld = new THREE.Matrix4();
const parentInverse = new THREE.Matrix4();

function onObjectChange() {
	/** @type {any} */
	const controls = get(TControls);
	const object = controls?.object;
	if (!object?.userData?.isMultiPivot) return;
	// origin mode: keep the panel's rows following the gizmo, move nothing else
	if (get(pivotOnly)) {
		publishPivotPose();
		return;
	}
	if (!pivotStartInverse || !dragMembers.length) return;
	pivot.updateMatrixWorld(true);
	deltaMatrix.multiplyMatrices(pivot.matrixWorld, pivotStartInverse);
	for (const entry of dragMembers) {
		memberWorld.multiplyMatrices(deltaMatrix, entry.startWorld);
		entry.object.parent.updateMatrixWorld(true);
		parentInverse.copy(entry.object.parent.matrixWorld).invert();
		memberWorld.premultiply(parentInverse);
		memberWorld.decompose(entry.object.position, entry.object.quaternion, entry.object.scale);
	}
	publishPivotPose(); // the panel's origin rows follow the gizmo
	// live motion for peers, throttled
	const now = Date.now();
	if (now - lastLiveSend > 100) {
		lastLiveSend = now;
		/** @type {any} */
		const peer = get(peers);
		if (peer)
			for (const entry of dragMembers)
				peer.send({
					type: 'move',
					uuid: entry.object.uuid,
					pos: entry.object.position.toArray(),
					rot: entry.object.rotation.toArray(),
					scale: entry.object.scale.toArray()
				});
	}
}

/** @type {any} */
let hooked = null;
let started = false;

export function startMultiTransform() {
	if (started || typeof window === 'undefined') return;
	started = true;
	TControls.subscribe((controls) => {
		if (!controls || controls === hooked) return;
		hooked = controls;
		controls.addEventListener('dragging-changed', onDraggingChanged);
		controls.addEventListener('objectChange', onObjectChange);
	});
}
