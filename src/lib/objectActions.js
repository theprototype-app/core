import * as THREE from 'three';
import { get } from 'svelte/store';
import { dropToSurface } from './snapping';
import { recordTransform, recordEntry, recordObjectPresence, registerHistoryKind, beginHistoryBatch, endHistoryBatch } from './history';
import { cascadeJointDeletes } from './joints';
import { createGroup } from './geometries.svelte';
import { suspendAnimation, resumeAnimation, parkAnimatedAtBase } from './flowRuntime';
import {
	objectsGroup,
	TControls,
	transformMode,
	selectedObject,
	selectedObjects,
	lockedObjects,
	globalCamera,
	orbitControls,
	isVRMode,
	gizmoSuppressed,
	cameraClaim
} from '../stores/sceneStore';
import { attachMultiPivot, releaseMultiPivot } from './multiTransform';
import { focusTargetFace } from './faceEdit';
import { focusTargetVertex } from './meshEdit';
import {
	peers,
	showSidebar,
	inspectorClose,
	inspectorKind,
	inspectorPinned,
	closeSelectionInspector,
	specatorMode,
	showToast,
	toggleExpand
} from '../stores/appStore';
import { canEditObject, warnViewerReadOnly } from './objectPermissions';
import { stripEditOverlays } from './editOverlays';
// B7: the transient marker (a LEAF — two stores only, so no cycle back through history)
import { markTransient } from './transientObjects';
import {
	duplicateCarriesAnimation,
	duplicateCarriesFlow,
	duplicateCarriesShader
} from '../stores/appStore';

// #20 P1: what a duplicate carries beyond the clone itself. PRIMED dynamic
// imports (the moduleSDK precedent) — a static edge into either module closes a
// cycle back through history, and both are resolved long before a user can
// press Ctrl+D.
/** @type {any} */ let animModule = null;
/** @type {any} */ let graphModule = null;
/** @type {any} */ let shaderModule = null;
import('./animationPreview').then((m) => (animModule = m));
import('./flowGraphs').then((m) => (graphModule = m));
import('./shaderGraph').then((m) => (shaderModule = m));

/**
 * Copy the per-uuid state that BELONGS to an object onto its fresh clone.
 * Initiator-only: each carrier broadcasts through its own existing message, so a
 * peer that copied locally as well would double the work. Ordering on the wire
 * does not matter — both stores are keyed by uuid and tolerate arriving first.
 * @param {string} fromUuid @param {string} toUuid
 */
function carryObjectState(fromUuid, toUuid) {
	if (get(duplicateCarriesAnimation)) animModule?.copyAnimationsTo(fromUuid, toUuid);
	if (get(duplicateCarriesFlow)) graphModule?.copyGraphTo(fromUuid, toUuid);
	if (get(duplicateCarriesShader)) shaderModule?.copyShaderGraphTo(fromUuid, toUuid);
}

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
	const previous = get(selectedObjects);
	selectedObjects.set(clean);
	if (!clean.length) {
		releaseMultiPivot();
		if (controls && !get(isVRMode)) controls.detach();
		broadcastSelectionRelease(previous);
		return;
	}
	const primary = group.getObjectByProperty('uuid', clean[clean.length - 1]);
	selectedObject.set(primary);
	if (controls && !get(isVRMode)) {
		// viewer perms: selecting/inspecting a shared object is fine, but deny the
		// move gizmo unless every object in the set is editable by the local user
		// (their own local-only objects, or anything for editors/admins).
		const editable = clean.every((/** @type {any} */ uuid) => canEditObject(group.getObjectByProperty('uuid', uuid)));
		if (get(gizmoSuppressed)) {
			// sculpt mode: selection (and its lock) stand, but no gizmo — the
			// SculptToolbar toggle re-attaches explicitly when the user opts in
			releaseMultiPivot();
			controls.detach();
		} else if (!editable) {
			releaseMultiPivot();
			controls.detach();
			warnViewerReadOnly();
		} else if (clean.length === 1) {
			// 17-D: an object carrying its own ORIGIN gets the pivot, so rotate and
			// scale happen about the point the user placed. attachMultiPivot declines
			// for a plain object, which then attaches directly exactly as before.
			if (!attachMultiPivot(clean)) {
				releaseMultiPivot();
				controls.attach(primary);
			}
		} else {
			attachMultiPivot(clean);
		}
	}
	// one lock message covers the whole set (receivers replace this peer's set)
	if (peer) peer.send({ type: 'lock', uuid: clean[clean.length - 1], uuids: clean, peerId: peer.peer.id });
	// 15-O: explicit request (double-click / context menu / object list), a
	// PINNED panel (follows every selection), or a panel already showing the
	// selection. A plain viewport click alone no longer forces it open.
	if (openProperties || get(inspectorPinned) || (!get(inspectorClose) && get(inspectorKind) === 'selection')) {
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
		broadcastSelectionRelease(get(selectedObjects)); // 16-P6: let go of what we held
		selectedObjects.set([]);
		if (controls && !get(isVRMode)) controls.detach();
		selectedObject.set(object);
		if (openProperties || get(inspectorPinned) || (!get(inspectorClose) && get(inspectorKind) === 'selection')) {
			showSidebar('properties');
		}
		return;
	}
	applySelectionSet([uuid], openProperties);
}

