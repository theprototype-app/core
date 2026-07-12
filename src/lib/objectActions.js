import * as THREE from 'three';
import { get } from 'svelte/store';
import { dropToSurface } from './snapping';
import { recordTransform, recordEntry, recordObjectPresence, registerHistoryKind } from './history';
import { suspendAnimation, resumeAnimation } from './flowRuntime';
import {
	objectsGroup,
	TControls,
	transformMode,
	selectedObject,
	selectedObjects,
	lockedObjects,
	globalCamera,
	orbitControls,
	isVRMode
} from '../stores/sceneStore';
import { attachMultiPivot, releaseMultiPivot } from './multiTransform';
import {
	peers,
	showSidebar,
	inspectorClose,
	inspectorKind,
	closeSelectionInspector,
	specatorMode,
	showToast,
	toggleExpand
} from '../stores/appStore';

// Shared object selection used by the object list, viewport clicks and VR rays.
// Mirrors the original Objects.svelte behavior: selecting an unlocked object
// attaches the gizmo and broadcasts a lock (peers replace this peer's previous
// lock, so switching selection moves the lock automatically). Multi-select
// (13): shift-click/marquee grow a set; the primary (last picked) stays in
// selectedObject so the inspector and every existing consumer keep working.

// member highlight: emissive tint, original colors restored on deselect
/** @type {Map<string, any>} */
const memberTints = new Map();

/** @param {any} group @param {string[]} uuids */
function applyMemberTints(group, uuids) {
	// restore objects that left the set
	for (const [uuid, original] of [...memberTints]) {
		if (uuids.includes(uuid)) continue;
		const object = group?.getObjectByProperty('uuid', uuid);
		object?.traverse((/** @type {any} */ node) => {
			if (node.material?.emissive && original[node.uuid] !== undefined)
				node.material.emissive.setHex(original[node.uuid]);
		});
		memberTints.delete(uuid);
	}
	// a lone selection keeps the plain gizmo look — tint only real sets
	if (uuids.length < 2) return;
	for (const uuid of uuids) {
		if (memberTints.has(uuid)) continue;
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) continue;
		/** @type {any} */
		const original = {};
		object.traverse((/** @type {any} */ node) => {
			if (node.material?.emissive) {
				original[node.uuid] = node.material.emissive.getHex();
				node.material.emissive.setHex(0x2a4d8f);
			}
		});
		memberTints.set(uuid, original);
	}
}

/** Make a uuid set the current selection. Primary = last entry.
 * @param {string[]} uuids @param {boolean=} openProperties */
export function applySelectionSet(uuids, openProperties = false) {
	const group = get(objectsGroup);
	/** @type {any} */
	const controls = get(TControls);
	/** @type {any} */
	const peer = get(peers);
	const locked = get(lockedObjects);
	// sets never contain peer-locked objects
	const clean = uuids.filter(
		(uuid) =>
			group?.getObjectByProperty('uuid', uuid) &&
			!locked.find((lockedUuid) => lockedUuid[1] === uuid)
	);
	applyMemberTints(group, clean);
	selectedObjects.set(clean);
	if (!clean.length) {
		releaseMultiPivot();
		if (controls && !get(isVRMode)) controls.detach();
		return;
	}
	const primary = group.getObjectByProperty('uuid', clean[clean.length - 1]);
	selectedObject.set(primary);
	if (controls && !get(isVRMode)) {
		if (clean.length === 1) {
			releaseMultiPivot();
			controls.attach(primary);
		} else {
			attachMultiPivot(clean);
		}
	}
	// one lock message covers the whole set (receivers replace this peer's set)
	if (peer) peer.send({ type: 'lock', uuid: clean[clean.length - 1], uuids: clean, peerId: peer.peer.id });
	if (openProperties || (!get(inspectorClose) && get(inspectorKind) === 'selection')) {
		showSidebar('properties');
	}
}

