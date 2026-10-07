// 37 R3 — the MOVING PARTS of the parametric door and window, and their link to the 33
// behaviour runtime. A door is ONE replicated mesh (its frame); the leaf (and a window's
// sash) is a child pivot this module builds from the params on every peer, so nothing about
// the parts ever travels — the `geometry` message and userData.geometryParams already do.
//
// RECONCILE, not create: an object reaches a scene by /create, a peer's GLTF sync, a toJSON
// duplicate, an undo snapshot, a session or an autosave restore — and the serialized ones
// arrive WITH last time's parts as plain children. So on every scene poke this walks the
// replicated tree and, per door/window, rebuilds the parts when their params changed (or the
// object is new to it): old part children (`userData.archPart`) are removed first, which is
// what keeps a restore from drawing every leaf twice. Part uuids are derived from the root's,
// so every peer names them the same.
//
// THE BEHAVIOUR: each pivot gets a generated 'Open' clip (a quaternion track on the hinge)
// and the root is registered with packBehavior through `registerProceduralBehavior` — a pack
// door's whole runtime, unchanged: click / proximity in Interact and Play only, the rest pose
// in Edit, ONE replicated `behavior` message per trigger, the frame collider cut round the
// doorway and a kinematic box following the leaf while a simulation runs. A late joiner gets
// the open/shut state from `sendArchBehaviorStates` (the getanim reply), because procedural
// items have no objectfile to carry it.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, sceneRevision } from '../../stores/sceneStore';
import { doorParts, windowParts, archParams } from './archGeometry.js';
import { registerProceduralBehavior, dropProceduralBehavior } from '../animatedImports';
import { behaviorState } from '../packBehavior';

/** the clip every part animates */
const CLIP = 'Open';
/** seconds a door / a casement takes to open */
const DURATION = { Door: 1.1, Window: 0.8 };
/** the ease the hinge follows (smoothstep, sampled — slerp between keys stays on the arc) */
const KEYS = [0, 0.2, 0.4, 0.6, 0.8, 1];

/** the glass every pane shares (never edited; the frame keeps the object's own material) */
let glassMaterial = /** @type {any} */ (null);
function glass() {
	glassMaterial ??= new THREE.MeshStandardMaterial({
		color: '#cfe8f5',
		roughness: 0.05,
		metalness: 0,
		transparent: true,
		opacity: 0.28,
		depthWrite: false
	});
	return glassMaterial;
}

/** root -> the params key its parts were built for @type {WeakMap<any, string>} */
const builtFor = new WeakMap();
/** uuid -> root, every root registered with the behaviour runtime @type {Map<string, any>} */
const registered = new Map();
const stats = { builds: 0, reconciles: 0, registrations: 0, drops: 0 };

/** @param {any} object */
function archTypeOf(object) {
	const gtype = object?.userData?.geometryParams?.gtype;
	return gtype === 'Door' || gtype === 'Window' ? gtype : null;
}

/** the generated hinge track @param {string} node @param {number} angle @param {number} duration */
function hingeTrack(node, angle, duration) {
	const q = new THREE.Quaternion();
	const axis = new THREE.Vector3(0, 1, 0);
	/** @type {number[]} */
	const values = [];
	for (const f of KEYS) {
		q.setFromAxisAngle(axis, angle * f * f * (3 - 2 * f));
		values.push(q.x, q.y, q.z, q.w);
	}
	return new THREE.QuaternionKeyframeTrack(node + '.quaternion', KEYS.map((f) => f * duration), values);
}

/** remove (and free) the part children a root carries — ours from last time, or a serialized copy @param {any} root */
function dropParts(root) {
	for (const child of [...root.children]) {
		if (!child.userData?.archPart) continue;
		root.remove(child);
		child.traverse((/** @type {any} */ node) => {
			if (node.isMesh) node.geometry?.dispose?.();
		});
	}
}

/** the frame collider our behaviour stamped, removed (a casement made fixed) @param {any} root */
function dropFrameCollider(root) {
	const physics = root.userData?.physics;
	if (!physics?.__behaviorFrame) return;
	const { collider, colliderVerts, colliderPieces, __behaviorFrame, ...rest } = physics;
	if (Object.keys(rest).length) root.userData.physics = rest;
	else delete root.userData.physics;
}

/**
 * Build (or rebuild) one root's parts and its behaviour registration.
 * @param {any} root @param {'Door'|'Window'} gtype @param {Record<string, any>} params
 */