/**
 * 16-P6: tell peers we let go. A `lock` message only ever REPLACES a peer's set
 * (`lockGeometry` ignores an empty list), so without this a deselect left the
 * object highlighted + "locked by X" on every other peer until we happened to
 * select something else. `unlock` + `applyUnlock` already exist — no new type;
 * one message per uuid (a selection set is a handful of objects). A peer that
 * had asked us for control gets it here, which is exactly right.
 * @param {string[]} uuids
 */
export function broadcastSelectionRelease(uuids) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer?.peer?.id || !uuids?.length) return;
	for (const uuid of uuids) peer.send({ type: 'unlock', peerId: peer.peer.id, uuid });
}

export function deselectObject() {
	/** @type {any} */
	const controls = get(TControls);
	releaseMultiPivot();
	applyMemberTints(get(objectsGroup), []);
	broadcastSelectionRelease(get(selectedObjects));
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
	const object = controls?.object;
	// a face/vertex/multi gizmo proxy just switches mode (163) — no deselect
	const isProxy = !!(
		object?.userData?.isFaceProxy ||
		object?.userData?.isVertexProxy ||
		object?.userData?.isMultiPivot
	);
	if (!isProxy && get(transformMode) === mode && object && !get(isVRMode)) {
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
/** Delete a specific set of objects by uuid (replicated + undoable). @param {string[]} uuids */
export function deleteObjectsByUuid(uuids) {
	if (!uuids.length) return 0;
	deselectObject();
	// P-B: cascade joint deletes at the SENDER (each jointdelete replicates;
	// receivers only apply)
	cascadeJointDeletes(uuids);
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

export function deleteSelection() {
	return deleteObjectsByUuid(selectionUuids());
}

/**
 * Delete the current selection, but a single GROUP with children asks first via
 * an action-toast (154). Single objects / multi-selects delete immediately.
 * Used by the viewport menu Delete + the Delete/Backspace shortcut.
 */
export function requestDeleteSelection() {
	const uuids = selectionUuids();
	if (!uuids.length) return;
	const group = get(objectsGroup);
	if (uuids.length === 1) {
		const object = group?.getObjectByProperty('uuid', uuids[0]);
		if (object?.type === 'Group' && object.children.length > 0) {
			const count = collectTree(object).length - 1;
			const name = object.name || 'group';
			showToast(`Delete "${name}" and its ${count} object${count === 1 ? '' : 's'}?`, [
				{ label: 'Delete', action: () => deleteObjectsByUuid([object.uuid]) },
				{ label: 'Cancel', action: () => {} }
			]);
			return;
		}
	}
	deleteSelection();
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
 * A multi-select member wears an emissive HIGHLIGHT (applyMemberTints), and
 * `detachMaterials` clones the material with that tint baked in — the copy then
 * kept the selection blue forever. Restore each cloned node's recorded original
 * emissive (source and clone share collectTree's depth-first order). 15-B2.
 * @param {any} source @param {any} clone
 */
function stripSelectionTint(source, clone) {
	const original = memberTints.get(source.uuid);
	if (!original) return;
	const sourceNodes = collectTree(source);
	collectTree(clone).forEach((node, index) => {
		const hex = original[sourceNodes[index]?.uuid];
		if (hex !== undefined && node.material?.emissive) node.material.emissive.setHex(hex);
	});
}

/**
 * Duplicate an object (Ctrl+D / context menu) and replicate the copy to peers.
 * Peers clone their own instance of the source, so no geometry re-export is needed.
 *
 * 21-B B7 added the three SPAWNER options, all of them opt-in so Ctrl+D is byte-unchanged:
 *
 * - `history: false` records no undo entry. A spawner firing forty times would otherwise
 *   flood the stack with forty creations the user never made, and the objects are swept
 *   at the end of the run anyway — half a lifecycle on the undo stack is worse than none.
 * - `transient: true` stamps `userData.transient` and tells peers to do the same, so the
 *   copy is excluded from sessions and autosave and swept when the sim stops
 *   (transientObjects.js documents all four paths). The message field is ADDITIVE: an
 *   older peer ignores it and keeps an ordinary copy.
 * - `at` places the clone BEFORE the broadcast. The default +0.5/+0.5 nudge is right for
 *   Ctrl+D and wrong for a spawner, and moving the object afterwards would send peers the
 *   nudged position and let the ~10 Hz move stream correct it a frame later — a visible pop.
 *
 * A transient duplicate deliberately carries NO per-object state (animation clips, object
 * flow, shader graph). Each carrier broadcasts a whole DOCUMENT per copy, and volume is
 * the spawner's entire point: thirty-two crates would be thirty-two replicated graph
 * documents, into every peer and every save path, for objects that exist for one run.
 * @param {string=} uuid - defaults to the selected object
 * @param {{select?: boolean, history?: boolean, transient?: boolean, at?: number[]}=} options
 *   select:false leaves the selection alone (duplicateSelection selects the whole clone
 *   SET once, at the end)
 */
export function duplicateObject(uuid, options = {}) {
	const group = get(objectsGroup);
	const targetUuid = uuid ?? get(selectedObject)?.uuid;
	const source = targetUuid ? group?.getObjectByProperty('uuid', targetUuid) : null;
	if (!source) {
		showToast('Nothing selected to duplicate');
		return null;
	}
	const clone = source.clone(true);
	// `clone(true)` copies CHILDREN, and the mesh-edit wireframe is one of them —
	// duplicating the object you are editing handed the copy a frozen wireframe
	// that no session owns (they stack up: the reported file had two on one mesh).
	// It also keeps the node COUNT the same on both sides of applyRemoteDuplicate,
	// whose uuid assignment walks the clone in depth-first order.
	stripEditOverlays(clone);
	detachMaterials(clone);
	stripSelectionTint(source, clone);
	const cloneNodes = collectTree(clone);
	cloneNodes.forEach((node) => (node.uuid = crypto.randomUUID()));
	clone.name = (source.name || source.type) + ' copy';
	if (Array.isArray(options.at)) clone.position.fromArray(options.at);
	else {
		clone.position.x += 0.5;
		clone.position.z += 0.5;
	}
	if (options.transient) markTransient(clone);
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
			pos: clone.position.toArray(),
			// B7: absent for every ordinary duplicate, so the message a peer already
			// knows how to read is unchanged
			...(options.transient ? { transient: true } : {})
		});

	// after the clone exists and its uuid is known, and after the `duplicate`
	// message so a peer has the object before its clips/graph arrive (not
	// required — both stores tolerate either order — but it keeps a trace readable)
	if (!options.transient) carryObjectState(source.uuid, clone.uuid);

	if (options.select !== false) selectObject(clone.uuid);
	if (options.history !== false) recordObjectPresence('create', clone);
	return clone;
}

/** Ctrl+D on a set: clone every member, the clones become the new selection */
export function duplicateSelection() {
	const uuids = selectionUuids();
	// 15-K4: an empty selection SET means nothing is selected — creation now
	// populates the set (K3), so the old fallback (duplicate `selectedObject`'s
	// deliberately-sticky LAST object) only ever resurrected stale state. The
	// one legitimate empty-set-with-a-primary state is VIEWING a peer-locked
	// object (selectObject keeps the set empty there) — that may still fall
	// through to selectionUuids' primary and duplicate an editable copy.
	if (!get(selectedObjects).length) {
		const primary = get(selectedObject)?.uuid;
		const lockedView = primary && get(lockedObjects).some((lock) => lock[1] === primary);
		if (!lockedView) {
			showToast('Nothing selected to duplicate');
			return [];
		}
	}
	if (uuids.length <= 1) return duplicateObject(uuids[0]);
	// 15-B2: selecting each clone mid-loop collapsed the set and restored the
	// sources' tints one by one — the FIRST clone was made from a still-tinted
	// source and then had that tint recorded as its "original". Clone the whole
	// set first (each copy un-tinted by stripSelectionTint), select once after.
	const clones = uuids
		.map((uuid) => duplicateObject(uuid, { select: false }))
		.filter(Boolean)
		.map((clone) => clone.uuid);
	if (clones.length) applySelectionSet(clones);
	return clones;
}

/**
 * Apply a duplicate made by a peer: clone the same source locally and assign
 * the uuids the originator generated (same depth-first order on both sides).
 * @param {string} sourceUuid @param {string[]} uuids @param {string} name @param {number[]} pos
 * @param {boolean=} transient B7: the sender says this copy lives only for the run — the
 *   flag has to be stamped HERE because the clone is made from OUR source object, whose
 *   userData is (correctly) not transient. Without it a peer would keep the spawned crates
 *   in its own sessions and autosave, and only the initiator's sweep would remove them.
 */
export function applyRemoteDuplicate(sourceUuid, uuids, name, pos, transient) {
	const group = get(objectsGroup);
	const source = group?.getObjectByProperty('uuid', sourceUuid);
	if (!source) return;
	const clone = source.clone(true);
	stripEditOverlays(clone); // see duplicateObject: the index walk below counts nodes
	detachMaterials(clone);
	collectTree(clone).forEach((node, index) => {
		if (uuids[index]) node.uuid = uuids[index];
	});
	clone.name = name;
	clone.position.fromArray(pos);
	if (transient) markTransient(clone);
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
	if ('physics' in state) {
		// P-A: Inspector physics edits are undoable through the same kind
		if (state.physics) object.userData.physics = state.physics;
		else delete object.userData.physics;
		if (peer)
			peer.send({ type: 'objectParameters', parameter: 'physics', uuid: entry.uuid, physics: state.physics });
	}
	if ('particles' in state) {
		// PFX-A: particle emitter add/remove/edits replay the same way
		if (state.particles) object.userData.particles = state.particles;
		else delete object.userData.particles;
		if (peer)
			peer.send({ type: 'objectParameters', parameter: 'particles', uuid: entry.uuid, particles: state.particles });
	}
	if ('camera' in state) {
		// 16-P5: camera-object settings ride the same kind (viz + any live preview
		// rebuild from the poke below)
		if (state.camera) object.userData.camera = state.camera;
		else delete object.userData.camera;
		if (peer)
			peer.send({ type: 'objectParameters', parameter: 'camera', uuid: entry.uuid, camera: state.camera });
	}
	if ('device' in state) {
		// 23-A3: a device's document rides the same kind; the audioDevices reconcile
		// rebuilds/re-params the subgraph from the poke below
		if (state.device) object.userData.device = state.device;
		else delete object.userData.device;
		if (peer)
			peer.send({ type: 'objectParameters', parameter: 'device', uuid: entry.uuid, device: state.device });
	}
	if ('origin' in state) {
		// 17-D: the per-object transform origin (pivot offset) is scene data, so
		// moving it is undoable and replicated like any other userData write
		if (state.origin) object.userData.origin = state.origin;
		else delete object.userData.origin;
		if (peer)
			peer.send({ type: 'objectParameters', parameter: 'origin', uuid: entry.uuid, origin: state.origin });
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
 * Ungroup (216): move every child up to the group's parent (world transform kept
 * via moveObjectToGroup 'up', which replicates + records undo per child), then
 * delete the now-empty group. Peers apply the child moves BEFORE the delete, so
 * children survive. @param {string} groupUuid @returns {boolean}
 */
export function ungroupObject(groupUuid) {
	const root = get(objectsGroup);
	const grp = root?.getObjectByProperty('uuid', groupUuid);
	if (!grp || grp.type !== 'Group') return false;
	const children = [...grp.children]; // snapshot: attach() mutates .children
	// 15-G: one undo step, not N+1 (a move per child plus the group delete)
	beginHistoryBatch();
	for (const child of children) moveObjectToGroup(child.uuid, 'up');
	deleteObjectsByUuid([groupUuid]); // now empty -> removes just the group
	endHistoryBatch('Ungroup');
	return true;
}

/**
 * Group the current multi-selection into a NEW empty group placed at the
 * selection centroid, then move every member into it (U-2). All pieces are
 * already replicated primitives — createGroup + the group message + a move for
 * the centroid — wrapped in ONE history batch so undo restores the flat layout
 * in a single step. Returns the new group's uuid (or null if <2 selected).
 */
export function groupSelection() {
	const uuids = selectionUuids();
	if (uuids.length < 2) return null;
	const group = get(objectsGroup);
	const members = uuids
		.map((uuid) => group?.getObjectByProperty('uuid', uuid))
		.filter(Boolean);
	if (members.length < 2) return null;

	// centroid of members in world space → the group's pivot
	const centroid = new THREE.Vector3();
	const world = new THREE.Vector3();
	for (const member of members) {
		member.getWorldPosition(world);
		centroid.add(world);
	}
	centroid.divideScalar(members.length);

	/** @type {any} */
	const peer = get(peers);
	beginHistoryBatch();
	// empty group (replicated via the same message the /group command uses)
	const groupUuid = createGroup('/group Selection');
	const newGroup = group?.getObjectByProperty('uuid', groupUuid);
	if (peer) peer.send({ type: 'group', command: '/group Selection', uuid: groupUuid });
	recordObjectPresence('create', newGroup);
	// move the empty group to the centroid BEFORE attaching (both peers attach
	// with the group already at the pivot, so member local coords match)
	if (newGroup) {
		newGroup.position.copy(centroid);
		if (peer)
			peer.send({
				type: 'move',
				uuid: groupUuid,
				pos: newGroup.position.toArray(),
				rot: newGroup.rotation.toArray(),
				scale: newGroup.scale.toArray()
			});
	}
	for (const uuid of uuids) moveObjectToGroup(uuid, groupUuid);
	endHistoryBatch('Group objects');
	objectsGroup.update((value) => value);
	applySelectionSet([groupUuid]);
	return groupUuid;
}

// --- 15-G: convert a Group / multi-selection into ONE mesh ---------------------

// mergeGeometries wants every input to carry the SAME attribute set, so each
// source geometry is normalized down to this triple (extras like color/uv1/
// tangent/skinning are dropped, a missing normal/uv is generated).
const MERGE_ATTRIBUTES = ['position', 'normal', 'uv'];

/** @param {any} ancestor @param {any} object */
function isAncestorOf(ancestor, object) {
	let current = object.parent;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

/** Copy a vertex RANGE of a NON-INDEXED geometry into its own geometry.
 * @param {any} geometry @param {number} start @param {number} count */
function sliceGeometry(geometry, start, count) {
	const out = new THREE.BufferGeometry();
	for (const name of Object.keys(geometry.attributes)) {
		const attribute = geometry.attributes[name];
		const size = attribute.itemSize;
		out.setAttribute(
			name,
			new THREE.BufferAttribute(attribute.array.slice(start * size, (start + count) * size), size)
		);
	}
	return out;
}

/**
 * One normalized geometry per MATERIAL SLOT of a source mesh. A multi-material
 * source has to be split along its own geometry groups first: mergeGeometries
 * writes exactly ONE group per input geometry and ignores the groups already on
 * it, so a merged mesh would otherwise collapse every slot onto one material.
 * @param {any} mesh @returns {{ geometry: any, material: any }[]}
 */
function mergePieces(mesh) {
	const source = mesh.geometry;
	// toNonIndexed() returns a NEW geometry (and copies the groups, whose
	// start/count map 1:1 onto the expanded vertices)
	const base = source.index ? source.toNonIndexed() : source.clone();
	for (const name of Object.keys(base.attributes))
		if (!MERGE_ATTRIBUTES.includes(name)) base.deleteAttribute(name);
	base.morphAttributes = {};
	if (!base.attributes.normal) base.computeVertexNormals();
	if (!base.attributes.uv)
		base.setAttribute(
			'uv',
			new THREE.BufferAttribute(new Float32Array(base.attributes.position.count * 2), 2)
		);
	const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
	if (materials.length < 2 || !base.groups.length)
		return [{ geometry: base, material: materials[0] }];
	const pieces = base.groups.map((/** @type {any} */ slot) => ({
		geometry: sliceGeometry(base, slot.start, slot.count),
		material: materials[slot.materialIndex ?? 0] ?? materials[0]
	}));
	base.dispose();
	return pieces;
}

/**
 * Merge a Group (or a 2+ multi-selection) into ONE new mesh: geometries baked
 * into a shared frame, every distinct source material kept as a slot of a
 * material ARRAY, the originals deleted — all as ONE undo entry.
 *
 * Replication goes through the `object` message (ObjectLoader on the receiver),
 * NOT `sendObjects`: that helper announces a GROUP for the root it is handed and
 * then walks its CHILDREN, so a bare mesh would arrive as an empty group. The
 * `object` path is also exactly what the create/delete history entries replay,
 * so undo/redo and the live convert stay byte-identical for peers.
 *
 * @param {string[]=} uuids - defaults to the current selection
 * @returns {Promise<string|null>} the merged mesh's uuid, or null when refused
 */
export async function convertToMesh(uuids) {
	const group = get(objectsGroup);
	const requested = uuids?.length ? uuids : selectionUuids();
	/** @type {any[]} */
	let targets = requested.map((uuid) => group?.getObjectByProperty('uuid', uuid)).filter(Boolean);
	// a selection can hold a group AND one of its descendants — merging the child
	// twice (it is deleted with its parent anyway) would duplicate its geometry
	targets = targets.filter(
		(object) => !targets.some((other) => other !== object && isAncestorOf(other, object))
	);
	if (!targets.length) {
		showToast('Nothing selected to convert');
		return null;
	}

	const locks = get(lockedObjects);
	const lockedTarget = targets.find((object) => locks.find((lock) => lock[1] === object.uuid));
	if (lockedTarget) {
		showToast('Cannot convert: an object is locked by another peer');
		return null;
	}
	// viewer perms: converting DELETES the sources, so it needs edit rights on all
	if (!targets.every((object) => canEditObject(object))) {
		warnViewerReadOnly();
		return null;
	}

	/** @type {{ mesh: any, rootUuid: string }[]} */
	const sources = [];
	let skinned = false;
	for (const target of targets)
		target.traverse((/** @type {any} */ node) => {
			if (node.isSkinnedMesh) skinned = true;
			else if (node.isMesh && node.geometry?.attributes?.position)
				sources.push({ mesh: node, rootUuid: target.uuid });
		});
	if (skinned) {
		showToast('Cannot convert: rigged models keep their skeleton and cannot be merged');
		return null;
	}
	if (sources.length < 2) {
		showToast('Convert to mesh needs at least 2 meshes');
		return null;
	}

	const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');

	// serializer rule 10: bake the animation BASE pose, never a mid-swing one
	const restorePose = parkAnimatedAtBase();
	/** @type {any[]} */
	const geometries = [];
	/** @type {any[]} */
	const materials = [];
	/** @type {number[]} */
	const slotOfGroup = []; // merged group i -> index into `materials`
	/** @type {Map<string, number>} */
	const slotOfMaterial = new Map();
	const origin = new THREE.Vector3();
	try {
		targets[0].updateWorldMatrix(true, false);
		origin.setFromMatrixPosition(targets[0].matrixWorld);
		const toLocal = new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);
		for (const { mesh, rootUuid } of sources) {
			mesh.updateWorldMatrix(true, false);
			const relative = new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld);
			for (const piece of mergePieces(mesh)) {
				piece.geometry.applyMatrix4(relative);
				geometries.push(piece.geometry);
				const material = piece.material ?? new THREE.MeshStandardMaterial();
				if (!slotOfMaterial.has(material.uuid)) {
					const clone = material.clone();
					// a multi-select member wears the emissive HIGHLIGHT, and the clone
					// bakes it in forever (the 15-B2 duplicate bug) — put the recorded
					// pre-selection emissive back on the copy
					const tint = memberTints.get(rootUuid)?.[mesh.uuid];
					if (tint !== undefined && clone.emissive) clone.emissive.setHex(tint);
					slotOfMaterial.set(material.uuid, materials.length);
					materials.push(clone);
				}
				slotOfGroup.push(/** @type {number} */ (slotOfMaterial.get(material.uuid)));
			}
		}
	} finally {
		restorePose();
	}

	const merged = mergeGeometries(geometries, true);
	geometries.forEach((geometry) => geometry.dispose());
	if (!merged) {
		showToast('Cannot convert: these geometries could not be merged');
		return null;
	}
	// mergeGeometries numbers its groups by INPUT order; re-point them at the
	// de-duplicated material slots (two boxes sharing one material = one slot)
	merged.groups.forEach((/** @type {any} */ slot, /** @type {number} */ index) => {
		slot.materialIndex = slotOfGroup[index] ?? 0;
	});
	if (materials.length === 1) merged.clearGroups();
	merged.computeBoundingSphere();

	const mesh = new THREE.Mesh(merged, materials.length === 1 ? materials[0] : materials);
	mesh.name =
		targets.length === 1 && targets[0].name ? targets[0].name + ' (mesh)' : 'Merged mesh';
	mesh.castShadow = sources[0].mesh.castShadow;
	mesh.receiveShadow = sources[0].mesh.receiveShadow;

	// keep the merge where the sources were, and inside the same parent group
	const parent = targets[0].parent && targets[0].parent !== group ? targets[0].parent : null;
	const parentUuid = parent?.uuid ?? null;

	/** @type {any} */
	const peer = get(peers);
	beginHistoryBatch();
	// delete FIRST so the batch replays as "restore the originals, then drop the
	// merge" on undo, and so deselectObject's gizmo detach cannot fight the
	// selection we set at the end
	deleteObjectsByUuid(targets.map((object) => object.uuid));
	group.add(mesh);
	mesh.position.copy(origin);
	if (parent) parent.attach(mesh); // keeps the world pose, rewrites the local one
	mesh.updateMatrix();
	recordObjectPresence('create', mesh);
	if (peer)
		peer.send({
			type: 'object',
			element: mesh.toJSON(),
			groupuuid: parentUuid ?? undefined
		});
	endHistoryBatch('Convert to mesh');

	objectsGroup.update((value) => value);
	applySelectionSet([mesh.uuid]);
	showToast(`Merged ${sources.length} meshes into "${mesh.name}"`);
	return mesh.uuid;
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
	// H11: announce that the camera has a new owner, so anything driving it
	// continuously (a note-follow session) steps aside instead of fighting the tween
	cameraClaim.update((n) => n + 1);

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
	// 173: in mesh-edit, F frames the selected face/vertex; fall back to the object
	if (!uuid) {
		const editFocus = focusTargetFace() || focusTargetVertex();
		if (editFocus) {
			/** @type {any} */
			const camera = get(globalCamera);
			/** @type {any} */
			const controls = get(orbitControls);
			if (!camera || !controls) return;
			const fov = THREE.MathUtils.degToRad(camera.fov);
			const distance = THREE.MathUtils.clamp((editFocus.radius / Math.tan(fov / 2)) * 1.2, 0.5, 200);
			const direction = camera.position.clone().sub(controls.target).normalize();
			flyTo(editFocus.center.clone().add(direction.multiplyScalar(distance)), editFocus.center.clone());
			return;
		}
	}
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

// ---- Phase 85: selection extras --------------------------------------------

/**
 * Ctrl+A — select every unlocked TOP-LEVEL object. Top-level because that is what
 * a selection means everywhere else in this app (the gizmo, the multi-pivot and
 * the Inspector all act on whole objects); a group is one member, not its children.
 * Peer-locked objects are skipped by `applySelectionSet` itself, so a locked
 * object simply never joins the set.
 * @returns {number} how many were selected
 */
export function selectAllObjects() {
	const group = get(objectsGroup);
	const uuids = (group?.children ?? [])
		.filter((/** @type {any} */ child) => child?.uuid && child.visible !== false)
		.map((/** @type {any} */ child) => child.uuid);
	applySelectionSet(uuids);
	if (!uuids.length) showToast('Nothing in the scene to select');
	return get(selectedObjects).length;
}

/** Select every object sharing the given object's kind — the geometry type for a
 * mesh ('BoxGeometry'), otherwise the object type ('PointLight', 'Group').
 * @param {string} uuid @returns {number} how many were selected */
export function selectSameType(uuid) {
	const group = get(objectsGroup);
	const source = group?.getObjectByProperty('uuid', uuid);
	if (!source) return 0;
	const kindOf = (/** @type {any} */ object) =>
		object?.isMesh ? (object.geometry?.type ?? 'Mesh') : object?.type;
	const kind = kindOf(source);
	const uuids = (group?.children ?? [])
		.filter((/** @type {any} */ child) => kindOf(child) === kind)
		.map((/** @type {any} */ child) => child.uuid);
	applySelectionSet(uuids);
	showToast(uuids.length + ' × ' + kind);
	return uuids.length;
}

// ISOLATION is LOCAL and reversible: it hides the other top-level objects rather
// than fading them. Fading would mean writing `transparent`/`opacity` onto
// materials that are frequently SHARED between objects (and re-uploading a render
// program), so a restore could not be exact — while `visible` is per object, is
// never serialized by a peer message, and puts back exactly what was there.
// The snapshot remembers each object's OWN visibility, so restoring never reveals
// something the user had deliberately hidden.
/** @type {Map<string, boolean>|null} */
let isolationSnapshot = null;

/** Is something isolated right now? */
export function isIsolated() {
	return !!isolationSnapshot;
}

/** Frame `uuids` and hide every other top-level object until `clearIsolation`.
 * @param {string[]} uuids @returns {number} how many objects were hidden */
export function isolateObjects(uuids) {
	const group = get(objectsGroup);
	if (!group) return 0;
	clearIsolation(); // never nest — the second isolate would snapshot hidden ones
	const keep = new Set(uuids);
	/** @type {Map<string, boolean>} */
	const snapshot = new Map();
	let hidden = 0;
	for (const child of group.children) {
		snapshot.set(child.uuid, child.visible !== false);
		if (!keep.has(child.uuid) && child.visible !== false) {
			child.visible = false;
			hidden++;
		}
	}
	isolationSnapshot = snapshot;
	objectsGroup.update((v) => v);
	if (hidden) showToast('Isolated — press Esc to bring the scene back');
	return hidden;
}

/** Undo an isolation, restoring each object's own visibility. Safe to call when
 * nothing is isolated. @returns {boolean} whether anything was restored */
export function clearIsolation() {
	if (!isolationSnapshot) return false;
	const group = get(objectsGroup);
	for (const [uuid, visible] of isolationSnapshot) {
		const object = group?.getObjectByProperty('uuid', uuid);
		// only put back what WE hid: an object the user hid meanwhile stays hidden
		if (object && visible && object.visible === false) object.visible = true;
	}
	isolationSnapshot = null;
	objectsGroup.update((v) => v);
	return true;
}
