import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordObjectPresence, beginHistoryBatch, endHistoryBatch } from './history';
import { patch as audioPatch, addCablesRemapped } from './audioPatch';
import { selectObject } from './objectActions';
import { parkEditOverlays, stripEditOverlays } from './editOverlays';
import { idbGet, idbPut } from './idb';

// Personal prefab library: save any object/group as a reusable asset
// (ObjectLoader snapshot + rendered thumbnail) in IndexedDB. The library is
// LOCAL by design — instantiated copies replicate like any other object.

/** @type {import('svelte/store').Writable<any[]>} [{id, name, createdAt, thumbnail, element}] */
export const prefabs = writable([]);

const KEY = 'prefabs-v1';
let loaded = false;

export async function loadPrefabs() {
	if (loaded || typeof indexedDB === 'undefined') return;
	loaded = true;
	try {
		prefabs.set((await idbGet(KEY)) ?? []);
	} catch (error) {
		console.log('prefabs load failed', error);
	}
}

async function persist() {
	try {
		await idbPut(KEY, get(prefabs));
	} catch (error) {
		console.log('prefabs persist failed', error);
		showToast('Could not save the prefab library');
	}
}

/** Small offscreen render of the snapshot @param {any} element */
function renderThumbnail(element) {
	try {
		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.setSize(128, 128);
		const scene = new THREE.Scene();
		scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.5));
		const clone = new THREE.ObjectLoader().parse(element);
		clone.position.set(0, 0, 0);
		scene.add(clone);
		const box = new THREE.Box3().setFromObject(clone);
		const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.5);
		const center = box.getCenter(new THREE.Vector3());
		const camera = new THREE.PerspectiveCamera(40, 1, size / 100, size * 10);
		camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.55, size * 0.9));
		camera.lookAt(center);
		renderer.render(scene, camera);
		const url = renderer.domElement.toDataURL('image/webp', 0.7);
		renderer.dispose();
		renderer.forceContextLoss?.();
		return url;
	} catch (error) {
		console.log('prefab thumbnail failed', error);
		return null;
	}
}

const PREFAB_LIMIT = 5_000_000;

/**
 * 23-D2: the cables INTERNAL to a set of subtrees, with their ends rewritten through
 * `remap` (original uuid -> the uuid the element carries). Cables crossing the boundary
 * are dropped, deliberately: half a cable is not a thing, and re-attaching to whatever
 * object happens to share a uuid later would be worse.
 * @param {Record<string, string>} remap every uuid inside the selection -> its element uuid
 */
function cablesWithin(remap) {
	return get(audioPatch).cables
		.filter((cable) => remap[cable.from.uuid] && remap[cable.to.uuid])
		.map((cable) => ({ from: { uuid: remap[cable.from.uuid], port: cable.from.port }, to: { uuid: remap[cable.to.uuid], port: cable.to.port }, gain: cable.gain }));
}
/** stamp the captured cables onto the serialized element's root userData - the ELEMENT,
 * never the live object (its userData replicates) @param {any} element @param {any[]} cables */
function stampCables(element, cables) {
	if (!cables.length || !element?.object) return;
	element.object.userData = { ...(element.object.userData ?? {}), cables };
}

/**
 * 21-H2: the serialized snapshot behind every prefab write — ONE object by uuid, or a
 * MULTI-selection baked into a holder group (U-2). Extracted so "Update from selection"
 * cannot drift from "Save as prefab": they are the same bytes by construction, and the
 * size refusal lives in exactly one place.
 * @param {string[]} uuids @param {string=} name
 * @returns {{element: any, name: string}|null}
 */