/** @param {string} uuid @param {boolean} openProperties @param {boolean=} additive - shift-click toggles set membership */
export function selectObject(uuid, openProperties = false, additive = false) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return;

	/** @type {any} */
	const controls = get(TControls);
	const locked = get(lockedObjects);
	const isLockedByPeer = !!locked.find((lockedUuid) => lockedUuid[1] === uuid);

	if (additive) {
		if (isLockedByPeer) return; // locked objects can't join a set
		const current = get(selectedObjects);
		const next = current.includes(uuid)
			? current.filter((entry) => entry !== uuid)
			: [...current, uuid];
		applySelectionSet(next, openProperties);
		return;
	}

	if (isLockedByPeer) {
		// keep the original locked-view behavior: show it, no gizmo, no lock
		releaseMultiPivot();
		applyMemberTints(group, []);
		selectedObjects.set([]);
		if (controls && !get(isVRMode)) controls.detach();
		selectedObject.set(object);
		if (openProperties || (!get(inspectorClose) && get(inspectorKind) === 'selection')) {
			showSidebar('properties');
		}
		return;
	}
	applySelectionSet([uuid], openProperties);
}

export function deselectObject() {
	/** @type {any} */
	const controls = get(TControls);
	releaseMultiPivot();
	applyMemberTints(get(objectsGroup), []);
	selectedObjects.set([]);
	if (controls && !get(isVRMode)) controls.detach();
	// selectedObject keeps the last object on purpose — the open inspector binds
	// to $selectedObject.position/material and would crash on an empty value
	closeSelectionInspector();
}

/**
 * Set the gizmo transform mode from the toolbar OR the 1/2/3 shortcuts through
 * ONE path (151), so the toolbar tint (transformMode store) always matches.
 * Pressing the ALREADY-active mode while a gizmo is attached = "done": deselect
 * + detach (a repeat press exits rather than being a no-op).
 * @param {'translate'|'rotate'|'scale'} mode
 */
export function setTransformMode(mode) {
	/** @type {any} */
	const controls = get(TControls);
	if (get(transformMode) === mode && controls?.object && !get(isVRMode)) {
		deselectObject();
		return;
	}
	controls?.setMode(mode);
	transformMode.set(mode);
}

/** Every selected uuid (the set, or the single selection) */
export function selectionUuids() {
	const set = get(selectedObjects);
	if (set.length) return [...set];
	const primary = get(selectedObject)?.uuid;
	return primary ? [primary] : [];
}

/** Delete the whole selection (context menu / Delete key) */
export function deleteSelection() {
	const uuids = selectionUuids();
	if (!uuids.length) return 0;
	deselectObject();
	/** @type {any} */
	const peer = get(peers);
	const group = get(objectsGroup);
	for (const uuid of uuids) {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) continue;
		recordObjectPresence('delete', object);
		object.parent?.remove(object);
		if (peer) peer.send({ type: 'delete', uuid, peerId: peer.peer.id });
	}
	objectsGroup.update((value) => value);
	return uuids.length;
}

/**
 * Walk an intersected mesh up to its top-level ancestor inside objectsGroup
 * @param {any} object
 */
export function topLevelObjectOf(object) {
	const group = get(objectsGroup);
	let current = object;
	while (current.parent && current.parent !== group) current = current.parent;
	return current.parent === group ? current : null;
}

/** Collect an object and all descendants in a stable depth-first order @param {any} object @param {any[]} list */
function collectTree(object, list = []) {
	list.push(object);
	object.children.forEach((/** @type {any} */ child) => collectTree(child, list));
	return list;
}

/** @param {any} clone - give cloned meshes their own materials and geometry (three's clone() shares both) */
function detachMaterials(clone) {
	collectTree(clone).forEach((node) => {
		if (node.material)
			node.material = Array.isArray(node.material)
				? node.material.map((/** @type {any} */ m) => m.clone())
				: node.material.clone();
		// own geometry so vertex edits on the copy don't deform the original
		if (node.geometry) node.geometry = node.geometry.clone();
	});
}

/**
 * Duplicate an object (Ctrl+D / context menu) and replicate the copy to peers.
 * Peers clone their own instance of the source, so no geometry re-export is needed.
 * @param {string=} uuid - defaults to the selected object
 */
export function duplicateObject(uuid) {
	const group = get(objectsGroup);
	const targetUuid = uuid ?? get(selectedObject)?.uuid;
	const source = targetUuid ? group?.getObjectByProperty('uuid', targetUuid) : null;
	if (!source) {
		showToast('Nothing selected to duplicate');
		return null;
	}
	const clone = source.clone(true);
	detachMaterials(clone);
	const cloneNodes = collectTree(clone);
	cloneNodes.forEach((node) => (node.uuid = crypto.randomUUID()));
	clone.name = (source.name || source.type) + ' copy';
	clone.position.x += 0.5;
	clone.position.z += 0.5;
	source.parent.add(clone);
	objectsGroup.update((value) => value);

	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'duplicate',
			sourceUuid: source.uuid,
			uuids: cloneNodes.map((node) => node.uuid),
			name: clone.name,
			pos: clone.position.toArray()
		});

	selectObject(clone.uuid);
	recordObjectPresence('create', clone);
	return clone;
}