function buildParts(root, gtype, params) {
	dropParts(root);
	const parts = gtype === 'Door' ? doorParts(params) : [windowParts(params)];
	const duration = DURATION[gtype];
	/** @type {any[]} */
	const tracks = [];
	for (const part of parts) {
		const pivot = new THREE.Object3D();
		pivot.name = part.name;
		pivot.uuid = root.uuid + '-' + part.name;
		pivot.userData.archPart = true;
		pivot.position.fromArray(part.pivot);
		const body = new THREE.Mesh(part.leaf, root.material);
		body.name = part.name + 'Body';
		body.uuid = pivot.uuid + '-body';
		body.userData.archPart = 'body';
		body.castShadow = root.castShadow;
		body.receiveShadow = root.receiveShadow;
		pivot.add(body);
		if (part.glass) {
			const pane = new THREE.Mesh(part.glass, glass());
			pane.name = part.name + 'Glass';
			pane.uuid = pivot.uuid + '-glass';
			pane.userData.archPart = 'glass';
			pane.castShadow = false;
			pivot.add(pane);
		}
		root.add(pivot);
		if (part.angle) tracks.push(hingeTrack(part.name, part.angle, duration));
	}
	root.updateMatrixWorld(true);
	stats.builds++;
	if (!tracks.length) {
		// a fixed window: nothing moves, nothing to trigger
		if (registered.has(root.uuid)) dropRegistration(root.uuid);
		dropFrameCollider(root);
		return;
	}
	const spec =
		gtype === 'Door'
			? { type: 'door', clip: CLIP, trigger: params.trigger, collider: 'follow', sound: 'door' }
			: { type: 'toggle', clip: CLIP, trigger: 'click', collider: 'follow', sound: 'gate' };
	if (registerProceduralBehavior(root, [new THREE.AnimationClip(CLIP, duration, tracks)], spec)) {
		registered.set(root.uuid, root);
		stats.registrations++;
	}
}

/** @param {string} uuid */
function dropRegistration(uuid) {
	dropProceduralBehavior(uuid);
	registered.delete(uuid);
	stats.drops++;
}

/** the parts' bodies follow the frame's material (the Inspector recolours the root) @param {any} root */
function followMaterial(root) {
	for (const pivot of root.children) {
		if (!pivot.userData?.archPart) continue;
		for (const node of pivot.children)
			if (node.userData?.archPart === 'body' && node.material !== root.material) node.material = root.material;
	}
}

/** is `object` still in the replicated tree? @param {any} object @param {any} group */
function inTree(object, group) {
	for (let node = object; node; node = node.parent) if (node === group) return true;
	return false;
}

/** One pass over the replicated tree: build what is new or changed, drop what left. */
export function reconcileArchParts() {
	const group = get(objectsGroup);
	if (!group) return;
	stats.reconciles++;
	/** @type {any[]} */
	const roots = [];
	group.traverse((/** @type {any} */ node) => {
		if (node.userData?.archPart) return;
		if (archTypeOf(node) && node.isMesh) roots.push(node);
	});
	for (const root of roots) {
		const gtype = /** @type {'Door'|'Window'} */ (archTypeOf(root));
		const params = archParams(gtype, root.userData.geometryParams.params);
		if (!params) continue;
		const key = JSON.stringify(params);
		// a new object (a restore, a duplicate, an arrival heal under the same uuid) is not in
		// the map, so it rebuilds; an unchanged one only re-follows its material
		if (builtFor.get(root) === key) {
			followMaterial(root);
			continue;
		}
		builtFor.set(root, key);
		buildParts(root, gtype, params);
	}
	for (const [uuid, root] of [...registered]) if (!inTree(root, group) || !archTypeOf(root)) dropRegistration(uuid);
}

/**
 * The open/shut state of every procedural door we hold, for a late joiner (peerHandler's
 * getanim reply). Only doors that were ever triggered have one; the receiver keeps it keyed
 * by uuid until the door arrives.
 * @param {any} conn
 */
export function sendArchBehaviorStates(conn) {
	for (const uuid of registered.keys()) {
		const state = behaviorState(uuid);
		if (state?.n) conn?.send?.({ type: 'behavior', uuid, on: state.on, at: state.at, from: state.from, n: state.n });
	}
}

let started = false;
/** Start once (Scene.svelte, beside startPackBehaviors). */
export function startArchParts() {
	if (started) return;
	started = true;
	sceneRevision.subscribe(() => reconcileArchParts());
}

/** the suites' view */
export function archPartsDebug() {
	return {
		...stats,
		registered: [...registered.entries()].map(([uuid, root]) => ({
			uuid,
			gtype: archTypeOf(root),
			parts: root.children.filter((/** @type {any} */ c) => c.userData?.archPart).map((/** @type {any} */ c) => c.name),
			state: behaviorState(uuid)
		}))
	};
}