function buildPrefabElement(uuids, name) {
	const group = get(objectsGroup);
	const list = (uuids ?? []).filter(Boolean);
	if (!list.length) return null;
	if (list.length === 1) {
		const object = group?.getObjectByProperty('uuid', list[0]);
		if (!object) return null;
		// a prefab is a serialize like any other: saving the object you are editing
		// baked the mesh-edit WIREFRAME into the library entry, and every instance
		// spread it to peers from then on (editOverlays.js)
		const unpark = parkEditOverlays(object);
		/** @type {any} */
		let element;
		try {
			element = object.toJSON();
		} finally {
			unpark();
		}
		if (JSON.stringify(element).length > PREFAB_LIMIT) {
			showToast('Object is too large for a prefab (>5 MB)');
			return null;
		}
		// toJSON keeps the uuids, so the remap is the identity over the subtree
		/** @type {Record<string, string>} */
		const identity = {};
		object.traverse((/** @type {any} */ node) => (identity[node.uuid] = node.uuid));
		stampCables(element, cablesWithin(identity));
		return { element, name: name || object.name || object.type };
	}
	const holder = new THREE.Group();
	holder.name = name || 'Group';
	/** clone(true) mints fresh uuids, so the cable capture needs original -> clone
	 * @type {Record<string, string>} */
	const remap = {};
	for (const uuid of list) {
		const object = group?.getObjectByProperty('uuid', uuid);
		if (!object) continue;
		const clone = object.clone(true);
		/** @type {any[]} */
		const originals = [];
		object.traverse((/** @type {any} */ node) => originals.push(node));
		let i = 0;
		clone.traverse((/** @type {any} */ node) => {
			if (originals[i]) remap[originals[i].uuid] = node.uuid;
			i++;
		});
		stripEditOverlays(clone); // clone(true) copies the edit wireframe with it
		object.updateWorldMatrix(true, false);
		clone.matrix.copy(object.matrixWorld);
		clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
		holder.add(clone);
	}
	if (!holder.children.length) return null;
	const element = holder.toJSON();
	stampCables(element, cablesWithin(remap));
	if (JSON.stringify(element).length > PREFAB_LIMIT) {
		showToast('Selection is too large for a prefab (>5 MB)');
		return null;
	}
	return { element, name: holder.name };
}

/** Save an object (by uuid) into the prefab library @param {string} uuid @param {string=} name */
export async function savePrefab(uuid, name) {
	const snap = buildPrefabElement([uuid], name);
	if (!snap) return null;
	const entry = {
		id: crypto.randomUUID(),
		name: snap.name,
		createdAt: Date.now(),
		thumbnail: renderThumbnail(snap.element),
		element: snap.element
	};
	prefabs.update((list) => [...list, entry]);
	await persist();
	showToast('Prefab saved to your library');
	return entry;
}

/** Save a MULTI-selection as ONE prefab: clone every member (baking world
 * transform so layout is preserved) into a temp group, snapshot that (U-2).
 * @param {string[]} uuids @param {string=} name */
export async function savePrefabSelection(uuids, name) {
	if (!uuids || uuids.length <= 1) return savePrefab(uuids?.[0], name);
	const snap = buildPrefabElement(uuids, name);
	if (!snap) return null;
	const entry = {
		id: crypto.randomUUID(),
		name: snap.name,
		createdAt: Date.now(),
		thumbnail: renderThumbnail(snap.element),
		element: snap.element
	};
	prefabs.update((list) => [...list, entry]);
	await persist();
	showToast('Prefab saved to your library');
	return entry;
}

/**
 * 21-H2: re-save an EXISTING prefab from a selection — same id, same NAME, new bytes.
 * The id is the identity every card, drag payload and preview key uses, so an update
 * has to write through it rather than mint a second entry beside the first (which is
 * what calling savePrefabSelection again would do).
 * @param {string} id @param {string[]} uuids
 * @param {{toast?: boolean}} [opts] `toast: false` when the CALLER reports it — 21-I3's
 *   instant update reports with an Undo action, and two toasts for one act is noise.
 */