/** Ctrl+D on a set: clone every member, the clones become the new selection */
export function duplicateSelection() {
	const uuids = selectionUuids();
	if (uuids.length <= 1) return duplicateObject(uuids[0]);
	const clones = uuids
		.map((uuid) => duplicateObject(uuid))
		.filter(Boolean)
		.map((clone) => clone.uuid);
	if (clones.length > 1) applySelectionSet(clones);
	return clones;
}

/**
 * Apply a duplicate made by a peer: clone the same source locally and assign
 * the uuids the originator generated (same depth-first order on both sides).
 * @param {string} sourceUuid @param {string[]} uuids @param {string} name @param {number[]} pos
 */
export function applyRemoteDuplicate(sourceUuid, uuids, name, pos) {
	const group = get(objectsGroup);
	const source = group?.getObjectByProperty('uuid', sourceUuid);
	if (!source) return;
	const clone = source.clone(true);
	detachMaterials(clone);
	collectTree(clone).forEach((node, index) => {
		if (uuids[index]) node.uuid = uuids[index];
	});
	clone.name = name;
	clone.position.fromArray(pos);
	source.parent.add(clone);
	objectsGroup.update((value) => value);
}

// name/visibility undo entries replay by setting the recorded value directly
registerHistoryKind('props', (entry, state) => {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', entry.uuid);
	if (!object) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	/** @type {any} */
	const peer = get(peers);
	if ('name' in state) {
		object.name = state.name;
		if (peer) peer.send({ type: 'name', uuid: entry.uuid, name: state.name });
	}
	if ('visible' in state) {
		object.visible = state.visible;
		if (peer)
			peer.send({ type: 'objectParameters', parameter: 'visible', uuid: entry.uuid, visible: state.visible });
	}
	objectsGroup.update((value) => value);
	return true;
});

// group moves replay through moveObjectToGroup (recordEntry no-ops during replay)
registerHistoryKind('group', (entry, state) => {
	const group = get(objectsGroup);
	if (!group?.getObjectByProperty('uuid', entry.uuid)) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	moveObjectToGroup(entry.uuid, state.parent);
	return true;
});

/** Toggle visibility and replicate (same message Properties uses) @param {string} uuid */
export function toggleObjectVisibility(uuid) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return;
	recordEntry({
		kind: 'props',
		uuid: uuid,
		before: { visible: object.visible },
		after: { visible: !object.visible }
	});
	object.visible = !object.visible;
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({ type: 'objectParameters', parameter: 'visible', uuid: uuid, visible: object.visible });
}

/** Rename an object and replicate @param {string} uuid @param {string} name */
export function renameObject(uuid, name) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !name) return;
	if (object.name !== name)
		recordEntry({ kind: 'props', uuid: uuid, before: { name: object.name }, after: { name: name } });
	object.name = name;
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'name', uuid: uuid, name: name });
}

/**
 * Move an object into a group ('up' = one level up, 'root' = all the way to
 * the scene root). Replicates through the existing `group` message; the root
 * case walks up one replicated hop at a time because the root group's uuid
 * differs per client.
 * @param {string} uuid @param {string} target - group uuid | 'up' | 'root'
 */
export function moveObjectToGroup(uuid, target) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return;
	/** @type {any} */
	const peer = get(peers);
	const fromParent = object.parent === group ? 'root' : object.parent?.uuid;

	if (target === 'root') {
		while (object.parent && object.parent !== group) {
			const destination = object.parent.parent;
			if (peer) peer.send({ type: 'group', uuid: uuid, group: 'up' });
			destination.attach(object);
		}
	} else if (target === 'up') {
		if (!object.parent || object.parent === group) return;
		toggleExpand.set(object.parent.uuid);
		if (peer) peer.send({ type: 'group', uuid: uuid, group: 'up' });
		object.parent.parent.attach(object);
	} else {
		const destination = group.getObjectByProperty('uuid', target);
		if (!destination || destination.type !== 'Group') return;
		if (destination.uuid === object.uuid || object.parent === destination) return;
		// never drop a group into its own descendant
		let ancestor = destination;
		while (ancestor) {
			if (ancestor === object) return;
			ancestor = ancestor.parent;
		}
		toggleExpand.set(destination.uuid);
		if (peer) peer.send({ type: 'group', uuid: uuid, group: destination.uuid });
		destination.attach(object);
	}
	const toParent = object.parent === group ? 'root' : object.parent?.uuid;
	if (fromParent !== toParent)
		recordEntry({ kind: 'group', uuid: uuid, before: { parent: fromParent }, after: { parent: toParent } });
	objectsGroup.update((value) => value);
}

