// D2 — SHARED MATERIALS: "by default copy, add an option to share" (the user's ask,
// 2026-08-17), held until the shader lane had established what a material IDENTITY is.
//
// WHY IT WAITED, and what changed. Sharing is one line locally — skip `detachMaterials`
// and the clone keeps the source's material instance. The reason that was refused is
// REPLICATION: every material change is broadcast PER OBJECT (`materialParam`,
// `objectParameters`, `map`), so two objects sharing an instance locally would diverge
// the instant a peer applied one — the sender sees both change, the receiver sees one.
// A late joiner would receive two independent materials and never share them again, and
// toJSON/GLTF each lose it differently.
//
// THE IDENTITY, and it is deliberately the one the shader lane already proved rather
// than a second system: **a small string on `userData`**. That is the same carrier
// `userData.physics`, `userData.origin`, `userData.camera` and `__uuid` ride — it rides
// toJSON AND GLTF extras, which is exactly the four-carrier problem solved once.
//
// THE THREE RULES THIS ENCODES
//
// 1. THE ID IS THE TRUTH; THE INSTANCE IS AN OPTIMISATION. Objects that share an id
//    should share one THREE.Material so a local edit is instant on both — but every
//    carrier splits instances somewhere (GLTF rebuilds a material per mesh, a peer
//    receives objects one at a time, undo re-parses a subtree). So nothing depends on
//    the instance: `reconcileSharedMaterials` re-unifies by id whenever the scene
//    changes, the way shaderGraph reconciles a graph whose object arrived late.
//
// 2. THE SENDER FANS. Rather than mint a material-addressed message — a new type, a new
//    applier, a new capability-gate entry and a story for every older peer — the sender
//    broadcasts the per-object messages the receiver ALREADY understands, once per
//    object sharing the id (`fanTargets`). The wire is byte-unchanged, an older peer
//    needs no code at all, and the answer to "what happens when a shared material meets
//    a peer that does not have it" is: it receives ordinary per-object edits and agrees.
//    The honest cost, stated rather than hidden: a peer on an OLDER build that edits a
//    shared material fans nothing, so only the object it edited changes — for everyone.
//
// 3. COPY REMAINS THE DEFAULT. `shareDuplicatedMaterials` is LOCAL and OFF, because a
//    duplicate is a working copy of everything that belongs to the object (D1's DCC
//    rule) and only data people deliberately SHARE is linked — Blender's linked
//    duplicate is a different command, not a different default.
//
// A LEAF: svelte stores and THREE only. objectActions, materialsHandler and the
// Inspector all read it, so it may import none of them.

import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';

/** The userData key. Short and namespaced, since it rides every serializer. */
export const MATERIAL_ID_KEY = 'materialId';

/**
 * LOCAL pref: does Ctrl+D hand the copy the SAME material as the source?
 *
 * Local rather than scene data on purpose — it is a fact about how YOU duplicate, like
 * the snap step or the double-click action, and two people in one session may reasonably
 * want different answers. What they produce (a shared id) IS scene data and replicates.
 */
export const shareDuplicatedMaterials = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('shareDuplicatedMaterials') === 'true'
);
shareDuplicatedMaterials.subscribe((value) => {
	try {
		localStorage.setItem('shareDuplicatedMaterials', String(value));
	} catch {
		/* private mode: a pref is a convenience, never a requirement */
	}
});

let idCounter = 0;
/** Unique within a session; the id only has to be stable, never meaningful. */
function newMaterialId() {
	return 'mat' + Date.now().toString(36) + (idCounter++).toString(36);
}

/** @param {any} object @returns {string} */
export function materialIdOf(object) {
	const id = object?.userData?.[MATERIAL_ID_KEY];
	return typeof id === 'string' ? id : '';
}

/** @param {any} object @param {string} id */
export function setMaterialId(object, id) {
	if (!object) return;
	if (!object.userData) object.userData = {};
	if (id) object.userData[MATERIAL_ID_KEY] = id;
	else delete object.userData[MATERIAL_ID_KEY];
}

/** Every mesh in the scene, with an optional filter. @param {(node: any) => boolean} [keep] */
function meshes(keep) {
	const group = get(objectsGroup);
	/** @type {any[]} */
	const out = [];
	group?.traverse((/** @type {any} */ node) => {
		if (node.isMesh && (!keep || keep(node))) out.push(node);
	});
	return out;
}

/** The objects sharing one id (including, normally, the one you asked about).
 * @param {string} id @returns {any[]} */
export function objectsSharing(id) {
	if (!id) return [];
	return meshes((node) => materialIdOf(node) === id);
}

/** Is this object's material shared with anything else right now? @param {string} uuid */
export function isSharedMaterial(uuid) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	const id = materialIdOf(object);
	return !!id && objectsSharing(id).length > 1;
}

