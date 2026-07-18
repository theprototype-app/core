// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalCamera, selectedObject } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { explorerItems, itemBlob } from './explorer';
import { prefabs, instantiatePrefab } from './prefabs';
import { importFile } from './fileHandler.svelte';
import { setObjectTexture } from './materialsHandler';
import { topLevelObjectOf } from './objectActions';

// Explorer -> scene drops (96): place objects/prefabs at the pointed spot,
// texture the mesh under the cursor with a dropped image. Everything goes
// through the EXISTING replicated paths (instantiatePrefab, importFile,
// setObjectTexture) — the library itself stays local.

const raycaster = new THREE.Raycaster();

/**
 * Raycast the drop coordinates: `{point, object}` — object is null over
 * empty ground; point is null when aiming at the sky.
 * @param {number} clientX @param {number} clientY
 */
export function dropTarget(clientX, clientY) {
	/** @type {any} */
	const camera = get(globalCamera);
	const group = get(objectsGroup);
	if (!camera) return { point: null, object: null };
	const ndc = new THREE.Vector2(
		(clientX / window.innerWidth) * 2 - 1,
		-(clientY / window.innerHeight) * 2 + 1
	);
	raycaster.setFromCamera(ndc, camera);
	const hits = group ? raycaster.intersectObjects(group.children, true) : [];
	if (hits[0]) return { point: hits[0].point.toArray(), object: topLevelObjectOf(hits[0].object) };
	const planePoint = new THREE.Vector3();
	const onGround = raycaster.ray.intersectPlane(
		new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
		planePoint
	);
	return { point: onGround ? planePoint.toArray() : null, object: null };
}

/** @param {any} object @param {number[]} point */
function placeAt(object, point) {
	object.position.set(point[0], point[1], point[2]);
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'move',
			uuid: object.uuid,
			pos: object.position.toArray(),
			rot: object.rotation.toArray(),
			scale: object.scale.toArray()
		});
}

/**
 * Apply an Explorer image item as the texture of an object (Inspector drop
 * target + viewport mesh drop share this). Replicates via setObjectTexture.
 * @param {string} uuid @param {any} payload @returns {Promise<boolean>}
 */
export async function applyExplorerImage(uuid, payload) {
	const item = get(explorerItems).find((entry) => entry.id === payload.id);
	if (!item || item.kind !== 'image') return false;
	const blob = await itemBlob(item.id);
	if (!blob) return false;
	await setObjectTexture(uuid, new File([blob], item.name, { type: blob.type || 'image/png' }));
	return true;
}

/**
 * Handle a viewport drop of an Explorer card.
 * @param {{id?: string, kind: string, name: string, prefabId?: string | null, url?: string | null}} payload
 * @param {number} clientX @param {number} clientY
 */
export async function dropExplorerItem(payload, clientX, clientY) {
	const target = dropTarget(clientX, clientY);
	if (payload.prefabId) {
		const prefab = get(prefabs).find((entry) => entry.id === payload.prefabId);
		if (!prefab) return;
		const object = instantiatePrefab(prefab);
		if (object && target.point) placeAt(object, target.point);
		return;
	}
	// N6: a default-pack item carries a `url` (not a stored library item) — fetch
	// its glb and place it at the drop point. The placed object replicates normally.
	if (payload.url) {
		try {
			const res = await fetch(payload.url);
			if (!res.ok) return showToast('Could not fetch the pack item');
			const name = String(payload.name || 'model').replace(/\.\w+$/, '');
			importFile(new File([await res.blob()], name + '.glb'), name, undefined, target.point ?? undefined);
		} catch {
			showToast('Could not load the pack item (network / CORS)');
		}
		return;
	}
	const item = get(explorerItems).find((entry) => entry.id === payload.id);
	if (!item) return;
	if (item.kind === 'object') {
		const blob = await itemBlob(item.id);
		if (!blob) return;
		importFile(
			new File([blob], item.name),
			item.name.replace(/\.\w+$/, ''),
			undefined,
			target.point ?? undefined
		);
	} else if (item.kind === 'image') {
		if (!target.object) {
			showToast('Drop the image ON an object to texture it');
			return;
		}
		await applyExplorerImage(target.object.uuid, { id: item.id });
	} else {
		showToast('Audio/text items are used where they plug in (sound nodes, scripts)');
	}
}