/**
 * One-shot "Align to ground": drop the selected object onto the surface below,
 * replicate and record an undoable history entry.
 * @param {string=} uuid - defaults to the selected object
 */
export function alignToGround(uuid) {
	const group = get(objectsGroup);
	const targetUuid = uuid ?? get(selectedObject)?.uuid;
	const object = targetUuid ? group?.getObjectByProperty('uuid', targetUuid) : null;
	if (!object) {
		showToast('Nothing selected to align');
		return;
	}
	suspendAnimation(object.uuid); // park animated objects at their base first
	const before = {
		pos: object.position.toArray(),
		rot: object.rotation.toArray(),
		scale: object.scale.toArray()
	};
	if (!dropToSurface(object, group)) {
		resumeAnimation(object.uuid);
		return;
	}
	const after = {
		pos: object.position.toArray(),
		rot: object.rotation.toArray(),
		scale: object.scale.toArray()
	};
	recordTransform({ uuid: object.uuid, before: before, after: after });
	resumeAnimation(object.uuid); // dropped spot becomes the new animation base
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({ type: 'move', uuid: object.uuid, pos: after.pos, rot: after.rot, scale: after.scale });
}

let focusAnimation = 0;

/**
 * Smoothly move the editor camera (position + orbit target). Used by focus,
 * camera bookmarks and annotation jumps.
 * @param {number[] | THREE.Vector3} position @param {number[] | THREE.Vector3} target
 */
export function flyTo(position, target, duration = 400) {
	if (get(specatorMode) || get(isVRMode)) return;
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (!camera || !controls) return;

	const endPosition = Array.isArray(position) ? new THREE.Vector3().fromArray(position) : position.clone();
	const endTarget = Array.isArray(target) ? new THREE.Vector3().fromArray(target) : target.clone();
	const startPosition = camera.position.clone();
	const startTarget = controls.target.clone();

	const started = performance.now();
	const token = ++focusAnimation; // cancel a previous camera animation

	/** @param {number} now */
	function step(now) {
		if (token !== focusAnimation) return;
		const t = Math.min((now - started) / duration, 1);
		const ease = 1 - Math.pow(1 - t, 3);
		camera.position.lerpVectors(startPosition, endPosition, ease);
		controls.target.lerpVectors(startTarget, endTarget, ease);
		controls.update();
		if (t < 1) requestAnimationFrame(step);
	}
	requestAnimationFrame(step);
}

/**
 * Smoothly pan/zoom the editor camera to frame an object (F key).
 * @param {string=} uuid - defaults to the selected object
 */
export function focusObject(uuid) {
	if (get(specatorMode) || get(isVRMode)) return;
	const group = get(objectsGroup);
	// a multi-selection frames the union of every member's bounds
	const targets = uuid ? [uuid] : selectionUuids();
	const objects = targets
		.map((entry) => group?.getObjectByProperty('uuid', entry))
		.filter(Boolean);
	if (!objects.length) {
		showToast('Nothing selected to focus on');
		return;
	}
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (!camera || !controls) return;

	const box = new THREE.Box3();
	objects.forEach((object) => box.expandByObject(object));
	const center = box.getCenter(new THREE.Vector3());
	const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
	const fov = THREE.MathUtils.degToRad(camera.fov);
	const distance = THREE.MathUtils.clamp((radius / Math.tan(fov / 2)) * 1.2, 1, 200);

	// keep the current view direction: pan the target, dolly to framing distance
	const direction = camera.position.clone().sub(controls.target).normalize();
	const endPosition = center.clone().add(direction.multiplyScalar(distance));
	flyTo(endPosition, center);
}