/**
 * THE SEND-SIDE FAN: which uuids a per-object material message must ALSO be sent for.
 *
 * Returns the OTHER objects sharing this one's material — never the object itself, so a
 * caller adds the fan to what it was already sending and cannot double-send. Empty for
 * the overwhelmingly common unshared case, which is what keeps the hot path free.
 * @param {string} uuid @returns {string[]}
 */
export function fanTargets(uuid) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	const id = materialIdOf(object);
	if (!id) return [];
	return objectsSharing(id)
		.map((node) => node.uuid)
		.filter((other) => other !== uuid);
}

/**
 * Link `clone`'s material to `source`'s, minting the id if this is the first link.
 *
 * Walks BOTH trees in the same order the duplicate path does, so a group shares
 * per-child rather than as a lump: two children of one group may legitimately hold
 * different materials, and one id for the group would be a lie about all but one.
 * @param {any} source @param {any} clone
 */
export function linkMaterials(source, clone) {
	/** @type {any[]} */
	const from = [];
	/** @type {any[]} */
	const to = [];
	source.traverse((/** @type {any} */ node) => node.isMesh && from.push(node));
	clone.traverse((/** @type {any} */ node) => node.isMesh && to.push(node));
	for (let i = 0; i < to.length && i < from.length; i++) {
		// a material ARRAY (UV4 slots) is refused rather than half-shared: every consumer
		// of the id assumes one material per object, and `switchMaterialType` sets the
		// precedent of declining instead of collapsing the array
		if (Array.isArray(from[i].material) || Array.isArray(to[i].material)) continue;
		const id = materialIdOf(from[i]) || newMaterialId();
		setMaterialId(from[i], id);
		setMaterialId(to[i], id);
		to[i].material = from[i].material;
	}
}

/**
 * Stop sharing: this object gets its own copy of the material and drops the id.
 *
 * The LAST holder of an id keeps it harmlessly (a group of one is not shared, which is
 * what `isSharedMaterial` answers) — hunting it down would mean a second pass for no
 * observable difference, and a later duplicate simply re-uses it.
 * @param {string} uuid
 */
export function unlinkMaterial(uuid) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || Array.isArray(object.material)) return false;
	setMaterialId(object, '');
	if (object.material) object.material = object.material.clone();
	objectsGroup.update((value) => value);
	return true;
}

/**
 * Re-unify instances by id — the half that makes every carrier work.
 *
 * Every path that rebuilds an object rebuilds its material: GLTF (the wire's object sync
 * and autosave) makes one per mesh, a peer receives objects one message at a time, and
 * undo re-parses a subtree. The id survives all of them because it is `userData`; the
 * INSTANCE does not. So the first object holding an id lends its material to the rest,
 * and the rest is then an ordinary local share again.
 *
 * Cheap in the common case: it only walks meshes that carry an id at all, and only
 * assigns where the instance actually differs.
 * @returns {number} how many objects were re-pointed (for the debug hook and the suite)
 */
export function reconcileSharedMaterials() {
	/** @type {Map<string, any>} */
	const first = new Map();
	let changed = 0;
	for (const node of meshes((n) => !!materialIdOf(n))) {
		if (Array.isArray(node.material)) continue;
		const id = materialIdOf(node);
		const held = first.get(id);
		if (!held) {
			first.set(id, node.material);
			continue;
		}
		if (node.material !== held) {
			node.material = held;
			changed++;
		}
	}
	if (changed) objectsGroup.update((value) => value);
	return changed;
}

/** @type {(() => void)|null} */
let reconcileStop = null;
/** @type {any} */
let reconcileTimer = null;

/** Idempotent; call once at boot. Debounced, because objectsGroup pokes on every
 * scene mutation (the shaderGraph reconcile precedent exactly). */
export function startMaterialSharing() {
	if (reconcileStop) return;
	reconcileStop = objectsGroup.subscribe(() => {
		clearTimeout(reconcileTimer);
		reconcileTimer = setTimeout(() => reconcileSharedMaterials(), 150);
	});
}

/** Test seam. */
export function stopMaterialSharing() {
	reconcileStop?.();
	reconcileStop = null;
	clearTimeout(reconcileTimer);
}

/** test/debug view: the sharing groups, by id */
export function materialSharingDebug() {
	/** @type {Record<string, {uuids: string[], instances: number}>} */
	const groups = {};
	for (const node of meshes((n) => !!materialIdOf(n))) {
		const id = materialIdOf(node);
		groups[id] ??= { uuids: [], instances: 0 };
		groups[id].uuids.push(node.uuid);
	}
	for (const id of Object.keys(groups)) {
		const set = new Set(objectsSharing(id).map((node) => node.material));
		groups[id].instances = set.size;
	}
	return { on: get(shareDuplicatedMaterials), groups };
}