export async function updatePrefab(id, uuids, opts = {}) {
	const entry = get(prefabs).find((p) => p.id === id);
	if (!entry) return null;
	const snap = buildPrefabElement(uuids, entry.name);
	if (!snap) return null;
	const next = {
		...entry,
		element: snap.element,
		thumbnail: renderThumbnail(snap.element),
		updatedAt: Date.now()
	};
	prefabs.update((list) => list.map((p) => (p.id === id ? next : p)));
	await persist();
	if (opts.toast !== false) showToast(`Updated "${entry.name}" from the selection`);
	return next;
}

/**
 * 21-I3 — THE BYTES OF ONE PREFAB, captured so a caller can put them back.
 *
 * Locked answer 6: an instant "Update from selection" reports with an **Undo** that
 * belongs to the TOAST and must never enter the scene history stack, because Ctrl+Z is
 * expected to undo viewport changes and nothing else. So this is deliberately NOT a
 * history kind and there is no `recordEntry` anywhere near it — the caller holds the
 * snapshot in a closure for as long as its toast lives, and when the toast goes so does
 * the ability to undo. That is the honest lifetime for a library edit that is not part
 * of the scene.
 *
 * `element` is plain JSON and `thumbnail` a dataURL string, so the snapshot is a value:
 * nothing it points at can be mutated out from under it.
 * @param {string} id
 * @returns {{id: string, element: any, thumbnail: string|null, updatedAt: number|null}|null}
 */
export function prefabSnapshot(id) {
	const entry = prefabById(id);
	if (!entry?.element) return null;
	return {
		id,
		element: entry.element,
		thumbnail: entry.thumbnail ?? null,
		updatedAt: entry.updatedAt ?? null
	};
}

/**
 * Put a `prefabSnapshot` back — the Undo half. Keeps the entry's CURRENT name (a rename
 * between the update and the undo is a different edit, and reverting it too would be
 * undoing something nobody asked about).
 * @param {{id: string, element: any, thumbnail: string|null, updatedAt: number|null}|null} snap
 */
export async function restorePrefabBytes(snap) {
	if (!snap?.id || !snap.element) return null;
	const entry = prefabById(snap.id);
	if (!entry) return null; // deleted in the meantime — nothing to restore into
	const next = { ...entry, element: snap.element, thumbnail: snap.thumbnail, updatedAt: snap.updatedAt };
	if (next.updatedAt === null) delete next.updatedAt; // it had never been updated
	prefabs.update((list) => list.map((p) => (p.id === snap.id ? next : p)));
	await persist();
	return next;
}

/** @param {string} id */
export function prefabById(id) {
	return get(prefabs).find((p) => p.id === id) ?? null;
}

/**
 * 21-H2: the stored prefab JSON as a LIVE THREE tree — **never added to the scene**.
 *
 * ONE seam, deliberately, because the preview and the GLTF export are not two features:
 * a prefab is not an Explorer item, so `ModelPreview` (which resolves an item id to a
 * blob) could not show one, and the exporter needs the very same parse. Fresh uuids on
 * every node, exactly as `instantiatePrefab` does — nothing is added here, but the
 * export TRAVERSES this tree and a uuid colliding with a live object is a trap waiting
 * for the first thing that looks one up.
 * @param {string} id @returns {any|null}
 */
export function prefabObject(id) {
	const entry = prefabById(id);
	if (!entry?.element) return null;
	/** @type {any} */
	let object;
	try {
		object = new THREE.ObjectLoader().parse(entry.element);
	} catch (error) {
		console.log('prefab parse failed', error);
		return null;
	}
	stripEditOverlays(object); // heals a prefab an older build saved mid-session
	object.traverse((/** @type {any} */ node) => (node.uuid = crypto.randomUUID()));
	object.name = entry.name;
	return object;
}

/**
 * 21-H2: a prefab's FACTS for the Properties pane — what it holds, and when it was
 * saved. Parses through `prefabObject`, so the numbers describe the same tree the
 * preview draws and the export writes. `objects` counts the root as well (it is a real
 * node in the tree, and for a single-mesh prefab "1 object" is the honest answer).
 * @param {string} id
 */
