import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, objectsGroup, TControls, selectedObjects } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordTransformSet } from './history';
import { suspendAnimation, resumeAnimation } from './flowRuntime';

// Multi-select transforms (phase 13). TransformControls drives ONE object, so
// a hidden pivot Group sits at the selection centroid and the gizmo attaches
// to it. Members are NEVER reparented — while the pivot moves, their world
// matrices are recomputed from the pivot's delta every objectChange. That
// keeps them in objectsGroup the whole time (object list, sync and raycasts
// stay untouched). Drag end broadcasts one final move and records one history
// entry per member (`transformSet` batch — same kind physics restore uses).

const PIVOT_NAME = 'multi-select-pivot';

/** @type {any} */ let pivot = null;
/** @type {any[]} */ let dragMembers = [];
/** @type {any} */ let pivotStartInverse = null;
let lastLiveSend = 0;

export function multiPivot() {
	return pivot;
}

/** Place (or replace) the pivot for the current selection set @param {string[]} uuids */
export function attachMultiPivot(uuids) {
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
	pivot.position.copy(centroid);
	scene.add(pivot);
	controls.attach(pivot);
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
}

function onDraggingChanged(/** @type {any} */ event) {
	/** @type {any} */
	const controls = get(TControls);
	const object = controls?.object;
	if (!object?.userData?.isMultiPivot) return;
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
	if (!object?.userData?.isMultiPivot || !pivotStartInverse || !dragMembers.length) return;
	pivot.updateMatrixWorld(true);
	deltaMatrix.multiplyMatrices(pivot.matrixWorld, pivotStartInverse);
	for (const entry of dragMembers) {
		memberWorld.multiplyMatrices(deltaMatrix, entry.startWorld);
		entry.object.parent.updateMatrixWorld(true);
		parentInverse.copy(entry.object.parent.matrixWorld).invert();
		memberWorld.premultiply(parentInverse);
		memberWorld.decompose(entry.object.position, entry.object.quaternion, entry.object.scale);
	}
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
