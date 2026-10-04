// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { beginHistoryBatch, endHistoryBatch, recordObjectPresence } from './history';
import { packRefFromUrl, packRefOf, isLoadingStub } from './packRefs';
import { placeholderBoxOf } from './placeholders';

// 36 U9 — "REPLACE MODEL…" for a placeholder whose piece will not come (or is the wrong one).
//
// TWO SOURCES, TWO RULES (QUESTIONS-36-preload #5):
//   a PACK item replaces IN PLACE — the same uuid, transform, name-if-unchanged and userData,
//     as a new STUB pointing at the new file; every peer refills it like any other stub. It is
//     the ordinary delete + object messages in ONE history batch (the 26-F reduce precedent),
//     so an older peer understands it and one Ctrl+Z puts the old placeholder back. Keeping the
//     uuid keeps every flow graph, HUD binding and note that names the object.
//   an EXPLORER library model is not a reference (its bytes live on this device), so it is
//     IMPORTED at the placeholder's pose through the ordinary import path and the placeholder
//     is deleted — a new uuid, said in the toast.

/** the placeholder the picker is choosing for (a uuid), or null when closed
 * @type {import('svelte/store').Writable<string | null>} */
export const replaceModelTarget = writable(null);

/** @param {string} uuid */
export function openReplaceModel(uuid) {
	replaceModelTarget.set(uuid);
}

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return group?.getObjectByProperty('uuid', uuid) ?? null;
}

/**
 * Point a placeholder at another pack item, keeping its uuid and pose.
 * @param {string} uuid @param {{glbUrl: string, name: string, label?: string, packName?: string}} item
 * @returns {boolean}
 */
export function replaceWithPackItem(uuid, item) {
	const old = objectOf(uuid);
	/** @type {any} */
	const group = get(objectsGroup);
	if (!old || !group || !item?.glbUrl) return false;
	const ref = packRefFromUrl(item.glbUrl, { pack: item.packName, item: item.name });
	if (!ref) {
		showToast('That item cannot be referenced (it is not a pack file)');
		return false;
	}
	const oldRef = packRefOf(old);
	const parent = old.parent ?? group;
	const stub = new THREE.Group();
	stub.uuid = old.uuid;
	// a name the person typed survives; the old ITEM's name follows the new item
	stub.name = !old.name || old.name === oldRef?.item ? item.label || item.name : old.name;
	stub.position.copy(old.position);
	stub.quaternion.copy(old.quaternion);
	stub.scale.copy(old.scale);
	stub.visible = old.visible;
	const { packRef: _drop, packStub: _stub, lod: _lod, ...rest } = old.userData ?? {};
	// the old box stands in until the new file says how big it is
	stub.userData = JSON.parse(JSON.stringify({ ...rest, packRef: { ...ref, box: placeholderBoxOf(old) }, packStub: true }));
	stub.updateMatrix();
	/** @type {any} */
	const peer = get(peers);
	beginHistoryBatch();
	try {
		recordObjectPresence('delete', old);
		parent.remove(old);
		if (peer) peer.send({ type: 'delete', uuid: old.uuid, peerId: peer.peer.id });
		parent.add(stub);
		recordObjectPresence('create', stub);
		if (peer) peer.send({ type: 'object', element: stub.toJSON(), groupuuid: parent !== group ? parent.uuid : undefined });
	} finally {
		endHistoryBatch('Replace model');
	}
	pokeScene();
	return true;
}

/**
 * Put a library model where the placeholder is, then remove the placeholder.
 * @param {string} uuid @param {{id: string, name: string}} item an Explorer object item
 * @returns {Promise<string | null>} the new object's uuid
 */
export async function replaceWithLibraryItem(uuid, item) {
	const old = objectOf(uuid);
	if (!old) return null;
	const [{ itemBlob }, { importFile }, { deleteObjectsByUuid }] = await Promise.all([
		import('./explorer'),
		import('./fileHandler.svelte.js'),
		import('./objectActions')
	]);
	const blob = await itemBlob(item.id);
	if (!blob) {
		showToast('That library file is not on this device');
		return null;
	}
	old.updateWorldMatrix(true, false);
	const pos = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scale = new THREE.Vector3();
	old.matrixWorld.decompose(pos, quat, scale);
	const fresh = await importFile(new File([blob], item.name), item.name.replace(/\.\w+$/, ''), undefined, pos.toArray());
	if (!fresh) return null;
	const placed = objectOf(fresh);
	if (placed) {
		placed.quaternion.copy(quat);
		placed.scale.copy(scale);
		placed.position.copy(pos);
		placed.updateMatrix();
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'move', uuid: placed.uuid, pos: placed.position.toArray(), rot: placed.rotation.toArray(), scale: placed.scale.toArray() });
	}
	if (objectOf(uuid) && isLoadingStub(objectOf(uuid))) deleteObjectsByUuid([uuid]);
	showToast('Replaced with "' + item.name + '" (a library model is a new object)');
	return fresh;
}