export function prefabFacts(id) {
	const entry = prefabById(id);
	if (!entry) return null;
	const object = prefabObject(id);
	let objects = 0;
	let meshes = 0;
	let tris = 0;
	let verts = 0;
	object?.traverse((/** @type {any} */ node) => {
		objects++;
		if (node.isMesh && node.geometry) {
			meshes++;
			const count = node.geometry.attributes?.position?.count ?? 0;
			verts += count;
			tris += node.geometry.index ? node.geometry.index.count / 3 : count / 3;
		}
	});
	return {
		name: entry.name,
		createdAt: entry.createdAt ?? null,
		updatedAt: entry.updatedAt ?? null,
		objects,
		meshes,
		tris: Math.round(tris),
		verts
	};
}

/** Add a prefab instance to the scene (fresh uuids), replicated + undoable.
 * @param {any} prefab @param {any=} position optional spawn point (group-local) */
export function instantiatePrefab(prefab, position) {
	const group = get(objectsGroup);
	if (!group) return null;
	let object;
	try {
		object = new THREE.ObjectLoader().parse(prefab.element);
	} catch (error) {
		console.log('prefab parse failed', error);
		showToast('This prefab could not be loaded');
		return null;
	}
	stripEditOverlays(object); // heals a prefab an older build saved mid-session
	// 23-D2: the cables the element carries come back under the fresh uuids - the re-uuid
	// traverse is the hook, so the map falls out of the same loop
	/** @type {Record<string, string>} */
	const uuidMap = {};
	object.traverse((node) => {
		const fresh = crypto.randomUUID();
		uuidMap[node.uuid] = fresh;
		node.uuid = fresh;
	});
	const cables = Array.isArray(object.userData?.cables) ? object.userData.cables : [];
	// the snapshot stays in the LIBRARY, not on the instance - and ObjectLoader hands the
	// parsed object the element's userData by REFERENCE, so the copy comes first or the
	// delete would strip the library entry itself (the second instantiate came back uncabled)
	if (object.userData?.cables) {
		object.userData = { ...object.userData };
		delete object.userData.cables;
	}
	object.name = prefab.name;
	if (position) object.position.copy(position);
	// the objects and their cables are ONE act, so one undo takes the whole rig back
	if (cables.length) beginHistoryBatch();
	try {
		group.add(object);
		objectsGroup.update((value) => value);
		recordObjectPresence('create', object);
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'object', element: object.toJSON() });
		if (cables.length) addCablesRemapped(cables, uuidMap);
	} finally {
		if (cables.length) endHistoryBatch('Prefab ' + (prefab.name || ''));
	}
	selectObject(object.uuid, true);
	return object;
}

/** @param {string} id */
export async function removePrefab(id) {
	prefabs.update((list) => list.filter((p) => p.id !== id));
	await persist();
}

/** @param {string} id @param {string} name */
export async function renamePrefab(id, name) {
	if (!name) return;
	prefabs.update((list) => list.map((p) => (p.id === id ? { ...p, name } : p)));
	await persist();
}

/** JSON string for sharing a prefab as a file @param {any} prefab */
export function exportPrefab(prefab) {
	return JSON.stringify({ name: prefab.name, element: prefab.element });
}

/** Import a previously exported prefab @param {string} json */
export async function importPrefab(json) {
	try {
		const parsed = JSON.parse(json);
		if (!parsed?.element) throw new Error('not a prefab file');
		const entry = {
			id: crypto.randomUUID(),
			name: parsed.name || 'Imported prefab',
			createdAt: Date.now(),
			thumbnail: renderThumbnail(parsed.element),
			element: parsed.element
		};
		prefabs.update((list) => [...list, entry]);
		await persist();
		return entry;
	} catch (error) {
		console.log('prefab import failed', error);
		showToast('Not a valid prefab file');
		return null;
	}
}
